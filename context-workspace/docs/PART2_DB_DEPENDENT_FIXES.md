# Part 2 — DB-dependent fixes (proposed, NOT verified)

## Resolved in Part 1 (round 2) -- no longer here

Two items originally flagged by Gemini's review of state_orchestrator.py/
context_persistence.py were pure application logic, not DB-dependent, so
they moved to Part 1 and are DONE + tested (see tests/test_part1_round2_fixes.py):

- **Orchestrator retry on ConcurrencyError** (was unhandled, an easy
  application-layer DoS surface) -- `StateTransitionOrchestrator` now
  retries against the re-fetched tip, bounded by `max_retries`.
- **Future-timestamp sanity bound** (state-pinning liveness bug) --
  `verify_lineage` now rejects any node whose `created_at` is more than
  `MAX_FUTURE_SKEW_SECONDS` ahead of wall-clock, applied to roots too.
  This is a mitigation, not the full fix -- see item 2 below, which is
  still the only thing that fully closes the client-clock issue.

Note on provenance: a separate review pass (same zip, different LLM,
different turn) also flagged a JSON-key-order/BYTEA-round-trip hash
mismatch and a raw-SQL-construction/SQLi claim. Both were checked
against the actual code and don't hold: `generate_self_hash` calls
`json.dumps(..., sort_keys=True)`, which normalizes key order
recursively (verified empirically, not just by reading the function),
and every query in `context_persistence.py` uses parameterized `%s`
placeholders, never string-built SQL. Neither is in this list.

## Round 2 (Gemini): two more resolved in Part 1, one escalated

- **Retry backoff+jitter** (Finding 2) -- DONE. Exponential backoff with
  full jitter added to the orchestrator retry loop, injectable
  `sleep_fn`/`jitter_fn` for offline testing. See
  `test_backoff_grows_exponentially_and_respects_cap` and
  `test_backoff_respects_max_cap`.
- **Future-timestamp window shrunk 300s -> 30s** (Finding 1) -- DONE,
  but explicitly a *mitigation*, not a fix. Confirmed by direct
  execution that a near-bound timestamp (e.g. +29s under the new 30s
  cap) still locks out honest clients until it naturally elapses -- see
  `test_near_bound_timestamp_still_locks_out_honest_client`. No value of
  the allowance closes this while still tolerating real clock skew; item
  2 below (server-assigned timestamps) is the only real fix.
- **Parent-hash trust boundary** (Finding 3) -- ESCALATED from
  "hardening" to CRITICAL, see item 1 below. Confirmed exploitable via
  the documented `process_proposal()` API path, not just a theoretical
  future-code concern. A deliberately-failing test documents this so it
  can't get lost: `tests/test_known_gap_parent_hash_trust_boundary.py`.
  UPDATE: this item is now implemented (pending live verification) --
  see item 1 for the full fix and safety analysis.

Everything below requires a live Postgres instance to implement safely
and to test. This sandbox has no network access and no psycopg2/Postgres
available, so none of this has been executed. Treat every item as a
design proposal to review, not a merged fix, until it's actually run
against a real database per this project's own "verified by execution"
standard.

## 1. [CRITICAL] Real hash cross-check before archive (finding #4, was "hardening" -- escalated) -- IMPLEMENTED, PENDING LIVE VERIFICATION

STATUS: code written and syntax-checked in
`src/persistence/context_persistence.py`'s `insert_node()`. Test suite
written in `tests/test_parent_hash_cross_check.py`. **Neither has been
run against a live Postgres instance.** Per this project's own
standard, do not consider this item CLOSED until that test file
actually passes for real -- "implemented" here means "the diff exists
and is believed correct," not "verified."

`insert_node()` used to only check that a given `parent_id` is
currently `'active'` in the DB (the archive-if-active UPDATE). It never
compared the incoming node's `hash_parent` against the REAL stored
`hash_self` of that row -- it just wrote whatever `hash_parent` value
was on the node, verbatim. `verify_lineage()` was the only place that
comparison happened at all, and it checked the caller-supplied
`parent_node` object against itself, not against real persisted state.

Concrete consequence (proven, see
`tests/test_known_gap_parent_hash_trust_boundary.py`): a caller that
knows a real, currently-active `parent_id` but supplies a forged
`hash_self` on that parent object got past `verify_lineage()` cleanly
-- both forged values were self-consistent with each other, neither was
checked against the DB. If that reached `insert_node()`, the archive
succeeded (the `parent_id` really was active) and a permanently wrong
`hash_parent` would land in the audit trail with nothing to catch it.
This was integrity corruption reachable through the documented API, not
a theoretical future-code concern.

### The fix as implemented

No separate `SELECT ... FOR UPDATE` was needed -- the existing archive
`UPDATE`'s `WHERE status = 'active'` clause already acquires the row
lock as part of doing its job. Widened its `RETURNING` clause from
`RETURNING node_id` to `RETURNING node_id, hash_self`, and added, in
Python, after the existing `row is None` check (which MUST run first --
see the inline comment in the code; getting this order backwards turns
a clean `ConcurrencyError` into a raw `TypeError` for an ordinary
race-loser):

```sql
UPDATE context_nodes
SET status = 'archived'
WHERE node_id = %s AND status = 'active'
RETURNING node_id, hash_self
```
```python
if real_parent_hash_self != node['hash_parent']:
    raise HashMismatchError(...)
```

Reused the existing `HashMismatchError` class rather than inventing a
new one -- same violation category `validation_service.py` already uses
that name for, just caught at a different layer. Also added
`except errors.DeadlockDetected: raise ConcurrencyError(...)` alongside
the existing `UniqueViolation` handler, as defense-in-depth (see safety
analysis below for why this branch is believed unreachable given the
current design, and what would have to change to make it reachable).

### Safety analysis (reasoned through explicitly before implementing, not just asserted)

**Does this risk leaving zero active nodes** (archive succeeds, insert
never lands)? No -- prevented by the pre-existing single-transaction
structure. The archive `UPDATE` and the child `INSERT` already share
one `with conn:` block; any raise after the archive (including the new
`HashMismatchError`) rolls back the WHOLE transaction, including the
archive. The parent reverts to `active` on rollback. **Constraint to
preserve if this code is ever touched again:** no intermediate commit
may be introduced between the hash check, the archive, and the insert
-- all three must stay inside one transaction, always. This isn't a new
guarantee the fix adds; it's a pre-existing one the fix depends on not
being broken later.

**Does this introduce deadlock risk** via lock ordering? No, by
construction: each `insert_node()` call locks exactly ONE existing row
(the direct parent). A classic Postgres deadlock needs a cycle -- two
transactions each holding a lock the other wants, on two different
resources. Two writers on the same parent just queue behind each other
on that one lock (no cycle possible with single-resource contention);
two writers on different parents never touch each other's rows at all.
**Constraint to preserve:** the fix must never lock more than one
existing row per call (no future expansion to also touch a grandparent,
or scan a range) -- that's what keeps the `DeadlockDetected` handler
above a defensive no-op rather than something that actually fires.

**Can this produce false tamper alarms during ordinary concurrent
traffic** (an honest race-loser getting `HashMismatchError` instead of
a clean, retryable `ConcurrencyError`)? No -- proven impossible, not
just unlikely. `hash_self` is immutable from the moment a row is
created (the immutability trigger blocks every column update except
`status`), so a race-winner's `hash_parent` -- built from any honest
prior read of that row, whenever that read happened -- is guaranteed to
still match the real stored `hash_self` at archive time, because that
value never moves. Race-losers hit `row is None` (their `UPDATE`
matched zero rows) and raise `ConcurrencyError` BEFORE the hash
comparison is even reached -- structurally unreachable for that path,
not just "usually correct." The only way to actually reach
`HashMismatchError` is a `hash_parent` that was never derived from a
real, previously-persisted node -- i.e., genuine forgery, exactly
`tests/test_known_gap_parent_hash_trust_boundary.py`'s scenario, not
anything ordinary concurrent traffic can produce.

### Also fixed alongside this (small, related)

`tests/test_concurrency.py` had no synchronization forcing its two
threads to actually collide at the DB -- `t1.start(); t2.start()` with
no barrier meant the test's assertions could pass identically whether
the threads truly raced, or whether one fully completed before the
other even started (a much weaker property than what the test claims to
prove -- a false "all green"). Added `threading.Barrier(2)`; both
threads now wait on it immediately before calling `process_proposal`.
Doesn't guarantee true nanosecond simultaneity, but eliminates the
degenerate full-serialization case. This matters specifically for this
item because `test_concurrency.py` running WITH the barrier, against
live Postgres, is the first real evidence (not just analysis) that the
true-simultaneous-write serialization claims above actually hold.

## 2. Server-assigned timestamp (finding #2, completes the Part 1 partial fix)

Part 1 added a monotonicity check (child.created_at > parent.created_at)
but the timestamp is still client-generated and fed into the hash before
the row is ever written. Closing this fully means the hash can't be
finalized until the DB has assigned an authoritative timestamp, which
means restructuring `insert_node()`:

```python
# Proposed shape -- NOT tested against live Postgres:
def insert_node(self, node: dict):
    with psycopg2.connect(**self.conn_params) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT clock_timestamp()")
            server_ts = cur.fetchone()[0].isoformat()
            node['created_at'] = server_ts
            node['hash_self'] = generate_self_hash(
                node['payload'], node['parent_id'], node['hash_parent'],
                node['version_index'], server_ts,
            )
            # ...archive parent + insert child as before, using server_ts
```

This moves hash finalization out of `node_builder.create_node()` (pure,
DB-free) and into the persistence layer (DB-required), which is a real
architectural shift, not a one-line patch. Needs a transaction-isolation
check too: `clock_timestamp()` vs `now()` behave differently inside a
transaction and the choice matters here.

## 3. Constraint-specific error mapping (finding #6)

`except errors.UniqueViolation` currently collapses three distinct
constraints (`parent_id` UNIQUE, `idx_single_root`, `idx_single_active_node`)
into one message. Proposed:

```python
except errors.UniqueViolation as e:
    constraint = e.diag.constraint_name
    if constraint == 'idx_single_root':
        raise LineageError("A root node already exists; cannot create a second root.")
    elif constraint == 'idx_single_active_node':
        raise ConcurrencyError("Another node is already active; archive it first.")
    else:
        raise ConcurrencyError("Concurrency conflict: a sibling node already claimed this parent.")
```

Needs live Postgres because `e.diag.constraint_name` behavior and the
exact constraint names on conflict can only be confirmed by actually
triggering each of the three constraints.

(Row-level locking before archive is now folded into item 1 above --
the CRITICAL hash cross-check -- since the same `SELECT ... FOR UPDATE`
serves both purposes.)

## 4. Retry/backoff for `get_latest_active_node()` (finding #7)

No retry logic exists for the brief window where the old active row has
been archived but the new one isn't committed yet. Proposed: bounded
retry with backoff, or an advisory lock (`pg_advisory_xact_lock`) held
across the archive+insert in `insert_node()` so resolvers never observe
zero active rows. Needs load testing to pick sane retry/backoff numbers.

## 5. Run `test_concurrency.py` for real -- now with a real barrier

This is the actual gate for everything above, item 1 especially. The
file previously had a plausible-looking `success == 1, collision == 1`
assertion that could pass identically whether the two threads actually
raced at the DB or whether one fully completed before the other even
started -- a false "all green" (see: Distributed Concurrency Test
Systems / Production-Equivalent Chaos Harness Verification finding,
folded into item 1's writeup above). Fixed: `threading.Barrier(2)` now
forces both threads to begin their DB work at the same instant Python's
threading can guarantee, before either calls `process_proposal`.

Also gates on: `tests/test_parent_hash_cross_check.py` (new), which
proves item 1's fix end-to-end, including the empirical
parent-stays-`'active'`-after-rejection proof that the zero-active-
nodes stress-test scenario doesn't occur in practice, not just in
theory.

Nothing in this doc should be considered done until both files actually
run green against a live Postgres instance (`docker compose up` or
equivalent, e.g. Railway).

## Round 3 (Gemini): mostly confirms existing tracked items, two more resolved

This pass ("Red-team analysis of the Part-1-fixed context-workspace")
was thorough and accurate -- every numbered item either matched an
already-tracked issue (client-clock hash, TOCTOU/parent re-check,
zero-active-node window, coarse UniqueViolation mapping -- all
already items 1-4 below) or was a genuinely new, checkable observation:

- **Payload size guard** (item 6 in that review) -- DONE. No limit
  existed anywhere; added `MAX_PAYLOAD_BYTES` (1MB default) checked in
  `create_node` before hashing. Pure Python, tested offline --
  `tests/test_payload_size_guard.py`.
- **raw_payload storage now matches hash serialization** (item 6,
  second half) -- DONE. Confirmed by grep that storage previously used
  plain `json.dumps(payload)` while the hash used `sort_keys=True`;
  functionally harmless (hash is computed from the deserialized dict,
  not the raw bytes) but an inconsistency for anyone auditing at the
  byte level. Both now use `sort_keys=True`.
- **test_concurrency.py assertion specificity** (item 9) -- fixed as a
  text-only edit (now catches `ConcurrencyError` instead of the base
  `IntegrityError`, so a real `HashMismatchError`/`LineageError` bug
  can't get silently miscounted as ordinary collision behavior). This
  file still cannot be executed in this sandbox -- the correctness of
  the edit itself is unverified until it's actually run against live
  Postgres.
- **Redundant `parent_id` in the hash alongside `parent_hash`** (item
  5) -- reviewed, agree it's true and reasonably called "not
  exploitable... but unnecessary" by the review itself. Deliberately
  NOT changed unilaterally: this would be a second hash-format change,
  and per this project's own practice (resolve design questions with
  explicit rationale before implementing, don't just do it), that's a
  call for you to make, not a change to slip in as if it were an
  obvious bugfix. Options if you want it: (a) drop `parent_id` from the
  hash inputs entirely and rely on `parent_hash` alone for content
  binding (`parent_id` stays as a DB column/FK, just leaves the hash
  formula), or (b) leave as-is since the current form isn't wrong, just
  slightly redundant.
- **Connection pooling / statement timeouts / no schema size limit /
  no audit event log / bootstrap API for root** -- all real, all
  legitimate production-hardening items, all deferred (need live
  Postgres or are genuinely lower priority than the CRITICAL item
  above). Not added as new numbered items since they're standard
  "harden before production" work, not exploitable gaps.
