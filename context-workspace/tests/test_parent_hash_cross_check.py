"""
tests/test_parent_hash_cross_check.py

Proves the CRITICAL fix in context_persistence.py's insert_node()
actually works end-to-end against a real database -- not just by
reading the code, per this project's own standard.

Most of these tests need `db_config`/`last_node` (from conftest.py) and
are skipped, not faked, if no Postgres is reachable -- same convention
as test_concurrency.py. The deadlock-mapping test is the one exception:
it's written to need no live DB at all (fully mocked), though it still
can't run in a sandbox where psycopg2 itself isn't installed, since
that's a dependency of the module under test regardless of whether a
real connection is ever opened.
"""
import uuid
import pytest
import psycopg2

from src.engine.node_builder import create_node
from src.engine.crypto_engine import generate_self_hash
from src.persistence.context_persistence import ContextPersistence
from src.errors import ConcurrencyError, HashMismatchError


def test_valid_proposal_succeeds(db_config, last_node):
    persistence = ContextPersistence(db_config)
    child = create_node({"data": "legitimate child"}, last_node)

    persistence.insert_node(child)  # must not raise

    with psycopg2.connect(**db_config) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT status FROM context_nodes WHERE node_id = %s",
                (last_node["node_id"],),
            )
            (parent_status,) = cur.fetchone()
            cur.execute(
                "SELECT status FROM context_nodes WHERE node_id = %s",
                (child["node_id"],),
            )
            (child_status,) = cur.fetchone()
    assert parent_status == "archived"
    assert child_status == "active"


def test_forged_hash_parent_raises_and_leaves_parent_active(db_config, last_node):
    # Deliberately bypass verify_lineage() and call insert_node()
    # directly -- the whole point of this test is proving the
    # PERSISTENCE layer's own independent check catches this, not the
    # application layer (which already catches a differently-shaped
    # version of this attack via its own hash_parent-link comparison,
    # see validation_service.py -- calling this through the orchestrator
    # would test that check instead of the one this test exists for).
    forged_hash = "totally-fabricated-hash-not-what-is-really-stored"
    child = create_node({"data": "attacker payload"}, last_node)
    child["hash_parent"] = forged_hash
    child["hash_self"] = generate_self_hash(
        child["payload"], child["parent_id"], forged_hash,
        child["version_index"], child["created_at"],
    )

    persistence = ContextPersistence(db_config)
    with pytest.raises(HashMismatchError):
        persistence.insert_node(child)

    # THE key empirical proof (not an inference from reading the code):
    # the archive attempt must have been rolled back along with the
    # rejected insert. If this ever reads 'archived', the system would
    # have zero active nodes despite the child never landing -- exactly
    # the failure mode flagged and stress-tested before this was built.
    with psycopg2.connect(**db_config) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT status FROM context_nodes WHERE node_id = %s",
                (last_node["node_id"],),
            )
            (parent_status,) = cur.fetchone()
    assert parent_status == "active"

    # And the forged child must not have landed either.
    with psycopg2.connect(**db_config) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM context_nodes WHERE node_id = %s",
                (child["node_id"],),
            )
            (count,) = cur.fetchone()
    assert count == 0


def test_nonexistent_parent_still_raises_concurrency_error(db_config, last_node):
    # Regression check: unchanged existing behavior for a parent_id that
    # was never inserted at all (as opposed to one that exists but is
    # archived -- both hit the same `row is None` branch).
    fake_parent = dict(last_node)
    fake_parent["node_id"] = str(uuid.uuid4())
    child = create_node({"data": "orphan"}, fake_parent)

    persistence = ContextPersistence(db_config)
    with pytest.raises(ConcurrencyError):
        persistence.insert_node(child)


def test_archived_parent_still_raises_concurrency_error(db_config, last_node):
    # Regression check: a parent that exists but is already archived
    # (as opposed to never having existed) -- must also raise
    # ConcurrencyError, and specifically NOT HashMismatchError, since
    # this path shouldn't even reach the hash comparison (row is None
    # for this WHERE clause since status != 'active').
    persistence = ContextPersistence(db_config)
    first_child = create_node({"data": "first"}, last_node)
    persistence.insert_node(first_child)  # archives last_node for real

    second_child = create_node({"data": "second, against the now-stale parent"}, last_node)
    with pytest.raises(ConcurrencyError):
        persistence.insert_node(second_child)


def test_deadlock_detected_maps_to_concurrency_error():
    """Doesn't need a live DB connection at all -- mocks psycopg2.connect
    so the archive UPDATE raises DeadlockDetected directly, since
    reliably forcing a REAL deadlock against this system's single-row-
    lock design is expected to be difficult (that difficulty is the
    point of the design -- see the deadlock-freedom analysis in
    docs/PART2_DB_DEPENDENT_FIXES.md item 1). Still requires psycopg2 to
    be importable, since that's a dependency of the module under test
    regardless of whether a real connection is ever opened -- so this
    still can't run in a sandbox where psycopg2 itself isn't installed."""
    from unittest.mock import MagicMock, patch
    from psycopg2 import errors as pg_errors

    root = create_node({"data": "root"}, None)
    child = create_node({"data": "child"}, root)

    mock_conn = MagicMock()
    mock_conn.__enter__.return_value = mock_conn
    mock_cur = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_cur.execute.side_effect = pg_errors.DeadlockDetected("simulated deadlock")

    persistence = ContextPersistence(
        {"dbname": "x", "user": "x", "password": "x", "host": "x", "port": "5432"}
    )
    with patch("psycopg2.connect", return_value=mock_conn):
        with pytest.raises(ConcurrencyError):
            persistence.insert_node(child)


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
