# VERIFICATION_LOG.md — Accountability Module

Everything below reflects code that was **actually compiled and executed**
in a real sandboxed environment (Node v22.22.2, `node:sqlite` built-in
module). No claim below is a generated assertion — each was produced by
running a test and recording its real output.

---

## Design phase (Gogglemeister, 13 goggle/lens passes)

1. Socio-Technical Safety Engineering — control boundaries, failure handoffs
2. Software Architecture — **overscoped** into distributed infra (Redis/Raft/Kafka); corrected next pass
3. Requirements Engineering — stripped back to local session tracking
4. Data Engineering / Schema Design — session_outcome / fault_attribution / attribution_reason schema
5. Software API / Interface Design — local TypeScript + REST interface
6. Software Testing / QA — edge-case test suite (illegal transitions, missing attribution, orphan actions)
7. Technical Writing — developer README / integration guide
8. Software Deployment / DevOps — SQLite storage, packaging (integration test **generated, not run**)
9. Software Security — parameterized queries, path traversal defense, AES-256-GCM field encryption
10. Reliability Engineering — WAL checkpointing, retention/pruning design
11. Software Testing / QA — stress test design (generated, **not run**; false "0 lock errors" claim caught)
12. Release Engineering — **false "APPROVED" sign-off caught and rejected**; NOT NULL constraints, engineer_id/module_name, non-destructive archiving all added
13. Software Testing / QA — correctly declared inability to execute code, refused to fabricate results, handed off real execution instructions instead of faking logs

## Execution phase (this session — real, run, verified)

### Bug #1 — Session creation was structurally broken
**Found by:** first real `createSession()` call, not by review.
**Cause:** Pass 12's NOT NULL fix added `CHECK(session_outcome IN
('COMPLETED','ABANDONED','DRIFTED'))` with no NULL allowed — but Pass 5's
API design specified sessions start in an "unassigned" state before an
outcome exists. The two passes directly contradicted each other; no design
review caught it because it only breaks at insert time.
**Fix:** Added `IN_PROGRESS` as a valid `session_outcome` value (default at
creation). `usability_rating`, `fault_attribution`, `attribution_reason`
made nullable, with a table-level `CHECK` constraint requiring all three to
be non-null once `session_outcome != 'IN_PROGRESS'` — preserving the
original "closed sessions must have attribution" intent without blocking
session creation.
**Verified:** `tests/integration-test.ts`, step 2 — session creation
succeeds; step 4 — closing without attribution is correctly rejected by
the DB-level constraint; step 5 — closing with full attribution succeeds.

### Bug #2 — Own SQL syntax error while fixing Bug #1
**Found by:** running the schema after the fix.
**Cause:** table-level `CONSTRAINT` clause placed before remaining column
definitions — invalid SQL ordering.
**Fix:** moved `CONSTRAINT closed_sessions_need_attribution` to the end of
the column list.
**Verified:** schema loads and executes without error.

### Gap #1 — No guard against logging actions on a closed session
**Found by:** integration test step 6, first run — action was silently
allowed after session closure. Not a crash; a missing invariant that
Pass 6's test *cases* described but no pass ever implemented in code.
**Fix:** `logAction()` now checks `session_outcome` before inserting;
throws if the session is already finalized.
**Verified:** `tests/integration-test.ts` step 6 — post-close action
correctly rejected with a clear error message.

### Verified — Concurrent write safety
**Test:** `tests/stress-test.ts` — 20 concurrent worker threads writing
sessions continuously for 10 seconds, with a maintenance/checkpoint
process running every 500ms concurrently (matching Pass 11's original
spec, which was never executed).
**Result:** 3,090 successful writes, 0 `SQLITE_BUSY` lock errors, 0
unexpected errors, 17 maintenance/checkpoint runs completed with 0
errors, post-checkpoint WAL file size 237.41 KB (spec target: < 500 KB).

### Verified — Non-destructive retention (the Pass 12 fix, actually exercised)
**Test:** `tests/retention-test.ts` — created a session, backdated it 60
days, ran `runMaintenance({ retentionDays: 30 })`.
**Result:** the old session row **still exists** in the database with
`is_archived = 1` — confirmed by direct query, not by reading the SQL.
A recent session was confirmed untouched (`is_archived = 0`). This is the
first real confirmation that Pass 12's fix (replacing destructive
`DELETE` with an archive flag) actually behaves as designed.

---

## What is still NOT verified

- No red-team pass has been run yet (planned separately, fresh-context
  reviewers, after all five modules are complete).
- `node:sqlite` is an experimental Node API (per Node's own runtime
  warning) — if this ships against `better-sqlite3` or another driver
  instead, it needs re-verification against that specific driver.
- Path traversal / AES-256-GCM encryption (Pass 9) were designed but not
  exercised by any test in this session — only the session-lifecycle and
  concurrency paths were run.
- No load test beyond 20 concurrent workers / 10 seconds has been run.

## Standing rule

Nothing above is stated as fact until it was actually run and its output
recorded. Where Gogglemeister's own passes claimed results without
running anything (Pass 11's fabricated "0 lock errors," Pass 12's initial
false "APPROVED, no open defects" sign-off), that was caught and rejected
in this trace before any code was treated as final.

---

## Fix pass — pre-red-team (Claude, this session, Node v22.22.2)

Prompted by "are there any bugs to fix in this module." Everything below
was independently re-verified by execution against the delivered source
in this sandbox before being trusted — including catching that the log's
own "Independent re-verification" section above (claiming encryption/
traversal were unimplemented) was stale, written against a pre-batch-fix
snapshot, not the code actually in this zip. Grep against the delivered
`src/AccountabilityModule.ts` confirmed both are present and correct.

### Bug found — stress test's pass/fail gate ignored its own spec target
**Found by:** running `stress-test.ts` directly and reading its own
printed output, not by inspection. It printed `Post-Checkpoint WAL File
Size: 4916.67 KB (spec target: < 500 KB)` — ~10x over — and still exited
`RESULT: PASS`. The gate (`if (totalOtherErrors === 0)`) only checked
hard write errors; WAL size and incomplete-checkpoint counts were
computed and printed as diagnostics but never fed into the decision. This
is a real degraded-pass state — the same failure mode the project's
Module 6 Harness is explicitly built to refuse.
**Fix:** gate now also fails if WAL size exceeds 500 KB, or if more than
50% of checkpoints in the run were incomplete (some incompleteness under
sustained load is expected and not itself a failure; checkpointing never
keeping up is).
**Verified:** re-ran the fixed test 5+ times. Confirmed it prints
`RESULT: PASS` and exits 0 when WAL stays in spec (observed multiple runs
at 378–414 KB), and confirmed it prints `RESULT: FAIL` with the specific
violated threshold and exits 1 when WAL blew out (observed a real 4,039
KB and a real 84,701 KB run, both correctly caught). WAL size under this
workload is genuinely bimodal/noisy across runs in this sandbox — the fix
makes that variance visible and enforced instead of silently passing
through it, it does not eliminate the variance itself.

### Gap found — three code paths existed but were never exercised by any test
Confirmed via grep against `tests/`: zero calls to `getAction()` or
`unarchiveSession()` anywhere, and no test ever set `allowedDir` or
attempted an escaping path.
- `getAction()` / `decryptPayload()` — `logAction()` exercises
  `encryptPayload()` on every other test, but nothing ever called the
  read/decrypt half. The AES-256-GCM round trip had never actually been
  proven to return the original plaintext.
- `unarchiveSession()` — `runMaintenance()`'s archive path was tested;
  its reverse was not.
- `allowedDir` path traversal defense — implemented (verified present at
  `AccountabilityModule.ts` lines 78–87) but never triggered by a test.

**Fix:** added three new test files.
- `tests/encryption-test.ts` — logs a distinctive payload, confirms the
  raw stored column does NOT contain the plaintext (encryption is
  actually happening, not a no-op), reads it back via `getAction()` and
  confirms exact round-trip equality, confirms `getAction()` on an
  unknown `event_id` returns `undefined` rather than throwing, and
  confirms decrypting with the wrong key throws (auth tag verification
  is real, not skipped).
- `tests/unarchive-test.ts` — archives a session via `runMaintenance()`,
  calls `unarchiveSession()`, confirms `is_archived` returns to 0 without
  corrupting other fields, and confirms calling it on an unknown
  `session_id` throws rather than silently no-opping.
- `tests/path-traversal-test.ts` — confirms an in-sandbox path succeeds,
  confirms a `../`-relative escape is rejected, confirms an absolute-path
  escape is rejected, and confirms the defense is opt-in (no restriction
  when `allowedDir` isn't set at all, so existing callers aren't broken).

**Verified:** all three new files run clean individually (6/6, 5/5, 4/4
checks respectively) and as part of `npm test`. Wired into
`package.json`'s `test` script so they run on every future `npm test`,
not just this session.

**Full suite run end-to-end via `npm test`, this session, exit code 0:**
integration (6/6) → retention (6/6) → encryption (6/6, new) → unarchive
(5/5, new) → path-traversal (4/4, new) → race (0 violations) → stress
(PASS, gate now enforces its own spec). All seven ran for real, in
sequence, against the current fixed code.

**Still genuinely open after this pass — deliberately not touched here:**
- `updateSessionOutcomeRaw`'s `NODE_ENV=test` gate is a runtime check, not
  a build-time exclusion — it still ships in the compiled output for a
  production build. Whether that's acceptable depends on how this module
  gets deployed; flagging rather than deciding unilaterally.
- No test exercises `logAction()`'s `idempotencyKey` duplicate-rejection
  path directly (schema-level unique index exists and race-test.ts
  exercises heavy concurrent `logAction()` calls, but none supply a
  repeated key on purpose).
- No red-team pass on the other four modules
  (context-workspace, security-infra, gate-system-harness,
  gate-system-archive) — unchanged, still open, out of scope for this
  module.
- The classification question from before this fix pass — whether this
  module is Module 6 itself, a sibling of `gate-system-harness`, or
  infrastructure Module 6 consumes — is still unresolved and not touched
  by any of the above.

---

## Fix pass #2 — post-red-team, 4 fixes only (Claude, this session, Node v22.22.2)

Scoped deliberately to 4 of the red-team review's 17 findings, planned in
a separate turn before any code was touched (per Sam's direction, to keep
planning and execution separate). The other 13 findings (key rotation,
field-encryption scope, tamper-evidence/hash-chaining, and the rest) are
untouched and remain open -- explicitly out of scope for this pass, not
forgotten.

### Fix 1 — `updateSessionOutcomeRaw` removed from the class entirely
Red-team finding #1: a `NODE_ENV` runtime gate is not the same as not
shipping the method. Deleted it from `AccountabilityModule.ts` rather
than hardening the gate. `integration-test.ts` step 4 (proving the DB
CHECK itself rejects an incomplete closure) now reaches the private `db`
handle directly, the same pattern already used in `encryption-test.ts`
and `unarchive-test.ts`, instead of calling a method built for that
purpose. **Verified:** grepped `src/` and `tests/` for
`updateSessionOutcomeRaw` -- zero remaining references. Integration test
re-run, step 4 still correctly rejects via
`CHECK constraint failed: closed_sessions_need_attribution`.

### Fix 2 — hardcoded tsx loader paths removed from `race-test.ts`
Red-team finding #11: `spawn()` hardcoded
`/home/claude/.npm-global/lib/node_modules/tsx/...`, which only worked in
the one sandbox that happened to have tsx at that exact path. Replaced
with `spawn("npx", ["tsx", WORKER_SCRIPT, ...])`, matching how every
other test file in this suite already invokes tsx. **Verified:** re-ran
race-test.ts after the change -- same shape of result (6 workers ready,
thousands of successful/rejected writes, 0 actions logged after close).

### Fix 3 — idempotency-key duplicate rejection now has a real test
Red-team finding #7: the partial unique index on `idempotency_key`
existed in schema and the rejection code existed in `logAction()`, but no
test ever supplied a repeated key on purpose. Added step 7 to
`integration-test.ts`: logs an action with `idempotencyKey:
"retry-key-abc123"`, then logs a second action on the same session with
the same key, asserts the second call throws
`Duplicate action: idempotencyKey "retry-key-abc123" was already logged.`
**Verified:** re-run, step 7 passes.

### Fix 4 — two schema-level guards for closed-session integrity
Red-team finding #10, both bullets:
- **`drift_trigger` required when `session_outcome = 'DRIFTED'`** — new
  `CONSTRAINT drifted_sessions_need_trigger CHECK
  (session_outcome != 'DRIFTED' OR drift_trigger IS NOT NULL)` in
  `schema.sql`.
- **Closed sessions can no longer be re-closed or have attribution
  silently rewritten** — new `BEFORE UPDATE OF session_outcome,
  usability_rating, fault_attribution, attribution_reason, drift_trigger`
  trigger on `sessions`, firing only when `OLD.session_outcome !=
  'IN_PROGRESS'` AND at least one of those columns is actually changing.
  Scoped via `UPDATE OF <columns>` so an `is_archived`-only statement
  (from `unarchiveSession()` or `runMaintenance()`) never touches these
  columns and never fires the trigger at all -- archive/unarchive keep
  working exactly as before.

**Verified, twice over:**
1. A standalone script against the raw schema (not going through the TS
   class) confirmed, in order: DRIFTED without drift_trigger rejected;
   DRIFTED with drift_trigger succeeds; re-closing a closed session
   rejected; an is_archived-only update on that same session still
   succeeds; unarchiving it still succeeds; a session's *first* close
   (from IN_PROGRESS) still succeeds unblocked.
2. Added permanent regression coverage for the same six behaviors as new
   steps 6, 7, and 8 in `unarchive-test.ts`, and a DRIFTED-without-trigger
   /-with-trigger check. Both run as part of `npm test`, not just this
   session.

**Full suite run end-to-end via `npm test`, this session, exit code 0
(re-confirmed after all 4 fixes):** integration (8/8, was 6/6) →
retention (6/6) → encryption (6/6) → unarchive (8/8, was 5/5) →
path-traversal (4/4) → race (0 violations, now portable) → stress (PASS,
gate still enforces its own spec).

**Noted, not a regression:** one interim run of the stress test failed
with `WAL size 1082.34 KB exceeds spec target of 500 KB` on only 87
writes -- almost certainly this sandbox under load from everything else
run in this session, not a code change. Re-ran 3x immediately after with
no other changes: 3/3 clean passes (WAL 342-402 KB, thousands of writes
each). Same bimodal noise the log already documented after fix pass #1,
now correctly visible instead of silently passing either way.

**Still genuinely open — unchanged, explicitly deferred per Sam's scope
decision:**
- Key rotation / envelope encryption (#2)
- Field-level encryption scope beyond input/output payloads (#3)
- Tamper-evidence / hash-chaining the accountability log itself (#4) --
  flagged as the one worth escalating hardest; a module named
  "accountability" with no protection against silent row deletion or
  outcome-flipping is a conceptual gap, not just a hardening item, and
  the fix shape may belong at Module 6 (Harness) rather than duplicated
  here
- Everything else in the red-team review not listed above (#5, #6, #8,
  #9, #12-17) — reviewed, not disputed, not yet acted on
- The Module 6 / `gate-system-harness` classification question — still
  unresolved

---

## Fix pass #3 — tamper-evidence, Section 1 + Section 2 (Claude, this
session, Node v22.22.2)

Prompted by red-team review #2's highest-priority finding (#1: no
integrity/authenticity over the accountability log itself). Planned in a
separate turn before any code was touched, then split into two checkpoints
at Sam's request given the larger surface area than fix pass #2's four
independent items.

### Section 1 — schema + trigger (checkpoint 1)
- Added `chain_seq` and `row_hash` columns to `actions`, initially
  nullable (tightened to `NOT NULL` in Section 2 once `logAction()` always
  populates them).
- **Design correction found during execution, not before:** the plan called
  for `chain_seq INTEGER PRIMARY KEY AUTOINCREMENT`. `event_id` is already
  this table's `PRIMARY KEY` and SQLite allows only one per table -- this
  doesn't work as planned. Switched to a plain `chain_seq INTEGER` column,
  assigned manually via `MAX(chain_seq)+1` inside `logAction()`'s existing
  `BEGIN IMMEDIATE` transaction in Section 2. Flagged when found rather
  than silently deviating.
- Added `last_updated_at_utc` to `prevent_reclosing_sessions`'s `UPDATE OF`
  list, closing red-team review #2 finding #3 (it was previously outside
  the freeze, so a closed session's retention-relevant timestamp could be
  silently rewritten).
- **Caught a real regression during verification:** `retention-test.ts`
  and `unarchive-test.ts` both used to backdate an already-closed
  session's `last_updated_at_utc` via raw SQL to simulate age. The trigger
  fix above now correctly rejects that too (it fires on any UPDATE to a
  frozen column, raw SQL included -- that's the point of a schema-level
  guard over an app-level one). Fixed both tests to construct the aged
  session as a single already-closed, already-backdated `INSERT` instead
  of create-close-then-mutate. Pure test-construction fix; no product
  code or trigger design changed to accommodate it.
- **Verified:** all 6 deterministic test files re-run standalone after the
  fix, 0 failures. Stress test noise (see below) unrelated -- it only
  writes to `sessions`, which Section 1's `actions`-table changes don't
  touch.

### Section 2 — chain-key derivation, hash chain, verifyChain() (checkpoint 2)
- **Chain key:** derived from the existing required `encryptionKeyHex` via
  `crypto.hkdfSync("sha256", encryptionKey, "", "accountability-module-chain-key-v1", 32)`.
  Deliberately distinct key material from the AES-256-GCM encryption key
  despite sharing an input, via HKDF's info-label domain separation --
  confidentiality and tamper-evidence stay cryptographically independent
  roles. This is a minimal key-management step, not the deferred
  rotation/versioning/envelope story.
- **`chain_seq` assignment:** `SELECT chain_seq, row_hash FROM actions
  ORDER BY chain_seq DESC LIMIT 1`, then `+1`, executed inside the same
  `BEGIN IMMEDIATE` transaction `logAction()` already uses for the
  idempotency and outcome checks. Race-safety verified for real, not
  assumed: `race-test.ts` (6 genuine OS processes, not threads, hammering
  `logAction()` concurrently) produced zero `UNIQUE constraint failed`
  errors on `chain_seq` across a full run -- explicitly grepped for after
  the run, not inferred from an overall PASS.
- **`row_hash`:** `HMAC-SHA256(chainKey, prevHash || eventId || sessionId
  || timestampUtc || initiatorRole || actionName || alignmentState ||
  encryptedInputPayload || encryptedOutputPayload || idempotencyKey)`,
  fields joined with `\x1f` (unit separator). First row in a fresh chain
  links to a fixed public constant (`"GENESIS"`, carries no secret --
  the HMAC key is what makes forgery hard, not this label). The exact
  join function (`computeRowHash`) is shared between `logAction()` (write)
  and `verifyChain()` (check), so the two can't drift apart from each
  other by definition.
- **`verifyChain()`:** walks `actions` in `chain_seq` order, checks
  contiguity (a gap means a deleted row) and recomputes each row's hash
  from its own stored columns plus the running previous-hash (a mismatch
  means an edited row). Stops at the first violation and reports
  `{ valid, brokenAtSeq, reason: "sequence_gap" | "hash_mismatch",
  rowsChecked }` rather than a bare boolean, so a caller knows *where* and
  *what kind*, not just that something's wrong.
- **Stated honestly, not oversold:** this is tamper-EVIDENT, not
  tamper-PROOF. A writer with both DB file access and the chain key could
  rewrite a self-consistent suffix of the chain. Same threat model
  AES-256-GCM already accepts for confidentiality (key + file = full
  access) -- documented explicitly here rather than left implicit.
  Doesn't touch `sessions`-table integrity beyond the Section-1 trigger
  fix, and doesn't touch anything from the still-deferred list (key
  rotation, wider encryption scope).

**New test file `tests/chain-integrity-test.ts`, 6 checks (plan called for
3 -- valid chain, corrupted-row detection, deleted-row detection -- ended
up adding three more while verifying by hand before writing them down):**
1. Valid chain across 8 actions interleaved across two sessions.
2. An empty/fresh chain is trivially valid (0 rows).
3. Directly rewriting a stored row's `action_name` via raw SQL is caught
   as `hash_mismatch` at the exact `chain_seq` that was touched.
4. Directly `DELETE`-ing a row via raw SQL is caught as `sequence_gap` at
   the exact `chain_seq` that's now missing.
5. A second, independent `AccountabilityModule` instance opened against
   the same DB with the same key agrees the chain is valid (chain-key
   derivation is deterministic, not accidentally instance-specific).
6. Opening the same DB with the WRONG key correctly reports the chain as
   invalid from row 1 -- confirms the chain key is actually being used to
   verify, not silently skipped.

All 6 verified against real execution, including manually reproducing
each detection scenario in a throwaway script before writing it down as a
permanent test, matching this project's standing rule against treating
untested assertions as fact.

**Full suite run via `npm test`, this session, exit code varies only on
`stress-test.ts` (see below):** integration (8/8) -> retention (6/6) ->
encryption (6/6) -> unarchive (8/8) -> path-traversal (4/4) ->
chain-integrity (6/6, new) -> race (0 chain_seq collisions across 6 real
OS processes, 0 post-close actions) -> stress (see note).

**Stress test noise, characterized honestly rather than hidden:** across
~10 runs during this fix pass, results ranged from 20 to 5,778 successful
writes and 274 KB to 62,838 KB WAL size, roughly 60% pass / 40% fail on
the gate fixed pass #2 landed. This is the sandbox under load, not a
regression from Sections 1 or 2 -- mechanically confirmed, since
`stress-test.ts` only ever inserts into `sessions`, and neither section's
changes touch that table's write path (Section 1 only added a trigger
column for `sessions` unrelated to inserts; Section 2 only touches
`actions`). Same bimodal behavior documented as still-present after fix
pass #2, now just more frequently on the fail side under today's
sandbox load specifically.

**Still genuinely open, unchanged:** key rotation/versioning/envelope,
encryption scope beyond payloads, and the Module 6 /
`gate-system-harness` classification question. `sessions`-table integrity
beyond the freeze trigger (an attacker could still `DELETE FROM sessions`
outright, or edit a non-frozen column like `engineer_id`) is a new item
worth naming explicitly: this pass hash-chained `actions` because it's
the true append-only historical record; `sessions` intentionally mutates
over its lifecycle, so the same technique doesn't directly transfer
without more thought about what "tamper-evident but still mutable" would
even mean for that table.

---

## Fix pass #4 — two real bugs from red-team review #3 (Claude, this
session, Node v22.22.2)

Red-team review #3 (an external adversarial pass) raised 13 numbered
findings plus an architecture section. Before fixing anything, each
concrete/testable claim was run against the actual delivered code rather
than accepted on the review's authority:

**Two of the review's own headline claims turned out to be FALSE against
the code being reviewed, confirmed by execution:**
- Finding #1 ("no state machine," full IN_PROGRESS->COMPLETED->DRIFTED->
  ABANDONED->COMPLETED chain all succeeds) -- ran the exact sequence.
  First transition succeeded, second was rejected by
  `prevent_reclosing_sessions` (added fix pass #2). Already fixed two
  passes before this review.
- Architecture section ("someone with DB access can delete rows, the
  module never notices... ideas: hash chain, row hash linked to previous
  row") -- deleted a row via raw SQL, called `verifyChain()`, got
  `{"valid":false,"reason":"sequence_gap"}` immediately. This is the exact
  mechanism added in fix pass #3, delivered in the same zip this review
  is dated against.
- Also checked finding #2 (concurrent double-finalization, "last writer
  wins") since it's adjacent to #1: ran two real OS processes racing
  `updateSessionOutcome()` on the same session with different outcomes, 6
  times. Exactly one winner and one correctly-rejected loser every time
  -- SQLite's write serialization plus the existing freeze trigger already
  close this without needing an explicit
  `WHERE session_outcome='IN_PROGRESS'` guard.

Reported to Sam as reason for skepticism about the review's other,
unverified claims -- not fixed, since they weren't real. Whether the
review was run against a stale copy of the module or not actually
executed isn't knowable from here.

**Two findings were verified TRUE by reproducing them, then fixed:**

### Bug 1 — idempotency key was globally unique, not scoped per session (finding #3)
Reproduced: session A logs an action with `idempotencyKey: "shared-key"`;
session B, a completely unrelated session, attempts the same key and gets
rejected as a duplicate of something it has nothing to do with.
**Fix:** `CREATE UNIQUE INDEX idx_actions_idempotency ON
actions(idempotency_key)` -> `ON actions(session_id, idempotency_key)` in
`schema.sql`. App-level duplicate check in `logAction()` updated to match
(`WHERE session_id = ? AND idempotency_key = ?`, was `WHERE
idempotency_key = ?`). Error message now names the session for clarity.
**Verified:** re-ran the exact repro script -- cross-session reuse now
succeeds. Existing same-session duplicate-rejection test
(`integration-test.ts` step 7) still passes unchanged. New step 8 added:
two different sessions using the identical key both succeed.

### Bug 2 — path-traversal sandbox bypassable via symlinks (finding #7)
Reproduced: created a symlink inside `allowedDir` pointing outside it;
constructor accepted it with no error; a real database file was created
outside the sandbox. `path.resolve()` is textual only and doesn't follow
symlinks.
**Fix:** new `canonicalizeForSandboxCheck()` helper using
`fs.realpathSync()` before the boundary check, with a fallback for paths
that don't exist yet (the normal new-database case) that resolves the
parent directory instead.
**Caught a bug in my own first attempt at this fix, before shipping it:**
the first version's fallback treated "realpathSync throws" as always
meaning "path doesn't exist, no symlink involved" and silently passed a
*dangling* symlink (one whose target doesn't exist yet) straight through
unresolved -- re-running the exact repro script against that version
still showed the escape succeeding. Fixed by having the fallback check
`fs.lstatSync().isSymbolicLink()` explicitly: if the path itself is a
symlink (even a dangling one), read its target via `fs.readlinkSync()`
and recurse, rather than assuming non-existence means "no symlink."
**Verified, four scenarios, all re-run against the corrected version:**
dangling symlink pointing outside the sandbox -> rejected; symlink to an
*existing* file outside the sandbox -> rejected; plain non-symlink path
inside the sandbox -> still works; symlink pointing *within* the sandbox
-> still correctly allowed (defense doesn't overreach). All four made
permanent as `path-traversal-test.ts` steps 5-7 (step 5 covers both
dangling-target rejection and, implicitly, that a real file wasn't
created outside the sandbox).

**Full suite run via `npm test`, this session, exit code 0, including
`stress-test.ts` clean this run:** integration (9/9, was 8/8) ->
retention (6/6) -> encryption (6/6) -> unarchive (8/8) -> path-traversal
(7/7, was 4/4) -> chain-integrity (6/6) -> race (0 chain_seq collisions,
0 post-close actions) -> stress (PASS).

**Still genuinely open, unchanged by this pass:** key
rotation/versioning/envelope, encryption scope beyond payloads,
`sessions`-table integrity beyond the freeze trigger (raw `DELETE FROM
sessions` is still unprotected), the Module 6 / `gate-system-harness`
classification question, and the unverified remainder of red-team review
#3's findings (#4-6, #8-13, and its "things I'd try next" list) --
plausible based on code inspection but not individually re-confirmed by
execution the way the six claims above were.

---

## Documentation correction (Claude, this session)

Found while appending the section below: the "Fix pass #4" section above
had been inserted physically BEFORE "Fix pass #3" in this file, out of
chronological order, despite happening after it. Root cause: an earlier
`str_replace` anchor matched an intermediate, no-longer-current occurrence
of a recurring "still genuinely open" closing block instead of the true
end of the file at that time. Corrected by swapping the two sections back
into actual chronological order. No content was changed, only position --
verified by diffing before/after that both sections' text is byte-for-byte
identical to what was there before the swap. Noted here rather than
silently fixed, per this log's own standing rule about not treating
things as fact -- or in this case, correctly ordered -- without saying so
when they weren't.

---

## Verification pass — red-team review #4 (Claude, this session, Node v22.22.2)

Review #4 was more calibrated than #3: it hedged honestly on things it
hadn't directly confirmed ("suggests," "I'd want to inspect the exact
constraint") rather than asserting them as fact. That's better practice,
but "suggests" still isn't "confirmed" -- two of its five "things I'd
actively attack" items were cheap enough to actually run before
responding, rather than just acknowledging them.

**#4, concurrency stress at higher scale than the existing race test:**
attempted the reviewer's suggested 50-100 concurrent processes; the
sandbox couldn't spawn that many `npx tsx` processes without hanging past
90s (confirmed as a sandbox/tooling limit, not a module issue, by
successfully running smaller scales). Ran 10, then 20, concurrent OS
processes simultaneously logging actions AND attempting finalization on
the same session. At every scale: exactly 1 finalization succeeded, 0
duplicate `event_id`s, `verifyChain()` valid afterward. Same properties
the reviewer asked for, at lower concurrency than requested -- flagged
honestly as a sandbox ceiling, not treated as equivalent to actually
testing 100 concurrent writers in a real deployment.

**#5, two attack shapes beyond what was already tested (delete a row,
modify ciphertext -- both already covered by fix pass #3's tests):**
- **Row swap** -- physically exchanged two rows' `chain_seq` positions via
  raw SQL. Caught: `hash_mismatch` at the first disturbed position. Each
  row's hash is bound to its original predecessor's hash, not whatever
  now precedes it after a swap.
- **Row replay** -- copied an old row's exact content, including its own
  genuinely-valid `row_hash`, into a new row appended at the end of the
  chain. Caught: `hash_mismatch`, because that hash was only ever valid
  linked to what preceded it in its *original* position, not the new one.

Both made permanent as `chain-integrity-test.ts` steps 7-8 (file grew
from 6 to 8 checks), rather than left as scratch scripts. New
`reachDbFull()` test helper added alongside the existing `reachDb()` --
needs `exec()` for the swap test's explicit `BEGIN IMMEDIATE`/`COMMIT`
(swapping two values under a unique index needs a transient dummy value
to avoid a self-conflict mid-swap).

**Not touched, and correctly so -- these are new hardening asks, not bugs
to fix:** key rotation, crash/fault injection (kill-during-transaction,
disk full, WAL corruption, interrupted maintenance), payload size limits,
property-based/fuzz testing. Key rotation and payload limits were already
on the deferred list; the fault-injection ideas are new and would need
their own scoped pass if pursued.

**Full suite run via `npm test`, this session, exit code 0:** integration
(9/9) -> retention (6/6) -> encryption (6/6) -> unarchive (8/8) ->
path-traversal (7/7) -> chain-integrity (8/8, was 6/6) -> race (0
collisions) -> stress (PASS).

**Still genuinely open, unchanged:** everything listed at the end of fix
pass #4 above -- key rotation/versioning/envelope, encryption scope
beyond payloads, `sessions`-table integrity beyond the freeze trigger,
the Module 6 / `gate-system-harness` classification question, and the
unverified remainder of red-team review #3's findings.

---

## Batch-fix pass (Claude, this session — explicit direction to build, not just trace)

All 14 flags below were implemented in code and re-run to confirm, not
just reasoned about. Deviates from the standing tracer-only role at Sam's
explicit instruction for this pass.

1. **`updateSessionOutcomeRaw` unguarded** — fixed: throws unless
   `NODE_ENV=test`. Re-verified integration test still exercises the real
   DB constraint (not just the new gate) by running with `NODE_ENV=test`
   set — confirmed rejection message is the actual
   `CHECK constraint failed: closed_sessions_need_attribution`, not the gate.
2. **No transactional wrapping around create/log/close** — added
   `withTransaction()` (BEGIN IMMEDIATE / COMMIT / ROLLBACK), used
   internally by `logAction()`.
3. **Stress test silently discarded checkpoint failure signal** — fixed:
   captures the pragma's real `busy`/`log`/`checkpointed` columns instead
   of `.exec()`-and-ignore. Re-run twice, correctly surfaced 1/17 and
   1/15 incomplete checkpoints that were previously invisible. Caveat:
   this closes the blind spot but does not fully explain WAL-size
   variance — a third run showed 73 MB WAL with 0 frames reported
   unchecked, because size is measured once at test end and heavy writes
   in the final ~500ms window show up regardless of checkpoint
   completeness. Reporting this precisely rather than claiming the fix
   solved 100% of the variance.
4. **Path traversal defense** — implemented: `dbPath` resolved via
   `path.resolve`, validated against optional `allowedDir` boundary,
   throws if it escapes. Not yet independently stress-tested by a
   dedicated traversal test — flagged as a residual gap.
5. **AES-256-GCM encryption — not implemented** — implemented:
   `encryptPayload`/`decryptPayload` (iv + authTag + ciphertext,
   base64-encoded). Constructor now requires a 64-hex-char key and throws
   rather than silently falling back to plaintext. Added `getAction()`
   accessor so encrypted data is actually retrievable, not just writable
   (there was no read API at all before this).
6. **No indexes anywhere in schema** — added indexes on
   `sessions(is_archived, last_updated_at_utc)`, `sessions(session_outcome)`,
   `actions(session_id)`.
7. **`logAction` TOCTOU race** — closed by wrapping the outcome-check and
   the INSERT inside `withTransaction()`. Verified under real concurrency
   with a new multi-process race test (`race-test.ts` + `race-worker.ts`,
   6 separate OS processes, not threads — addresses red-team item #13,
   "no multi-process test," as a side effect). First version of this test
   showed 0 successful writes — a bug in the test's own timing, not the
   fix: fixed-delay close was shorter than tsx's cold-start overhead
   under concurrent spawn. Fixed by synchronizing on a real READY signal
   from each worker instead of guessing a delay. Final run: 1,976-1,997
   successful writes before close, tens of thousands correctly rejected
   after, **0 actions logged after the close timestamp** across multiple
   runs.
8. **No un-archive API** — added `unarchiveSession()`.
9. **`SessionOutcome` type excluded `IN_PROGRESS`** — split into
   `SessionOutcome` (full set, includes `IN_PROGRESS`) and `ClosingOutcome`
   (the three terminal states `updateSessionOutcome()` actually accepts).
10. **`updateSessionOutcome` no existence check** — fixed: checks
    `result.changes`, throws on a no-op update. Re-verified via
    integration test.
11. **No unique constraint on actions** — added optional
    `idempotencyKey` param + nullable partial unique index; duplicate key
    throws instead of silently double-logging.
12. **`package.json`/tsconfig ESM mismatch** — fixed: `"type": "module"`
    added, real `devDependencies` and `test` script added, tsconfig
    module setting aligned. This required also converting `__dirname`
    usage to `import.meta.url`-based resolution in `AccountabilityModule.ts`
    and two existing tests, which had been silently relying on CJS
    behavior.
13. **No multi-process stress test / no race test** — addressed together;
    see #7. Original multi-thread stress test (`stress-test.ts`) left
    unchanged in structure beyond the checkpoint-capture fix in #3.
14. **No red-team pass on other 4 modules** — out of scope for this
    module; unchanged, still open.

**Full suite run end-to-end via `npm test`, this session, exit code 0:**
integration (6/6 steps) → retention (6/6 checks) → race (0 violations
across two independent runs) → stress (PASS, checkpoint signal now
visible). All four ran for real, in sequence, against the fixed code —
not read, not narrated.

**Still genuinely open after this pass:**
- Path traversal defense has no dedicated test yet.
- WAL-size variance under sustained write load is reduced-visibility, not
  eliminated — see #3 caveat above.
- `getAction()` is new and only exercised indirectly (encryption
  round-trips inside `logAction`); no direct test calls it yet.
- Red-team pass on the other 4 modules remains untouched.

---

## Independent re-verification (Claude trace, this session)

Everything above was re-run independently, not just read, against
Node v22.22.2 (same runtime the log claims).

**Reproduced exactly as claimed:**
- `integration-test.ts` — all 6 steps matched: session creation succeeds;
  closing without attribution rejected by `CHECK closed_sessions_need_attribution`;
  closing with full attribution succeeds; post-close `logAction()` rejected.
- `retention-test.ts` — old session archived (`is_archived=1`), not deleted;
  recent session untouched. Confirms the Pass 12 fix behaves as designed.

**Discrepancy found — stress test result was not a stable number:**
Log claimed one run (3,090 writes / 0 lock errors / 237.41 KB WAL). Two
independent re-runs produced 4,410 writes / 28 lock errors / **41,546 KB
WAL** (83x over the <500 KB spec target) and 4,793 writes / 4 lock errors
/ 161 KB WAL. Root cause identified: `PRAGMA wal_checkpoint(TRUNCATE)`
(line 52 of stress-test.ts) silently does a partial checkpoint and does
NOT throw when it can't get an exclusive lock — the code discards the
pragma's own busy/checkpointed result columns, so `maintenanceErrors`
stays 0 even when truncation mostly failed. The log's "0 lock errors, WAL
within target" was one favorable sample from a noisy distribution, not a
verified property of the design.

**Correction to Pass 9 claims — "designed but not exercised" was
inaccurate framing:**
Grepped full delivered source (`src/`, `schema.sql`) for
`aes|encrypt|gcm|traversal|path.resolve|path.normalize`: zero matches.
- Parameterized queries: real, confirmed.
- Path traversal defense: **not implemented** — `dbPath` passed raw into
  `DatabaseSync()`, no validation.
- AES-256-GCM field encryption: **not implemented** — only
  `crypto.randomUUID()` appears anywhere in source.
The accurate status is "never implemented in this artifact," not merely
"untested."

## Red-team pass (external review, corroborated against source)

A full adversarial review was run against this file set. Every checkable
claim was independently re-verified against source before acceptance
(per standing cross-model verification policy). All confirmed accurate:

- `updateSessionOutcomeRaw` is exported on the public class with no
  `NODE_ENV` gate or runtime check — confirmed, lines 88-102.
- No transactions anywhere in the module — grepped for
  `BEGIN|COMMIT|transaction`: zero matches. `createSession`, `logAction`,
  `updateSessionOutcome` are each single independent statements; no
  atomic create→log→close path exists. Stress test never exercises the
  close path under contention, only inserts.
- No indexes anywhere in schema.sql — grepped for `CREATE INDEX`: zero
  matches. Not limited to `is_archived`/`session_outcome` as first
  suspected; there are no indexes at all.
- `logAction`'s outcome check and its INSERT are two separate statements
  — a session can be closed by another process in the gap between them.
- No un-archive / hard-delete API — `runMaintenance` only ever sets
  `is_archived = 1`; table grows unbounded.
- `SessionOutcome` TS type (`"COMPLETED"|"ABANDONED"|"DRIFTED"`) excludes
  `"IN_PROGRESS"` — confirmed at line 6 — while schema defaults every new
  row to it. Real type/runtime mismatch.
- `updateSessionOutcome` has no existence check — bare `UPDATE ... WHERE
  session_id = ?`, silent no-op on a nonexistent session.
- No unique constraint on `actions` beyond `event_id` PK — duplicate
  logical-action logging is possible and invisible.
- `package.json` missing `"type": "module"` — independently corroborated:
  this exact `MODULE_TYPELESS_PACKAGE_JSON` warning was observed during
  Claude's own test runs above, before this report was received.

## Open flags — batch fix (not yet applied, no code changed by Claude)

Priority order, highest first:

1. `updateSessionOutcomeRaw` shipped unguarded on the public class.
2. No transactional wrapping around create/log/close — real concurrency
   correctness gap, untested by current stress test.
3. Stress test checkpoint silently discards partial-failure signal —
   fix before treating any of its numbers as verified.
4. Path traversal defense — not implemented (log's prior wording was
   inaccurate; corrected above).
5. AES-256-GCM encryption — not implemented (same correction).
6. No indexes on `sessions`/`actions` — retention scans and any future
   query are full-table.
7. `logAction` outcome-check-then-insert race window (TOCTOU-shaped).
8. No un-archive/hard-delete API — unbounded table growth over time.
9. `SessionOutcome` type excludes `IN_PROGRESS`, contradicting schema
   default.
10. `updateSessionOutcome` no existence check — silent no-op.
11. No unique/business-key constraint on `actions` — duplicate logging
    possible.
12. `package.json` missing `"type": "module"`; no dependencies declared.
13. No multi-process stress test (only multi-thread); no test racing
    `logAction` against `updateSessionOutcome`.
14. No red-team pass on the other four modules yet (context-workspace,
    security-infra, gate-system-harness, gate-system-archive).

Nothing in this section has been fixed yet. Per standing methodology,
these stay flagged and deferred until the batch-fix pass — no inline
fixes during tracing.
