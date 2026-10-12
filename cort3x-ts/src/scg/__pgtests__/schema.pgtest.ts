import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createTestDb, seedTenant, insertThread, insertNode, SCG_ROOT, type TestDb } from './harness.js';

describe('migrations 001-005', () => {
  let db: TestDb;
  before(async () => { db = await createTestDb(); });
  after(async () => { await db.drop(); });

  test('apply cleanly in order and leave every column the code reads', async () => {
    const cols = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'nodes'`
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const c of ['lifecycle_state', 'leased_by', 'lease_expires_at', 'fan_in_attempt_count', 'role_profile', 'active_goggle', 'active_lens', 'system_instructions']) {
      assert.ok(names.includes(c), `nodes.${c} missing`);
    }
  });

  test('catalog versions are immutable (trg_lock_catalog_versions)', async () => {
    const s = await seedTenant(db.pool);
    await assert.rejects(db.pool.query(`UPDATE catalog_entry_versions SET system_prompt = 'x' WHERE id = $1`, [s.versionId]), /immutable/);
    await assert.rejects(db.pool.query(`DELETE FROM catalog_entry_versions WHERE id = $1`, [s.versionId]), /immutable/);
  });

  test("a node can't claim a different tenant than its thread", async () => {
    const a = await seedTenant(db.pool);
    const b = await seedTenant(db.pool);
    const thread = await insertThread(db.pool, a);
    await assert.rejects(
      db.pool.query(`INSERT INTO nodes (thread_id, tenant_id, catalog_entry_version_id, resolved_input_text) VALUES ($1, $2, $3, 'x')`, [thread, b.tenantId, a.versionId]),
      /does not match its thread/
    );
  });

  test('a CLOSED thread must carry closed_at and close_mode, an OPEN one neither', async () => {
    const s = await seedTenant(db.pool);
    await assert.rejects(
      db.pool.query(`INSERT INTO threads (tenant_id, title, created_by, status) VALUES ($1, 't', $2, 'CLOSED')`, [s.tenantId, s.principalId]),
      /chk_thread_closed_fields/
    );
    const id = await insertThread(db.pool, s);
    await assert.rejects(db.pool.query(`UPDATE threads SET closed_at = now() WHERE id = $1`, [id]), /chk_thread_closed_fields/);
  });

  test('unknown lifecycle states are rejected', async () => {
    const s = await seedTenant(db.pool);
    const t = await insertThread(db.pool, s);
    await assert.rejects(insertNode(db.pool, s, t, { state: 'DONE' }), /check constraint/);
  });
});

describe('006_provision_worker_principal.sql (run with psql, as documented)', () => {
  let db: TestDb;
  const file = path.join(SCG_ROOT, 'persistence/006_provision_worker_principal.sql');
  const psql = (vars: Record<string, string>) =>
    spawnSync('psql', [db.url, '-X', '-q', ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`]), '-f', file], { encoding: 'utf8' });
  before(async () => {
    db = await createTestDb();
    await db.pool.query(`INSERT INTO tenants (slug) VALUES ('acme')`);
  });
  after(async () => { await db.drop(); });

  test('provisions the worker principal with node.execute in the tenant', async () => {
    const r = psql({ worker_issuer: 'spiffe://cluster.local', worker_subject: '/ns/prod/sa/scg-worker', tenant_slug: 'acme' });
    assert.equal(r.status, 0, r.stderr);
    const row = await db.pool.query(
      `SELECT p.status, m.capabilities, m.status AS m_status FROM principals p
         JOIN principal_tenant_memberships m ON m.principal_id = p.id
         JOIN tenants t ON t.id = m.tenant_id
        WHERE p.issuer = 'spiffe://cluster.local' AND p.subject = '/ns/prod/sa/scg-worker' AND t.slug = 'acme'`
    );
    assert.deepEqual(row.rows, [{ status: 'ACTIVE', capabilities: ['node.execute'], m_status: 'ACTIVE' }]);
  });

  test('re-running is idempotent', async () => {
    const r = psql({ worker_issuer: 'spiffe://cluster.local', worker_subject: '/ns/prod/sa/scg-worker', tenant_slug: 'acme' });
    assert.equal(r.status, 0, r.stderr);
    const n = await db.pool.query(`SELECT count(*)::int AS n FROM principals WHERE subject = '/ns/prod/sa/scg-worker'`);
    assert.equal(n.rows[0].n, 1);
  });

  test('a missing variable fails with the provisioning message and writes nothing', async () => {
    const before = (await db.pool.query(`SELECT count(*)::int AS n FROM principals`)).rows[0].n;
    const r = psql({ worker_issuer: 'x', tenant_slug: 'acme' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /must all be supplied/);
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM principals`)).rows[0].n, before);
  });

  test('an unknown tenant fails and writes nothing', async () => {
    const before = (await db.pool.query(`SELECT count(*)::int AS n FROM principals`)).rows[0].n;
    const r = psql({ worker_issuer: 'x', worker_subject: 'y', tenant_slug: 'nope' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no tenant with slug nope/);
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM principals`)).rows[0].n, before);
  });
});
