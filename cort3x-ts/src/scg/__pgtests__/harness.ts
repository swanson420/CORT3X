// Fresh-database harness for the Postgres integration tests.
//
// Needs TEST_DATABASE_URL pointing at a server where that role may CREATE
// DATABASE. There is deliberately no skip: without a database these tests
// fail with a message, so a missing DB can never pass as "green".
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCG_ROOT = path.join(here, '..');

/** Applied in this order; 006 needs psql and is tested separately. */
export const MIGRATIONS = [
  'persistence/001_state_persistence_consolidated.sql',
  'orchestrator/002_add_lease_tracking.sql',
  'persistence/003_add_fan_in_backoff.sql',
  'persistence/005_add_node_directives.sql',
].map((p) => path.join(SCG_ROOT, p));

export function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. The Postgres integration tests need a server where this role can CREATE DATABASE, ' +
        'e.g. TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run test:pg'
    );
  }
  return url;
}

export interface TestDb {
  pool: pg.Pool;
  url: string;
  name: string;
  drop(): Promise<void>;
}

/** Creates an empty database, applies MIGRATIONS, returns a pool on it. */
export async function createTestDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  const name = `scg_test_${randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 20 });
  if (opts.migrate !== false) {
    for (const file of MIGRATIONS) {
      try {
        await pool.query(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        throw new Error(`migration ${path.basename(file)} failed: ${(err as Error).message}`);
      }
    }
  }
  return {
    pool,
    url: url.toString(),
    name,
    async drop() {
      await pool.end();
      const a = new pg.Client({ connectionString: adminUrl() });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export interface Seed {
  tenantId: string;
  tenantSlug: string;
  principalId: string;
  issuer: string;
  subject: string;
  catalogEntryId: string;
  versionId: string;
}

export const DEFAULT_MODEL_CONFIG = { provider: 'anthropic', modelId: 'test-model', parameters: { temperature: 0.1 } };

/** One tenant with an active member principal and one catalog version. */
export async function seedTenant(pool: pg.Pool, slug = `t-${randomBytes(3).toString('hex')}`, modelConfig: object = DEFAULT_MODEL_CONFIG): Promise<Seed> {
  const t = await pool.query<{ id: string }>(`INSERT INTO tenants (slug) VALUES ($1) RETURNING id`, [slug]);
  const issuer = 'https://issuer.test';
  const subject = `user-${randomUUID()}`;
  const p = await pool.query<{ id: string }>(`INSERT INTO principals (issuer, subject) VALUES ($1, $2) RETURNING id`, [issuer, subject]);
  await pool.query(
    `INSERT INTO principal_tenant_memberships (principal_id, tenant_id, capabilities) VALUES ($1, $2, ARRAY['node.execute'])`,
    [p.rows[0]!.id, t.rows[0]!.id]
  );
  const c = await pool.query<{ id: string }>(`INSERT INTO catalog_entries (tenant_id, name) VALUES ($1, 'summarise') RETURNING id`, [t.rows[0]!.id]);
  const v = await pool.query<{ id: string }>(
    `INSERT INTO catalog_entry_versions (catalog_entry_id, version, system_prompt, model_config) VALUES ($1, 1, 'You summarise.', $2) RETURNING id`,
    [c.rows[0]!.id, JSON.stringify(modelConfig)]
  );
  return {
    tenantId: t.rows[0]!.id,
    tenantSlug: slug,
    principalId: p.rows[0]!.id,
    issuer,
    subject,
    catalogEntryId: c.rows[0]!.id,
    versionId: v.rows[0]!.id,
  };
}

export async function insertThread(pool: pg.Pool, seed: Seed, status: 'OPEN' | 'CLOSED' = 'OPEN'): Promise<string> {
  const closed = status === 'CLOSED';
  const r = await pool.query<{ id: string }>(
    `INSERT INTO threads (tenant_id, title, created_by, status, closed_at, close_mode)
     VALUES ($1, 'thread', $2, $3, $4, $5) RETURNING id`,
    [seed.tenantId, seed.principalId, status, closed ? new Date() : null, closed ? 'ABORT_ACTIVE' : null]
  );
  return r.rows[0]!.id;
}

export async function insertNode(
  pool: pg.Pool,
  seed: Seed,
  threadId: string,
  fields: { state?: string; input?: string; createdAt?: Date; leaseExpiresAt?: Date; leasedBy?: string; directives?: Partial<Record<'role_profile' | 'active_goggle' | 'active_lens' | 'system_instructions', string>> } = {}
): Promise<string> {
  const d = fields.directives ?? {};
  const r = await pool.query<{ id: string }>(
    `INSERT INTO nodes (thread_id, tenant_id, catalog_entry_version_id, resolved_input_text, lifecycle_state, created_at,
                        lease_expires_at, leased_by, role_profile, active_goggle, active_lens, system_instructions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [
      threadId, seed.tenantId, seed.versionId, fields.input ?? 'input text', fields.state ?? 'PENDING', fields.createdAt ?? new Date(),
      fields.leaseExpiresAt ?? null, fields.leasedBy ?? null,
      d.role_profile ?? null, d.active_goggle ?? null, d.active_lens ?? null, d.system_instructions ?? null,
    ]
  );
  return r.rows[0]!.id;
}

export async function nodeState(pool: pg.Pool, id: string): Promise<string> {
  return (await pool.query<{ s: string }>(`SELECT lifecycle_state AS s FROM nodes WHERE id = $1`, [id])).rows[0]!.s;
}
