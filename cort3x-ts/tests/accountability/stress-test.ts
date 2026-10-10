import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename2 = fileURLToPath(import.meta.url);
const __dirname2 = path.dirname(__filename2);

const TEST_DB_PATH = path.join(__dirname2, ".stress_tmp_accountability.db");
const WAL_PATH = `${TEST_DB_PATH}-wal`;
const NUM_WRITE_WORKERS = 20;
const DURATION_MS = 10000;
const CHECKPOINT_INTERVAL_MS = 500;
const WAL_SAMPLE_INTERVAL_MS = 50;
// A worker that never reports back must fail the run, not hang it or let
// it exit silently -- see the note on runMasterCoordinator's .catch below.
const WORKER_REPORT_TIMEOUT_MS = 15000;
const WAL_SIZE_TARGET_BYTES = 500 * 1024;
// Some incomplete checkpoints are expected under sustained write load (a
// writer can legitimately be mid-transaction when TRUNCATE runs) -- the
// bug was that this signal was discarded entirely, not that >0 is
// inherently a failure. Fail only if checkpoints are *mostly* incomplete,
// which indicates checkpointing isn't keeping up at all.
const INCOMPLETE_CHECKPOINT_FAIL_RATIO = 0.5;

// Why the 500 KB target is checked right after a completed checkpoint, not
// once at the end of the run:
//
// The old gate stat'd the WAL once, after the last checkpoint but while
// all 20 writers were still running. Every insert here is its own commit
// and appends ~15-19 KB of WAL frames (table page + index pages), so the
// end-of-run size was just "writes that landed in the 0-500 ms since the
// last checkpoint", capped near 4 MB where SQLite's auto-checkpoint wraps
// the WAL. Instrumented runs: a checkpoint that completed always left the
// WAL at 0 KB, and a checkpoint once writers stopped always completed and
// truncated to 0 KB. Only runs with ~20 writes in that trailing window
// came in under 500 KB, which is why the old gate flipped between pass
// and fail with nothing actually wrong (and why the log called it
// "bimodal").
//
// What the gates check now:
//   1. Every checkpoint that reports complete (busy=0, all frames
//      backfilled) leaves the WAL under the 500 KB target.
//   2. Checkpointing keeps up: no more than half the checkpoints were
//      partial.
//   3. The WAL never grows past twice its auto-checkpoint high-water mark
//      at any point in the run. This is the real blowout the log recorded
//      (62-73 MB runs): checkpoints starved and the WAL grew without limit.
//      The old gate only caught it if the blowout happened to still be in
//      place at the last instant.
//   4. Once writers stop, a final TRUNCATE checkpoint completes and leaves
//      the WAL under target, so nothing is left stuck in the WAL.
//   5. Every worker reports, and no unexpected (non-lock) write errors.

type CheckpointRow = { busy: number; log: number; checkpointed: number };
type WorkerReport = { workerId: number; writes: number; lockErrors: number; otherErrors: number };

function walSize(): number {
  return fs.existsSync(WAL_PATH) ? fs.statSync(WAL_PATH).size : 0;
}

function isComplete(row: CheckpointRow): boolean {
  return row.busy === 0 && row.checkpointed === row.log;
}

function removeDbFiles() {
  for (const ext of ["", "-wal", "-shm"]) {
    const p = TEST_DB_PATH + ext;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

if (isMainThread) {
  // runMasterCoordinator used to be a floating promise. If it rejected,
  // or a worker's result never arrived, the process could exit 0 with no
  // RESULT line at all, which npm test's && chain counts as a pass.
  // Anything other than an explicit PASS now exits non-zero.
  runMasterCoordinator().catch((err) => {
    console.error("RESULT: FAIL - stress test crashed:", err);
    process.exit(1);
  });
  process.on("beforeExit", () => {
    console.error("RESULT: FAIL - event loop drained before the stress test reached a verdict.");
    process.exit(1);
  });
} else {
  runWorkerTask();
}

async function runMasterCoordinator() {
  removeDbFiles();

  console.log("--- STARTING REAL STRESS TEST (node:sqlite, actually executed) ---");
  console.log(`Workers: ${NUM_WRITE_WORKERS}, Duration: ${DURATION_MS}ms`);

  const initDb = new DatabaseSync(TEST_DB_PATH);
  initDb.exec("PRAGMA journal_mode = WAL");
  initDb.exec("PRAGMA busy_timeout = 5000");
  const schema = fs.readFileSync(path.join(__dirname2, "..", "..", "src", "accountability", "schema.sql"), "utf8");
  initDb.exec(schema);
  const pageSize = (initDb.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
  const autoCheckpointPages = (initDb.prepare("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number })
    .wal_autocheckpoint;
  initDb.close();
  // A WAL frame is a 24-byte header plus one page; the file has a 32-byte
  // header. Auto-checkpoint keeps a healthy WAL near autoCheckpointPages
  // frames, so 2x that means checkpoints are not keeping up.
  const walCeilingBytes = 2 * autoCheckpointPages * (pageSize + 24) + 32;

  const workers: Worker[] = [];
  const reports: Promise<WorkerReport>[] = [];
  for (let i = 0; i < NUM_WRITE_WORKERS; i++) {
    const w = new Worker(__filename2, { workerData: { dbPath: TEST_DB_PATH, workerId: i } });
    workers.push(w);
    // Attach before start so a report can never arrive unheard, and
    // settle on exit/error too so a lost report fails instead of hanging.
    reports.push(
      new Promise<WorkerReport>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`worker ${i} did not report within ${WORKER_REPORT_TIMEOUT_MS}ms of stop`)),
          DURATION_MS + WORKER_REPORT_TIMEOUT_MS
        );
        w.once("message", (msg: WorkerReport) => {
          clearTimeout(timer);
          resolve(msg);
        });
        w.once("error", (err) => {
          clearTimeout(timer);
          reject(new Error(`worker ${i} crashed: ${err.message}`));
        });
        w.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`worker ${i} exited (code ${code}) without reporting`));
        });
      })
    );
  }

  workers.forEach((w) => w.postMessage({ start: true }));

  let maxWalSize = 0;
  const walSampler = setInterval(() => {
    maxWalSize = Math.max(maxWalSize, walSize());
  }, WAL_SAMPLE_INTERVAL_MS);

  const maintDb = new DatabaseSync(TEST_DB_PATH);
  maintDb.exec("PRAGMA busy_timeout = 5000");
  let maintenanceRuns = 0;
  let maintenanceErrors = 0;
  let incompleteCheckpoints = 0;
  let totalFramesRemaining = 0;
  let maxSizeAfterCompleteCheckpoint = 0;
  const maintInterval = setInterval(() => {
    try {
      // PRAGMA wal_checkpoint(TRUNCATE) does NOT throw when it can only do a
      // partial checkpoint — it returns busy=1 / log/checkpointed frame
      // counts instead. .exec() discards that; .get() surfaces it, which is
      // the fix for the flag: "silently discards partial-failure signal."
      const row = maintDb.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as CheckpointRow | undefined;
      const sizeAfter = walSize();
      maintenanceRuns++;
      maxWalSize = Math.max(maxWalSize, sizeAfter);
      if (!row || !isComplete(row)) {
        incompleteCheckpoints++;
        if (row) totalFramesRemaining += row.log - row.checkpointed;
      } else {
        maxSizeAfterCompleteCheckpoint = Math.max(maxSizeAfterCompleteCheckpoint, sizeAfter);
      }
    } catch (err) {
      maintenanceErrors++;
      console.error("[maintenance error]:", (err as Error).message);
    }
  }, CHECKPOINT_INTERVAL_MS);

  await new Promise((res) => setTimeout(res, DURATION_MS));
  clearInterval(maintInterval);
  workers.forEach((w) => w.postMessage({ stop: true }));

  const settled = await Promise.allSettled(reports);
  clearInterval(walSampler);
  maxWalSize = Math.max(maxWalSize, walSize());

  const missingReports: string[] = [];
  let totalWrites = 0;
  let totalLockErrors = 0;
  let totalOtherErrors = 0;
  for (const s of settled) {
    if (s.status === "fulfilled") {
      totalWrites += s.value.writes;
      totalLockErrors += s.value.lockErrors;
      totalOtherErrors += s.value.otherErrors;
    } else {
      missingReports.push((s.reason as Error).message);
    }
  }

  // All writers are closed now, so this checkpoint has nothing to wait on.
  // If it still can't complete, something is holding the WAL.
  const finalRow = maintDb.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as CheckpointRow | undefined;
  const finalWalSize = walSize();
  maintDb.close();

  const kb = (bytes: number) => `${(bytes / 1024).toFixed(2)} KB`;
  console.log("\n--- REAL STRESS TEST RESULTS ---");
  console.log(`Total Successful Writes: ${totalWrites}`);
  console.log(`Workers Reported: ${NUM_WRITE_WORKERS - missingReports.length} / ${NUM_WRITE_WORKERS}`);
  console.log(`Lock Errors (SQLITE_BUSY): ${totalLockErrors}`);
  console.log(`Other Errors: ${totalOtherErrors}`);
  console.log(`Maintenance/Checkpoint Runs: ${maintenanceRuns}`);
  console.log(`Maintenance Errors (thrown): ${maintenanceErrors}`);
  console.log(`Incomplete Checkpoints (partial, busy=1 or frames left): ${incompleteCheckpoints} / ${maintenanceRuns}`);
  console.log(`Total WAL Frames Left Unchecked Across Run: ${totalFramesRemaining}`);
  console.log(`Max WAL Size After A Complete Checkpoint: ${kb(maxSizeAfterCompleteCheckpoint)} (spec target: < 500 KB)`);
  console.log(`Peak WAL Size During Load: ${kb(maxWalSize)} (ceiling: ${kb(walCeilingBytes)} = 2x auto-checkpoint)`);
  console.log(
    `Final Checkpoint (writers stopped): ${finalRow ? JSON.stringify(finalRow) : "no row"}, WAL ${kb(finalWalSize)} (spec target: < 500 KB)`
  );

  removeDbFiles();

  const failures: string[] = [];
  if (missingReports.length > 0) {
    failures.push(`${missingReports.length} worker(s) never reported: ${missingReports.join("; ")}`);
  }
  if (totalOtherErrors !== 0) {
    failures.push(`${totalOtherErrors} unexpected (non-lock-contention) write errors`);
  }
  if (maintenanceErrors !== 0) {
    failures.push(`${maintenanceErrors} checkpoint(s) threw`);
  }
  if (maxSizeAfterCompleteCheckpoint > WAL_SIZE_TARGET_BYTES) {
    failures.push(
      `a complete checkpoint left the WAL at ${kb(maxSizeAfterCompleteCheckpoint)}, over the ${kb(WAL_SIZE_TARGET_BYTES)} target`
    );
  }
  const incompleteRatio = maintenanceRuns > 0 ? incompleteCheckpoints / maintenanceRuns : 1;
  if (incompleteRatio > INCOMPLETE_CHECKPOINT_FAIL_RATIO) {
    failures.push(
      `${incompleteCheckpoints}/${maintenanceRuns} checkpoints incomplete (${(incompleteRatio * 100).toFixed(0)}%, threshold ${(INCOMPLETE_CHECKPOINT_FAIL_RATIO * 100).toFixed(0)}%) -- checkpointing is not keeping up with write volume`
    );
  }
  if (maxWalSize > walCeilingBytes) {
    failures.push(`WAL peaked at ${kb(maxWalSize)}, over the ${kb(walCeilingBytes)} ceiling -- checkpoints were starved`);
  }
  if (!finalRow || !isComplete(finalRow)) {
    failures.push(`final checkpoint with all writers stopped did not complete: ${JSON.stringify(finalRow)}`);
  }
  if (finalWalSize > WAL_SIZE_TARGET_BYTES) {
    failures.push(`WAL is ${kb(finalWalSize)} after the final checkpoint, over the ${kb(WAL_SIZE_TARGET_BYTES)} target`);
  }

  if (failures.length === 0) {
    console.log("RESULT: PASS - writes clean, every worker reported, WAL bounded under load and truncated by every complete checkpoint.");
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
      db.close();
      parentPort?.postMessage({ workerId, writes, lockErrors, otherErrors });
      // No process.exit() here: exiting right after postMessage could drop
      // the report. Closing the port lets the thread end on its own once
      // the message is flushed.
      parentPort?.close();
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
