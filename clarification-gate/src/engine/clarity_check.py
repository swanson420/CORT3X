"""
src/engine/clarity_check.py

Clarification Gate -- decides whether an incoming request or step is clear
enough to act on, or needs to bounce back as a question before anything
proceeds.

Mirrors the same two-outcome severity-split pattern already used
elsewhere in Cort3x (telemetry_harness's halt/flag-and-continue split,
datahub-lineage-guard's HALT/QUARANTINE split) -- not a new design, a
reapplication of one that's already proven.

STATUS: skeleton. The actual ambiguity judgment -- is this request/step
clear or not -- is Module 1's real job per gate-system-build-plan.md
(an LLM single-pass call, consumes UserRequest v1, produces
RequirementChecklist v1). That call doesn't exist yet. This file defines
the shape everything else can be built and tested against, with the
judgment itself stubbed loudly (judge_ambiguity, below) rather than
faked with a heuristic that "looks right." An untested stub that returns
plausible answers is worse than one that fails loudly -- it can pass a
demo while proving nothing real. Same reasoning as datahub_client.py's
NotImplementedError stubs.

Design settled across conversation, for reference:
  - Manual toggle only. No automatic stakes-tier default -- that's a
    later enhancement if wanted, not built here.
  - Toggle ON, ambiguous: BOUNCE_BACK. Pause. Send the question back as
    its own turn. Do not proceed/commit until answered.
  - Toggle ON, not ambiguous: CLEAR. Proceeds immediately, no lag.
  - Toggle OFF, not ambiguous: CLEAR.
  - Toggle OFF, ambiguous: proceeds either way (OFF never blocks) --
    but see OFF_MODE_SURFACES_FLAG below, this half is a placeholder,
    not a final decision.
  - Two trigger paths are DESIGNED, not both BUILT. Manual/on-demand
    (user asks "check where we are" regardless of toggle state) is real
    today -- this is exactly how the test suite calls it. Automatic at
    intake (Module 1 running its own internal checks at the start of
    every turn) has no caller anywhere in this tree -- there is no
    turn-loop to call it from yet. Both are designed to call the same
    run_clarification_gate() below with no new logic required, but only
    one of the two callers currently exists.
  - This is NOT the same thing as "revert a turn" (undoing something
    already committed, noticed later) or "hold for approval" (nothing
    commits without explicit yes, every time). Those are different
    features and are not built here.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Optional


class ClarityResult(Enum):
    CLEAR = "clear"                      # proceeds normally, gate took no action
    BOUNCE_BACK = "bounce_back"          # gate ON, ambiguous -- pause, ask, wait
    FLAGGED_PROCEED = "flagged_proceed"  # gate OFF, ambiguous -- proceeds, but visibly marked


@dataclass
class ClarityCheck:
    """
    Result of running the clarification gate against a single
    request/step. `question` is populated only for BOUNCE_BACK -- the
    actual text to send back as its own turn. The caller MUST NOT
    proceed/commit on a BOUNCE_BACK result until that question has been
    answered and the check re-run.
    """
    result: ClarityResult
    reason: Optional[str] = None    # why it was judged ambiguous, if it was
    question: Optional[str] = None  # populated only when result == BOUNCE_BACK


@dataclass
class AmbiguityJudgment:
    """What judge_ambiguity() returns -- the raw judgment, before the
    toggle logic decides what to do with it."""
    is_ambiguous: bool
    reason: Optional[str] = None
    suggested_question: Optional[str] = None


# DECIDED. Keep True -- matches the fail-closed convention already set
# by datahub-lineage-guard's severity.py ("fail toward HALT, not
# QUARANTINE, same fail-closed principle as the rest of Cort3x"). Silent
# proceed-on-ambiguous would be the one place in the codebase that fails
# toward invisibility instead of visibility when unsure. Not a fresh
# guess -- this module matching a standard the rest of the project
# already committed to.
OFF_MODE_SURFACES_FLAG = True


def run_clarification_gate(request_or_step: str, gate_enabled: bool) -> ClarityCheck:
    """
    Entry point. Does NOT itself judge ambiguity -- delegates to
    judge_ambiguity() below (the real stub). This function only wires
    the toggle behavior around whatever that judgment returns:

      gate_enabled=False, not ambiguous -> CLEAR
      gate_enabled=False, ambiguous     -> FLAGGED_PROCEED
                                            (or CLEAR if OFF_MODE_SURFACES_FLAG
                                            is set False) -- never blocks
      gate_enabled=True,  not ambiguous -> CLEAR
      gate_enabled=True,  ambiguous     -> BOUNCE_BACK -- caller must not
                                            proceed/commit on this result

    (OFF_MODE_SURFACES_FLAG only matters on the gate_enabled=False,
    ambiguous=True row -- every other row returns before that flag is
    ever read.)
    """
    judgment = judge_ambiguity(request_or_step)

    if not judgment.is_ambiguous:
        return ClarityCheck(result=ClarityResult.CLEAR)

    if gate_enabled:
        return ClarityCheck(
            result=ClarityResult.BOUNCE_BACK,
            reason=judgment.reason,
            question=judgment.suggested_question,
        )

    if OFF_MODE_SURFACES_FLAG:
        return ClarityCheck(result=ClarityResult.FLAGGED_PROCEED, reason=judgment.reason)

    return ClarityCheck(result=ClarityResult.CLEAR, reason=judgment.reason)


def judge_ambiguity(request_or_step: str) -> AmbiguityJudgment:
    """
    STUB. This is Module 1's actual job per gate-system-build-plan.md --
    an LLM single-pass call, not built yet anywhere in this codebase.

    Day 1 task: replace this with a real call that actually inspects
    request_or_step -- Module 1's real implementation once it exists, or
    a direct LLM prompt if that's the faster path. Do not stub this with
    keyword-matching or a rule that returns plausible-looking answers on
    a few manual tests -- same reasoning as datahub_client.py: a stub
    that "looks right" is worse than one that loudly fails, because it
    can pass a demo while proving nothing real.

    Required of the real implementation, not yet applicable to this
    stub: it currently only fails one way (NotImplementedError, because
    it isn't built). Once it's a real LLM call, it gains a second,
    different failure mode -- the call exists and gets used, but errors
    at runtime (timeout, API failure, malformed response). Those are
    not the same situation and must not be handled the same way. A
    runtime judgment failure must resolve at least as safe as
    is_ambiguous=True, never silently as is_ambiguous=False.

    Rationale: OFF_MODE_SURFACES_FLAG above is locked True specifically
    because this project fails toward visibility when uncertain -- same
    reasoning as datahub-lineage-guard's HALT-over-QUARANTINE default.
    A failed judgment is a strictly higher-uncertainty case than
    "judged not ambiguous"; letting it collapse to CLEAR would mean the
    gate silently waves through exactly the requests it couldn't
    actually evaluate, while looking like it did -- worse than no gate
    at all, because it looks protected and isn't.

    Not implemented here because the real call's error surface doesn't
    exist yet to design against -- same reason the caller contract and
    input type are also left open (see README). This is the policy the
    implementation is expected to satisfy, decided in advance so it
    doesn't get decided by accident under deadline pressure once the
    real call exists.
    """
    raise NotImplementedError(
        "Day 1 task: wire this to Module 1's real ambiguity judgment "
        "(LLM single-pass call per gate-system-build-plan.md, Consumes "
        "UserRequest v1 / Produces RequirementChecklist v1). "
        "run_clarification_gate() above is fully built and tested against "
        "a mocked version of this function -- only this judgment itself "
        "is unbuilt."
    )
