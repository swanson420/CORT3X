import unittest
from unittest.mock import patch

from src.engine.node_builder import create_node
from src.engine.validation_service import verify_lineage
from src.errors import LineageError, MonotonicityError, HashMismatchError


class TestParentNoneVsEmptyDict(unittest.TestCase):
    def test_empty_dict_parent_no_longer_silently_bypasses_checks(self):
        root = create_node({"data": "root"}, None)
        child = create_node({"data": "child"}, root)
        with self.assertRaises(KeyError):
            verify_lineage(child, {})

    def test_none_parent_still_means_legitimate_root(self):
        root = create_node({"data": "root"}, None)
        self.assertTrue(verify_lineage(root, None))


class TestCheapChecksHoistedBeforeExpensiveHash(unittest.TestCase):
    def test_generate_self_hash_not_called_when_parent_status_check_fails_first(self):
        root = create_node({"data": "root"}, None)
        inactive_parent = dict(root)
        inactive_parent["status"] = "archived"
        child = create_node({"data": "child"}, root)
        with patch("src.engine.validation_service.generate_self_hash", wraps=None) as mocked:
            mocked.side_effect = AssertionError("should not be called")
            with self.assertRaises(LineageError):
                verify_lineage(child, inactive_parent)
            mocked.assert_not_called()

    def test_generate_self_hash_not_called_when_monotonicity_check_fails_first(self):
        root = create_node({"data": "root"}, None)
        child = create_node({"data": "child"}, root)
        child["created_at"] = root["created_at"]
        with patch("src.engine.validation_service.generate_self_hash") as mocked:
            mocked.side_effect = AssertionError("should not be called")
            with self.assertRaises(MonotonicityError):
                verify_lineage(child, root)
            mocked.assert_not_called()

    def test_generate_self_hash_not_called_when_hash_parent_link_check_fails_first(self):
        root = create_node({"data": "root"}, None)
        child = create_node({"data": "child"}, root)
        child["hash_parent"] = "forged-link-value"
        with patch("src.engine.validation_service.generate_self_hash") as mocked:
            mocked.side_effect = AssertionError("should not be called")
            with self.assertRaises(HashMismatchError):
                verify_lineage(child, root)
            mocked.assert_not_called()

    def test_expensive_hash_still_runs_and_still_catches_pure_tamper_case(self):
        root = create_node({"data": "root"}, None)
        child = create_node({"data": "child"}, root)
        child["hash_self"] = "forged-self-hash"
        with self.assertRaises(HashMismatchError):
            verify_lineage(child, root)

    def test_valid_node_still_passes_and_hash_is_computed_exactly_once(self):
        root = create_node({"data": "root"}, None)
        child = create_node({"data": "child"}, root)
        from src.engine.crypto_engine import generate_self_hash as real_fn
        with patch("src.engine.validation_service.generate_self_hash", wraps=real_fn) as mocked:
            self.assertTrue(verify_lineage(child, root))
            mocked.assert_called_once()


if __name__ == "__main__":
    unittest.main()
