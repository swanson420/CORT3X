"""
main.py
"""

import os

from src.persistence.context_persistence import ContextPersistence
from src.orchestration.state_orchestrator import StateTransitionOrchestrator
from src.orchestration.state_resolver import StateResolver


def assemble_pipeline():
    db_config = {
        "dbname": os.environ.get("POSTGRES_DB", "context_db"),
        "user": os.environ.get("POSTGRES_USER", "admin"),
        "password": os.environ.get("POSTGRES_PASSWORD", ""),
        "host": os.environ.get("POSTGRES_HOST", "localhost"),
        "port": os.environ.get("POSTGRES_PORT", "5432"),
    }
    persistence = ContextPersistence(db_config)
    resolver = StateResolver(persistence)
    orchestrator = StateTransitionOrchestrator(persistence, resolver=resolver)
    return orchestrator, resolver
