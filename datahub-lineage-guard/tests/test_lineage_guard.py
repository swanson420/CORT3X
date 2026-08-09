"""
Hermetic: no real MCP session, no real network call, no dependency on
a running DataHub instance. DataHubMCPClient is never instantiated with
a real session here -- get_lineage() results and failures are injected
directly as fixtures. This proves comparator/severity/writeback logic
is correct in isolation; it does NOT prove the real MCP integration
works against a live instance. That's a separate, non-hermetic check
you still need to run once against Docker (scripts/verify_mcp_contract.py)
before trusting this end-to-end.
"""

import sys
import os
import pytest

# Allow running `pytest tests/ -v` from the project root without
# needing this installed as a package.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from lineage_comparator import compare_lineage, LineageOutcome
from severity import decide_action, Action
from mcp_client import DataHubUnreachableError, DataHubMCPClient
from writeback import flag_entity_in_datahub


# ---- Comparator: deterministic diff outcomes ----

def test_removed_edge_triggers_halt():
    """Expected upstream dependency missing from actual result -> HALT."""
    expected = {"urn:li:dataset:(platform,upstream_a,PROD)"}
    actual = {"upstream": []}  # injected: the dependency is simply gone
    diff = compare_lineage("urn:li:dataset:(platform,target,PROD)", expected, actual)
    assert diff.outcome == LineageOutcome.EDGES_REMOVED
    assert decide_action(diff) == Action.HALT


def test_added_edge_triggers_quarantine_not_halt():
    """Unexpected new upstream edge present -> QUARANTINE, explicitly NOT halt.
    This is the case a naive flat-diff would get wrong -- it would collapse
    this into the same bucket as a removal."""
    expected = {"urn:li:dataset:(platform,upstream_a,PROD)"}
    actual = {"upstream": [
        {"urn": "urn:li:dataset:(platform,upstream_a,PROD)"},
        {"urn": "urn:li:dataset:(platform,new_unexpected,PROD)"},
    ]}
    diff = compare_lineage("urn:li:dataset:(platform,target,PROD)", expected, actual)
    assert diff.outcome == LineageOutcome.EDGES_ADDED
    assert decide_action(diff) == Action.QUARANTINE


def test_removal_dominates_when_both_present():
    """If an edge is removed AND a different edge is added in the same
    check, removal must win the severity classification -- confirms the
    'removed dominates' rule from the comparator isn't just documented,
    it's enforced."""
    expected = {"urn:li:dataset:(platform,upstream_a,PROD)"}
    actual = {"upstream": [
        {"urn": "urn:li:dataset:(platform,unexpected_new,PROD)"}
        # upstream_a is gone, unexpected_new appeared -- both at once
    ]}
    diff = compare_lineage("urn:li:dataset:(platform,target,PROD)", expected, actual)
    assert diff.outcome == LineageOutcome.EDGES_REMOVED
    assert decide_action(diff) == Action.HALT
    assert diff.removed == ["urn:li:dataset:(platform,upstream_a,PROD)"]
    assert diff.added == ["urn:li:dataset:(platform,unexpected_new,PROD)"]


def test_malformed_result_is_ambiguous_not_halt():
    """Injected malformed/empty response (e.g. sync lag, not tampering)
    must NOT escalate to HALT -- that's the exact false-alarm failure
    mode a conflated tamper/concurrency taxonomy would produce."""
    expected = {"urn:li:dataset:(platform,upstream_a,PROD)"}
    actual = {}  # injected: no "upstream" key at all
    diff = compare_lineage("urn:li:dataset:(platform,target,PROD)", expected, actual)
    assert diff.outcome == LineageOutcome.AMBIGUOUS
    assert decide_action(diff) == Action.QUARANTINE


def test_clean_match_clears():
    expected = {"urn:li:dataset:(platform,upstream_a,PROD)"}
    actual = {"upstream": [{"urn": "urn:li:dataset:(platform,upstream_a,PROD)"}]}
    diff = compare_lineage("urn:li:dataset:(platform,target,PROD)", expected, actual)
    assert diff.outcome == LineageOutcome.MATCH
    assert decide_action(diff) == Action.CLEAR


# ---- Failure injection: connection layer isolation ----

class _FailingSession:
    """Hermetic stand-in for a real MCP session that always fails --
    injects a transport-level failure without touching any network."""
    def call_tool(self, name, arguments):
        raise ConnectionRefusedError("simulated: MCP server unreachable")


def test_unreachable_server_raises_isolated_error_not_a_finding():
    """Core isolation guarantee: a connection failure must surface as
    DataHubUnreachableError, never get mistaken for a lineage result of
    any kind. This is the test that would catch someone accidentally
    letting a transport exception leak through as if it were data."""
    client = DataHubMCPClient(_FailingSession())
    with pytest.raises(DataHubUnreachableError):
        client.get_lineage("urn:li:dataset:(platform,target,PROD)")


# ---- Full pipeline wiring test (hermetic end-to-end through the logic) ----

def test_full_pipeline_removed_edge_flows_to_halt_and_writeback_attempted():
    """Wires mcp_client -> comparator -> severity -> writeback together
    with an injected result, confirming the whole chain behaves as one
    unit -- not just each piece in isolation."""

    class _InjectedSession:
        def call_tool(self, name, arguments):
            if name == "get_lineage":
                return {"upstream": []}  # injected: dependency missing
            if name == "add_tag":
                return {"status": "ok"}
            raise AssertionError(f"unexpected tool call in test: {name}")

    client = DataHubMCPClient(_InjectedSession())
    raw = client.get_lineage("urn:li:dataset:(platform,target,PROD)")
    diff = compare_lineage(
        "urn:li:dataset:(platform,target,PROD)",
        {"urn:li:dataset:(platform,upstream_a,PROD)"},
        raw,
    )
    action = decide_action(diff)
    assert action == Action.HALT

    wrote_back = flag_entity_in_datahub(client, diff.entity_urn, diff.detail)
    assert wrote_back is True


def test_writeback_failure_does_not_escalate_the_halt_decision():
    """Injected write-back failure must not change or suppress the HALT
    finding that already stood on its own -- confirms the 'best-effort
    enrichment, not a dependency' contract actually holds."""

    class _WritebackFailsSession:
        def call_tool(self, name, arguments):
            if name == "get_lineage":
                return {"upstream": []}
            if name == "add_tag":
                raise RuntimeError("simulated: write-back rejected")
            raise AssertionError(f"unexpected tool call: {name}")

    client = DataHubMCPClient(_WritebackFailsSession())
    raw = client.get_lineage("urn:li:dataset:(platform,target,PROD)")
    diff = compare_lineage(
        "urn:li:dataset:(platform,target,PROD)",
        {"urn:li:dataset:(platform,upstream_a,PROD)"},
        raw,
    )
    assert decide_action(diff) == Action.HALT  # unaffected by writeback outcome

    wrote_back = flag_entity_in_datahub(client, diff.entity_urn, diff.detail)
    assert wrote_back is False  # writeback failure surfaces here, doesn't cascade
