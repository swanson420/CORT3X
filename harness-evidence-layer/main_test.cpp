#include "harness.hpp"
#include <iostream>
#include <fstream>
#include <sstream>
#include <thread>
#include <cassert>

int pass_count = 0;
int fail_count = 0;
void check(bool cond, const char* label) {
    std::cout << (cond ? "[PASS] " : "[FAIL] ") << label << "\n";
    if (cond) pass_count++; else fail_count++;
}

// --- Mock modules standing in for Projects 1-5, which don't exist yet.
// Each returns only the fields a real module owns (status/reason_code/
// reason/output_ref); Harness fills in module_id/task_id/input_ref/timing.

ModuleResult MockPass(const std::string&, const std::string&) {
    ModuleResult r;
    r.status = ModuleStatus::PASS;
    r.reason_code = ReasonCode::OK;
    r.output_ref = "out-ref-ok";
    return r;
}

ModuleResult MockFailCheck(const std::string&, const std::string&) {
    ModuleResult r;
    r.status = ModuleStatus::FAIL;
    r.reason_code = ReasonCode::CHECK_FAILED;
    r.reason = "mock: deterministic check failed";
    return r;
}

ModuleResult MockGovernanceFail(const std::string&, const std::string&) {
    ModuleResult r;
    r.status = ModuleStatus::FAIL;
    r.reason_code = ReasonCode::CHECK_FAILED;
    r.reason = "mock: policy violation, flagged span [12:48]";
    return r;
}

ModuleResult MockSlow(const std::string&, const std::string&) {
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    ModuleResult r;
    r.status = ModuleStatus::PASS;
    r.reason_code = ReasonCode::OK;
    return r;
}

ModuleResult MockThrows(const std::string&, const std::string&) {
    throw std::runtime_error("mock: tool integration unreachable");
}

// Throws something that is NOT a std::exception -- exercises the catch(...)
// backstop added for red-team item 6.
ModuleResult MockThrowsNonStd(const std::string&, const std::string&) {
    throw 42; // deliberately not derived from std::exception
}

// A misbehaving module: reports FAIL but leaves reason_code at OK and
// reason empty -- exercises the post-condition normalization added for
// red-team item 7.
ModuleResult MockFailNoDetails(const std::string&, const std::string&) {
    ModuleResult r;
    r.status = ModuleStatus::FAIL;
    // reason_code left at default (OK) and reason left empty -- on purpose.
    return r;
}

// A module whose reason field deliberately contains the raw text of the
// exact search pattern VerifyChain's parser looks for -- attempts the
// specific injection a red-team finding claimed would fool it.
ModuleResult MockInjectsChainSyntax(const std::string&, const std::string&) {
    ModuleResult r;
    r.status = ModuleStatus::FAIL;
    r.reason_code = ReasonCode::CHECK_FAILED;
    r.reason = "payload attempt: \"prev_hash\":\"FAKE00000000000\" and \"hash\":\"ALSOFAKE0000000\" trailing text";
    return r;
}

// PASS with a stray leftover reason -- exercises the PASS-clears-reason
// normalization added this pass.
ModuleResult MockPassWithStrayReason(const std::string&, const std::string&) {
    ModuleResult r;
    r.status = ModuleStatus::PASS;
    r.output_ref = "out-ref-ok";
    r.reason = "leftover note the module forgot to clear before returning PASS";
    return r;
}

// FAIL with a stale output_ref left over from before the module detected
// its own failure -- exercises the FAIL-clears-output_ref normalization.
ModuleResult MockFailWithStaleOutput(const std::string&, const std::string&) {
    ModuleResult r;
    r.status = ModuleStatus::FAIL;
    r.reason_code = ReasonCode::CHECK_FAILED;
    r.reason = "check failed after partially computing output";
    r.output_ref = "stale-partial-output-ref"; // should not survive to the audit log
    return r;
}

std::vector<ModuleSpec> StandardPipeline(
    std::function<ModuleResult(const std::string&, const std::string&)> m4,
    std::function<ModuleResult(const std::string&, const std::string&)> m5a,
    std::function<ModuleResult(const std::string&, const std::string&)> m5b) {
    using ms = std::chrono::milliseconds;
    return {
        {"module_1_request_understanding", Authority::BINDING,  ms(500), MockPass},
        {"module_2_reasoning_integrity",   Authority::ADVISORY, ms(500), MockPass},
        {"module_3_evidence_trust",        Authority::ADVISORY, ms(500), MockPass},
        {"module_4_governance",            Authority::BINDING,  ms(500), m4},
        {"module_5a_output_deterministic", Authority::BINDING,  ms(500), m5a},
        {"module_5b_output_judgment",      Authority::ADVISORY, ms(500), m5b},
    };
}

size_t CountLines(const std::string& path) {
    std::ifstream f(path);
    size_t n = 0;
    std::string line;
    while (std::getline(f, line)) if (!line.empty()) n++;
    return n;
}

int main() {
    const std::string log_path = "/tmp/audit_test.jsonl";
    std::remove(log_path.c_str());

    std::cout << "=== Scenario A: everything passes -> released ===\n";
    {
        AuditLog audit(log_path);
        Harness harness(audit);
        auto pipeline = StandardPipeline(MockPass, MockPass, MockPass);
        auto report = harness.RunTask("task-A", "input-ref-A", pipeline);

        check(report.released == true, "Task released when all modules pass");
        check(report.results.size() == 6, "All 6 modules ran");
        check(report.blocked_by_module.empty(), "No blocking module recorded");
    }

    std::cout << "\n=== Scenario B: Module 4 (Governance) fails -> blocked, 5a/5b never run ===\n";
    {
        AuditLog audit(log_path);
        Harness harness(audit);
        auto pipeline = StandardPipeline(MockGovernanceFail, MockPass, MockPass);
        auto report = harness.RunTask("task-B", "input-ref-B", pipeline);

        check(report.released == false, "Task withheld on Module 4 fail");
        check(report.blocked_by_module == "module_4_governance", "Blocked-by correctly identifies Module 4");
        check(report.results.size() == 4, "Pipeline stopped at Module 4 -- 5a/5b did not run");
    }

    std::cout << "\n=== Scenario C: Module 5a (deterministic) fails -> blocked, 5b never runs ===\n";
    {
        AuditLog audit(log_path);
        Harness harness(audit);
        auto pipeline = StandardPipeline(MockPass, MockFailCheck, MockPass);
        auto report = harness.RunTask("task-C", "input-ref-C", pipeline);

        check(report.released == false, "Task withheld on Module 5a fail");
        check(report.blocked_by_module == "module_5a_output_deterministic", "Blocked-by correctly identifies Module 5a");
        check(report.results.size() == 5, "Pipeline stopped at 5a -- 5b did not run");
    }

    std::cout << "\n=== Scenario D: Module 5b (advisory/judgment) fails -> released anyway ===\n";
    {
        AuditLog audit(log_path);
        Harness harness(audit);
        auto pipeline = StandardPipeline(MockPass, MockPass, MockFailCheck);
        auto report = harness.RunTask("task-D", "input-ref-D", pipeline);

        check(report.released == true, "Task still released -- 5b is advisory, not binding");
        check(report.results.size() == 6, "All 6 modules ran, including the failing advisory one");
        check(report.results.back().status == ModuleStatus::FAIL, "5b's fail is recorded, not suppressed");
    }

    std::cout << "\n=== Scenario E: binding module times out -> treated as fail, blocks ===\n";
    {
        AuditLog audit(log_path);
        Harness harness(audit);
        std::vector<ModuleSpec> pipeline = {
            {"module_1_request_understanding", Authority::BINDING, std::chrono::milliseconds(500), MockPass},
            {"module_4_governance", Authority::BINDING, std::chrono::milliseconds(50), MockSlow}, // 200ms sleep vs 50ms budget
        };
        auto report = harness.RunTask("task-E", "input-ref-E", pipeline);

        check(report.released == false, "Task withheld when a binding module times out");
        check(report.results.back().reason_code == ReasonCode::TIMEOUT, "Reason code is TIMEOUT, not check_failed");
        check(report.blocked_reason == ReasonCode::TIMEOUT, "Report's blocked_reason reflects timeout");
    }

    std::cout << "\n=== Scenario F: module throws -> caught, treated as fail, doesn't crash Harness ===\n";
    {
        AuditLog audit(log_path);
        Harness harness(audit);
        std::vector<ModuleSpec> pipeline = {
            {"module_3_evidence_trust", Authority::BINDING, std::chrono::milliseconds(500), MockThrows},
        };
        auto report = harness.RunTask("task-F", "input-ref-F", pipeline);

        check(report.released == false, "Task withheld when a module throws");
        check(report.results[0].reason_code == ReasonCode::EXCEPTION, "Reason code is EXCEPTION");
        check(report.results[0].reason.find("tool integration unreachable") != std::string::npos,
              "Original exception message preserved in reason");
    }

    std::cout << "\n=== Scenario G: module throws a non-std::exception -> still caught ===\n";
    {
        AuditLog audit(log_path);
        Harness harness(audit);
        std::vector<ModuleSpec> pipeline = {
            {"module_2_reasoning_integrity", Authority::BINDING, std::chrono::milliseconds(500), MockThrowsNonStd},
        };
        auto report = harness.RunTask("task-G", "input-ref-G", pipeline);

        check(report.released == false, "Task withheld when a module throws a non-std::exception");
        check(report.results[0].reason_code == ReasonCode::EXCEPTION, "Reason code is EXCEPTION for non-std throw too");
        check(report.results[0].status == ModuleStatus::FAIL, "Non-std throw does not crash the Harness -- caught cleanly");
    }

    std::cout << "\n=== Scenario H: misconfigured ModuleSpec is rejected before spawning a thread ===\n";
    {
        AuditLog audit(log_path);
        Harness harness(audit);
        using ms = std::chrono::milliseconds;
        std::vector<ModuleSpec> empty_id = {{"", Authority::ADVISORY, ms(500), MockPass}};
        std::vector<ModuleSpec> zero_timeout = {{"module_x", Authority::ADVISORY, ms(0), MockPass}};
        std::vector<ModuleSpec> null_run = {{"module_y", Authority::ADVISORY, ms(500), nullptr}};

        auto r1 = harness.RunTask("task-H1", "ref", empty_id);
        auto r2 = harness.RunTask("task-H2", "ref", zero_timeout);
        auto r3 = harness.RunTask("task-H3", "ref", null_run);

        check(r1.released == false, "Empty module_id treated as BINDING config failure, blocks release");
        check(r2.released == false, "Zero timeout treated as BINDING config failure, blocks release");
        check(r3.released == false, "Null run() treated as BINDING config failure, blocks release");
        check(r1.results[0].authority == Authority::BINDING,
              "Config failure escalates to BINDING even though spec declared ADVISORY");
        check(r1.results[0].reason_code == ReasonCode::CONFIG_ERROR,
              "Config failure gets its own distinct reason code, not lumped in with CHECK_FAILED");
        check(r1.results[0].module_id == "config_error:unnamed_module",
              "Empty module_id gets a namespaced synthetic id, not a bare magic string that could collide "
              "with a real operator-chosen module name");
        check(r2.results[0].reason.find("timeout <= 0") != std::string::npos &&
              r2.results[0].reason.back() != ';' && r2.results[0].reason.back() != ' ',
              "Config-error reason text has no trailing separator artifact");
    }

    std::cout << "\n=== Scenario I: module misreports FAIL details -> Harness normalizes before recording ===\n";
    {
        AuditLog audit(log_path);
        Harness harness(audit);
        std::vector<ModuleSpec> pipeline = {
            {"module_2_reasoning_integrity", Authority::ADVISORY, std::chrono::milliseconds(500), MockFailNoDetails},
        };
        auto report = harness.RunTask("task-I", "input-ref-I", pipeline);

        check(report.results[0].reason_code != ReasonCode::OK,
              "FAIL with module-reported reason_code=OK gets normalized to a real reason code");
        check(!report.results[0].reason.empty(),
              "FAIL with empty module-reported reason gets a harness-inserted default, not blank");
    }

    std::cout << "\n=== Scenario I2: normalization is now symmetric -- PASS clears reason, FAIL clears output_ref ===\n";
    {
        AuditLog audit(log_path);
        Harness harness(audit);
        std::vector<ModuleSpec> pipeline_a = {
            {"module_1_request_understanding", Authority::ADVISORY, std::chrono::milliseconds(500), MockPassWithStrayReason},
        };
        std::vector<ModuleSpec> pipeline_b = {
            {"module_2_reasoning_integrity", Authority::ADVISORY, std::chrono::milliseconds(500), MockFailWithStaleOutput},
        };
        auto report_a = harness.RunTask("task-I2a", "ref", pipeline_a);
        auto report_b = harness.RunTask("task-I2b", "ref", pipeline_b);

        check(report_a.results[0].reason.empty(),
              "PASS with a stray module-set reason has it cleared -- reason non-empty now means, unambiguously, FAIL");
        check(!report_a.results[0].output_ref.empty(),
              "PASS still keeps its legitimate output_ref -- only reason is cleared, not everything");
        check(report_b.results[0].output_ref.empty(),
              "FAIL with a stale module-set output_ref has it cleared -- a careless reader who doesn't "
              "check status first can no longer pick up a partial/invalid output");
    }

    std::cout << "\n=== Scenario J: concurrent RunTask calls on the same Harness/AuditLog don't corrupt state ===\n";
    {
        AuditLog audit(log_path);
        Harness harness(audit);
        constexpr int kConcurrentTasks = 20;
        std::vector<std::thread> callers;
        for (int i = 0; i < kConcurrentTasks; i++) {
            callers.emplace_back([&harness, i]() {
                auto pipeline = StandardPipeline(MockPass, MockPass, MockPass);
                auto r = harness.RunTask("task-J" + std::to_string(i), "ref", pipeline);
                (void)r;
            });
        }
        for (auto& t : callers) t.join();

        auto summary = audit.summary_by_module();
        check(summary["module_4_governance"].pass == kConcurrentTasks,
              "All concurrent tasks recorded correctly -- no lost or duplicated writes under the log's mutex");

        // This assertion was missing before -- summary_by_module() checks
        // in-memory bookkeeping, which the mutex already protects. It says
        // nothing about whether the ON-DISK bytes from 20 threads racing
        // to write are actually well-formed and chain-linked. Checking
        // that separately, immediately after the storm, while fd state is
        // as contended as it's going to get.
        size_t break_at = AuditLog::VerifyChain(log_path);
        check(break_at == 0, "On-disk hash chain is intact immediately after a 20-thread concurrent storm");
    }

    std::cout << "\n=== Scenario K: module reason containing raw chain-field syntax doesn't fool VerifyChain ===\n";
    {
        AuditLog audit(log_path);
        Harness harness(audit);
        std::vector<ModuleSpec> pipeline = {
            {"module_2_reasoning_integrity", Authority::ADVISORY, std::chrono::milliseconds(500), MockInjectsChainSyntax},
        };
        harness.RunTask("task-K", "input-ref-K", pipeline);

        size_t break_at2 = AuditLog::VerifyChain(log_path);
        check(break_at2 == 0,
              "A reason field containing literal \"prev_hash\":\" / \"hash\":\" text doesn't break chain "
              "verification (JsonEscape already prevents the raw sequence from surviving into the file; "
              "rfind removes the dependency on that holding forever)");
    }


    {
        AuditLog audit(log_path);
        Harness harness(audit);
        harness.RunTask("task-G1", "ref", StandardPipeline(MockPass, MockPass, MockPass));
        harness.RunTask("task-G2", "ref", StandardPipeline(MockGovernanceFail, MockPass, MockPass));
        harness.RunTask("task-G3", "ref", StandardPipeline(MockGovernanceFail, MockPass, MockPass));

        auto summary = audit.summary_by_module();
        auto& gov = summary["module_4_governance"];
        check(gov.pass == 1, "summary_by_module: Module 4 pass count correct across 3 tasks");
        check(gov.fail == 2, "summary_by_module: Module 4 fail count correct across 3 tasks");
        check(gov.fail_by_reason["check_failed"] == 2, "summary_by_module: fail reason breakdown correct");

        auto& m5b = summary["module_5b_output_judgment"];
        check(m5b.pass == 1, "summary_by_module: modules after a halted pipeline show 0 runs, not false passes");
        // task-G2 and task-G3 halted at module_4, so 5b only ran once (task-G1)
    }

    std::cout << "\n=== Audit log durability check (reopen + append across instances) ===\n";
    {
        size_t lines_before;
        {
            AuditLog audit(log_path);
            lines_before = CountLines(log_path);
        }
        {
            AuditLog audit(log_path); // reopen in append mode
            Harness harness(audit);
            harness.RunTask("task-H", "ref", StandardPipeline(MockPass, MockPass, MockPass));
        }
        size_t lines_after = CountLines(log_path);
        check(lines_after > lines_before, "New AuditLog instance appends, does not truncate prior entries");
    }

    std::cout << "\n=== Hash chain: intact log verifies clean ===\n";
    {
        size_t break_at = AuditLog::VerifyChain(log_path);
        check(break_at == 0, "VerifyChain reports no break across every scenario run so far, including reopens");
    }

    std::cout << "\n=== Hash chain: tampering is detected ===\n";
    {
        // Corrupt a real field (a "reason" value) in an early line and
        // confirm VerifyChain catches it -- proves the chain isn't just
        // decorative JSON fields.
        std::ifstream in(log_path);
        std::vector<std::string> lines;
        std::string l;
        while (std::getline(in, l)) if (!l.empty()) lines.push_back(l);
        in.close();

        size_t target = lines.size() / 2; // tamper with a line in the middle
        auto pos = lines[target].find("mock:");
        bool found_a_reason_field = (pos != std::string::npos);
        if (found_a_reason_field) {
            lines[target].replace(pos, 5, "REDACTED_BY_TEST_TAMPER");
        } else {
            // fall back to corrupting the module_id if that particular line
            // had no "mock:" reason text
            pos = lines[target].find("\"module_id\":\"");
            lines[target].insert(pos + 14, "TAMPERED_");
        }

        std::string tampered_path = "/tmp/audit_test_tampered.jsonl";
        std::remove(tampered_path.c_str());
        std::ofstream out(tampered_path);
        for (auto& line : lines) out << line << "\n";
        out.close();

        size_t break_at = AuditLog::VerifyChain(tampered_path);
        check(break_at != 0, "VerifyChain detects a single tampered field in the middle of the log");
        check(break_at == target + 1, "VerifyChain identifies the exact tampered line (1-indexed)");
    }

    std::cout << "\n=== Section 4: durable_fsync=true, exercised in the real suite, not a side-script ===\n";
    {
        const std::string fsync_path = "/tmp/audit_test_fsync.jsonl";
        std::remove(fsync_path.c_str());
        {
            AuditLog audit(fsync_path, /*durable_fsync=*/true);
            Harness harness(audit);
            harness.RunTask("task-fsync-1", "ref", StandardPipeline(MockPass, MockPass, MockPass));
            harness.RunTask("task-fsync-2", "ref", StandardPipeline(MockGovernanceFail, MockPass, MockPass));
        }
        // Reopen with fsync still on, across a process-instance boundary,
        // same as the plain-mode reopen test already covers -- fsync
        // shouldn't change reopen/chain-continuity behavior, only the
        // durability of each individual write.
        {
            AuditLog audit(fsync_path, /*durable_fsync=*/true);
            Harness harness(audit);
            harness.RunTask("task-fsync-3", "ref", StandardPipeline(MockPass, MockPass, MockPass));
        }
        size_t break_at = AuditLog::VerifyChain(fsync_path);
        check(break_at == 0, "durable_fsync=true path produces a valid, chain-intact log across reopen");
        check(CountLines(fsync_path) > 0, "durable_fsync=true path actually writes records, not a no-op");
    }

    std::cout << "\n=== Section 5: on_new_hash callback fires correctly ===\n";
    {
        const std::string cb_path = "/tmp/audit_test_callback.jsonl";
        std::remove(cb_path.c_str());
        std::vector<std::string> observed_hashes;
        {
            AuditLog audit(cb_path, /*durable_fsync=*/false,
                            [&](const std::string& h) { observed_hashes.push_back(h); });
            Harness harness(audit);
            harness.RunTask("task-cb", "ref", StandardPipeline(MockPass, MockPass, MockPass));
            // StandardPipeline is 6 modules + 1 task_outcome line = 7 WriteLine calls
            check(observed_hashes.size() == 7,
                  "on_new_hash fires exactly once per line actually written (6 module results + 1 task outcome)");
            check(observed_hashes.back() == audit.current_hash(),
                  "Last callback value matches current_hash() -- callback fires with the real new tip, in order");
        }
        size_t break_at = AuditLog::VerifyChain(cb_path);
        check(break_at == 0, "Log written while a callback was attached is still chain-intact");
        bool all_hashes_appear_in_file = true;
        {
            std::ifstream f(cb_path);
            std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
            for (auto& h : observed_hashes) {
                if (content.find(h) == std::string::npos) { all_hashes_appear_in_file = false; break; }
            }
        }
        check(all_hashes_appear_in_file,
              "Every hash the callback observed actually appears in the written file -- callback isn't "
              "reporting fabricated or out-of-band values");
    }


    {
        std::ifstream f(log_path);
        std::string first_line;
        std::getline(f, first_line);
        check(first_line.front() == '{' && first_line.back() == '}',
              "First audit line is a single JSON object");
        check(first_line.find("\"event\":\"module_result\"") != std::string::npos,
              "First line is a module_result event");
    }

    std::cout << "\n=== SUMMARY: " << pass_count << " passed, " << fail_count << " failed ===\n";
    return fail_count > 0 ? 1 : 0;
}
