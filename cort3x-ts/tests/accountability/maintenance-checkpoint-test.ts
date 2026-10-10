// runMaintenance() used to run PRAGMA wal_checkpoint(TRUNCATE) via .exec()
// and discard the result, so a blocked or partial checkpoint was invisible
// to the caller -- the same blind spot the stress test had (see the
// "Stress test flake" entry in docs/accountability/VERIFICATION_LOG.md).
// It now returns { busy, log, checkpointed, complete }. This checks that
// each outcome is reported truthfully, and that a blocked checkpoint never
// undoes or hides the archive step that ran before it.
import { AccountabilityModule } from "../../src/accountability/AccountabilityModule.js";
import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(__dirname, ".tmp_test_maintenance_checkpoint.db");
const walPath = `${testDbPath}-wal`;
const TEST_KEY = "3ababc623cf6dc4d7bce7d154ccb0d4141e69e3c90e04a1104c9540ebba4f34a";

function cleanup() {
  for (const ext of ["", "-wal", "-shm"]) {
    const p = testDbPath + ext;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

function fail(msg: string, detail?: unknown): never {
  console.error(`   FAILED: ${msg}`, detail ?? "");
  process.exit(1);
}

function walSize(): number {
  return fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
}

function closedSession(mod: AccountabilityModule): string {
  const id = mod.createSession({ engineerId: "maint_tester", moduleName: "maintenance-checkpoint-test" });
  mod.updateSessionOutcome({
    sessionId: id,
    sessionOutcome: "COMPLETED",
    usabilityRating: "USABLE",
    faultAttribution: "UNDETERMINED",
    attributionReason: "Closed so runMaintenance can archive it.",
  });
  return id;
}

function isArchived(mod: AccountabilityModule, sessionId: string): number {
  const row = (mod as any).db.prepare("SELECT is_archived FROM sessions WHERE session_id = ?").get(sessionId);
  return row?.is_archived;
}

cleanup();
const mod = new AccountabilityModule({ dbPath: testDbPath, encryptionKeyHex: TEST_KEY });
// The module waits up to 5s on a busy WAL; shorten it here so the blocked
// case returns quickly. Only the wait changes, not the checkpoint logic.
(mod as any).db.exec("PRAGMA busy_timeout = 200");

console.log("1. Quiescent: checkpoint completes and truncates the WAL...");
const s1 = closedSession(mod);
// retentionDays -1 puts the cutoff in the future, so a just-closed session qualifies.
const r1 = mod.runMaintenance({ retentionDays: -1 });
if (r1.archivedCount !== 1) fail("expected 1 session archived", r1);
if (!r1.checkpoint.complete) fail("checkpoint should be complete with no other connections", r1.checkpoint);
if (r1.checkpoint.busy !== 0) fail("busy should be 0", r1.checkpoint);
if (walSize() !== 0) fail(`WAL should be truncated to 0 bytes, is ${walSize()}`);
if (isArchived(mod, s1) !== 1) fail("session not archived");
console.log("   OK -", JSON.stringify(r1));

console.log("2. Blocked: a reader holding an old snapshot stops the checkpoint...");
const reader = new DatabaseSync(testDbPath);
reader.exec("BEGIN");
reader.prepare("SELECT count(*) FROM sessions").get(); // pins the snapshot
const s2 = closedSession(mod); // these frames land after the reader's snapshot
const r2 = mod.runMaintenance({ retentionDays: -1 });
if (r2.checkpoint.complete) fail("checkpoint reported complete while a reader pinned the WAL", r2.checkpoint);
if (r2.checkpoint.busy !== 1) fail("busy should be 1 when blocked", r2.checkpoint);
if (!(r2.checkpoint.log > 0)) fail("log should count the frames left in the WAL", r2.checkpoint);
if (walSize() === 0) fail("WAL should not have been truncated while blocked");
// The archive ran before the checkpoint and is already committed; a
// blocked checkpoint must not undo or hide it.
if (r2.archivedCount !== 1) fail("archive should still report its work when the checkpoint is blocked", r2);
if (isArchived(mod, s2) !== 1) fail("session should be archived even though the checkpoint was blocked");
console.log("   OK -", JSON.stringify(r2));

console.log("3. Recovery: once the reader lets go, the next run completes...");
reader.exec("COMMIT");
reader.close();
const r3 = mod.runMaintenance({ retentionDays: -1 });
if (!r3.checkpoint.complete) fail("checkpoint should complete after the reader released", r3.checkpoint);
if (walSize() !== 0) fail(`WAL should be truncated after recovery, is ${walSize()}`);
if (r3.archivedCount !== 0) fail("nothing new to archive", r3);
console.log("   OK -", JSON.stringify(r3));

console.log("4. Not in WAL mode: reported as not complete, not as success...");
(mod as any).db.exec("PRAGMA journal_mode = DELETE");
const r4 = mod.runMaintenance({ retentionDays: -1 });
if (r4.checkpoint.complete) fail("a non-WAL database has nothing checkpointed; must not report complete", r4.checkpoint);
if (r4.checkpoint.log !== -1) fail("SQLite reports log = -1 outside WAL mode", r4.checkpoint);
console.log("   OK -", JSON.stringify(r4));

mod.close();
cleanup();
console.log("MAINTENANCE CHECKPOINT TEST COMPLETE - exit code 0");
