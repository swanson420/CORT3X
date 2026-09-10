import time
import unittest
from datetime import timedelta

from src.engine.node_builder import create_node
from src.engine.crypto_engine import generate_self_hash
from src.engine.validation_service import verify_lineage
from src.errors import HashMismatchError, MonotonicityError


class TestAncestorTamperDetection(unittest.TestCase):
    def test_mutated_and_self_consistently_rehashed_parent_is_caught(self):
        root = create_node({"data": "original"}, None)
        child = create_node({"data": "child"}, root)
        self.assertTrue(verify_lineage(child, root))
        tampered_root = dict(root)
        tampered_root["payload"] = {"data": "MUTATED-AFTER-THE-FACT"}
        tampered_root["hash_self"] = generate_self_hash(
            tampered_root["payload"],
            tampered_root["parent_id"],
            None,
            tampered_root["version_index"],
            tampered_root["created_at"],
        )
        with self.assertRaises(HashMismatchError):
            verify_lineage(child, tampered_root)

    def test_self_hash_changes_if_parent_hash_changes_even_with_identical_content(self):
        root_a = create_node({"data": "root"}, None)
        root_b = create_node({"data": "root"}, None)
        h1 = generate_self_hash({"x": 1}, "same-parent-id", root_a["hash_self"], 1, "2026-01-01T00:00:00")
        h2 = generate_self_hash({"x": 1}, "same-parent-id", root_b["hash_self"], 1, "2026-01-01T00:00:00")
        self.assertNotEqual(h1, h2)


class TestMonotonicity(unittest.TestCase):
    def test_normal_creation_order_passes(self):
        root = create_node({"data": "root"}, None)
        time.sleep(0.001)
        child = create_node({"data": "child"}, root)
        self.assertTrue(verify_lineage(child, root))

    def test_backdated_child_is_rejected(self):
        root = create_node({"data": "root"}, None)
        child = create_node({"data": "child"}, root)
        from datetime import datetime
        backdated = (datetime.fromisoformat(root["created_at"]) - timedelta(seconds=5)).isoformat()
        child["created_at"] = backdated
        child["hash_self"] = generate_self_hash(
            child["payload"], child["parent_id"], child["hash_parent"],
            child["version_index"], backdated,
        )
        with self.assertRaises(MonotonicityError):
            verify_lineage(child, root)


class TestErrorTaxonomy(unittest.TestCase):
    def test_hash_mismatch_is_not_a_monotonicity_error(self):
        root = create_node({"data": "root"}, None)
        child = create_node({"data": "child"}, root)
        child["hash_self"] = "forged"
        with self.assertRaises(HashMismatchError):
            verify_lineage(child, root)


if __name__ == "__main__":
    unittest.main()
