"""
src/engine/node_builder.py

PART 1 FIX: create_node now threads parent_hash (the parent's hash_self)
into generate_self_hash, per the crypto_engine.py fix. hash_parent and
the parent_hash fed into the self-hash are the same value by
construction -- there is exactly one place a node learns its parent's
hash, so they can't drift apart.

NOT FIXED HERE (see PART 2): `timestamp` is still
`datetime.now(timezone.utc)` on the client. Making this server-assigned
requires the persistence layer to hand back an authoritative timestamp
*before* the hash is finalized, which means restructuring the
create-then-insert flow around a live DB round-trip. That can't be
built or verified without Postgres available, so it's deferred to
Part 2 rather than half-done here.

PART 1 FIX (Gemini review round 3, item 6): added an explicit payload
size guard. Previously there was no limit anywhere in the code or
schema -- an unbounded payload is a storage/memory/hash-compute DoS
vector, since every descendant verification re-hashes the full payload
and every read reconstructs it from BYTEA. This is a pure Python check
(measures the same canonical JSON encoding used for hashing) and is
fully testable offline -- see tests/test_payload_size_guard.py.
MAX_PAYLOAD_BYTES is a conservative default; tune per deployment.
"""
import json
import uuid
from datetime import datetime, timezone
from typing import Dict, Any, Optional
from src.engine.crypto_engine import generate_self_hash
from src.errors import PayloadTooLargeError

MAX_PAYLOAD_BYTES = 1_000_000  # 1 MB, conservative default -- tune per deployment


def create_node(payload: Dict[str, Any], parent_node: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    encoded = json.dumps(payload, sort_keys=True).encode()
    if len(encoded) > MAX_PAYLOAD_BYTES:
        raise PayloadTooLargeError(
            f"Payload is {len(encoded)} bytes, exceeding the "
            f"{MAX_PAYLOAD_BYTES}-byte limit."
        )
    version_index = (parent_node['version_index'] + 1) if parent_node else 0
    parent_id = parent_node['node_id'] if parent_node else None
    parent_hash = parent_node['hash_self'] if parent_node else None
    timestamp = datetime.now(timezone.utc).isoformat()
    node_id = str(uuid.uuid4())
    hash_self = generate_self_hash(payload, parent_id, parent_hash, version_index, timestamp)
    return {
        "node_id": node_id, "parent_id": parent_id, "version_index": version_index,
        "payload": payload, "hash_self": hash_self, "hash_parent": parent_hash,
        "status": "active", "created_at": timestamp
    }
