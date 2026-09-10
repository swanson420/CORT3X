import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename2 = fileURLToPath(import.meta.url);
const __dirname2 = path.dirname(__filename2);

const TEST_DB_PATH = path.join(__dirname2, ".stress_tmp_accountability.db");
const NUM_WRITE_WORKERS = 20;
const DURATION_MS = 10000;
const WAL_SIZE_TARGET_BYTES = 500 * 1024;
// Some incomplete checkpoints are expected under sustained write load (a
// writer can legitimately be mid-transaction when TRUNCATE runs) -- the
// bug was that this signal was discarded entirely, not that >0 is
// inherently a failure. Fail only if checkpoints are *mostly* incomplete,
// which indicates checkpointing isn't keeping up at all.
const INCOMPLETE_CHECKPOINT_FAIL_RATIO = 0.5;

if (isMainThread) {
  runMasterCoordinator();
} else {
  runWorkerTask();
}

async function runMasterCoordinator() {
  for (const ext of ["", "-wal", "-shm"]) {
    const p = TEST_DB_PATH + ext;
    if (fs.existsSync(p)) fs.rmSync(p);
  }

  console.log("--- STARTING REAL STRESS TEST (node:sqlite, actually executed) ---");
  console.log(`Workers: ${NUM_WRITE_WORKERS}, Duration: ${DURATION_MS}ms`);

  const initDb = new DatabaseSync(TEST_DB_PATH);
  initDb.exec("PRAGMA journal_mode = WAL");
  initDb.exec("PRAGMA busy_timeout = 5000");
  const schema = fs.readFileSync(path.join(__dirname2, "..", "schema.sql"), "utf8");
  initDb.exec(schema);
  initDb.close();

  const workers: Worker[] = [];
  for (let i = 0; i < NUM_WRITE_WORKERS; i++) {
    workers.push(
      new Worker(__filename2, { workerData: { dbPath: TEST_DB_PATH, workerId: i } })
    );
  }

  workers.forEach((w) => w.postMessage({ start: true }));

  const maintDb = new DatabaseSync(TEST_DB_PATH);
  maintDb.exec("PRAGMA busy_timeout = 5000");
  let maintenanceRuns = 0;
  let maintenanceErrors = 0;
  let incompleteCheckpoints = 0;
  let totalFramesRemaining = 0;
  const maintInterval = setInterval(() => {
    try {
      // PRAGMA wal_checkpoint(TRUNCATE) does NOT throw when it can only do a
      // partial checkpoint — it returns busy=1 / log/checkpointed frame
      // counts instead. .exec() discards that; .get() surfaces it, which is
      // the fix for the flag: "silently discards partial-failure signal."
      const row = maintDb.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
        | { busy: number; log: number; checkpointed: number }
        | undefined;
      maintenanceRuns++;
      if (row && (row.busy === 1 || row.checkpointed < row.log)) {
        incompleteCheckpoints++;
        totalFramesRemaining += row.log - row.checkpointed;
      }
    } catch (err) {
      maintenanceErrors++;
      console.error("[maintenance error]:", (err as Error).message);
    }
  }, 500);

  await new Promise((res) => setTimeout(res, DURATION_MS));
  clearInterval(maintInterval);
  maintDb.close();
  workers.forEach((w) => w.postMessage({ stop: true }));

  let totalWrites = 0;
  let totalLockErrors = 0;
  let totalOtherErrors = 0;

  await Promise.all(
    workers.map(
      (w) =>
        new Promise<void>((resolve) => {
          w.on("message", (msg) => {
            totalWrites += msg.writes;
            totalLockErrors += msg.lockErrors;
            totalOtherErrors += msg.otherErrors;
            resolve();
          });
        })
    )
  );

  const walPath = `${TEST_DB_PATH}-wal`;
  const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;

  console.log("\n--- REAL STRESS TEST RESULTS ---");
  console.log(`Total Successful Writes: ${totalWrites}`);
  console.log(`Lock Errors (SQLITE_BUSY): ${totalLockErrors}`);
  console.log(`Other Errors: ${totalOtherErrors}`);
  console.log(`Maintenance/Checkpoint Runs: ${maintenanceRuns}`);
  console.log(`Maintenance Errors (thrown): ${maintenanceErrors}`);
  console.log(`Incomplete Checkpoints (silent partial, busy=1): ${incompleteCheckpoints} / ${maintenanceRuns}`);
  console.log(`Total WAL Frames Left Unchecked Across Run: ${totalFramesRemaining}`);
  console.log(`Post-Checkpoint WAL File Size: ${(walSize / 1024).toFixed(2)} KB (spec target: < 500 KB)`);

  for (const ext of ["", "-wal", "-shm"]) {
    const p = TEST_DB_PATH + ext;
    if (fs.existsSync(p)) fs.rmSync(p);
  }

  // Previously this gate only checked totalOtherErrors === 0, so a WAL
  // blowout or checkpointing that never keeps up would still print PASS.
  // Both are now real failure conditions, not just diagnostic prints.
  const failures: string[] = [];
  if (totalOtherErrors !== 0) {
    failures.push(`${totalOtherErrors} unexpected (non-lock-contention) write errors`);
  }
  if (walSize > WAL_SIZE_TARGET_BYTES) {
    failures.push(
      `WAL size ${(walSize / 1024).toFixed(2)} KB exceeds spec target of ${(WAL_SIZE_TARGET_BYTES / 1024).toFixed(0)} KB`
    );
  }
  const incompleteRatio = maintenanceRuns > 0 ? incompleteCheckpoints / maintenanceRuns : 0;
  if (incompleteRatio > INCOMPLETE_CHECKPOINT_FAIL_RATIO) {
    failures.push(
      `${incompleteCheckpoints}/${maintenanceRuns} checkpoints incomplete (${(incompleteRatio * 100).toFixed(0)}%, threshold ${(INCOMPLETE_CHECKPOINT_FAIL_RATIO * 100).toFixed(0)}%) -- checkpointing is not keeping up with write volume`
    );
  }

  if (failures.length === 0) {
    console.log("RESULT: PASS - writes clean, WAL size within spec, checkpointing kept up.");
    process.exit(0);
  } else {
    console.log("RESULT: FAIL:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

function runWorkerTask() {
  const { dbPath, workerId } = workerData as { dbPath: string; workerId: number };
  let running = false;
  let writes = 0;
  let lockErrors = 0;
  let otherErrors = 0;

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");

  parentPort?.on("message", (msg) => {
    if (msg.start) {
      running = true;
      loop();
    } else if (msg.stop) {
      running = false;
      parentPort?.postMessage({ workerId, writes, lockErrors, otherErrors });
      db.close();
      process.exit(0);
    }
  });

  function loop() {
    if (!running) return;
    try {
      const sessionId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO sessions (session_id, engineer_id, module_name, created_at_utc, last_updated_at_utc)
         VALUES (?, ?, ?, ?, ?)`
      ).run(sessionId, `worker_${workerId}`, "stress_test", now, now);
      writes++;
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("SQLITE_BUSY") || message.includes("database is locked")) {
        lockErrors++;
      } else {
        otherErrors++;
        console.error(`[Worker ${workerId} unexpected error]:`, message);
      }
    }
    setImmediate(loop);
  }
}
