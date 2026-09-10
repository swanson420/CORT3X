# Fixes applied to context-workspace

This is context-workspace's first review pass — STATUS.md previously had
all 14 files at ❓ (read once, zero findings issued, nothing verified).
Two real bugs were found and fixed this pass. Verified where execution
was actually possible in this environment (pure-Python logic, via
`unittest` since `pytest` could not be installed offline); NOT verified
against a live Postgres, since no Docker/Postgres was available in this
sandbox (no network access to pull images). That distinction is kept
explicit throughout, per this project's own standing rule: a static
read proves the code says the right thing, not that it does the right
thing.

## 1. db/schema.sql + src/persistence/context_persistence.py —
   the archive/immutability contradiction

**Before:** `protect_immutable_nodes()` fired on every `UPDATE OR DELETE`
and raised unconditionally, with no exception for any kind of change.
Separately, `state_resolver.py`'s `get_latest_active_node()` assumed
exactly one row has `status = 'active'` at a time, and nothing in any
provided file ever set a node's status to `'archived'`.

**Problem, confirmed by direct search, not by eye:** grepping every
provided file for `archived` being *set* (not just checked) turned up
nothing — it appears exactly once, in the `CHECK` constraint. Combined
with the trigger blocking all updates unconditionally, it was
*structurally impossible* for any node to ever become `'archived'`.
Every node ever created stays `'active'` forever. `get_latest_active_node()`
runs `SELECT ... WHERE status = 'active' LIMIT 1` with no `ORDER BY` —
once more than one row is `'active'` (i.e., after the very first child
node is proposed), Postgres makes no guarantee which row `LIMIT 1`
returns. "Latest active node" was not actually resolving to the latest
node.

**Fix:**
- `protect_immutable_nodes()` now permits exactly one thing: a status
  transition from `'active'` to `'archived'`, with every other column
  required to stay identical (checked via `IS DISTINCT FROM` against
  `OLD`). Any other `UPDATE`, and `DELETE` in all cases, still raises
  exactly as before.
- `context_persistence.py`'s `insert_node()` now archives the parent
  node in the **same transaction** as the child insert, so there's
  never a window with zero or two active rows. The actual race between
  two concurrent proposals against the same parent is still decided by
  the pre-existing `parent_id UNIQUE` constraint — this fix doesn't
  touch that.
- `state_resolver.py`'s query now has `ORDER BY version_index DESC,
  created_at DESC` — kept as defense-in-depth even though the fix above
  should guarantee a single active row.

**Verified:** by direct source read and grep, confirming the original
absence of any archive-setting code. NOT verified by running the
trigger against a live Postgres instance — this sandbox has no
Docker/network access. The SQL was checked for structural balance
(matching `IF`/`END IF` counts, dollar-quote pairs) but that is not a
substitute for an actual `psql` run.

## 2. docker-compose.yml + main.py — missing connection config

**Before:** `docker-compose.yml` set no `POSTGRES_PASSWORD` or
`POSTGRES_HOST_AUTH_METHOD`. `main.py`'s `db_config` had only `dbname`
and `user` — no `host`, `port`, or `password`.

**Problem:** the official `postgres` Docker image refuses to
initialize without `POSTGRES_PASSWORD` or `POSTGRES_HOST_AUTH_METHOD`
set — this is documented, well-known image behavior, not something
inspectable from this repo's files alone. Separately, even if the
container did start, `psycopg2.connect(dbname=..., user=...)` with no
`host` falls back to local peer/socket auth, which cannot reach a
container over TCP regardless.

**Fix:** `docker-compose.yml` now requires `POSTGRES_PASSWORD` via a
`.env` file or exported shell variable (never hardcoded). `main.py` now
reads `host`, `port`, and `password` from environment variables with
sane local defaults.

**Verified:** NOT run — no Docker available in this sandbox. This is a
well-documented requirement of the official Postgres image, not a
guess, but it's still an unexecuted claim by this project's own
standard and should be logged as such until someone actually runs
`docker compose up` against it.

## 3. tests/conftest.py — did not exist, added

`test_concurrency.py` references `db_config` and `last_node` as pytest
fixtures. No `conftest.py` was ever provided with the original files —
meaning this test could not be run by anyone, in any environment, as
delivered. A minimal `conftest.py` was written to supply both fixtures.

**This file is new, not part of the original delivery, and NOT verified
by execution** — same constraint as above, no live Postgres available
here. Running `pytest tests/test_concurrency.py` against the
docker-compose instance is the actual next verification step.

## What was checked and found sound (no fix needed)

- `crypto_engine.py`, `node_builder.py`, `validation_service.py` — the
  hash-chain and lineage-verification logic. Confirmed by actually
  running (`python3 -m unittest tests.test_engine`, since `pytest`
  could not be installed offline) — both tests pass.
- The `parent_id UNIQUE` constraint enforcing a strictly linear
  history (no branching) — this is a design property, not a bug. Worth
  knowing about if branching is ever wanted, but not something this
  pass changed.

## Known gap, not fixed, flagged for awareness

`crypto_engine.py`'s `generate_self_hash()` binds a node's hash to its
parent's **ID**, not the parent's **hash**. In a system where updates
were possible this would be a real integrity gap — swapping a parent's
content wouldn't change any child's hash. In practice this isn't
currently exploitable, because the immutability trigger blocks content
mutation entirely (item 1 above only ever permits a status-only
change). Not fixed here since doing so would change the hash format
itself and wasn't required to close either bug found this pass — noted
so it doesn't get silently forgotten.

## Not yet done

- No live Postgres run of any of this. Every fix above is confirmed
  correct by source read, grep, and (for the pure-Python pieces) actual
  test execution — not by running the schema or the archiving logic
  against a real database. That is the next real verification step for
  this module, matching the same standard already applied to
  security-infra.
- `test_concurrency.py` still cannot be confirmed to behave as claimed
  (`success == 1, collision == 1`) until it's actually run.
