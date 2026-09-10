import json
import psycopg2
from psycopg2 import errors
from src.errors import ConcurrencyError, HashMismatchError


class ContextPersistence:
    def __init__(self, db_config: dict):
        self.conn_params = db_config

    def insert_node(self, node: dict):
        try:
            with psycopg2.connect(**self.conn_params) as conn:
                with conn.cursor() as cur:
                    if node['parent_id'] is not None:
                        cur.execute(
                            """
                            UPDATE context_nodes
                            SET status = 'archived'
                            WHERE node_id = %s AND status = 'active'
                            RETURNING node_id, hash_self
                            """,
                            (node['parent_id'],),
                        )
                        row = cur.fetchone()
                        if row is None:
                            raise ConcurrencyError(
                                f"Concurrency conflict: parent node {node['parent_id']} "
                                "is no longer active (already superseded or does not exist)."
                            )
                        _, real_parent_hash_self = row
                        if real_parent_hash_self != node['hash_parent']:
                            raise HashMismatchError(
                                f"Parent hash mismatch: node claims "
                                f"hash_parent={node['hash_parent']!r} but the "
                                f"real stored hash_self for parent "
                                f"{node['parent_id']} is "
                                f"{real_parent_hash_self!r}. Possible tampering."
                            )

                    cur.execute(
                        """
                        INSERT INTO context_nodes
                            (node_id, parent_id, version_index, hash_self, hash_parent,
                             raw_payload, status, created_at)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            node['node_id'],
                            node['parent_id'],
                            node['version_index'],
                            node['hash_self'],
                            node['hash_parent'],
                            json.dumps(node['payload'], sort_keys=True).encode(),
                            node['status'],
                            node['created_at'],
                        ),
                    )
        except errors.UniqueViolation:
            raise ConcurrencyError("Concurrency conflict: a sibling node already claimed this parent.")
        except errors.DeadlockDetected:
            raise ConcurrencyError("Deadlock detected during proposal; safe to retry.")

    @staticmethod
    def row_to_node(row) -> dict:
        (node_id, parent_id, version_index, hash_self, hash_parent,
         raw_payload, status, created_at) = row
        payload = json.loads(bytes(raw_payload).decode())
        return {
            "node_id": str(node_id),
            "parent_id": str(parent_id) if parent_id else None,
            "version_index": version_index,
            "payload": payload,
            "hash_self": hash_self,
            "hash_parent": hash_parent,
            "status": status,
            "created_at": created_at.isoformat() if hasattr(created_at, "isoformat") else created_at,
        }
