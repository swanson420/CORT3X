"""
src/orchestration/state_orchestrator.py

Retry-on-ConcurrencyError logic with exponential backoff + jitter.
"""
import random
import time

from src.engine.node_builder import create_node
from src.engine.validation_service import verify_lineage
from src.errors import IntegrityError, ConcurrencyError

__all__ = ["StateTransitionOrchestrator", "IntegrityError", "ConcurrencyError"]


class StateTransitionOrchestrator:
    def __init__(self, persistence, resolver=None, max_retries=3,
                 base_backoff_seconds=0.05, max_backoff_seconds=2.0,
                 sleep_fn=time.sleep, jitter_fn=random.uniform):
        self.persistence = persistence
        self.resolver = resolver
        self.max_retries = max_retries
        self.base_backoff_seconds = base_backoff_seconds
        self.max_backoff_seconds = max_backoff_seconds
        self.sleep_fn = sleep_fn
        self.jitter_fn = jitter_fn

    def process_proposal(self, payload, last_node):
        parent = last_node
        attempts = 0
        while True:
            new_node = create_node(payload, parent)
            verify_lineage(new_node, parent)
            try:
                self.persistence.insert_node(new_node)
                return new_node
            except ConcurrencyError:
                attempts += 1
                if self.resolver is None or attempts > self.max_retries:
                    raise
                self._backoff(attempts)
                parent = self._refetch_tip_with_retry()

    def _backoff(self, attempt):
        cap = min(self.max_backoff_seconds, self.base_backoff_seconds * (2 ** (attempt - 1)))
        delay = self.jitter_fn(0, cap)
        self.sleep_fn(delay)

    def _refetch_tip_with_retry(self):
        last_exc = None
        for _ in range(self.max_retries):
            try:
                return self.resolver.get_latest_active_node()
            except RuntimeError as exc:
                last_exc = exc
        raise last_exc
