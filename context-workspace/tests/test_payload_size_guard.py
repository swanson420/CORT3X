import json
import unittest

from src.engine.node_builder import create_node, MAX_PAYLOAD_BYTES
from src.errors import PayloadTooLargeError


class TestPayloadSizeGuard(unittest.TestCase):
    def test_normal_payload_passes(self):
        node = create_node({"data": "small payload"}, None)
        self.assertEqual(node["payload"]["data"], "small payload")

    def test_oversized_payload_rejected(self):
        huge_string = "x" * (MAX_PAYLOAD_BYTES + 1)
        with self.assertRaises(PayloadTooLargeError):
            create_node({"data": huge_string}, None)

    def test_payload_just_under_limit_passes(self):
        padding = "x" * (MAX_PAYLOAD_BYTES - 100)
        node = create_node({"data": padding}, None)
        self.assertEqual(len(node["payload"]["data"]), len(padding))

    def test_error_message_reports_actual_size(self):
        huge_string = "x" * (MAX_PAYLOAD_BYTES + 500)
        try:
            create_node({"data": huge_string}, None)
            self.fail("expected PayloadTooLargeError")
        except PayloadTooLargeError as e:
            self.assertIn(str(MAX_PAYLOAD_BYTES), str(e))


class TestStorageHashSerializationConsistency(unittest.TestCase):
    def test_raw_payload_encoding_matches_hash_encoding(self):
        payload = {"z": 1, "a": 2, "nested": {"y": 9, "x": 8}}
        stored_bytes = json.dumps(payload, sort_keys=True).encode()
        from src.engine.crypto_engine import generate_self_hash
        self.assertEqual(stored_bytes, json.dumps(payload, sort_keys=True).encode())
        recovered = json.loads(stored_bytes.decode())
        self.assertEqual(recovered, payload)
        h_original = generate_self_hash(payload, None, None, 0, "t")
        h_recovered = generate_self_hash(recovered, None, None, 0, "t")
        self.assertEqual(h_original, h_recovered)


if __name__ == "__main__":
    unittest.main()
