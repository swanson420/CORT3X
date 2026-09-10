#pragma once
#include <functional>
#include <vector>
#include <string>
#include <chrono>
#include <future>
#include <thread>
#include "harness_types.hpp"
#include "audit_log.hpp"

// The black-box contract each module Project (1-5) has to implement.
// run() takes the task id and a reference to its input, returns a
// ModuleResult. status/authority/reason_code/reason are set by run();
// module_id/task_id/input_ref/timestamps are filled in by the Harness,
// not the module, so a module can't misreport its own identity or timing.
struct ModuleSpec {
    std::string module_id;
    Authority authority;
    std::chrono::milliseconds timeout;
    std::function<ModuleResult(const std::string& task_id, const std::string& input_ref)> run;
};

struct TaskReport {
    std::string task_id;
    bool released = true;
    std::string blocked_by_module;   // empty if released
    ReasonCode blocked_reason = ReasonCode::OK;
    std::vector<ModuleResult> results;
};

class Harness {
    AuditLog& audit;

public:
    explicit Harness(AuditLog& a) : audit(a) {}

    TaskReport RunTask(const std::string& task_id, const std::string& input_ref,
                        const std::vector<ModuleSpec>& modules) {
        TaskReport report;
        report.task_id = task_id;

        for (const auto& spec : modules) {
            ModuleResult res = RunWithTimeout(spec, task_id, input_ref);
            audit.Record(res);
            report.results.push_back(res);

            // Fail-closed: a BINDING failure stops the pipeline immediately.
            // Remaining modules do not run -- matches the plan's own logic
            // (a Module 4 fail or failed 5a check means the output should
            // never reach the user, so there's nothing left worth computing
            // Module 5b/etc. against). ADVISORY failures are recorded and
            // the pipeline continues.
            // Gate on res.authority, not spec.authority: normally identical
            // (Harness copies spec.authority onto every result), but the
            // config-validation path in RunWithTimeout escalates a
            // misconfigured spec to BINDING regardless of what it declared
            // -- checking spec.authority here would silently ignore that
            // escalation and let a broken ADVISORY-labeled module's config
            // error slide through unblocked. Caught by Scenario H failing
            // on first run of the expanded suite -- exactly the kind of
            // thing that's supposed to fail loudly in tests, not in
            // production.
            if (res.status == ModuleStatus::FAIL && res.authority == Authority::BINDING) {
                report.released = false;
                report.blocked_by_module = res.module_id;
                report.blocked_reason = res.reason_code;
                audit.RecordHalt(task_id, res.module_id, res.reason_code, res.reason);
                break;
            }
        }

        audit.RecordTaskOutcome(task_id, report.released);
        return report;
    }

private:
    // Open question 3, resolved: a module that blows its timeout budget is
    // recorded as FAIL / reason_code=timeout, not a separate degraded-pass
    // state. If that module is BINDING, the pipeline halts exactly as it
    // would for a real check failure -- fail-closed treats "we don't know"
    // the same as "it failed," on purpose.
    //
    // Known limitation, not hidden: C++ has no safe way to forcibly cancel
    // a running std::thread. On a genuine timeout (only that branch, see
    // below) the worker thread is detached and left to finish -- or hang --
    // on its own; the Harness moves on and reports the timeout, but a
    // genuinely stuck module leaks a thread until the process exits.
    // Acceptable for a first pass, not for production -- would need a
    // cooperative-cancellation contract on ModuleSpec::run (e.g. a
    // stop_token) to close properly. The non-timeout path joins instead of
    // detaching (see below) specifically to avoid a second, worse problem:
    // ThreadSanitizer caught a real data race when this used to detach
    // unconditionally.
    ModuleResult RunWithTimeout(const ModuleSpec& spec, const std::string& task_id,
                                 const std::string& input_ref) {
        auto started = std::chrono::system_clock::now();

        // Red-team item 9: a malformed ModuleSpec (empty id, non-positive
        // timeout, unset run function) must not reach a thread spawn --
        // std::function::operator() on an empty target throws
        // std::bad_function_call from inside the worker thread, which is
        // recoverable but wasteful and noisy, and a <=0 timeout would
        // always fire the timeout path regardless of what run() does.
        // Treated as BINDING regardless of the spec's own declared
        // authority: a config error isn't something an ADVISORY label can
        // downgrade -- if the harness can't trust the spec enough to run
        // it, it can't trust the spec's own authority field either.
        if (spec.module_id.empty() || spec.timeout.count() <= 0 || !spec.run) {
            std::vector<std::string> issues;
            if (spec.module_id.empty()) issues.push_back("module_id empty");
            if (spec.timeout.count() <= 0) issues.push_back("timeout <= 0");
            if (!spec.run) issues.push_back("run() unset");

            std::string joined;
            for (size_t i = 0; i < issues.size(); i++) {
                if (i > 0) joined += "; ";
                joined += issues[i];
            }

            ModuleResult r;
            // "config_error:" prefix keeps this out of real module_id
            // namespace (real ids look like "module_4_governance") --
            // won't collide with an operator-chosen name in
            // summary_by_module() or a dashboard.
            r.module_id = spec.module_id.empty() ? "config_error:unnamed_module" : spec.module_id;
            r.task_id = task_id;
            r.status = ModuleStatus::FAIL;
            r.authority = Authority::BINDING;
            r.reason_code = ReasonCode::CONFIG_ERROR;
            r.reason = "misconfigured ModuleSpec: " + joined;
            r.input_ref = input_ref;
            r.started_at = started;
            r.completed_at = started;
            return r;
        }

        // Capture by VALUE, not reference. spec is a reference into the
        // caller's vector and task_id/input_ref are local to RunTask's
        // stack frame -- if the timeout branch below fires and RunTask
        // returns while the detached thread is still running, references
        // to any of those would dangle. This is the same class of bug as
        // telemetry_harness's unlocked Quarantine() call: state that
        // outlives the scope guarding it. Copies avoid it entirely.
        std::packaged_task<ModuleResult()> task(
            [run = spec.run, task_id, input_ref]() { return run(task_id, input_ref); });
        std::future<ModuleResult> fut = task.get_future();
        std::thread worker(std::move(task));

        if (fut.wait_for(spec.timeout) == std::future_status::timeout) {
            // Genuinely abandoning this thread -- detach is the only option,
            // since it may never return (documented leak/hang risk below).
            // This is the ONLY branch that detaches. Confirmed by
            // ThreadSanitizer: detaching unconditionally, including on the
            // success/exception path, is a real data race, not a theoretical
            // one -- the worker thread's own teardown of its packaged_task
            // (dropping a shared_ptr to the future's shared state, including
            // any stored exception) can run concurrently with the main
            // thread still reading that exception via e.what() below.
            // join() on the non-timeout path fixes this: it guarantees the
            // worker has fully finished, including destroying its own
            // reference, before the main thread touches the result at all.
            worker.detach();
            ModuleResult r;
            r.module_id = spec.module_id;
            r.task_id = task_id;
            r.status = ModuleStatus::FAIL;
            r.authority = spec.authority;
            r.reason_code = ReasonCode::TIMEOUT;
            r.reason = "module exceeded timeout budget (" +
                       std::to_string(spec.timeout.count()) + "ms)";
            r.input_ref = input_ref;
            r.started_at = started;
            r.completed_at = std::chrono::system_clock::now();
            return r;
        }

        // Completed within budget: reap the thread properly. join()
        // synchronizes-with the worker's own cleanup, so nothing below
        // this line can race with it.
        worker.join();

        try {
            ModuleResult res = fut.get();
            // Harness owns identity/timing fields, not the module.
            res.module_id = spec.module_id;
            res.task_id = task_id;
            res.authority = spec.authority;
            res.input_ref = input_ref;
            res.started_at = started;
            res.completed_at = std::chrono::system_clock::now();

            // Red-team item 7 (pass 1) + follow-up (pass 3, "normalization
            // incomplete and asymmetric"): the harness overwrote
            // identity/timing above, but was trusting status/reason_code/
            // reason/output_ref verbatim from the module. Two gaps closed
            // here: PASS could carry a leftover non-empty reason (module
            // sets reason then flips to PASS, or just forgets to clear
            // it) -- ambiguous for a reader who uses "reason non-empty" as
            // a fail signal. And FAIL could carry a stale output_ref from
            // before the module detected its own failure -- the contract
            // comment says output_ref is "meaningful only if PASS", but
            // meaning isn't enforcement; a careless downstream reader who
            // doesn't check status first could pick it up anyway.
            if (res.status == ModuleStatus::FAIL) {
                if (res.reason_code == ReasonCode::OK) {
                    res.reason_code = ReasonCode::CHECK_FAILED;
                }
                if (res.reason.empty()) {
                    res.reason = "module reported FAIL without a reason "
                                  "(harness-inserted default; module contract violation)";
                }
                res.output_ref.clear();
            } else {
                // PASS should never carry a non-OK reason code -- avoid
                // confusing combinations like PASS + TIMEOUT reaching the
                // audit log. Also clear any stray reason text -- on PASS
                // it isn't wrong, exactly, but it's ambiguous (is this
                // informational, or did the module mean to fail and
                // didn't?) and costs nothing to remove: reason non-empty
                // now means, unambiguously and always, "this failed."
                res.reason_code = ReasonCode::OK;
                res.reason.clear();
            }
            return res;
        } catch (const std::exception& e) {
            ModuleResult r;
            r.module_id = spec.module_id;
            r.task_id = task_id;
            r.status = ModuleStatus::FAIL;
            r.authority = spec.authority;
            r.reason_code = ReasonCode::EXCEPTION;
            r.reason = std::string("module threw: ") + e.what();
            r.input_ref = input_ref;
            r.started_at = started;
            r.completed_at = std::chrono::system_clock::now();
            return r;
        } catch (...) {
            // Red-team item 6: only std::exception was caught before. A
            // module throwing something that doesn't derive from it (a
            // raw int, a custom type, etc.) would have propagated straight
            // out of the Harness and crashed the whole orchestrator over
            // one module's bad behavior. This is the backstop.
            // (Not adding a guard around e.what() itself per the
            // std::exception branch above -- what() is declared noexcept
            // by the standard, so it structurally cannot throw in
            // conforming code; a guard there would be dead code.)
            ModuleResult r;
            r.module_id = spec.module_id;
            r.task_id = task_id;
            r.status = ModuleStatus::FAIL;
            r.authority = spec.authority;
            r.reason_code = ReasonCode::EXCEPTION;
            r.reason = "module threw a non-std::exception value (unknown type)";
            r.input_ref = input_ref;
            r.started_at = started;
            r.completed_at = std::chrono::system_clock::now();
            return r;
        }
    }
};
