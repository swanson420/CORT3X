"""Clarification Gate engine.

Toggle-wiring logic only. Ambiguity judgment is intentionally stubbed
(Module 1's real job).
"""

from enum import Enum
from typing import Any, Optional


class GateOutcome(Enum):
    CLEAR = "clear"
    BOUNCE_BACK = "bounce_back"
    FLAGGED_PROCEED = "flagged_proceed"


# Locked decision: when the gate is OFF and input is ambiguous, still surface
# a flag rather than silent proceed. Matches the fail-closed convention used
# elsewhere in the codebase (datahub-lineage-guard, etc.).
OFF_MODE_SURFACES_FLAG = True


def judge_ambiguity(request_or_step: Any) -> bool:
    """Stub. Raises until Module 1 (LLM single-pass ambiguity judgment) is built.

    This is intentional -- do not replace with a keyword heuristic.
    """
    raise NotImplementedError(
        "judge_ambiguity is Module 1's responsibility and is not implemented here."
    )


def run_clarification_gate(request_or_step: Any, gate_enabled: bool) -> GateOutcome:
    """Run the clarification gate.

    Parameters
    ----------
    request_or_step :
        The user request or step under consideration.
    gate_enabled : bool
        Whether the gate toggle is currently ON.

    Returns
    -------
    GateOutcome
        CLEAR          - proceed
        BOUNCE_BACK    - pause and return a clarifying question (only when ON + ambiguous)
        FLAGGED_PROCEED - proceed but visibly flagged (only when OFF + ambiguous and OFF_MODE_SURFACES_FLAG)
    """
    # The real ambiguity judgment is deliberately not present.
    # Callers that need the real behavior must supply Module 1 first.
    try:
        is_ambiguous = judge_ambiguity(request_or_step)
    except NotImplementedError:
        # During the skeleton phase we still want the toggle wiring itself
        # to be testable. Tests inject a controlled is_ambiguous via a
        # test double or by catching this. Production path stays hard-fail.
        raise

    if gate_enabled:
        if is_ambiguous:
            return GateOutcome.BOUNCE_BACK
        return GateOutcome.CLEAR
    else:
        if is_ambiguous and OFF_MODE_SURFACES_FLAG:
            return GateOutcome.FLAGGED_PROCEED
        return GateOutcome.CLEAR
