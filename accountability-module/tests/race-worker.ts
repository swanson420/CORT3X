// Run as a separate OS process (via child_process.spawn in race-test.ts),
// not a worker_thread — this makes the race test genuinely multi-process,
// which the red-team review flagged as untested (only multi-thread
// contention had been exercised before).
import { AccountabilityModule } from "../src/AccountabilityModule";

const [, , dbPath, sessionId, durationMsStr, workerId] = process.argv;
const durationMs = parseInt(durationMsStr, 10);
const TEST_KEY = "3ababc623cf6dc4d7bce7d154ccb0d4141e69e3c90e04a1104c9540ebba4f34a";

const mod = new AccountabilityModule({ dbPath, encryptionKeyHex: TEST_KEY });
console.log("READY");
let succeeded = 0;
let rejected = 0;
const errorSamples: Record<string, number> = {};
const deadline = Date.now() + durationMs;

while (Date.now() < deadline) {
  try {
    mod.logAction({
      sessionId,
      initiatorRole: "AI_AGENT",
      actionName: `race_probe_${workerId}`,
      alignmentState: "ALIGNED",
      inputPayload: { probe: true },
      outputPayload: { probe: true },
    });
    succeeded++;
  } catch (err) {
    rejected++;
    const msg = (err as Error).message.slice(0, 60);
    errorSamples[msg] = (errorSamples[msg] ?? 0) + 1;
  }
}

mod.close();
console.error(`[worker ${workerId} error breakdown]`, JSON.stringify(errorSamples));
console.log(`RESULT ${JSON.stringify({ workerId, succeeded, rejected })}`);
