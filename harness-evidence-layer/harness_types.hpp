#pragma once
#include <string>
#include <chrono>

// authority distinguishes modules whose failure blocks output release
// (Module 4 Governance, Module 5a deterministic checks -- per gate-system
// build plan) from modules whose failure is recorded but non-blocking
// (Module 5b judgment checks, and by the plan's own description of
// Module 2's output, "a list of things worth double-checking" -- not
// ground truth). The Harness enforces on this field, not on module identity,
// so adding/removing modules later doesn't require touching Harness logic.
enum class Authority { BINDING, ADVISORY };

enum class ModuleStatus { PASS, FAIL };

// OK is only used internally as a default/unset marker; a completed
// module result should never carry reason_code OK if status is FAIL,
// and never carry anything but OK if status is PASS.
//
// HARD_HALT is reserved for a module to report a self-detected fatal
// condition it considers categorically different from a routine check
// failure (the analogue of telemetry_harness's TriggerHardHalt) -- the
// Harness itself never produces this code and, as of this pass, treats it
// no differently from CHECK_FAILED/TIMEOUT/EXCEPTION for fail-closed
// purposes. If modules 1-5 need HARD_HALT to trigger different Harness
// behavior (e.g. refusing to process further tasks at all, not just this
// one), that's a real decision for whoever builds those modules, made
// against real failure modes -- not guessed at here against mocks.
//
// CONFIG_ERROR is produced only by the Harness itself (RunWithTimeout's
// spec validation), never by a module. Kept distinct from CHECK_FAILED so
// a dashboard or alert can tell "the module ran and found a real problem"
// from "the module was never actually run because its spec was broken" --
// those need different people to look at them.
enum class ReasonCode { OK, TIMEOUT, CHECK_FAILED, HARD_HALT, EXCEPTION, CONFIG_ERROR };

inline const char* ToString(ModuleStatus s) {
    return s == ModuleStatus::PASS ? "pass" : "fail";
}
inline const char* ToString(Authority a) {
    return a == Authority::BINDING ? "binding" : "advisory";
}
inline const char* ToString(ReasonCode r) {
    switch (r) {
        case ReasonCode::OK:           return "ok";
        case ReasonCode::TIMEOUT:      return "timeout";
        case ReasonCode::CHECK_FAILED: return "check_failed";
        case ReasonCode::HARD_HALT:    return "hard_halt";
        case ReasonCode::EXCEPTION:    return "exception";
        case ReasonCode::CONFIG_ERROR: return "config_error";
    }
    return "unknown";
}

// The contract every module Project (1-5) has to conform to. input_ref /
// output_ref are references (hash, pointer, storage key) not raw payloads --
// the audit log stores provenance, not necessarily the full content.
//
// A module's returned status/reason_code/reason/output_ref are treated as
// a proposal, not a guarantee -- the Harness enforces these invariants on
// every result before it reaches the audit log, regardless of what the
// module actually returned:
//   - status == FAIL  => reason_code != OK, reason is non-empty,
//                         output_ref is cleared (even if the module set one)
//   - status == PASS  => reason_code == OK, reason is cleared (even if the
//                         module set one)
// So in the recorded log, "reason non-empty" means, unambiguously and
// always, "this failed" -- and a FAIL record can never carry a stray
// output_ref for a careless reader to mistakenly trust.
struct ModuleResult {
    std::string module_id;
    std::string task_id;
    ModuleStatus status = ModuleStatus::FAIL;
    Authority authority = Authority::ADVISORY;
    ReasonCode reason_code = ReasonCode::OK;
    std::string reason;       // enforced non-empty iff status == FAIL
    std::string input_ref;
    std::string output_ref;   // enforced empty iff status == FAIL
    std::chrono::system_clock::time_point started_at;
    std::chrono::system_clock::time_point completed_at;
};
