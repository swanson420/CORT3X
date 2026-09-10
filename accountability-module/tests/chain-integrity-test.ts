// Tests the tamper-evidence chain added in response to red-team review #2,
// finding #1 ("no integrity/authenticity over the accountability log
// itself"). Confirms verifyChain() actually detects the two tamper shapes
// it claims to: a modified row (hash_mismatch) and a deleted row
// (sequence_gap) -- and that it stays valid across normal use, including
// multiple sessions interleaved.

import { AccountabilityModule } from "../src/AccountabilityModule";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(__dirname, ".tmp_test_chain.db");
const KEY = "3ababc623cf6dc4d7bce7d154ccb0d4141e69e3c90e04a1104c9540ebba4f34a";

function cleanup() {
  for (const ext of ["", "-wal", "-shm"]) {
    const p = testDbPath + ext;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

function reachDb(mod: AccountabilityModule) {
  return (mod as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown } } }).db;
}

/** Same reach-in, extended with exec() for the row-swap test, which needs
 * an explicit BEGIN IMMEDIATE / COMMIT to swap two rows' chain_seq values
 * without tripping the unique index on chain_seq mid-swap. */
function reachDbFull(mod: AccountabilityModule) {
  return (
    mod as unknown as {
      db: {
        prepare: (q: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown };
        exec: (q: string) => void;
      };
    }
  ).db;
}

cleanup();

console.log("1. Logging several actions across two interleaved sessions and verifying the chain is valid...");
let mod = new AccountabilityModule({ dbPath: testDbPath, encryptionKeyHex: KEY });
const sessionA = mod.createSession({ engineerId: "samson", moduleName: "chain_test_a" });
const sessionB = mod.createSession({ engineerId: "samson", moduleName: "chain_test_b" });
const eventIds: string[] = [];
for (let i = 0; i < 8; i++) {
  eventIds.push(
    mod.logAction({
      sessionId: i % 2 === 0 ? sessionA : sessionB,
      initiatorRole: "AI_AGENT",
      actionName: `action_${i}`,
      alignmentState: "ALIGNED",
      inputPayload: { i },
      outputPayload: { ok: true },
    })
  );
}
let result = mod.verifyChain();
if (!result.valid || result.rowsChecked !== 8) {
  console.error("   FAILED: expected a valid chain over 8 rows, got:", result);
  process.exit(1);
}
console.log("   OK -", JSON.stringify(result));

console.log("2. An empty/fresh chain (no actions yet) is trivially valid...");
mod.close();
cleanup();
mod = new AccountabilityModule({ dbPath: testDbPath, encryptionKeyHex: KEY });
result = mod.verifyChain();
if (!result.valid || result.rowsChecked !== 0) {
  console.error("   FAILED: expected a valid empty chain, got:", result);
  process.exit(1);
}
console.log("   OK -", JSON.stringify(result));

console.log("3. Modifying a stored row's content is detected as hash_mismatch...");
const sessionC = mod.createSession({ engineerId: "samson", moduleName: "chain_test_c" });
const ids: string[] = [];
for (let i = 0; i < 5; i++) {
  ids.push(
    mod.logAction({
      sessionId: sessionC,
      initiatorRole: "AI_AGENT",
      actionName: `step_${i}`,
      alignmentState: "ALIGNED",
      inputPayload: { i },
      outputPayload: {},
    })
  );
}
// Directly rewrite the 3rd row's action_name via raw SQL -- exactly the
// "compromised process with DB write access" scenario the review raised.
reachDb(mod).prepare("UPDATE actions SET action_name = 'TAMPERED' WHERE event_id = ?").run(ids[2]);
result = mod.verifyChain();
if (result.valid || result.reason !== "hash_mismatch" || result.brokenAtSeq !== 3) {
  console.error("   FAILED: expected hash_mismatch at chain_seq 3, got:", result);
  process.exit(1);
}
console.log("   OK -", JSON.stringify(result), "(correctly pinpoints the tampered row, not just 'somewhere')");

console.log("4. Deleting a row entirely is detected as sequence_gap...");
mod.close();
cleanup();
mod = new AccountabilityModule({ dbPath: testDbPath, encryptionKeyHex: KEY });
const sessionD = mod.createSession({ engineerId: "samson", moduleName: "chain_test_d" });
const ids2: string[] = [];
for (let i = 0; i < 5; i++) {
  ids2.push(
    mod.logAction({
      sessionId: sessionD,
      initiatorRole: "AI_AGENT",
      actionName: `step_${i}`,
      alignmentState: "ALIGNED",
      inputPayload: { i },
      outputPayload: {},
    })
  );
}
reachDb(mod).prepare("DELETE FROM actions WHERE event_id = ?").run(ids2[2]);
result = mod.verifyChain();
if (result.valid || result.reason !== "sequence_gap" || result.brokenAtSeq !== 3) {
  console.error("   FAILED: expected sequence_gap at chain_seq 3, got:", result);
  process.exit(1);
}
console.log("   OK -", JSON.stringify(result));

console.log("5. Confirming two independent instances of the module (same key) agree on the same chain...");
// If chainKey derivation weren't deterministic, a second instance opening
// the same DB would disagree with the first about validity.
mod.close();
cleanup();
mod = new AccountabilityModule({ dbPath: testDbPath, encryptionKeyHex: KEY });
const sessionE = mod.createSession({ engineerId: "samson", moduleName: "chain_test_e" });
for (let i = 0; i < 3; i++) {
  mod.logAction({
    sessionId: sessionE,
    initiatorRole: "AI_AGENT",
    actionName: `step_${i}`,
    alignmentState: "ALIGNED",
    inputPayload: {},
    outputPayload: {},
  });
}
mod.close();
const mod2 = new AccountabilityModule({ dbPath: testDbPath, encryptionKeyHex: KEY });
const secondOpinion = mod2.verifyChain();
if (!secondOpinion.valid || secondOpinion.rowsChecked !== 3) {
  console.error("   FAILED: a fresh instance with the same key disagreed about chain validity:", secondOpinion);
  process.exit(1);
}
console.log("   OK -", JSON.stringify(secondOpinion));

console.log("6. A different key produces a different chain key -- verifyChain() correctly reports tampering that isn't really there, because it's the wrong key, not a real breach...");
mod2.close();
const WRONG_KEY = "a08dcc4b3e188486fb41b5e548c8e434647d2ee74bc67109f8a462ae15a5ccd8".slice(0, 64);
const mod3 = new AccountabilityModule({ dbPath: testDbPath, encryptionKeyHex: WRONG_KEY });
const wrongKeyResult = mod3.verifyChain();
if (wrongKeyResult.valid) {
  console.error("   FAILED: verifyChain() with the wrong key reported valid -- chain key is not actually being used");
  process.exit(1);
}
console.log("   OK -", JSON.stringify(wrongKeyResult), "(expected: wrong key can't reproduce the real chain's hashes)");
mod3.close();

console.log("7. Swapping two rows' positions in the chain (chain_seq swap) is detected...");
// Red-team review #4's "swap two rows" attack: an attacker with SQL access
// physically exchanges two rows' positions, hoping the individually-valid
// hashes at the wrong spots go unnoticed. They don't -- each row's hash
// was computed against ITS original predecessor's hash, not whatever now
// precedes it after the swap.
cleanup();
mod = new AccountabilityModule({ dbPath: testDbPath, encryptionKeyHex: KEY });
const sessionF = mod.createSession({ engineerId: "samson", moduleName: "chain_test_f" });
const ids3: string[] = [];
for (let i = 0; i < 5; i++) {
  ids3.push(
    mod.logAction({
      sessionId: sessionF,
      initiatorRole: "AI_AGENT",
      actionName: `step_${i}`,
      alignmentState: "ALIGNED",
      inputPayload: { i },
      outputPayload: {},
    })
  );
}
{
  const db = reachDbFull(mod);
  const row2 = db.prepare("SELECT chain_seq FROM actions WHERE event_id=?").get(ids3[1]) as { chain_seq: number };
  const row4 = db.prepare("SELECT chain_seq FROM actions WHERE event_id=?").get(ids3[3]) as { chain_seq: number };
  db.exec("BEGIN IMMEDIATE");
  db.prepare("UPDATE actions SET chain_seq = -1 WHERE event_id = ?").run(ids3[1]); // dodge the unique index mid-swap
  db.prepare("UPDATE actions SET chain_seq = ? WHERE event_id = ?").run(row2.chain_seq, ids3[3]);
  db.prepare("UPDATE actions SET chain_seq = ? WHERE event_id = ?").run(row4.chain_seq, ids3[1]);
  db.exec("COMMIT");
}
result = mod.verifyChain();
if (result.valid || result.reason !== "hash_mismatch" || result.brokenAtSeq !== 2) {
  console.error("   FAILED: expected hash_mismatch at chain_seq 2 after swapping rows 2 and 4, got:", result);
  process.exit(1);
}
console.log("   OK -", JSON.stringify(result));

console.log("8. Replaying an old row's exact (validly-hashed) content in a new position is detected...");
// Red-team review #4's "replay an old row" attack: an attacker copies a
// legitimately-logged row's full content -- including its own genuinely
// correct row_hash -- into a brand new row appended at the end, hoping a
// hash that WAS once valid passes as valid again. It doesn't, because
// that hash was only ever valid linked to what preceded IT originally,
// not to whatever now precedes this new position.
cleanup();
mod = new AccountabilityModule({ dbPath: testDbPath, encryptionKeyHex: KEY });
const sessionG = mod.createSession({ engineerId: "samson", moduleName: "chain_test_g" });
const ids4: string[] = [];
for (let i = 0; i < 4; i++) {
  ids4.push(
    mod.logAction({
      sessionId: sessionG,
      initiatorRole: "AI_AGENT",
      actionName: `step_${i}`,
      alignmentState: "ALIGNED",
      inputPayload: { i },
      outputPayload: {},
    })
  );
}
{
  const db = reachDbFull(mod);
  const old = db.prepare("SELECT * FROM actions WHERE event_id = ?").get(ids4[1]) as Record<string, unknown>;
  const maxSeq = (db.prepare("SELECT MAX(chain_seq) as m FROM actions").get() as { m: number }).m;
  db.prepare(
    `INSERT INTO actions (event_id, session_id, timestamp_utc, initiator_role, action_name, alignment_state, input_payload, output_payload, action_notes, idempotency_key, chain_seq, row_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "replayed-" + (old.event_id as string),
    old.session_id,
    old.timestamp_utc,
    old.initiator_role,
    old.action_name,
    old.alignment_state,
    old.input_payload,
    old.output_payload,
    old.action_notes,
    null,
    maxSeq + 1,
    old.row_hash // the OLD row's genuinely-correct hash, replayed into a new position
  );
}
result = mod.verifyChain();
if (result.valid || result.reason !== "hash_mismatch") {
  console.error("   FAILED: expected a replayed row to be caught as hash_mismatch, got:", result);
  process.exit(1);
}
console.log("   OK -", JSON.stringify(result), "(a validly-hashed row from elsewhere in the chain doesn't pass when replayed into a new position)");

console.log("CHAIN INTEGRITY TEST COMPLETE - exit code 0");
cleanup();
