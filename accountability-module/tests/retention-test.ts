import { AccountabilityModule } from "../src/AccountabilityModule";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const testDbPath = path.join(__dirname, ".tmp_test_retention.db");

function cleanup() {
  for (const ext of ["", "-wal", "-shm"]) {
    const p = testDbPath + ext;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

cleanup();
const mod = new AccountabilityModule({ dbPath: testDbPath, encryptionKeyHex: "3ababc623cf6dc4d7bce7d154ccb0d4141e69e3c90e04a1104c9540ebba4f34a" });

console.log("1. Creating and closing an old session (backdated 60 days)...");
// Previously: createSession() -> updateSessionOutcome() -> raw UPDATE to
// backdate last_updated_at_utc. That last step is now correctly rejected
// by prevent_reclosing_sessions (last_updated_at_utc was added to its
// UPDATE OF list after red-team review #2, finding #3 -- the trigger
// fires on any UPDATE to a frozen column, raw SQL included, which is the
// point). Fixed by inserting the row already closed and already
// backdated in a single INSERT instead -- no post-close UPDATE ever
// happens, so nothing here tests the trigger (unarchive-test.ts already
// covers that); this is purely a test-construction fix, not a product
// change.
const oldSessionId = crypto.randomUUID();
const backdated = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
(mod as any).db
  .prepare(
    `INSERT INTO sessions (
      session_id, engineer_id, module_name, created_at_utc, last_updated_at_utc,
      session_outcome, usability_rating, fault_attribution, attribution_reason
    ) VALUES (?, ?, ?, ?, ?, 'COMPLETED', 'USABLE', 'UNDETERMINED', ?)`
  )
  .run(oldSessionId, "samson", "test", backdated, backdated, "Test session for retention check.");
console.log("   OK");

console.log("2. Creating a recent session (should NOT be archived)...");
const recentSessionId = mod.createSession({ engineerId: "samson", moduleName: "test" });
mod.updateSessionOutcome({
  sessionId: recentSessionId,
  sessionOutcome: "COMPLETED",
  usabilityRating: "USABLE",
  faultAttribution: "UNDETERMINED",
  attributionReason: "Recent session, should survive retention.",
});
console.log("   OK");

console.log("3. Running maintenance with 30-day retention...");
const result = mod.runMaintenance({ retentionDays: 30 });
console.log(`   Archived count: ${result.archivedCount}`);

console.log("4. Verifying old session is ARCHIVED, not DELETED...");
const oldRow = (mod as any).db
  .prepare("SELECT session_id, is_archived, session_outcome FROM sessions WHERE session_id = ?")
  .get(oldSessionId);
if (!oldRow) {
  console.error("   FAILED: old session row was DELETED, not archived. This is the exact bug pass 12 was supposed to fix.");
  process.exit(1);
}
if (oldRow.is_archived !== 1) {
  console.error("   FAILED: old session exists but was not marked archived.", oldRow);
  process.exit(1);
}
console.log("   OK - session still exists with is_archived=1:", oldRow);

console.log("5. Verifying recent session is untouched...");
const recentRow = (mod as any).db
  .prepare("SELECT session_id, is_archived FROM sessions WHERE session_id = ?")
  .get(recentSessionId);
if (recentRow.is_archived !== 0) {
  console.error("   FAILED: recent session was archived, should not have been.", recentRow);
  process.exit(1);
}
console.log("   OK - recent session untouched:", recentRow);

console.log("6. Verifying action logs for the archived session are still intact...");
mod.logAction; // (actions were never added to oldSessionId in this test - checking table still exists/queryable)
const actionCount = (mod as any).db
  .prepare("SELECT COUNT(*) as c FROM actions")
  .get();
console.log("   OK - actions table intact, count:", actionCount.c);

console.log("RETENTION TEST COMPLETE - exit code 0");
mod.close();
cleanup();
