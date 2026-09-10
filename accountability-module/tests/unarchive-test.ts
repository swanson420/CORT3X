// Covers a real gap: unarchiveSession() existed (flag #8) but was never
// called by any test -- runMaintenance()'s archive path was verified,
// its reverse was not.

import { AccountabilityModule } from "../src/AccountabilityModule";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(__dirname, ".tmp_test_unarchive.db");
const KEY = "3ababc623cf6dc4d7bce7d154ccb0d4141e69e3c90e04a1104c9540ebba4f34a";

function cleanup() {
  for (const ext of ["", "-wal", "-shm"]) {
    const p = testDbPath + ext;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

cleanup();

console.log("1. Creating a session and closing it (60 days old)...");
const mod = new AccountabilityModule({ dbPath: testDbPath, encryptionKeyHex: KEY });
// Previously: createSession() -> updateSessionOutcome() -> raw UPDATE to
// backdate last_updated_at_utc. Now correctly rejected by
// prevent_reclosing_sessions after last_updated_at_utc joined its UPDATE
// OF list -- a post-close UPDATE to that column is exactly what the fix
// is supposed to block, raw SQL included. Fixed by inserting the row
// already closed and already backdated in one INSERT instead, same
// approach as retention-test.ts.
const sessionId = crypto.randomUUID();
const backdated = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
(mod as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => unknown } } })
  .db.prepare(
    `INSERT INTO sessions (
      session_id, engineer_id, module_name, created_at_utc, last_updated_at_utc,
      session_outcome, usability_rating, fault_attribution, attribution_reason
    ) VALUES (?, ?, ?, ?, ?, 'COMPLETED', 'USABLE', 'HUMAN_ENGINEER', ?)`
  )
  .run(sessionId, "samson", "unarchive_test", backdated, backdated, "Normal completion.");
console.log("   OK");

console.log("2. Archiving it via runMaintenance()...");
const { archivedCount } = mod.runMaintenance({ retentionDays: 30 });
if (archivedCount !== 1) {
  console.error(`   FAILED: expected 1 session archived, got ${archivedCount}`);
  process.exit(1);
}
console.log("   OK - archivedCount:", archivedCount);

console.log("3. Calling unarchiveSession() on it...");
try {
  mod.unarchiveSession(sessionId);
  console.log("   OK");
} catch (err) {
  console.error("   FAILED:", (err as Error).message);
  process.exit(1);
}

console.log("4. Confirming is_archived is back to 0 (and row still has its data)...");
const row = (mod as unknown as { db: { prepare: (q: string) => { get: (id: string) => Record<string, unknown> | undefined } } })
  .db.prepare("SELECT is_archived, session_outcome FROM sessions WHERE session_id = ?")
  .get(sessionId);
if (!row || row.is_archived !== 0) {
  console.error("   FAILED: session is still archived after unarchiveSession():", row);
  process.exit(1);
}
if (row.session_outcome !== "COMPLETED") {
  console.error("   FAILED: unarchiving corrupted unrelated fields:", row);
  process.exit(1);
}
console.log("   OK -", row);

console.log("5. Calling unarchiveSession() on a nonexistent session_id throws (not a silent no-op)...");
try {
  mod.unarchiveSession("00000000-0000-0000-0000-000000000000");
  console.error("   FAILED: expected a throw for unknown session_id, got silent success");
  process.exit(1);
} catch (err) {
  console.log("   OK - correctly rejected:", (err as Error).message);
}

console.log("6. Attempting to re-close/rewrite attribution on an already-closed session is rejected...");
try {
  mod.updateSessionOutcome({
    sessionId,
    sessionOutcome: "ABANDONED",
    usabilityRating: "DEGRADED",
    faultAttribution: "SYSTEM_ENVIRONMENT",
    attributionReason: "Trying to silently rewrite the original attribution.",
  });
  console.error("   FAILED: re-close was allowed -- closed session fields are not actually frozen");
  process.exit(1);
} catch (err) {
  const msg = (err as Error).message;
  if (!msg.includes("already closed")) {
    console.error("   FAILED: rejected, but not for the expected reason:", msg);
    process.exit(1);
  }
  console.log("   OK - correctly rejected:", msg);
}

console.log("7. Confirming archive/unarchive still work on that same closed session (trigger doesn't overreach)...");
try {
  mod.runMaintenance({ retentionDays: -1 }); // force-archive everything eligible right now
  const archived = (mod as unknown as { db: { prepare: (q: string) => { get: (id: string) => Record<string, unknown> | undefined } } })
    .db.prepare("SELECT is_archived FROM sessions WHERE session_id = ?")
    .get(sessionId);
  if (archived?.is_archived !== 1) {
    console.error("   FAILED: session was not archived as expected -- got", archived);
    process.exit(1);
  }
  mod.unarchiveSession(sessionId);
  const unarchived = (mod as unknown as { db: { prepare: (q: string) => { get: (id: string) => Record<string, unknown> | undefined } } })
    .db.prepare("SELECT is_archived FROM sessions WHERE session_id = ?")
    .get(sessionId);
  if (unarchived?.is_archived !== 0) {
    console.error("   FAILED: session was not unarchived as expected -- got", unarchived);
    process.exit(1);
  }
  console.log("   OK - archive/unarchive both still succeed on a closed session; only outcome/attribution fields are frozen");
} catch (err) {
  console.error("   FAILED: archive or unarchive was blocked by the new trigger:", (err as Error).message);
  process.exit(1);
}

console.log("8. DRIFTED outcome without a drift_trigger is rejected by the schema...");
try {
  const driftSessionId = mod.createSession({ engineerId: "samson", moduleName: "drift_check" });
  try {
    mod.updateSessionOutcome({
      sessionId: driftSessionId,
      sessionOutcome: "DRIFTED",
      usabilityRating: "UNUSABLE",
      faultAttribution: "AI_AGENT",
      attributionReason: "Session drifted, but no trigger explanation supplied.",
      // driftTrigger intentionally omitted
    });
    console.error("   FAILED: DRIFTED without drift_trigger was allowed");
    process.exit(1);
  } catch (err) {
    const msg = (err as Error).message;
    if (!msg.includes("drifted_sessions_need_trigger")) {
      console.error("   FAILED: rejected, but not for the expected reason:", msg);
      process.exit(1);
    }
    console.log("   OK - correctly rejected:", msg);
  }
  console.log("   Confirming DRIFTED WITH a drift_trigger succeeds...");
  mod.updateSessionOutcome({
    sessionId: driftSessionId,
    sessionOutcome: "DRIFTED",
    usabilityRating: "UNUSABLE",
    faultAttribution: "AI_AGENT",
    attributionReason: "Session drifted from spec.",
    driftTrigger: "Requirements changed mid-session.",
  });
  console.log("   OK");
} catch (err) {
  console.error("   FAILED:", (err as Error).message);
  process.exit(1);
}

mod.close();
console.log("UNARCHIVE TEST COMPLETE - exit code 0");
cleanup();
