import { AccountabilityModule } from "../src/AccountabilityModule";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const testDbPath = path.join(__dirname, ".tmp_test_accountability.db");

function cleanup() {
  for (const ext of ["", "-wal", "-shm"]) {
    const p = testDbPath + ext;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

cleanup();

console.log("1. Creating module instance and initializing schema...");
const mod = new AccountabilityModule({ dbPath: testDbPath, encryptionKeyHex: "3ababc623cf6dc4d7bce7d154ccb0d4141e69e3c90e04a1104c9540ebba4f34a" });
console.log("   OK");

console.log("2. Creating a session (engineerId + moduleName required)...");
try {
  const sessionId = mod.createSession({
    engineerId: "samson",
    moduleName: "telemetry_harness",
  });
  console.log("   OK - session created:", sessionId);
} catch (err) {
  console.error("   FAILED:", (err as Error).message);
  process.exit(1);
}

const sessionId = mod.createSession({ engineerId: "samson", moduleName: "telemetry_harness" });

console.log("3. Logging an action against the session...");
try {
  mod.logAction({
    sessionId,
    initiatorRole: "AI_AGENT",
    actionName: "generate_schema_fix",
    alignmentState: "ALIGNED",
    inputPayload: { task: "fix NOT NULL contradiction" },
    outputPayload: { status: "resolved" },
  });
  console.log("   OK");
} catch (err) {
  console.error("   FAILED:", (err as Error).message);
  process.exit(1);
}

console.log("4. Attempting to close session WITHOUT attribution (should fail)...");
try {
  // updateSessionOutcomeRaw() was removed from the shipped class entirely
  // (red-team finding: a NODE_ENV runtime gate is not the same as not
  // shipping the method). To prove the DB-level CHECK constraint itself
  // is what rejects an incomplete closure -- not app-layer validation --
  // reach past the public API the same way encryption-test.ts and
  // unarchive-test.ts already do, and attempt the same incomplete raw
  // UPDATE directly.
  (mod as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => unknown } } })
    .db.prepare(
      `UPDATE sessions SET session_outcome = ?, usability_rating = ?, fault_attribution = ?, attribution_reason = ? WHERE session_id = ?`
    )
    .run("DRIFTED", null, null, null, sessionId);
  console.error("   FAILED: constraint did not reject incomplete closure");
  process.exit(1);
} catch (err) {
  console.log("   OK - correctly rejected:", (err as Error).message);
}

console.log("5. Closing session WITH full attribution (should succeed)...");
try {
  mod.updateSessionOutcome({
    sessionId,
    sessionOutcome: "DRIFTED",
    usabilityRating: "UNUSABLE",
    faultAttribution: "AI_AGENT",
    attributionReason: "Schema NOT NULL constraint contradicted the API's unassigned-state design.",
    driftTrigger: "Pass 12 added NOT NULL without accounting for in-progress sessions.",
  });
  console.log("   OK");
} catch (err) {
  console.error("   FAILED:", (err as Error).message);
  process.exit(1);
}

console.log("6. Attempting to log an action AFTER session is closed (should fail)...");
try {
  mod.logAction({
    sessionId,
    initiatorRole: "AI_AGENT",
    actionName: "post_close_action",
    alignmentState: "ALIGNED",
    inputPayload: {},
    outputPayload: {},
  });
  console.error("   FAILED: post-close action was allowed, guard did not work");
  process.exit(1);
} catch (err) {
  console.log("   OK - correctly rejected:", (err as Error).message);
}

console.log("7. Logging two actions with the same idempotencyKey (second should be rejected)...");
try {
  const idemSessionId = mod.createSession({ engineerId: "samson", moduleName: "idempotency_check" });
  mod.logAction({
    sessionId: idemSessionId,
    initiatorRole: "AI_AGENT",
    actionName: "first_attempt",
    alignmentState: "ALIGNED",
    inputPayload: { attempt: 1 },
    outputPayload: {},
    idempotencyKey: "retry-key-abc123",
  });
  try {
    mod.logAction({
      sessionId: idemSessionId,
      initiatorRole: "AI_AGENT",
      actionName: "retried_attempt",
      alignmentState: "ALIGNED",
      inputPayload: { attempt: 2 },
      outputPayload: {},
      idempotencyKey: "retry-key-abc123",
    });
    console.error("   FAILED: duplicate idempotencyKey was NOT rejected -- unique index is not reachable");
    process.exit(1);
  } catch (err) {
    const msg = (err as Error).message;
    if (!msg.includes("Duplicate action") && !msg.includes("idempotency")) {
      console.error("   FAILED: rejected, but not for the expected reason:", msg);
      process.exit(1);
    }
    console.log("   OK - correctly rejected duplicate:", msg);
  }
} catch (err) {
  console.error("   FAILED:", (err as Error).message);
  process.exit(1);
}

console.log("8. Same idempotencyKey used across two DIFFERENT sessions succeeds for both...");
try {
  // Red-team review #3, finding #3, reproduced: the original unique index
  // was on idempotency_key alone, so an unrelated session B could never
  // reuse a key session A had already used, even though nothing about
  // that was actually a duplicate of anything.
  const sessionX = mod.createSession({ engineerId: "samson", moduleName: "idempotency_scope_x" });
  const sessionY = mod.createSession({ engineerId: "samson", moduleName: "idempotency_scope_y" });
  mod.logAction({
    sessionId: sessionX,
    initiatorRole: "AI_AGENT",
    actionName: "first_session_action",
    alignmentState: "ALIGNED",
    inputPayload: {},
    outputPayload: {},
    idempotencyKey: "shared-across-sessions",
  });
  mod.logAction({
    sessionId: sessionY,
    initiatorRole: "AI_AGENT",
    actionName: "unrelated_second_session_action",
    alignmentState: "ALIGNED",
    inputPayload: {},
    outputPayload: {},
    idempotencyKey: "shared-across-sessions",
  });
  console.log("   OK - same key across two unrelated sessions is not treated as a duplicate");
} catch (err) {
  console.error("   FAILED: cross-session key reuse was incorrectly rejected:", (err as Error).message);
  process.exit(1);
}

console.log("INTEGRATION TEST COMPLETE - exit code 0");
mod.close();
cleanup();
