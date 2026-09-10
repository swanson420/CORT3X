"""
tests/test_known_gap_parent_hash_trust_boundary.py

UPDATE: the actual gap this test describes has been FIXED, at the
persistence layer -- see the CRITICAL fix in
src/persistence/context_persistence.py's insert_node() (implemented,
pending live verification against tests/test_parent_hash_cross_check.py)
and docs/PART2_DB_DEPENDENT_FIXES.md item 1.

This test's own assertion is UNCHANGED and still correctly passes,
because it exercises verify_lineage() in isolation, which the fix does
not touch and was never meant to. That's intentional, not a leftover:
verify_lineage() alone genuinely still cannot catch a forged parent
hash on its own -- it only compares whatever parent_node object the
caller supplies against itself, with nothing here verifying that object
came from real persisted state. The actual close happens one layer
down, in insert_node(), which cross-checks against the real stored
hash_self before ever archiving a parent -- and this test never calls
insert_node() at all, deliberately (see original rationale below).

So: this test still documents a REAL, permanent property of
verify_lineage() as a standalone function (it is not, and was never
meant to be, a complete trust boundary on its own) -- not an open gap
in the system as a whole. Two independent layers now guard this: the
application layer (verify_lineage(), cheap, catches naive attacks
before ever reaching the DB) and the persistence layer (insert_node(),
now cross-checks the real stored value). This test documents the first
layer's known, permanent limitation; it does not indicate the second
layer is missing.

Original rationale, unchanged below (kept for context on why this test
is shaped the way it is -- verify_lineage()-only, no live DB):

CRITICAL, CONFIRMED (Gemini review round 2, Finding 3, extended).
Documented here as a deliberately-failing-style test rather than just
prose, so this couldn't quietly get lost in a doc file while the actual
fix was still pending. The gap: insert_node() only checked that a given
parent_id was currently 'active' in the DB (via the archive-if-active
UPDATE). It never compared the incoming node's hash_parent against the
REAL stored hash_self of that row. verify_lineage() -- the only place
that comparison happened at all -- checked it against whatever
parent_node object the caller supplied, which nothing there verified
came from real persisted state.

This test proves the verify_lineage()-alone limitation using
verify_lineage() alone, since that's the part reachable without a live
DB. It intentionally does NOT prove the full end-to-end persistence-
layer exploit (that needed Postgres to verify for real, per this
project's own standard, and now does -- see
tests/test_parent_hash_cross_check.py) -- it proves the necessary
precondition: the application-layer gate alone can be satisfied with a
forged parent hash tied to a real, active parent_id.
"""
import unittest

from src.engine.node_builder import create_node
from src.engine.validation_service import verify_lineage


class TestKnownGapParentHashTrustBoundary(unittest.TestCase):
    def test_forged_parent_hash_self_is_not_caught_by_verify_lineage_alone(self):
        real_root = create_node({"data": "the real root"}, None)

        # Attacker knows the real, currently-active parent_id (ordinary
        # legitimate information -- e.g. from any prior read) but
        # forges the hash_self on the parent object they pass in.
        forged_parent = dict(real_root)
        forged_parent["hash_self"] = "totally-fabricated-hash-not-what-is-really-stored"

        malicious_child = create_node({"data": "attacker payload"}, forged_parent)

        # This is EXPECTED to still return True -- verify_lineage()
        # alone was never meant to be a complete trust boundary on its
        # own. The real check now lives in insert_node(); this
        # demonstrates specifically what verify_lineage() by itself
        # cannot catch, which is why insert_node() needed its own
        # independent check rather than relying on this layer alone.
        result = verify_lineage(malicious_child, forged_parent)

        self.assertTrue(
            result,
            "verify_lineage() alone is not, and was never meant to be, "
            "a complete trust boundary -- see insert_node() in "
            "context_persistence.py for the actual cross-check against "
            "real persisted state. If this assertion starts failing, "
            "something changed verify_lineage()'s own behavior -- "
            "check that change against this docstring before assuming "
            "it's progress.",
        )
        self.assertNotEqual(
            malicious_child["hash_parent"], real_root["hash_self"],
            "sanity check: confirms the forged child's hash_parent really "
            "does diverge from the true root's real hash_self -- this is "
            "exactly the corrupted value insert_node()'s new check now "
            "catches at the persistence layer.",
        )


if __name__ == "__main__":
    unittest.main()
