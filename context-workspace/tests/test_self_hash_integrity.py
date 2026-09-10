import unittest
from src.engine.node_builder import create_node
from src.engine.validation_service import verify_lineage
from src.errors import IntegrityError


class TestSelfHashIntegrity(unittest.TestCase):
    def test_legitimate_root_node_passes(self):
        root = create_node({"data": "root"}, None)
        self.assertTrue(verify_lineage(root, None))

    def test_legitimate_child_node_passes(self):
        root = create_node({"data": "root"}, None)
        child = create_node({"data": "child"}, root)
        self.assertTrue(verify_lineage(child, root))

    def test_forged_self_hash_on_root_is_rejected(self):
        root = create_node({"data": "root"}, None)
        root['hash_self'] = 'forged_hash_value'
        with self.assertRaises(IntegrityError):
            verify_lineage(root, None)

    def test_forged_self_hash_on_child_is_rejected(self):
        root = create_node({"data": "root"}, None)
        child = create_node({"data": "child"}, root)
        child['hash_self'] = 'forged_hash_value'
        with self.assertRaises(IntegrityError):
            verify_lineage(child, root)

    def test_tampered_payload_with_stale_hash_is_rejected(self):
        root = create_node({"data": "root"}, None)
        root['payload'] = {"data": "TAMPERED"}
        with self.assertRaises(IntegrityError):
            verify_lineage(root, None)


if __name__ == '__main__':
    unittest.main()
