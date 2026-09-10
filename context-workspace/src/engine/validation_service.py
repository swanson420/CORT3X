from datetime import datetime, timezone
from typing import Dict, Any, Optional
from src.errors import (
    IntegrityError, HashMismatchError, LineageError, MonotonicityError,
    ImplausibleTimestampError,
)
from src.engine.crypto_engine import generate_self_hash

__all__ = [
    "IntegrityError", "HashMismatchError", "LineageError", "MonotonicityError",
    "ImplausibleTimestampError", "verify_lineage",
]

MAX_FUTURE_SKEW_SECONDS = 30


def verify_lineage(node: Dict[str, Any], parent_node: Optional[Dict[str, Any]]) -> bool:
    if parent_node is not None and parent_node['status'] != 'active':
        raise LineageError("Parent node must be 'active'.")
    if parent_node is not None and node['created_at'] <= parent_node['created_at']:
        raise MonotonicityError(
            "Child node's created_at does not strictly follow its "
            "parent's created_at -- clock moved backwards or was forged."
        )

    node_time = datetime.fromisoformat(node['created_at'])
    now = datetime.now(timezone.utc)
    skew = (node_time - now).total_seconds()
    if skew > MAX_FUTURE_SKEW_SECONDS:
        raise ImplausibleTimestampError(
            f"Node created_at ({node['created_at']}) is {skew:.0f}s ahead "
            f"of wall-clock time, exceeding the {MAX_FUTURE_SKEW_SECONDS}s "
            "allowance. Rejecting to prevent it becoming a poisoned tip "
            "that permanently locks out future proposals."
        )

    if parent_node is not None and node['hash_parent'] != parent_node['hash_self']:
        raise HashMismatchError("Hash mismatch: Lineage broken.")

    expected_hash = generate_self_hash(
        node['payload'],
        node['parent_id'],
        node['hash_parent'],
        node['version_index'],
        node['created_at'],
    )
    if node['hash_self'] != expected_hash:
        raise HashMismatchError(
            "Self-hash mismatch: node's hash_self does not match its own "
            "content (including its committed parent hash). Possible "
            "tampering or corruption."
        )

    return True
