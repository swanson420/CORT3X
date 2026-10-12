import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PgStatePersistenceEngine, resolveRequestIdentity, DomainFault, type RequestIdentity } from '../persistence/statePersistence.js';
import { Router } from '../orchestrator/http/router.js';
import { registerThreadRoutes } from '../orchestrator/http/threadRoutes.js';
import { createTestDb, seedTenant, insertThread, insertNode, nodeState, type TestDb, type Seed } from './harness.js';

const fault = (category: string) => (err: unknown) => {
  assert.ok(err instanceof DomainFault, `expected DomainFault, got ${err}`);
  assert.equal(err.category, category);
  return true;
};

describe('resolveRequestIdentity', () => {
  let db: TestDb;
  let s: Seed;
  before(async () => { db = await createTestDb(); s = await seedTenant(db.pool, 'acme'); });
  after(async () => { await db.drop(); });

  test('an active member resolves to its tenant and capabilities', async () => {
    const id = await resolveRequestIdentity(db.pool, s.issuer, s.subject, 'acme');
    assert.deepEqual(id, { principalId: s.principalId, tenantId: s.tenantId, capabilities: ['node.execute'] });
  });

  test('unknown, suspended and expired principals are all UNAUTHENTICATED', async () => {
    await assert.rejects(resolveRequestIdentity(db.pool, s.issuer, 'nobody', 'acme'), fault('UNAUTHENTICATED'));
    const sus = await seedTenant(db.pool);
    await db.pool.query(`UPDATE principals SET status = 'SUSPENDED' WHERE id = $1`, [sus.principalId]);
    await assert.rejects(resolveRequestIdentity(db.pool, sus.issuer, sus.subject, sus.tenantSlug), fault('UNAUTHENTICATED'));
    const exp = await seedTenant(db.pool);
    await db.pool.query(`UPDATE principals SET expires_at = now() - interval '1 second' WHERE id = $1`, [exp.principalId]);
    await assert.rejects(resolveRequestIdentity(db.pool, exp.issuer, exp.subject, exp.tenantSlug), fault('UNAUTHENTICATED'));
  });

  test("another tenant, an unknown tenant and a suspended membership are all FORBIDDEN", async () => {
    const other = await seedTenant(db.pool, 'other');
    await assert.rejects(resolveRequestIdentity(db.pool, s.issuer, s.subject, 'other'), fault('FORBIDDEN'));
    await assert.rejects(resolveRequestIdentity(db.pool, s.issuer, s.subject, 'does-not-exist'), fault('FORBIDDEN'));
    await db.pool.query(`UPDATE principal_tenant_memberships SET status = 'SUSPENDED' WHERE principal_id = $1`, [other.principalId]);
    await assert.rejects(resolveRequestIdentity(db.pool, other.issuer, other.subject, 'other'), fault('FORBIDDEN'));
  });
});

describe('PgStatePersistenceEngine', () => {
  let db: TestDb;
  let engine: PgStatePersistenceEngine;
  let a: Seed;
  let idA: RequestIdentity;
  let idB: RequestIdentity;
  before(async () => {
    db = await createTestDb();
    engine = new PgStatePersistenceEngine(db.pool);
    a = await seedTenant(db.pool);
    const b = await seedTenant(db.pool);
    idA = await resolveRequestIdentity(db.pool, a.issuer, a.subject, a.tenantSlug);
    idB = await resolveRequestIdentity(db.pool, b.issuer, b.subject, b.tenantSlug);
  });
  after(async () => { await db.drop(); });

  test('createThread then getThreadById round-trips', async () => {
    const id = await engine.createThread(idA, 'Plan', { k: 1 });
    const t = await engine.getThreadById(idA, id);
    assert.equal(t.title, 'Plan');
    assert.deepEqual(t.metadata, { k: 1 });
    assert.equal(t.status, 'OPEN');
    assert.equal(t.createdBy, idA.principalId);
    assert.equal(t.closedAt, null);
  });

  test("another tenant's thread, an unknown id and a malformed id are all NOT_FOUND", async () => {
    const id = await engine.createThread(idA, 'Mine', {});
    await assert.rejects(engine.getThreadById(idB, id), fault('NOT_FOUND'));
    await assert.rejects(engine.closeThread(idB, id, 'ABORT_ACTIVE'), fault('NOT_FOUND'));
    await assert.rejects(engine.getThreadById(idA, '00000000-0000-0000-0000-000000000000'), fault('NOT_FOUND'));
    await assert.rejects(engine.getThreadById(idA, 'not-a-uuid'), fault('NOT_FOUND'));
    assert.equal((await engine.getThreadById(idA, id)).status, 'OPEN', 'cross-tenant close must not touch the thread');
  });

  test('ABORT_ACTIVE closes and aborts PENDING/RUNNING nodes, leaving finished ones alone', async () => {
    const t = await engine.createThread(idA, 'T', {});
    const pending = await insertNode(db.pool, a, t);
    const running = await insertNode(db.pool, a, t, { state: 'RUNNING', leasedBy: 'w', leaseExpiresAt: new Date(Date.now() + 60_000) });
    const done = await insertNode(db.pool, a, t, { state: 'COMPLETED' });
    const failed = await insertNode(db.pool, a, t, { state: 'FAILED' });
    const summary = await engine.closeThread(idA, t, 'ABORT_ACTIVE');
    assert.equal(summary.abortedNodeCount, 2);
    assert.equal(summary.status, 'CLOSED');
    assert.equal(await nodeState(db.pool, pending), 'ABORTED');
    assert.equal(await nodeState(db.pool, running), 'ABORTED');
    assert.equal(await nodeState(db.pool, done), 'COMPLETED');
    assert.equal(await nodeState(db.pool, failed), 'FAILED');
    const after = await engine.getThreadById(idA, t);
    assert.equal(after.closeMode, 'ABORT_ACTIVE');
    assert.ok(after.closedAt);
  });

  test('REQUIRE_QUIESCENCE refuses while nodes are active, touching nothing, then succeeds once quiet', async () => {
    const t = await engine.createThread(idA, 'T', {});
    const n = await insertNode(db.pool, a, t);
    await assert.rejects(engine.closeThread(idA, t, 'REQUIRE_QUIESCENCE'), (err: unknown) => {
      fault('CONFLICT')(err);
      assert.equal((err as DomainFault).details.activeNodeCount, 1);
      return true;
    });
    assert.equal((await engine.getThreadById(idA, t)).status, 'OPEN');
    assert.equal(await nodeState(db.pool, n), 'PENDING');
    await db.pool.query(`UPDATE nodes SET lifecycle_state = 'COMPLETED' WHERE id = $1`, [n]);
    const s = await engine.closeThread(idA, t, 'REQUIRE_QUIESCENCE');
    assert.equal(s.abortedNodeCount, 0);
  });

  test('closing a closed thread and reopening an open one are INVALID_STATE', async () => {
    const t = await engine.createThread(idA, 'T', {});
    await assert.rejects(engine.reopenThread(idA, t), fault('INVALID_STATE'));
    await engine.closeThread(idA, t, 'ABORT_ACTIVE');
    await assert.rejects(engine.closeThread(idA, t, 'ABORT_ACTIVE'), fault('INVALID_STATE'));
  });

  test('reopen returns a closed thread to OPEN and clears close fields; aborted nodes stay aborted', async () => {
    const t = await engine.createThread(idA, 'T', {});
    const n = await insertNode(db.pool, a, t);
    await engine.closeThread(idA, t, 'ABORT_ACTIVE');
    const r = await engine.reopenThread(idA, t);
    assert.equal(r.status, 'OPEN');
    const after = await engine.getThreadById(idA, t);
    assert.equal(after.closedAt, null);
    assert.equal(after.closeMode, null);
    assert.equal(await nodeState(db.pool, n), 'ABORTED');
  });

  test('concurrent closes of one thread: exactly one wins, the rest are INVALID_STATE', async () => {
    const t = await engine.createThread(idA, 'Race', {});
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => engine.closeThread(idA, t, 'ABORT_ACTIVE')));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(ok.length, 1);
    for (const r of bad) fault('INVALID_STATE')(r.reason);
  });
});

describe('thread routes over HTTP (Router + translateError + real engine)', () => {
  let db: TestDb;
  let router: Router;
  let ctxA: { identity: RequestIdentity; engine: PgStatePersistenceEngine };
  let ctxB: typeof ctxA;
  const req = (body?: unknown) => ({ method: 'X', query: {}, headers: {}, body });
  before(async () => {
    db = await createTestDb();
    const engine = new PgStatePersistenceEngine(db.pool);
    const a = await seedTenant(db.pool);
    const b = await seedTenant(db.pool);
    ctxA = { identity: await resolveRequestIdentity(db.pool, a.issuer, a.subject, a.tenantSlug), engine };
    ctxB = { identity: await resolveRequestIdentity(db.pool, b.issuer, b.subject, b.tenantSlug), engine };
    router = new Router();
    registerThreadRoutes(router);
  });
  after(async () => { await db.drop(); });

  test('the full lifecycle maps to the right status codes', async () => {
    const created = await router.dispatch('POST', '/threads', req({ title: 'Hello', metadata: { a: 1 } }), ctxA);
    assert.equal(created.status, 201);
    const id = (created.body as { id: string }).id;

    assert.equal((await router.dispatch('GET', `/threads/${id}`, req(), ctxA)).status, 200);
    assert.equal((await router.dispatch('GET', `/threads/${id}`, req(), ctxB)).status, 404, 'other tenant');
    assert.equal((await router.dispatch('GET', '/threads/not-a-uuid', req(), ctxA)).status, 404);

    const closed = await router.dispatch('POST', `/threads/${id}/close`, req({ mode: 'REQUIRE_QUIESCENCE' }), ctxA);
    assert.equal(closed.status, 200);
    assert.equal((closed.body as { mode: string }).mode, 'REQUIRE_QUIESCENCE');

    const again = await router.dispatch('POST', `/threads/${id}/close`, req(), ctxA);
    assert.equal(again.status, 409);
    assert.equal((again.body as { error: string }).error, 'invalid_state');

    assert.equal((await router.dispatch('POST', `/threads/${id}/reopen`, req(), ctxA)).status, 200);
  });

  test('bad input is 400 before touching the database', async () => {
    assert.equal((await router.dispatch('POST', '/threads', req({}), ctxA)).status, 400);
    const created = await router.dispatch('POST', '/threads', req({ title: 'x' }), ctxA);
    const id = (created.body as { id: string }).id;
    const bad = await router.dispatch('POST', `/threads/${id}/close`, req({ mode: 'NUKE' }), ctxA);
    assert.equal(bad.status, 400);
  });
});
