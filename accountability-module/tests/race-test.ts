// Exercises the exact race the red-team review flagged: logAction()'s
// outcome-check and its INSERT used to be two separate statements, so
// another connection could close the session in the gap between them.
// This spawns several separate OS processes (not just threads) hammering
// logAction() while the main process closes the session mid-flight, then
// asserts that NOT ONE action ended up logged against a session that was
// already finalized at the moment its check ran.

import { spawn } from "child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AccountabilityModule } from "../src/AccountabilityModule";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = path.join(__dirname, ".race_tmp_accountability.db");
const WORKER_SCRIPT = path.join(__dirname, "race-worker.ts");
const NUM_WORKERS = 6;
const WORKER_DURATION_MS = 4000;
const CLOSE_DELAY_MS = 1500; // give processes time to actually spawn and start logging first
const TEST_KEY = "3ababc623cf6dc4d7bce7d154ccb0d4141e69e3c90e04a1104c9540ebba4f34a";

async function main() {
  for (const ext of ["", "-wal", "-shm"]) {
    const p = TEST_DB_PATH + ext;
    if (fs.existsSync(p)) fs.rmSync(p);
  }

  console.log("--- RACE TEST: logAction() vs updateSessionOutcome() (multi-process) ---");

  const mod = new AccountabilityModule({ dbPath: TEST_DB_PATH, encryptionKeyHex: TEST_KEY });
  const sessionId = mod.createSession({ engineerId: "race_tester", moduleName: "race-test" });
  mod.close();

  // Spawn real child processes, each running race-worker.ts via tsx.
  // Previously this hand-built --require/--import flags pointing at
  // /home/claude/.npm-global/... (tsx's internal loader paths) -- worked
  // only in the one sandbox that happened to have tsx installed at that
  // exact location, broke anywhere else, including plain CI. `npx tsx`
  // is what every other test file in this suite already uses; let tsx
  // resolve its own loader instead of hardcoding where it lives.
  const children = Array.from({ length: NUM_WORKERS }, (_, i) =>
    spawn(
      "npx",
      [
        "tsx",
        WORKER_SCRIPT,
        TEST_DB_PATH,
        sessionId,
        String(WORKER_DURATION_MS),
        String(i),
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    )
  );

  // Wait for every child to actually be past startup and into its loop,
  // instead of guessing a fixed delay. tsx cold-start under concurrent
  // spawn load in a sandboxed CPU is what caused the first version of this
  // test to see 0 successful writes — every worker's first attempt landed
  // after the fixed-delay close because process startup alone exceeded it.
  const readySignals = children.map(
    (child) =>
      new Promise<void>((resolve) => {
        const onData = (d: Buffer) => {
          if (d.toString().includes("READY")) {
            child.stdout?.off("data", onData);
            resolve();
          }
        };
        child.stdout?.on("data", onData);
      })
  );
  await Promise.all(readySignals);
  console.log(`All ${NUM_WORKERS} workers confirmed READY and looping.`);

  // Now give them a real window to succeed before closing.
  await new Promise((res) => setTimeout(res, 500));
  const closerMod = new AccountabilityModule({ dbPath: TEST_DB_PATH, encryptionKeyHex: TEST_KEY });
  closerMod.updateSessionOutcome({
    sessionId,
    sessionOutcome: "COMPLETED",
    usabilityRating: "USABLE",
    faultAttribution: "UNDETERMINED",
    attributionReason: "Closed mid-race by race-test.ts.",
  });
  const closeTimestamp = new Date().toISOString();
  closerMod.close();
  console.log(`Session closed at ${closeTimestamp}, ${NUM_WORKERS} worker processes still running...`);

  let totalSucceeded = 0;
  let totalRejected = 0;
  let stderrOutput = "";

  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          let stdout = "";
          child.stdout?.on("data", (d) => (stdout += d.toString()));
          child.stderr?.on("data", (d) => (stderrOutput += d.toString()));
          child.on("close", () => {
            const match = stdout.match(/RESULT (\{.*\})/);
            if (match) {
              const parsed = JSON.parse(match[1]);
              totalSucceeded += parsed.succeeded;
              totalRejected += parsed.rejected;
            }
            resolve();
          });
        })
    )
  );

  if (stderrOutput.trim()) {
    console.log("--- worker stderr (for diagnosis) ---");
    console.log(stderrOutput.trim().split("\n").slice(0, 10).join("\n"));
  }

  // The actual invariant: query the DB directly for any action logged
  // AFTER the session's outcome stopped being IN_PROGRESS. If the fix
  // holds, this must be zero, regardless of how many processes were racing.
  const checkDb = new DatabaseSync(TEST_DB_PATH);
  const sessionRow = checkDb
    .prepare("SELECT session_outcome FROM sessions WHERE session_id = ?")
    .get(sessionId) as { session_outcome: string };
  const violatingActions = checkDb
    .prepare(`SELECT COUNT(*) as c FROM actions WHERE session_id = ? AND timestamp_utc > ?`)
    .get(sessionId, closeTimestamp) as { c: number };
  checkDb.close();

  console.log(`Actions logged successfully (while IN_PROGRESS): ${totalSucceeded}`);
  console.log(`Actions correctly rejected (session already finalized): ${totalRejected}`);
  console.log(`Session final outcome: ${sessionRow.session_outcome}`);
  console.log(`Actions logged AFTER close timestamp (should be 0): ${violatingActions.c}`);

  for (const ext of ["", "-wal", "-shm"]) {
    const p = TEST_DB_PATH + ext;
    if (fs.existsSync(p)) fs.rmSync(p);
  }

  if (violatingActions.c === 0 && (totalSucceeded > 0 || totalRejected > 0)) {
    console.log("RESULT: PASS - no action was logged against an already-finalized session.");
    process.exit(0);
  } else {
    console.log("RESULT: FAIL - either the race condition is present, or no workers ran.");
    process.exit(1);
  }
}

main();
