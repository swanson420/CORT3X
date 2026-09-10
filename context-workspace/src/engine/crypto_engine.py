"""
src/engine/crypto_engine.py

PART 1 FIX (red-team finding #1): generate_self_hash previously hashed
{payload, parent_id, version_index, timestamp} -- parent_id is just a
UUID, not the parent's hash_self. That meant a node's own hash never
cryptographically committed to its parent's *content*, only to which
row it points at. Lineage integrity rested entirely on a separate check
(hash_parent == parent.hash_self) plus the DB trigger never allowing
in-place content mutation. If either of those were ever bypassed, a
node's self-hash would still validate against a parent whose content
had changed underneath it.

FIX: parent_hash is now a required input to generate_self_hash. Because
each node's hash_self recursively depends on its parent's hash_self
(which depends on *its* parent's hash_self, all the way to the root),
tampering with any ancestor's content -- even if hash_self on that row
is recomputed to be internally self-consistent -- breaks every
descendant's self-hash, not just the immediately-linked hash_parent
field. This makes the chain a real hash chain (Merkle-style linkage)
rather than a chain of independently-checkable single links.

This is a hash *format* change: existing hash_self values computed by
the old 4-field version will not match. Since nothing is deployed yet,
there is no migration to do -- but flag this loudly if that stops being
true.
"""
import hashlib
import json
from typing import Dict, Any, Optional


def generate_self_hash(payload: Dict[str, Any], parent_id: Optional[str],
                        parent_hash: Optional[str], version_index: int,
                        timestamp: str) -> str:
    data = {
        "payload": payload,
        "parent_id": parent_id,
        "parent_hash": parent_hash,
        "version_index": version_index,
        "timestamp": timestamp,
    }
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
