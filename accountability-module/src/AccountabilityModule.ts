import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// First row in the chain has no predecessor to link to; this fixed,
// public constant stands in for "previous hash" at genesis. It carries no
// secret material -- the HMAC key is what makes the chain unforgeable,
// not this label.
const CHAIN_GENESIS_HASH = "GENESIS";
// Domain-separation label for HKDF, so the chain-integrity key is
// cryptographically distinct from the AES-256-GCM payload-encryption key
// even though both are derived from the same caller-supplied secret.
const CHAIN_KEY_HKDF_INFO = "accountability-module-chain-key-v1";

/** Resolves a path the way the allowedDir sandbox check needs: following
 * symlinks, not just collapsing "..". path.resolve() alone is textual --
 * a symlink sitting inside allowedDir but pointing outside it still reads
 * as "inside" to path.relative(), which is exactly the bypass red-team
 * review #3 found and reproduced. fs.realpathSync() fixes that, but
 * throws on a path that doesn't exist yet, which is the normal case for
 * a database being created for the first time -- so this resolves the
 * parent directory (which must already exist for DatabaseSync to succeed
 * anyway) and only falls back to that when the full path doesn't exist. */
function canonicalizeForSandboxCheck(resolvedPath: string): string {
  try {
    return fs.realpathSync(resolvedPath);
  } catch {
    // realpathSync failing here means one of two different things, and
    // conflating them is exactly how the first version of this fix still
    // let a dangling symlink through: either (a) resolvedPath truly
    // doesn't exist at all (the normal new-db case, safe to treat as a
    // plain path), or (b) resolvedPath itself IS a symlink whose target
    // doesn't exist yet -- a "dangling" symlink, which still needs to be
    // followed to where it POINTS, not silently accepted as a bare path.
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(resolvedPath).isSymbolicLink();
    } catch {
      // lstat also failing means resolvedPath doesn't exist in any form,
      // not even as a symlink -- genuinely case (a), fall through below.
    }
    if (isSymlink) {
      const linkTarget = fs.readlinkSync(resolvedPath);
      const linkDir = path.dirname(resolvedPath);
      const resolvedTarget = path.isAbsolute(linkTarget) ? linkTarget : path.resolve(linkDir, linkTarget);
      // Recurse: the target a dangling symlink points to might itself not
      // exist yet, or might be another symlink.
      return canonicalizeForSandboxCheck(resolvedTarget);
    }
    const dir = path.dirname(resolvedPath);
    const canonicalDir = fs.realpathSync(dir); // let this throw if the dir itself doesn't exist -- a clear error beats a silent bypass
    return path.join(canonicalDir, path.basename(resolvedPath));
  }
}

export type SessionOutcome = "IN_PROGRESS" | "COMPLETED" | "ABANDONED" | "DRIFTED";
/** Outcomes a caller is allowed to close a session INTO. IN_PROGRESS is the
 * schema default on creation only — updateSessionOutcome() cannot be used
 * to move a session back to it. */
export type ClosingOutcome = "COMPLETED" | "ABANDONED" | "DRIFTED";
export type UsabilityRating = "USABLE" | "DEGRADED" | "UNUSABLE";
export type FaultAttribution =
  | "HUMAN_ENGINEER"
  | "AI_AGENT"
  | "SYSTEM_ENVIRONMENT"
  | "UNDETERMINED";
export type InitiatorRole = "HUMAN_ENGINEER" | "AI_AGENT" | "SYSTEM_ENVIRONMENT";
export type AlignmentState = "ALIGNED" | "OFF_TARGET" | "UNRESOLVED";

export interface CreateSessionParams {
  sessionId?: string;
  engineerId: string;
  moduleName: string;
}

export interface UpdateSessionOutcomeParams {
  sessionId: string;
  sessionOutcome: ClosingOutcome;
  usabilityRating: UsabilityRating;
  faultAttribution: FaultAttribution;
  attributionReason: string;
  driftTrigger?: string;
}

export interface LogActionParams {
  sessionId: string;
  initiatorRole: InitiatorRole;
  actionName: string;
  alignmentState: AlignmentState;
  inputPayload: Record<string, unknown>;
  outputPayload: Record<string, unknown>;
  actionNotes?: string;
  /** Optional caller-supplied dedup key. If provided, a repeat with the same
   * key throws instead of silently double-logging (flag #11). */
  idempotencyKey?: string;
}

export interface AccountabilityModuleConfig {
  dbPath: string;
  /** Required. 32-byte key, hex-encoded (64 hex chars), used for
   * AES-256-GCM encryption of action payloads at rest. There is no silent
   * "no encryption" fallback — an app that claims encrypted storage must
   * actually provide a key. */
  encryptionKeyHex: string;
  /** Optional. If set, dbPath must resolve to a location inside this
   * directory, or the constructor throws (path traversal defense). */
  allowedDir?: string;
}

export class AccountabilityModule {
  private db: DatabaseSync;
  private encryptionKey: Buffer;
  private chainKey: Buffer;

  constructor(config: AccountabilityModuleConfig) {
    if (!config.encryptionKeyHex || !/^[0-9a-fA-F]{64}$/.test(config.encryptionKeyHex)) {
      throw new Error(
        "AccountabilityModule requires encryptionKeyHex: a 64-char hex string " +
          "(32 raw bytes) for AES-256-GCM. Refusing to start with no key rather " +
          "than silently storing payloads in plaintext."
      );
    }
    this.encryptionKey = Buffer.from(config.encryptionKeyHex, "hex");
    // Deliberately not the same key material as encryptionKey, even
    // though both derive from the same input -- HKDF with a distinct
    // info label keeps "confidentiality" and "tamper-evidence" as
    // cryptographically separate roles. This is a minimal key-management
    // step, not the full rotation/versioning story (still open, deferred).
    this.chainKey = Buffer.from(
      crypto.hkdfSync("sha256", this.encryptionKey, Buffer.alloc(0), CHAIN_KEY_HKDF_INFO, 32)
    );

    let resolvedDbPath = path.resolve(config.dbPath);
    if (config.allowedDir) {
      let allowedRoot: string;
      try {
        allowedRoot = fs.realpathSync(path.resolve(config.allowedDir));
      } catch (err) {
        throw new Error(
          `allowedDir "${config.allowedDir}" does not exist or is not accessible: ${(err as Error).message}`
        );
      }
      let canonicalDbPath: string;
      try {
        canonicalDbPath = canonicalizeForSandboxCheck(resolvedDbPath);
      } catch (err) {
        throw new Error(
          `Cannot resolve dbPath "${config.dbPath}" to check against allowedDir: ${(err as Error).message}`
        );
      }
      const rel = path.relative(allowedRoot, canonicalDbPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(
          `dbPath "${config.dbPath}" resolves outside allowedDir "${config.allowedDir}" ` +
            `(checked after symlink resolution). Refusing to open database (path traversal defense).`
        );
      }
      // Open the canonical (symlink-resolved) path, not the original --
      // otherwise a validated-safe check could still open through a
      // symlink that changes between check and open.
      resolvedDbPath = canonicalDbPath;
    }

    this.db = new DatabaseSync(resolvedDbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
    this.db.exec(schema);
  }

  /** AES-256-GCM encrypt. Output format: base64(iv[12] || authTag[16] || ciphertext). */
  private encryptPayload(payload: Record<string, unknown>): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
  }

  /** Inverse of encryptPayload(). Throws if the auth tag doesn't verify. */
  private decryptPayload(stored: string): Record<string, unknown> {
    const raw = Buffer.from(stored, "base64");
    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  }

  /** Wraps fn in an immediate (write-locking) transaction so callers can
   * make multi-statement sequences atomic. Rolls back on any throw. */
  withTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Canonical hash for one chain link. Same function used when writing
   * (logAction) and when checking (verifyChain) -- if they ever diverge,
   * every row written under the old version fails verification under the
   * new one, so this is the one place that definition lives. Fields are
   * joined with a control character (0x1F, "unit separator") that cannot
   * appear in any of these values in practice (UUIDs, ISO timestamps,
   * fixed enum strings, base64 ciphertext) -- documented rather than
   * defended against, since this isn't parsing untrusted external input. */
  private computeRowHash(prevHash: string, fields: {
    eventId: string;
    sessionId: string;
    timestampUtc: string;
    initiatorRole: string;
    actionName: string;
    alignmentState: string;
    encryptedInputPayload: string;
    encryptedOutputPayload: string;
    idempotencyKey: string | null;
  }): string {
    const SEP = "\x1f";
    const canonical = [
      prevHash,
      fields.eventId,
      fields.sessionId,
      fields.timestampUtc,
      fields.initiatorRole,
      fields.actionName,
      fields.alignmentState,
      fields.encryptedInputPayload,
      fields.encryptedOutputPayload,
      fields.idempotencyKey ?? "",
    ].join(SEP);
    return crypto.createHmac("sha256", this.chainKey).update(canonical, "utf8").digest("hex");
  }

  createSession(params: CreateSessionParams) {
    const sessionId = params.sessionId ?? crypto.randomUUID();
    const now = new Date().toISOString();
    // As specified by the API pass: session starts with "default unassigned
    // outcome states" -- outcome/usability/attribution aren't known yet.
    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        session_id, engineer_id, module_name, created_at_utc, last_updated_at_utc
      ) VALUES (?, ?, ?, ?, ?)
    `);
    // session_outcome defaults to 'IN_PROGRESS' at the schema level;
    // usability_rating / fault_attribution / attribution_reason stay
    // NULL until updateSessionOutcome() is called.
    stmt.run(sessionId, params.engineerId, params.moduleName, now, now);
    return sessionId;
  }

  updateSessionOutcome(params: UpdateSessionOutcomeParams) {
    const stmt = this.db.prepare(`
      UPDATE sessions
      SET session_outcome = ?, usability_rating = ?, fault_attribution = ?,
          attribution_reason = ?, drift_trigger = ?, last_updated_at_utc = ?
      WHERE session_id = ?
    `);
    const result = stmt.run(
      params.sessionOutcome,
      params.usabilityRating,
      params.faultAttribution,
      params.attributionReason,
      params.driftTrigger ?? null,
      new Date().toISOString(),
      params.sessionId
    );
    if (result.changes === 0) {
      throw new Error(`No session found with id ${params.sessionId}; update was a no-op.`);
    }
  }

  logAction(params: LogActionParams) {
    // BEGIN IMMEDIATE takes the write lock up front, so the outcome check
    // and the INSERT below execute as one atomic unit — no other
    // connection can close the session in the gap between them (flag #7).
    return this.withTransaction(() => {
      const sessionRow = this.db
        .prepare("SELECT session_outcome FROM sessions WHERE session_id = ?")
        .get(params.sessionId) as { session_outcome: string } | undefined;

      if (!sessionRow) {
        throw new Error(`No session found with id ${params.sessionId}`);
      }
      if (sessionRow.session_outcome !== "IN_PROGRESS") {
        throw new Error(
          `Cannot log action: session ${params.sessionId} is already finalized (${sessionRow.session_outcome}).`
        );
      }

      if (params.idempotencyKey) {
        // Scoped to this session, not global -- red-team review #3, finding
        // #3: a global check meant session B could never use a key already
        // used by unrelated session A. The unique index below has the same
        // scoping as its backstop.
        const dup = this.db
          .prepare("SELECT event_id FROM actions WHERE session_id = ? AND idempotency_key = ?")
          .get(params.sessionId, params.idempotencyKey);
        if (dup) {
          throw new Error(
            `Duplicate action: idempotencyKey "${params.idempotencyKey}" was already logged for session ${params.sessionId}.`
          );
        }
      }

      // chain_seq/row_hash: assigned here, inside the same BEGIN IMMEDIATE
      // transaction that already serializes all writers (used for the
      // outcome check above and the idempotency check before it), so
      // reading "the last link" and appending the next one is race-safe
      // without a separate lock. MAX(chain_seq) rather than an
      // AUTOINCREMENT column, because event_id (not chain_seq) is this
      // table's PRIMARY KEY -- SQLite allows only one per table.
      const prevLink = this.db
        .prepare("SELECT chain_seq, row_hash FROM actions ORDER BY chain_seq DESC LIMIT 1")
        .get() as { chain_seq: number; row_hash: string } | undefined;
      const chainSeq = (prevLink?.chain_seq ?? 0) + 1;
      const prevHash = prevLink?.row_hash ?? CHAIN_GENESIS_HASH;

      const eventId = crypto.randomUUID();
      const timestampUtc = new Date().toISOString();
      const encryptedInputPayload = this.encryptPayload(params.inputPayload);
      const encryptedOutputPayload = this.encryptPayload(params.outputPayload);
      const rowHash = this.computeRowHash(prevHash, {
        eventId,
        sessionId: params.sessionId,
        timestampUtc,
        initiatorRole: params.initiatorRole,
        actionName: params.actionName,
        alignmentState: params.alignmentState,
        encryptedInputPayload,
        encryptedOutputPayload,
        idempotencyKey: params.idempotencyKey ?? null,
      });

      const stmt = this.db.prepare(`
        INSERT INTO actions (
          event_id, session_id, timestamp_utc, initiator_role, action_name,
          alignment_state, input_payload, output_payload, action_notes,
          idempotency_key, chain_seq, row_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        eventId,
        params.sessionId,
        timestampUtc,
        params.initiatorRole,
        params.actionName,
        params.alignmentState,
        encryptedInputPayload,
        encryptedOutputPayload,
        params.actionNotes ?? null,
        params.idempotencyKey ?? null,
        chainSeq,
        rowHash
      );
      return eventId;
    });
  }

  /** Reads an action back and decrypts its payloads. Added alongside
   * payload encryption so the encrypted data is actually retrievable
   * through the module's own API, not just writable. */
  getAction(eventId: string) {
    const row = this.db
      .prepare("SELECT * FROM actions WHERE event_id = ?")
      .get(eventId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      ...row,
      input_payload: this.decryptPayload(row.input_payload as string),
      output_payload: this.decryptPayload(row.output_payload as string),
    };
  }

  /** Walks the actions table in chain order and checks two independent
   * things: (1) chain_seq has no gaps (a deleted row leaves one), and
   * (2) every row's stored row_hash matches what recomputing it from the
   * row's own columns plus the previous row's hash produces (an edited
   * row's stored hash no longer matches its own content). Stops at the
   * first violation rather than continuing, since a broken link makes
   * every later hash meaningless to check further.
   *
   * This is tamper-EVIDENT, not tamper-PROOF: a writer who has both DB
   * write access and this module's chainKey could rewrite a consistent
   * suffix of the chain. That's the same threat model AES-256-GCM
   * encryption already accepts for confidentiality (key + file = full
   * access) -- stated here explicitly rather than implied to be stronger
   * than it is. */
  verifyChain(): {
    valid: boolean;
    brokenAtSeq?: number;
    reason?: "sequence_gap" | "hash_mismatch";
    rowsChecked: number;
  } {
    const rows = this.db
      .prepare(
        `SELECT event_id, session_id, timestamp_utc, initiator_role, action_name,
                alignment_state, input_payload, output_payload, idempotency_key, chain_seq, row_hash
         FROM actions
         WHERE chain_seq IS NOT NULL
         ORDER BY chain_seq ASC`
      )
      .all() as Array<{
      event_id: string;
      session_id: string;
      timestamp_utc: string;
      initiator_role: string;
      action_name: string;
      alignment_state: string;
      input_payload: string;
      output_payload: string;
      idempotency_key: string | null;
      chain_seq: number;
      row_hash: string;
    }>;

    let expectedSeq = 1;
    let prevHash = CHAIN_GENESIS_HASH;

    for (const row of rows) {
      if (row.chain_seq !== expectedSeq) {
        return { valid: false, brokenAtSeq: expectedSeq, reason: "sequence_gap", rowsChecked: expectedSeq - 1 };
      }
      const recomputed = this.computeRowHash(prevHash, {
        eventId: row.event_id,
        sessionId: row.session_id,
        timestampUtc: row.timestamp_utc,
        initiatorRole: row.initiator_role,
        actionName: row.action_name,
        alignmentState: row.alignment_state,
        encryptedInputPayload: row.input_payload,
        encryptedOutputPayload: row.output_payload,
        idempotencyKey: row.idempotency_key,
      });
      if (recomputed !== row.row_hash) {
        return { valid: false, brokenAtSeq: row.chain_seq, reason: "hash_mismatch", rowsChecked: expectedSeq - 1 };
      }
      prevHash = row.row_hash;
      expectedSeq++;
    }

    return { valid: true, rowsChecked: rows.length };
  }

  /** Reverses runMaintenance()'s archiving for a specific session
   * (flag #8 — previously there was no way back from is_archived=1). */
  unarchiveSession(sessionId: string) {
    const result = this.db
      .prepare("UPDATE sessions SET is_archived = 0 WHERE session_id = ?")
      .run(sessionId);
    if (result.changes === 0) {
      throw new Error(`No session found with id ${sessionId}; unarchive was a no-op.`);
    }
  }

  runMaintenance(options: { retentionDays?: number } = {}) {
    const retentionDays = options.retentionDays ?? 30;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    const archiveStmt = this.db.prepare(`
      UPDATE sessions
      SET is_archived = 1
      WHERE session_outcome != 'IN_PROGRESS'
        AND last_updated_at_utc < ?
        AND is_archived = 0
    `);
    const result = archiveStmt.run(cutoff);

    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    return { archivedCount: result.changes };
  }

  close() {
    this.db.close();
  }
}
