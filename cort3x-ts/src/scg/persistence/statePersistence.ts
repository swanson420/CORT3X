// Minimal StatePersistenceEngine over 001_state_persistence_consolidated.sql.
//
// RECONSTRUCTED: the original engine was referenced across SCG but never
// committed. This covers exactly what the HTTP layer calls today --
// createThread/getThreadById/closeThread/reopenThread -- plus resolving a
// RequestIdentity. Every design guess is listed in cort3x-ts/GAPS.md;
// fan-in, fencing and reopen tickets are not built.

import type { Pool, PoolClient } from 'pg';

export type ShutdownMode = 'ABORT_ACTIVE' | 'REQUIRE_QUIESCENCE';

/**
 * Domain-state problems, as opposed to malformed requests
 * (HttpValidationFault). The original named six categories but never wrote
 * them down; CONTRACT_VIOLATION is the only one the codebase names. The
 * other five are this reconstruction's.
 */
export type DomainFaultCategory =
  | 'UNAUTHENTICATED' // no usable identity: unknown, suspended, revoked or expired principal
  | 'FORBIDDEN' // identity is real but not an active member of the tenant
  | 'NOT_FOUND' // no such resource in the caller's tenant (cross-tenant looks identical)
  | 'INVALID_STATE' // resource exists but is in the wrong state for the operation
  | 'CONFLICT' // the operation would break a precondition, e.g. non-quiescent close
  | 'CONTRACT_VIOLATION'; // a catalog-declared contract was violated

export class DomainFault extends Error {
  readonly code = 'DOMAIN_FAULT';
  constructor(
    readonly category: DomainFaultCategory,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = 'DomainFault';
  }
}

/** Resolved once per request by resolveRequestIdentity(); handlers never
 * build one themselves. tenantId scopes every query the engine runs. */
export interface RequestIdentity {
  readonly principalId: string;
  readonly tenantId: string;
  readonly capabilities: readonly string[];
}

export interface ThreadRecord {
  id: string;
  tenantId: string;
  title: string;
  metadata: Record<string, unknown>;
  status: 'OPEN' | 'CLOSED';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closeMode: ShutdownMode | null;
}

export interface CloseSummary {
  threadId: string;
  status: 'CLOSED';
  mode: ShutdownMode;
  /** Nodes moved to ABORTED (always 0 for REQUIRE_QUIESCENCE). */
  abortedNodeCount: number;
  closedAt: string;
}

export interface ReopenSummary {
  threadId: string;
  status: 'OPEN';
  reopenedAt: string;
}

export interface StatePersistenceEngine {
  createThread(identity: RequestIdentity, title: string, metadata: Record<string, unknown>): Promise<string>;
  getThreadById(identity: RequestIdentity, threadId: string): Promise<ThreadRecord>;
  closeThread(identity: RequestIdentity, threadId: string, mode: ShutdownMode): Promise<CloseSummary>;
  reopenThread(identity: RequestIdentity, threadId: string): Promise<ReopenSummary>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id can't name anything, so it is NOT_FOUND -- not a raw
 * Postgres 22P02 error leaking out as a 500. */
function requireUuid(id: string, what: string): void {
  if (!UUID_RE.test(id)) {
    throw new DomainFault('NOT_FOUND', `${what} ${JSON.stringify(id)} does not exist.`, { id });
  }
}

/** Nodes that still have work in flight. ABORT_ACTIVE aborts these;
 * REQUIRE_QUIESCENCE refuses to close while any exist. */
const ACTIVE_NODE_STATES = ['PENDING', 'RUNNING'] as const;

/**
 * Maps a workload identity (issuer + subject) and a tenant to a
 * RequestIdentity. How the issuer/subject were authenticated (mTLS, JWT,
 * SPIFFE SVID) is the adapter's job; this only checks the database says
 * the principal may act in the tenant.
 *
 * Unknown principal and inactive principal both read as UNAUTHENTICATED,
 * and unknown tenant reads the same as no membership (FORBIDDEN), so a
 * caller can't use the errors to discover which principals or tenants
 * exist.
 */
export async function resolveRequestIdentity(
  pool: Pool,
  issuer: string,
  subject: string,
  tenantSlug: string
): Promise<RequestIdentity> {
  const principal = await pool.query<{ id: string; status: string; expired: boolean }>(
    `SELECT id, status, (expires_at IS NOT NULL AND expires_at <= now()) AS expired
       FROM principals WHERE issuer = $1 AND subject = $2`,
    [issuer, subject]
  );
  const p = principal.rows[0];
  if (!p || p.status !== 'ACTIVE' || p.expired) {
    throw new DomainFault('UNAUTHENTICATED', 'No active principal for these credentials.');
  }

  const membership = await pool.query<{ tenant_id: string; capabilities: string[] }>(
    `SELECT m.tenant_id, m.capabilities
       FROM principal_tenant_memberships m
       JOIN tenants t ON t.id = m.tenant_id
      WHERE m.principal_id = $1 AND t.slug = $2 AND m.status = 'ACTIVE'`,
    [p.id, tenantSlug]
  );
  const m = membership.rows[0];
  if (!m) {
    throw new DomainFault('FORBIDDEN', `Principal is not an active member of tenant ${JSON.stringify(tenantSlug)}.`);
  }
  return { principalId: p.id, tenantId: m.tenant_id, capabilities: m.capabilities };
}

type ThreadRow = {
  id: string;
  tenant_id: string;
  title: string;
  metadata: Record<string, unknown>;
  status: 'OPEN' | 'CLOSED';
  created_by: string;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  close_mode: ShutdownMode | null;
};

function toThreadRecord(r: ThreadRow): ThreadRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    title: r.title,
    metadata: r.metadata,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    closedAt: r.closed_at ? r.closed_at.toISOString() : null,
    closeMode: r.close_mode,
  };
}

export class PgStatePersistenceEngine implements StatePersistenceEngine {
  constructor(private readonly pool: Pool) {}

  async createThread(identity: RequestIdentity, title: string, metadata: Record<string, unknown>): Promise<string> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO threads (tenant_id, title, metadata, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [identity.tenantId, title, JSON.stringify(metadata), identity.principalId]
    );
    return res.rows[0]!.id;
  }

  async getThreadById(identity: RequestIdentity, threadId: string): Promise<ThreadRecord> {
    requireUuid(threadId, 'Thread');
    const res = await this.pool.query<ThreadRow>(`SELECT * FROM threads WHERE id = $1 AND tenant_id = $2`, [
      threadId,
      identity.tenantId,
    ]);
    const row = res.rows[0];
    if (!row) throw new DomainFault('NOT_FOUND', `Thread ${threadId} does not exist.`, { threadId });
    return toThreadRecord(row);
  }

  async closeThread(identity: RequestIdentity, threadId: string, mode: ShutdownMode): Promise<CloseSummary> {
    requireUuid(threadId, 'Thread');
    return this.inTransaction(async (client) => {
      const thread = await this.lockThread(client, identity, threadId);
      if (thread.status === 'CLOSED') {
        throw new DomainFault('INVALID_STATE', `Thread ${threadId} is already closed.`, { threadId });
      }

      let abortedNodeCount = 0;
      if (mode === 'REQUIRE_QUIESCENCE') {
        const active = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM nodes WHERE thread_id = $1 AND lifecycle_state = ANY($2)`,
          [threadId, ACTIVE_NODE_STATES]
        );
        const n = Number(active.rows[0]!.n);
        if (n > 0) {
          throw new DomainFault('CONFLICT', `Thread ${threadId} has ${n} active node(s); close with ABORT_ACTIVE or wait.`, {
            threadId,
            activeNodeCount: n,
          });
        }
      } else {
        const aborted = await client.query(
          `UPDATE nodes SET lifecycle_state = 'ABORTED', updated_at = now()
            WHERE thread_id = $1 AND lifecycle_state = ANY($2)`,
          [threadId, ACTIVE_NODE_STATES]
        );
        abortedNodeCount = aborted.rowCount ?? 0;
      }

      const closed = await client.query<{ closed_at: Date }>(
        `UPDATE threads SET status = 'CLOSED', closed_at = now(), close_mode = $2, updated_at = now()
          WHERE id = $1 RETURNING closed_at`,
        [threadId, mode]
      );
      return { threadId, status: 'CLOSED', mode, abortedNodeCount, closedAt: closed.rows[0]!.closed_at.toISOString() };
    });
  }

  /** Plain reopen: CLOSED -> OPEN. Aborted nodes stay ABORTED. The original
   * gated this behind fn_issue_reopen_ticket; tickets are not built. */
  async reopenThread(identity: RequestIdentity, threadId: string): Promise<ReopenSummary> {
    requireUuid(threadId, 'Thread');
    return this.inTransaction(async (client) => {
      const thread = await this.lockThread(client, identity, threadId);
      if (thread.status !== 'CLOSED') {
        throw new DomainFault('INVALID_STATE', `Thread ${threadId} is not closed.`, { threadId });
      }
      const reopened = await client.query<{ updated_at: Date }>(
        `UPDATE threads SET status = 'OPEN', closed_at = NULL, close_mode = NULL, updated_at = now()
          WHERE id = $1 RETURNING updated_at`,
        [threadId]
      );
      return { threadId, status: 'OPEN', reopenedAt: reopened.rows[0]!.updated_at.toISOString() };
    });
  }

  /** FOR UPDATE serialises close/reopen on the same thread, so two closes
   * can't both see OPEN and both succeed. */
  private async lockThread(client: PoolClient, identity: RequestIdentity, threadId: string): Promise<ThreadRow> {
    const res = await client.query<ThreadRow>(`SELECT * FROM threads WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
      threadId,
      identity.tenantId,
    ]);
    const row = res.rows[0];
    if (!row) throw new DomainFault('NOT_FOUND', `Thread ${threadId} does not exist.`, { threadId });
    return row;
  }

  private async inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
