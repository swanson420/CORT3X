# Clarification Gate -- skeleton

**Status: skeleton, verified. Toggle-wiring logic built and tested
(7/7 passing). Ambiguity judgment itself intentionally stubbed --
Module 1's real job, not built anywhere in this codebase yet.**

## Build & run

```
python3 -m unittest discover -v
```

12 tests: 11 exhaustive/edge-case checks of the toggle wiring, plus 1
property-based check (2000 generated string inputs, seeded/reproducible,
hand-rolled -- Hypothesis unavailable offline) confirming input passes
through to `judge_ambiguity()` completely unmodified.

## What's actually built

`src/engine/clarity_check.py` -- `run_clarification_gate(request_or_step, gate_enabled)`:

- Toggle ON, ambiguous -> `BOUNCE_BACK` (pause, return a question, caller must not proceed until answered)
- Toggle ON, not ambiguous -> `CLEAR` (proceeds immediately)
- Toggle OFF, not ambiguous -> `CLEAR`
- Toggle OFF, ambiguous -> `FLAGGED_PROCEED` by default (proceeds, but visibly marked -- never blocks when OFF)

Manual toggle only -- no automatic stakes-tier default. `run_clarification_gate()` itself doesn't distinguish automatic vs. manual triggering -- it's a plain function, agnostic to caller. Decided: it should be callable BOTH ways, but **only one of the two currently has a caller**:

  - **Manually, on demand -- real today.** This is exactly how the test suite calls it, fully working.
  - **Automatically, at the start of every turn -- designed, not built.** No turn-loop exists anywhere in this codebase to call it from, same gap as `context-workspace`/Module 6 wiring below. This path has zero callers right now.

Both are designed to call the exact same function with no new logic required once a turn-loop exists -- but claiming "both work" today would be wrong. Only the manual path is exercised by anything real.

## What's stubbed, on purpose

`judge_ambiguity()` raises `NotImplementedError`. This is Module 1's real job per `gate-system-build-plan.md` (LLM single-pass, consumes `UserRequest v1`, produces `RequirementChecklist v1`) -- that call doesn't exist yet anywhere in this codebase. Not faked with a keyword heuristic that would look plausible on a few manual tests and prove nothing real.

## Decided

- **`OFF_MODE_SURFACES_FLAG = True`, locked in.** Matches datahub-lineage-guard's fail-closed convention ("fail toward HALT, not QUARANTINE"). Silent proceed-on-ambiguous would be the one place in the codebase that fails toward invisibility instead of visibility -- ruled out on consistency grounds, not a fresh guess.
- **Storage stays plain in-memory, not wired to `context-workspace` now.** Deliberate: (1) this module is standalone specifically so it isn't coupled to `context-workspace`/Module 6 before either is confirmed as its real home -- wiring persistence in now creates the exact coupling that decision was avoiding; (2) mirrors `severity.py`'s own pattern in the DataHub scaffold -- operates on resolved objects, stays decoupled from where they're fetched or stored, persistence added later behind a hard boundary once there's a real caller and a real home.

## Still open

- **Where this file lives long-term.** Built standalone, not wired into `context-workspace` or Module 6 specifically -- moving it once that's decided is a small edit, not a rewrite.
- **Module 1 itself.** This is not Module 1 -- it's the gate that *would* sit in front of whatever Module 1 becomes, wired to a stub in the meantime.

## Not built here (different features, discussed and set aside)

- **Revert** -- undoing something already committed, noticed later. Different timing than this gate (which only guards the step about to happen).
- **Hold-for-approval** -- nothing commits without explicit yes, every time, regardless of ambiguity. A much broader behavior than this gate.
