// Covers a real gap: logAction() -> encryptPayload() was exercised by
// every other test, but nothing ever called getAction() -> decryptPayload().
// So the AES-256-GCM round trip -- that encrypted data comes back out
// correctly, not just that it goes in -- had never actually been run.

import { AccountabilityModule } from "../src/AccountabilityModule";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(__dirname, ".tmp_test_encryption.db");
const KEY_A = "3ababc623cf6dc4d7bce7d154ccb0d4141e69e3c90e04a1104c9540ebba4f34a";
const KEY_B = "a08dcc4b3e188486fb41b5e548c8e434647d2ee74bc67109f8a462ae15a5ccd8".slice(0, 64);

function cleanup() {
  for (const ext of ["", "-wal", "-shm"]) {
    const p = testDbPath + ext;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

cleanup();

console.log("1. Creating module instance and a session...");
const mod = new AccountabilityModule({ dbPath: testDbPath, encryptionKeyHex: KEY_A });
const sessionId = mod.createSession({ engineerId: "samson", moduleName: "encryption_test" });
console.log("   OK");

console.log("2. Logging an action with a distinctive, non-trivial payload...");
const inputPayload = { command: "rm -rf /tmp/scratch", args: ["-f"], nested: { flag: true, n: 42 } };
const outputPayload = { status: "ok", bytesFreed: 1048576, warnings: [] as string[] };
let eventId: string;
try {
  eventId = mod.logAction({
    sessionId,
    initiatorRole: "AI_AGENT",
    actionName: "cleanup_scratch",
    alignmentState: "ALIGNED",
    inputPayload,
    outputPayload,
  });
  console.log("   OK - event:", eventId);
} catch (err) {
  console.error("   FAILED:", (err as Error).message);
  process.exit(1);
}

console.log("3. Confirming the payload is actually encrypted at rest (raw column != plaintext)...");
try {
  // Reach past the module's own API to check the raw stored bytes -- if
  // this ever comes back as readable JSON, encryption silently isn't
  // happening despite the constructor's guarantee.
  const raw = (mod as unknown as { db: { prepare: (q: string) => { get: (id: string) => Record<string, unknown> | undefined } } })
    .db.prepare("SELECT input_payload FROM actions WHERE event_id = ?")
    .get(eventId);
  const rawStr = String(raw?.input_payload ?? "");
  if (rawStr.includes("rm -rf") || rawStr.includes("scratch")) {
    console.error("   FAILED: plaintext command visible in stored column -- payload is not encrypted");
    process.exit(1);
  }
  console.log("   OK - raw stored value does not contain plaintext");
} catch (err) {
  console.error("   FAILED:", (err as Error).message);
  process.exit(1);
}

console.log("4. Reading the action back via getAction() and checking the decrypted payload matches...");
try {
  const action = mod.getAction(eventId);
  if (!action) {
    console.error("   FAILED: getAction() returned undefined for a known event_id");
    process.exit(1);
  }
  const gotInput = JSON.stringify(action.input_payload);
  const gotOutput = JSON.stringify(action.output_payload);
  if (gotInput !== JSON.stringify(inputPayload) || gotOutput !== JSON.stringify(outputPayload)) {
    console.error("   FAILED: decrypted payload does not match what was written");
    console.error("     expected input:", JSON.stringify(inputPayload));
    console.error("     got input:     ", gotInput);
    process.exit(1);
  }
  console.log("   OK - decrypted payload round-trips exactly");
} catch (err) {
  console.error("   FAILED: getAction() threw on a legitimately encrypted row:", (err as Error).message);
  process.exit(1);
}

console.log("5. getAction() on a nonexistent event_id returns undefined, not a throw...");
try {
  const missing = mod.getAction("00000000-0000-0000-0000-000000000000");
  if (missing !== undefined) {
    console.error("   FAILED: expected undefined for unknown event_id, got:", missing);
    process.exit(1);
  }
  console.log("   OK");
} catch (err) {
  console.error("   FAILED: getAction() threw instead of returning undefined:", (err as Error).message);
  process.exit(1);
}
mod.close();

console.log("6. Decrypting with the WRONG key fails loudly instead of returning garbage...");
try {
  const modWrongKey = new AccountabilityModule({ dbPath: testDbPath, encryptionKeyHex: KEY_B });
  try {
    modWrongKey.getAction(eventId);
    console.error("   FAILED: decrypting with the wrong key did not throw -- auth tag is not being checked");
    modWrongKey.close();
    process.exit(1);
  } catch {
    console.log("   OK - wrong key correctly fails auth tag verification");
    modWrongKey.close();
  }
} catch (err) {
  console.error("   FAILED (setup):", (err as Error).message);
  process.exit(1);
}

console.log("ENCRYPTION ROUND-TRIP TEST COMPLETE - exit code 0");
cleanup();
