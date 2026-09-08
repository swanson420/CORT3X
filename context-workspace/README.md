# Context Workspace

**Module 1 of Cort3x — guards against silent tampering with an agent's working memory.**

Context Workspace is a linear, append-only, cryptographically-linked state machine for an agent's working context. Every piece of context is built into a hash-chained, tamper-evident node structure — immutable once written. If anything is altered after the fact, the chain breaks and the system knows.

## Status

**43/43 tests passed** against live Postgres 16.

- Hash-chain integrity under concurrent writes
- Immutability enforcement (no updates/deletes after commit)
- Path-traversal and injection defenses on node keys
- Concurrency: multiple writers, serializable isolation, no lost updates
- Recompute-and-compare verification of stored claims against live state

## What it does

Every context node carries:
- Content hash
- Parent hash (previous node)
- Timestamp + sequence
- Optional signature

The workspace refuses to accept a node whose parent hash does not match the current tip, and refuses any mutation of an already-committed node. This is the foundation the other modules lean on when they need durable, auditable working memory.

## Running the tests

```bash
# Requires a live Postgres 16 instance with the schema applied
pytest tests/ -v
```

All 43 tests exercise the real database, not mocks. Concurrency tests use multiple sessions and explicit locking scenarios.

## Design notes

- Fail toward visibility: a broken chain is a hard error, not a silent recovery.
- Storage is Postgres-backed for durability and concurrent access; the logical model is a pure hash chain independent of the storage engine.
- This module is intentionally decoupled from the clarification gate and DataHub lineage guard so each can be verified in isolation before wiring.
