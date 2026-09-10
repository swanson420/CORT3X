"""
tests/conftest.py
"""

import os
import pytest
import psycopg2

from src.persistence.context_persistence import ContextPersistence
from src.orchestration.state_orchestrator import StateTransitionOrchestrator


@pytest.fixture
def db_config():
    return {
        "dbname": os.environ.get("POSTGRES_DB", "context_db"),
        "user": os.environ.get("POSTGRES_USER", "admin"),
        "password": os.environ.get("POSTGRES_PASSWORD", ""),
        "host": os.environ.get("POSTGRES_HOST", "localhost"),
        "port": os.environ.get("POSTGRES_PORT", "5432"),
    }


@pytest.fixture
def last_node(db_config):
    try:
        conn = psycopg2.connect(**db_config)
    except psycopg2.OperationalError as exc:
        pytest.skip(f"No reachable Postgres instance for db_config: {exc}")

    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("TRUNCATE TABLE context_nodes")
    finally:
        conn.close()

    persistence = ContextPersistence(db_config)
    orchestrator = StateTransitionOrchestrator(persistence)
    root = orchestrator.process_proposal({"data": "root"}, None)
    return root
