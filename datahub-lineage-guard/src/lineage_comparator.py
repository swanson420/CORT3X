"""
Deterministic semantic diff of expected vs. actual lineage edges.
Deterministic = same input always produces the same diff, regardless
of set/dict iteration order -- sorted output, no reliance on
insertion order or hash-seed-dependent set iteration.

Governance principle: an ADDED edge and a REMOVED edge are different
findings, not the same "mismatch". Removal is the higher-severity
signal (something the target used to depend on is gone -- could be
broken lineage or tampering). Addition is lower-severity by default
(could be legitimate, unrecorded pipeline evolution) but still
worth surfacing, never silently absorbed.

CONFIRM AGAINST LIVE INSTANCE before trusting: the real response-shape
keys in _extract_upstream_urns(). Run scripts/verify_mcp_contract.py
to resolve this -- do not assume "upstream" / "urn" are the real keys
until confirmed against a live get_lineage call.
"""

from dataclasses import dataclass, field
from enum import Enum


class LineageOutcome(Enum):
    MATCH = "match"
    EDGES_REMOVED = "edges_removed"      # higher severity -- HALT territory
    EDGES_ADDED = "edges_added"          # lower severity -- QUARANTINE territory
    AMBIGUOUS = "ambiguous"              # malformed/empty result


@dataclass
class LineageDiff:
    outcome: LineageOutcome
    entity_urn: str
    removed: list = field(default_factory=list)   # expected but not present now
    added: list = field(default_factory=list)      # present now but not expected
    detail: str = ""


def compare_lineage(entity_urn: str, expected_upstream_urns: set,
                     actual_lineage_result: dict) -> LineageDiff:
    """
    expected_upstream_urns: the set of URNs this entity SHOULD depend on,
        per whatever declares expected state for the demo (config, a
        known-good snapshot, etc.)
    actual_lineage_result: raw dict returned by DataHubMCPClient.get_lineage()
    """
    actual_urns = _extract_upstream_urns(actual_lineage_result)

    if actual_urns is None:
        # Result came back malformed/empty -- not proof of tampering,
        # could just be sync lag. Ambiguous, not a hard failure.
        return LineageDiff(
            outcome=LineageOutcome.AMBIGUOUS,
            entity_urn=entity_urn,
            detail="Lineage result empty or malformed -- possible sync lag, not confirmed tampering.",
        )

    # Deterministic: sort before storing, never leave diff output at the
    # mercy of set iteration order between runs.
    removed = sorted(expected_upstream_urns - actual_urns)
    added = sorted(actual_urns - expected_upstream_urns)

    if not removed and not added:
        return LineageDiff(outcome=LineageOutcome.MATCH, entity_urn=entity_urn,
                            detail="Lineage matches expected state exactly.")

    if removed:
        # Removal present -- classify as the higher-severity outcome even
        # if additions are also present. A missing dependency is the
        # dominant signal; don't let a simultaneous addition dilute it.
        return LineageDiff(
            outcome=LineageOutcome.EDGES_REMOVED,
            entity_urn=entity_urn,
            removed=removed,
            added=added,
            detail=f"{len(removed)} expected upstream edge(s) missing: {removed}",
        )

    return LineageDiff(
        outcome=LineageOutcome.EDGES_ADDED,
        entity_urn=entity_urn,
        added=added,
        detail=f"{len(added)} unexpected upstream edge(s) present: {added}",
    )


def _extract_upstream_urns(raw_result: dict):
    """Pull the set of upstream entity URNs out of the raw MCP response shape.
    NOTE: exact key names depend on the real response shape from your
    running instance -- confirm against one real call before trusting this."""
    if not raw_result or "upstream" not in raw_result:
        return None
    return {edge.get("urn") for edge in raw_result["upstream"] if edge.get("urn")}
