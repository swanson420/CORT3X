// Claims the next runnable node for a worker, with a lease.
//
// RECONSTRUCTED: the original was referenced across SCG but never
// committed. NodeClaimPayload's fields are exactly the ones
// __tests__/resolveDirectivesFromNode.test.ts constructs; the directive
// columns come from 005 and the lease columns from 002. Completing or
// failing a claimed node, and fencing a stale lease holder out of that
// write, are not built -- see cort3x-ts/GAPS.md.

import type { Pool } from 'pg';

export interface NodeClaimPayload {
  nodeId: string;
  threadId: string;
  tenantId: string;
  catalogEntryId: string;
  catalogEntryVersionId: string;
  resolvedInputText: string;
  systemPrompt: string;
  /** catalog_entry_versions.model_config; validated by assemblePromptEnvelope(). */
  modelConfig: Record<string, unknown>;
  roleProfile: string | null;
  activeGoggle: string | null;
  activeLens: string | null;
  systemInstructions: string | null;
  leaseExpiresAt: Date;
  workerId: string;
}

export interface ClaimOptions {
  /** The tenant this worker serves (006 provisions one worker per tenant). */
  tenantId: string;
  /** Recorded as nodes.leased_by. */
  workerId: string;
  /** How long the lease lasts before another worker may reclaim the node. */
  leaseMs: number;
}

/**
 * Atomically claims one node and returns it, or null if none is runnable.
 *
 * Runnable means: in an OPEN thread of this tenant, and either PENDING or
 * RUNNING with an expired lease (its worker died or stalled -- the
 * watchdog case 002's index exists for). Oldest first.
 *
 * FOR UPDATE SKIP LOCKED lets concurrent workers claim different nodes
 * without blocking each other or double-claiming one.
 */
export async function claimNextNode(pool: Pool, opts: ClaimOptions): Promise<NodeClaimPayload | null> {
  if (!Number.isFinite(opts.leaseMs) || opts.leaseMs <= 0) {
    throw new RangeError(`leaseMs must be a positive number of milliseconds (got ${opts.leaseMs}).`);
  }
  const res = await pool.query<{
    node_id: string;
    thread_id: string;
    tenant_id: string;
    catalog_entry_id: string;
    catalog_entry_version_id: string;
    resolved_input_text: string;
    system_prompt: string;
    model_config: Record<string, unknown>;
    role_profile: string | null;
    active_goggle: string | null;
    active_lens: string | null;
    system_instructions: string | null;
    lease_expires_at: Date;
    leased_by: string;
  }>(
    `WITH candidate AS (
       SELECT n.id
         FROM nodes n
         JOIN threads t ON t.id = n.thread_id
        WHERE n.tenant_id = $1
          AND t.status = 'OPEN'
          AND (n.lifecycle_state = 'PENDING'
               OR (n.lifecycle_state = 'RUNNING' AND n.lease_expires_at < now()))
        ORDER BY n.created_at, n.id
        LIMIT 1
        FOR UPDATE OF n SKIP LOCKED
     )
     UPDATE nodes n
        SET lifecycle_state = 'RUNNING',
            leased_by = $2,
            lease_expires_at = now() + ($3::double precision * interval '1 millisecond'),
            updated_at = now()
       FROM candidate, catalog_entry_versions v
      WHERE n.id = candidate.id AND v.id = n.catalog_entry_version_id
     RETURNING n.id AS node_id, n.thread_id, n.tenant_id, v.catalog_entry_id,
               n.catalog_entry_version_id, n.resolved_input_text, v.system_prompt, v.model_config,
               n.role_profile, n.active_goggle, n.active_lens, n.system_instructions,
               n.lease_expires_at, n.leased_by`,
    [opts.tenantId, opts.workerId, opts.leaseMs]
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    nodeId: r.node_id,
    threadId: r.thread_id,
    tenantId: r.tenant_id,
    catalogEntryId: r.catalog_entry_id,
    catalogEntryVersionId: r.catalog_entry_version_id,
    resolvedInputText: r.resolved_input_text,
    systemPrompt: r.system_prompt,
    modelConfig: r.model_config,
    roleProfile: r.role_profile,
    activeGoggle: r.active_goggle,
    activeLens: r.active_lens,
    systemInstructions: r.system_instructions,
    leaseExpiresAt: r.lease_expires_at,
    workerId: r.leased_by,
  };
}
