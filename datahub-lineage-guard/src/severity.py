"""
Maps a LineageDiff onto an action decision.
Reuses the same halt/quarantine split already proven in the
telemetry harness and context-workspace -- new source, same pattern.
"""

from enum import Enum
from lineage_comparator import LineageOutcome, LineageDiff


class Action(Enum):
    HALT = "halt"                # edges removed -- possible broken/tampered lineage
    QUARANTINE = "quarantine"    # edges added, or ambiguous -- flag, don't block
    CLEAR = "clear"              # confirmed match -- proceed


def decide_action(diff: LineageDiff) -> Action:
    if diff.outcome == LineageOutcome.EDGES_REMOVED:
        return Action.HALT
    if diff.outcome in (LineageOutcome.EDGES_ADDED, LineageOutcome.AMBIGUOUS):
        return Action.QUARANTINE
    return Action.CLEAR
