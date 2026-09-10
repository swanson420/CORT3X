"""
src/orchestration/state_resolver.py
"""

import psycopg2
from src.persistence.context_persistence import ContextPersistence


class StateResolver:
    def __init__(self, persistence: ContextPersistence):
        self.persistence = persistence

    def get_latest_active_node(self) -> dict:
        with psycopg2.connect(**self.persistence.conn_params) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT node_id, parent_id, version_index, hash_self, hash_parent,
                           raw_payload, status, created_at
                    FROM context_nodes
                    WHERE status = 'active'
                    ORDER BY version_index DESC, created_at DESC
                    LIMIT 1
                    """
                )
                row = cur.fetchone()
                if not row:
                    raise RuntimeError("No active state.")
                return ContextPersistence.row_to_node(row)
