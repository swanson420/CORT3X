"""
tests/test_part1_round2_fixes.py

Verifies the two fixes from this round:
1. StateTransitionOrchestrator retries on ConcurrencyError instead of
   letting it bubble up unhandled (Gemini Doc 3/4, Vector 1).
2. verify_lineage rejects implausible future timestamps, closing the
   state-pinning liveness bug (Gemini Doc 3, Vector 2).

No live Postgres needed: persistence and resolver are mocked here so
the *orchestration logic* itself -- the retry loop, the re-fetch, the
give-up-after-max-retries behavior -- is exercised directly.
"""
import unittest
from datetime import datetime, timedelta, timezone

from src.engine.node_builder import create_node
from src.engine.validation_service import verify_lineage
from src.errors import ConcurrencyError, ImplausibleTimestampError, MonotonicityError
from src.orchestration.state_orchestrator import StateTransitionOrchestrator


class FakePersistence:
    """Raises ConcurrencyError on insert_node for the first `fail_times`
    calls, then succeeds and records the accepted node."""

    def __init__(self, fail_times=0):
        self.fail_times = fail_times
        self.calls = 0
        self.accepted = None

    def insert_node(self, node):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise ConcurrencyError("simulated race: a sibling claimed this parent")
        self.accepted = node


class FakeResolver:
    """Returns a pre-set sequence of 'current tip' nodes, one per call,
    simulating the tip advancing underneath a retrying caller."""

    def __init__(self, tips):
        self.tips = list(tips)
        self.calls = 0

    def get_latest_active_node(self):
        self.calls += 1
        if not self.tips:
            raise RuntimeError("No active state.")
        return self.tips.pop(0)


class TestOrchestratorRetry(unittest.TestCase):
    def test_no_retry_needed_behaves_as_before(self):
        persistence = FakePersistence(fail_times=0)
        orch = StateTransitionOrchestrator(persistence)  # no resolver at all
        root = orch.process_proposal({"data": "root"}, None)
        self.assertEqual(persistence.calls, 1)
        self.assertIs(persistence.accepted, root)

    def test_without_resolver_raises_immediately_on_first_conflict(self):
        # Backward-compat: no resolver injected means no way to know the
        # new tip, so the old "raise immediately" behavior is preserved.
        persistence = FakePersistence(fail_times=1)
        orch = StateTransitionOrchestrator(persistence)  # resolver=None
        with self.assertRaises(ConcurrencyError):
            orch.process_proposal({"data": "root"}, None)
        self.assertEqual(persistence.calls, 1)

    def test_retries_and_succeeds_against_new_tip(self):
        real_root = create_node({"data": "root"}, None)
        # Simulate: two competitors race in and successfully claim the
        # tip before we finally win on our third attempt.
        competitor_1 = create_node({"data": "competitor-1"}, real_root)
        competitor_2 = create_node({"data": "competitor-2"}, competitor_1)

        persistence = FakePersistence(fail_times=2)
        resolver = FakeResolver(tips=[competitor_1, competitor_2])
        orch = StateTransitionOrchestrator(persistence, resolver=resolver, max_retries=3, sleep_fn=lambda s: None)

        result = orch.process_proposal({"data": "my-proposal"}, real_root)

        self.assertEqual(persistence.calls, 3)
        self.assertEqual(resolver.calls, 2)
        # Final accepted node must be built against the LATEST tip, not
        # the stale one we started with.
        self.assertEqual(result["parent_id"], competitor_2["node_id"])
        self.assertEqual(result["hash_parent"], competitor_2["hash_self"])
        self.assertIs(persistence.accepted, result)

    def test_gives_up_after_max_retries(self):
        real_root = create_node({"data": "root"}, None)
        # Persistence always fails -- competitor keeps winning forever.
        persistence = FakePersistence(fail_times=999)
        # Resolver has "enough" tips to hand back for every retry attempt.
        tips = [create_node({"data": f"c{i}"}, real_root) for i in range(10)]
        resolver = FakeResolver(tips=tips)
        orch = StateTransitionOrchestrator(persistence, resolver=resolver, max_retries=2, sleep_fn=lambda s: None)

        with self.assertRaises(ConcurrencyError):
            orch.process_proposal({"data": "my-proposal"}, real_root)
        # 1 initial attempt + 2 retries = 3 total insert attempts
        self.assertEqual(persistence.calls, 3)

    def test_transient_no_active_state_is_retried_within_budget(self):
        real_root = create_node({"data": "root"}, None)
        competitor = create_node({"data": "competitor"}, real_root)
        persistence = FakePersistence(fail_times=1)
        # First resolver call hits the transient "no active row yet"
        # window (finding #7); second call succeeds.
        resolver = FakeResolver(tips=[])
        resolver.tips = []  # force RuntimeError on first pop via empty list
        orch = StateTransitionOrchestrator(persistence, resolver=resolver, max_retries=3, sleep_fn=lambda s: None)

        # Manually simulate transient-then-success by monkeypatching
        # get_latest_active_node with a small stateful function.
        call_count = {"n": 0}

        def flaky_get_latest():
            call_count["n"] += 1
            if call_count["n"] < 2:
                raise RuntimeError("No active state.")
            return competitor

        resolver.get_latest_active_node = flaky_get_latest

        result = orch.process_proposal({"data": "my-proposal"}, real_root)
        self.assertEqual(result["parent_id"], competitor["node_id"])
        self.assertGreaterEqual(call_count["n"], 2)

    def test_backoff_grows_exponentially_and_respects_cap(self):
        recorded_delays = []
        persistence = FakePersistence(fail_times=999)
        real_root = create_node({"data": "root"}, None)
        tips = [create_node({"data": f"c{i}"}, real_root) for i in range(10)]
        resolver = FakeResolver(tips=tips)
        orch = StateTransitionOrchestrator(
            persistence, resolver=resolver, max_retries=4,
            base_backoff_seconds=0.1, max_backoff_seconds=1.0,
            sleep_fn=lambda s: recorded_delays.append(s),
            jitter_fn=lambda lo, hi: hi,  # deterministic: always return the cap itself
        )
        with self.assertRaises(ConcurrencyError):
            orch.process_proposal({"data": "x"}, real_root)

        # attempt 1 -> cap = 0.1 * 2**0 = 0.1
        # attempt 2 -> cap = 0.1 * 2**1 = 0.2
        # attempt 3 -> cap = 0.1 * 2**2 = 0.4
        # attempt 4 -> cap = 0.1 * 2**3 = 0.8
        self.assertEqual(recorded_delays, [0.1, 0.2, 0.4, 0.8])

    def test_backoff_respects_max_cap(self):
        recorded_delays = []
        persistence = FakePersistence(fail_times=999)
        real_root = create_node({"data": "root"}, None)
        tips = [create_node({"data": f"c{i}"}, real_root) for i in range(10)]
        resolver = FakeResolver(tips=tips)
        orch = StateTransitionOrchestrator(
            persistence, resolver=resolver, max_retries=6,
            base_backoff_seconds=0.5, max_backoff_seconds=1.0,
            sleep_fn=lambda s: recorded_delays.append(s),
            jitter_fn=lambda lo, hi: hi,
        )
        with self.assertRaises(ConcurrencyError):
            orch.process_proposal({"data": "x"}, real_root)
        # would grow past 1.0 uncapped by attempt 3+; must be clamped
        self.assertTrue(all(d <= 1.0 for d in recorded_delays))
        self.assertIn(1.0, recorded_delays)


class TestFutureTimestampBound(unittest.TestCase):
    def test_normal_node_passes(self):
        root = create_node({"data": "root"}, None)
        self.assertTrue(verify_lineage(root, None))

    def test_root_with_implausible_future_timestamp_rejected(self):
        root = create_node({"data": "root"}, None)
        future = (datetime.now(timezone.utc) + timedelta(days=365 * 70)).isoformat()  # ~year 2099
        root["created_at"] = future
        from src.engine.crypto_engine import generate_self_hash
        root["hash_self"] = generate_self_hash(
            root["payload"], root["parent_id"], root["hash_parent"],
            root["version_index"], future,
        )
        with self.assertRaises(ImplausibleTimestampError):
            verify_lineage(root, None)

    def test_child_with_implausible_future_timestamp_rejected(self):
        root = create_node({"data": "root"}, None)
        child = create_node({"data": "child"}, root)
        future = (datetime.now(timezone.utc) + timedelta(days=365 * 70)).isoformat()
        child["created_at"] = future
        from src.engine.crypto_engine import generate_self_hash
        child["hash_self"] = generate_self_hash(
            child["payload"], child["parent_id"], child["hash_parent"],
            child["version_index"], future,
        )
        with self.assertRaises(ImplausibleTimestampError):
            verify_lineage(child, root)

    def test_small_clock_skew_within_allowance_passes(self):
        # A few seconds of clock skew between distributed callers should
        # not be treated as an attack.
        root = create_node({"data": "root"}, None)
        near_future = (datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat()
        from src.engine.crypto_engine import generate_self_hash
        root["created_at"] = near_future
        root["hash_self"] = generate_self_hash(
            root["payload"], root["parent_id"], root["hash_parent"],
            root["version_index"], near_future,
        )
        self.assertTrue(verify_lineage(root, None))

    def test_near_bound_timestamp_still_locks_out_honest_client(self):
        # Gemini review round 2, Finding 1, confirmed by direct execution:
        # shrinking the allowance narrows the window, it does not close
        # it. A node dated just under the (now 30s) bound is still
        # accepted, still becomes the tip, and an honest client
        # proposing moments later with a real timestamp still fails
        # monotonicity. This test exists to make sure nobody mistakes
        # the shrunk bound for a fix later.
        from src.engine.crypto_engine import generate_self_hash

        root = create_node({"data": "root"}, None)
        poisoned = create_node({"data": "attacker"}, root)
        near_max_future = (datetime.now(timezone.utc) + timedelta(seconds=29)).isoformat()
        poisoned["created_at"] = near_max_future
        poisoned["hash_self"] = generate_self_hash(
            poisoned["payload"], poisoned["parent_id"], poisoned["hash_parent"],
            poisoned["version_index"], near_max_future,
        )
        self.assertTrue(verify_lineage(poisoned, root), "poisoned near-bound node should still be accepted")

        honest_child = create_node({"data": "honest user data"}, poisoned)
        with self.assertRaises(MonotonicityError):
            verify_lineage(honest_child, poisoned)


if __name__ == "__main__":
    unittest.main()
