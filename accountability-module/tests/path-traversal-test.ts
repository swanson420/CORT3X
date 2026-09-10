// Covers a real gap: the constructor's allowedDir check (path traversal
// defense) was implemented but no test ever set allowedDir or attempted
// an escaping path, so the defense had never actually been triggered.

import { AccountabilityModule } from "../src/AccountabilityModule";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sandboxDir = path.join(__dirname, ".tmp_sandbox");
const outsideDir = path.join(__dirname, ".tmp_outside");
const KEY = "3ababc623cf6dc4d7bce7d154ccb0d4141e69e3c90e04a1104c9540ebba4f34a";

function cleanup() {
  for (const dir of [sandboxDir, outsideDir]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

cleanup();
fs.mkdirSync(sandboxDir, { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });

console.log("1. dbPath inside allowedDir succeeds...");
try {
  const mod = new AccountabilityModule({
    dbPath: path.join(sandboxDir, "inside.db"),
    encryptionKeyHex: KEY,
    allowedDir: sandboxDir,
  });
  mod.close();
  console.log("   OK");
} catch (err) {
  console.error("   FAILED: legitimate in-sandbox path was rejected:", (err as Error).message);
  process.exit(1);
}

console.log("2. dbPath escaping allowedDir via ../ is rejected...");
try {
  const escaped = path.join(sandboxDir, "..", ".tmp_outside", "escaped.db");
  const mod = new AccountabilityModule({
    dbPath: escaped,
    encryptionKeyHex: KEY,
    allowedDir: sandboxDir,
  });
  mod.close();
  console.error("   FAILED: path traversal via ../ was NOT rejected -- defense does not work");
  process.exit(1);
} catch (err) {
  const msg = (err as Error).message;
  if (!msg.includes("traversal")) {
    console.error("   FAILED: rejected, but not for the expected reason:", msg);
    process.exit(1);
  }
  console.log("   OK - correctly rejected:", msg);
}

console.log("3. dbPath escaping via an absolute path outside allowedDir is rejected...");
try {
  const mod = new AccountabilityModule({
    dbPath: path.join(outsideDir, "absolute-escape.db"),
    encryptionKeyHex: KEY,
    allowedDir: sandboxDir,
  });
  mod.close();
  console.error("   FAILED: absolute-path escape was NOT rejected");
  process.exit(1);
} catch (err) {
  console.log("   OK - correctly rejected:", (err as Error).message);
}

console.log("4. No allowedDir set -> traversal-style paths are allowed (feature is opt-in, not default-on)...");
try {
  const mod = new AccountabilityModule({
    dbPath: path.join(outsideDir, "no-sandbox.db"),
    encryptionKeyHex: KEY,
    // allowedDir intentionally omitted
  });
  mod.close();
  console.log("   OK - confirmed opt-in behavior (no allowedDir means no restriction)");
} catch (err) {
  console.error("   FAILED: allowedDir is being enforced even when not configured:", (err as Error).message);
  process.exit(1);
}

console.log("5. Symlink inside allowedDir pointing to a target that DOESN'T exist yet, outside allowedDir, is rejected...");
// Red-team review #3, finding #7, reproduced: the original check used
// path.resolve() (textual only), so a symlink sitting inside allowedDir
// but pointing outside it read as "inside" and was allowed through --
// and a real file got created outside the sandbox via the symlink. This
// specific case (dangling symlink -- target doesn't exist at check time)
// is the one that slipped through the FIRST attempt at this fix too: the
// fallback logic assumed "doesn't exist" meant "no symlink involved,"
// which is false for a symlink whose target hasn't been created yet.
try {
  const danglingLink = path.join(sandboxDir, "dangling-escape.db");
  if (fs.existsSync(danglingLink)) fs.rmSync(danglingLink);
  fs.symlinkSync(path.join(outsideDir, "not-created-yet.db"), danglingLink);
  const mod = new AccountabilityModule({
    dbPath: danglingLink,
    encryptionKeyHex: KEY,
    allowedDir: sandboxDir,
  });
  mod.close();
  const escaped = fs.existsSync(path.join(outsideDir, "not-created-yet.db"));
  console.error(`   FAILED: dangling-symlink escape was NOT rejected (file created outside sandbox: ${escaped})`);
  process.exit(1);
} catch (err) {
  const msg = (err as Error).message;
  if (!msg.includes("traversal") && !msg.includes("outside allowedDir")) {
    console.error("   FAILED: rejected, but not for the expected reason:", msg);
    process.exit(1);
  }
  console.log("   OK - correctly rejected:", msg);
}

console.log("6. Symlink inside allowedDir pointing to an EXISTING target outside allowedDir is rejected...");
try {
  const existingOutside = path.join(outsideDir, "pre-existing.db");
  fs.writeFileSync(existingOutside, "");
  const linkToExisting = path.join(sandboxDir, "existing-target-escape.db");
  if (fs.existsSync(linkToExisting)) fs.rmSync(linkToExisting);
  fs.symlinkSync(existingOutside, linkToExisting);
  const mod = new AccountabilityModule({
    dbPath: linkToExisting,
    encryptionKeyHex: KEY,
    allowedDir: sandboxDir,
  });
  mod.close();
  console.error("   FAILED: existing-target symlink escape was NOT rejected");
  process.exit(1);
} catch (err) {
  console.log("   OK - correctly rejected:", (err as Error).message);
}

console.log("7. A symlink pointing WITHIN allowedDir is legitimately allowed (defense doesn't overreach)...");
try {
  const target = path.join(sandboxDir, "real-target.db");
  const linkInside = path.join(sandboxDir, "link-to-inside.db");
  if (fs.existsSync(linkInside)) fs.rmSync(linkInside);
  fs.symlinkSync(target, linkInside);
  const mod = new AccountabilityModule({
    dbPath: linkInside,
    encryptionKeyHex: KEY,
    allowedDir: sandboxDir,
  });
  mod.close();
  console.log("   OK - within-sandbox symlink correctly allowed");
} catch (err) {
  console.error("   FAILED: legitimate within-sandbox symlink was rejected:", (err as Error).message);
  process.exit(1);
}

console.log("PATH TRAVERSAL TEST COMPLETE - exit code 0");
cleanup();
