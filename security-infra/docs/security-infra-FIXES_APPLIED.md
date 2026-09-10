# Fixes applied to this package

Verified by direct file edit + code execution (Python hashlib/regex checks),
not narration. Source: security-infra.zip as uploaded, cross-checked against
verification_harness.sql uploaded separately (confirmed byte-identical via
md5sum before any edits were made).

## 1. db/schema.sql — immutability trigger missing explicit SQLSTATE

**Before:** `reject_context_node_mutation()` raised a plain
`RAISE EXCEPTION '...'` with no error code attached, defaulting to the
generic `raise_exception` class (SQLSTATE P0001).

**Problem:** `verification_harness.sql` Test 1 catches errors to confirm
the trigger blocked an UPDATE. But the test's own "the trigger failed"
canary exception is *also* a generic `raise_exception`. Catching the
generic class meant the test could not tell the trigger's exception apart
from its own failure-path exception — it would report SUCCESS either way.

**Fix:** Added `USING ERRCODE = 'ZZ001'` to the trigger's RAISE EXCEPTION,
giving it a distinct, non-generic SQLSTATE.

## 2. db/verification_harness.sql — two issues

**Test 1:** Changed `WHEN raise_exception THEN` to `WHEN sqlstate 'ZZ001' THEN`,
matching the schema fix above. Now the test can only pass if the specific
trigger exception fires — not any exception.

**Test 3:** The `payload_hash` literal was 63 hex characters (one short of
the `sha256_hash` domain's required 64), confirmed via `len()` in Python —
not by eye. This caused the test to fail on hash-domain length before it
ever reached the mime_type/XSS check it was meant to exercise. Replaced
with a genuine `hashlib.sha256(...).hexdigest()` output, confirmed 64
characters and a valid hex match against `^[a-f0-9]{64}$`.

**Test 4:** Checked and confirmed correct — no fix needed. (An earlier
verbal claim that Test 4's hash was also 63 characters was based on
mistakenly reading a different, older pasted document instead of this
actual file. Retracted.)

## Not yet done

- No live Postgres run of this harness has happened. These fixes are
  confirmed correct by static read + code-assisted length/regex checks,
  not by executing the SQL against a real database. That's the next real
  verification step, not this one.
- `.agents/memory/` sits outside the `security-infra/` folder in the
  original zip's structure, not inside it. Left as-is here to match the
  original — worth deciding whether to nest it before this becomes a
  permanent repo layout.

---

# Round 2: red-team fixes

A red-team pass surfaced 6 real gaps the round-1 fix pass above didn't
touch (2 critical, 2 high, 2 medium). All 6 are fixed here. Verified by
direct read/grep against the actual files before writing each fix, same
as round 1 — not by trusting the red-team report's claims at face value.

## Critical

**1. TRUNCATE bypassed the immutability trigger entirely.** Row-level
`BEFORE UPDATE`/`BEFORE DELETE` triggers don't fire for `TRUNCATE` — it's a
separate statement-level event in Postgres. Confirmed via grep: only those
two trigger types existed. **Fix:** added an `AFTER TRUNCATE FOR EACH
STATEMENT` trigger (`trg_context_nodes_no_truncate`) raising the same
`ZZ001` error. Covered by verification harness Test 5.

**2. No privilege model existed.** Confirmed via grep: zero `GRANT`/`REVOKE`
statements anywhere in the schema. Trigger-only immutability trusts the
same role it's meant to constrain (that role can `ALTER TABLE ... DISABLE
TRIGGER ALL`). **Fix:** added `app_role`, `REVOKE ALL` then `GRANT SELECT,
INSERT` only on all four tables — no `UPDATE`/`DELETE`/`TRUNCATE` granted on
`context_nodes`. `NOLOGIN` deliberately; actual login/password belongs in
deployment secrets, not this file.

## High

**3. Rego policy allowed a container with no timeout env var at all.**
Confirmed via the policy's own test: `test_container_with_no_env_allowed`
asserted `count(deny) == 0` with the var absent — the most realistic
misconfiguration (a dev forgot to set it), unguarded. **Fix:** new Rule 3
denies by default when `POSTGRES_CONNECTION_TIMEOUT` is absent, with an
explicit `security-infra.io/no-postgres: "true"` pod-template annotation
opt-out for workloads that don't talk to this DB. Old test renamed/inverted
to `test_container_with_no_env_denied`; added coverage for Pod/CronJob and
the opt-out path. **Not independently executed** — no `opa` binary reachable
in this environment (no network egress); traced by hand instead of run.

**4. `nodes` array and `raw_payload` had no size cap.** The schema's
`$comment` claimed the hardening pass addressed heap-exhaustion, but grep
confirmed no `maxItems` existed anywhere, and `raw_payload` had no
`octet_length` check. **Fix:** `maxItems: 10000` on `nodes` (schema);
`CHECK (octet_length(raw_payload) <= 10485760)` (10 MiB) on the DB column.
Both bounds are starting points — adjust to the pipeline's real max, not
left unbounded. Covered by verification harness Test 7.

## Medium

**5. `metadata.maxProperties: 50` bounded breadth, not depth or DB-side
shape.** Each of the 50 keys could still hold an arbitrarily deep/large
nested value, and since JSONB has no native key-count/depth constraint, a
caller writing directly to Postgres wasn't bound by the schema's cap at
all — contradicting the docs' "mirror the same constraints" claim. **Fix:**
schema now restricts every metadata value to a scalar (string ≤1000 chars,
number, boolean, or null) via `additionalProperties`, which caps depth at 1
by construction. DB gets a matching `context_node_metadata_is_safe()`
function (≤50 keys, no nested object/array values, ≤20000 bytes
serialized) as a `CHECK` constraint, so the two layers now actually agree.
Covered by verification harness Test 6.

**6. `is_valid_number_string()` reintroduced the exact bug class the file's
own header says was fixed.** The header explains the boolean case was fixed
by checking JSON type explicitly instead of relying on `to_number()`'s
undefined/error behavior — but `is_valid_number_string(val) { to_number(val)
}` still called `to_number` directly on unvalidated strings, just moved into
a helper. **Fix:** replaced with a regex check
(`^-?[0-9]+(\.[0-9]+)?$`); `to_number` is now only ever called after this
has already confirmed the string is numeric, so it can't be called on a
value it can't parse.

## Not yet done (round 2)

- Same as round 1: no live `opa test` or Postgres run. Rego fixes were
  traced by hand (network egress is disabled in this environment, so no
  `opa` binary was reachable); SQL fixes were checked for syntax validity
  by inspection, not execution against a real Postgres instance.
- The 10000-item / 10 MiB / 20000-byte bounds (fixes #4, #5) are
  reasonable-sounding defaults, not numbers derived from this pipeline's
  actual traffic. Worth revisiting once real payload sizes are known.
- `docs/security-infra.md`'s "DB and schema mirror the same constraints"
  claim is now closer to true (fix #5 closes the gap that contradicted it)
  but hasn't been re-audited end-to-end for other places the two layers
  might still drift.

---

# Round 2.1: gap introduced by round 2 itself

An external review of round 2's diff (not trusting this file's own
narrative — verified against the actual code) confirmed all 6 round-2
fixes are genuine, and caught one new gap the fix pass introduced:

**`validate-all.sh`'s pass gate was a hardcoded `success_count -ge 5`.**
That threshold was already satisfied by the original 5 harness tests
alone, so once round 2 added 3 more (Tests 5–7: TRUNCATE, metadata-shape,
payload-size), a silent failure in any of the new tests -- the exact
"generic exception swallowed the specific one" bug class this project has
already hit twice, per `.agents/memory/` -- could produce zero `SUCCESS:`
lines from that test while the script still reported `pass`, since 5 old
successes alone already clear `-ge 5`. **Fix:** `expected_count` is now
derived from the harness file itself (`grep -c "^SAVEPOINT test_"
verification_harness.sql`), and the pass condition changed from
`-ge 5` to `-eq expected_count`, so the gate can't silently drift out of
sync with the harness again.

Non-security note from the same review, left as-is: the round-2 numeric
regex (`^-?[0-9]+(\.[0-9]+)?$`) doesn't accept `+30` or scientific notation
like `1e5` -- those get classified unsafe and denied. That's fail-closed
behavior, not a vulnerability, so no change made; worth knowing if a config
generator ever emits values in that shape.
