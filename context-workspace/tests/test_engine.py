import unittest
from src.engine.node_builder import create_node
from src.engine.validation_service import verify_lineage, IntegrityError


class TestContextEngine(unittest.TestCase):
    def test_node_linkage(self):
        root = create_node({"data": "root"}, None)
        child = create_node({"data": "child"}, root)
        self.assertTrue(verify_lineage(child, root))

    def test_broken_lineage(self):
        root = create_node({"data": "root"}, None)
        fake_parent = root.copy()
        fake_parent['hash_self'] = 'deadbeef'
        child = create_node({"data": "child"}, fake_parent)
        with self.assertRaises(IntegrityError):
            verify_lineage(child, root)
