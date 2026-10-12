import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { claimNextNode } from '../orchestrator/claimAndDispatchNode.js';
import { createResolveDirectivesFromNode } from '../orchestrator/resolveDirectivesFromNode.js';
import { assemblePromptEnvelope, InvalidModelConfigFault } from '../orchestrator/assemblePromptEnvelope.js';
import { runClaimedNode } from '../orchestrator/runClaimedNode.js';
import { NodeExecutionRunner } from '../model-proxy/runner.js';
import type { PromptEnvelopeDTO } from '../model-proxy/types.js';
import { createTestDb, seedTenant, insertThread, insertNode, nodeState, type TestDb, type Seed } from './harness.js';

describe('claimNextNode', () => {
  let db: TestDb;
  before(async () => { db = await createTestDb(); });
  after(async () => { await db.drop(); });

  test('claims the oldest PENDING node, marks it RUNNING with a lease, and returns every payload field', async () => {
    const s = await seedTenant(db.pool);
    const t = await insertThread(db.pool, s);
    const older = await insertNode(db.pool, s, t, { createdAt: new Date(Date.now() - 10_000), input: 'first', directives: { active_goggle: 'security' } });
    await insertNode(db.pool, s, t, { input: 'second' });

    const before = Date.now();
    const claim = await claimNextNode(db.pool, { tenantId: s.tenantId, workerId: 'w1', leaseMs: 30_000 });
    assert.ok(claim);
    assert.equal(claim.nodeId, older);
    assert.equal(claim.threadId, t);
    assert.equal(claim.tenantId, s.tenantId);
    assert.equal(claim.catalogEntryId, s.catalogEntryId);
    assert.equal(claim.catalogEntryVersionId, s.versionId);
    assert.equal(claim.resolvedInputText, 'first');
    assert.equal(claim.systemPrompt, 'You summarise.');
    assert.deepEqual(claim.modelConfig, { provider: 'anthropic', modelId: 'test-model', parameters: { temperature: 0.1 } });
    assert.equal(claim.activeGoggle, 'security');
    assert.equal(claim.roleProfile, null);
    assert.equal(claim.workerId, 'w1');
    const leaseMs = claim.leaseExpiresAt.getTime() - before;
    assert.ok(leaseMs > 25_000 && leaseMs < 35_000, `lease ~30s, got ${leaseMs}ms`);
    assert.equal(await nodeState(db.pool, older), 'RUNNING');
  });

  test('returns null when nothing is runnable', async () => {
    const s = await seedTenant(db.pool);
    const t = await insertThread(db.pool, s);
    await insertNode(db.pool, s, t, { state: 'COMPLETED' });
    await insertNode(db.pool, s, t, { state: 'RUNNING', leasedBy: 'other', leaseExpiresAt: new Date(Date.now() + 60_000) });
    assert.equal(await claimNextNode(db.pool, { tenantId: s.tenantId, workerId: 'w', leaseMs: 1000 }), null);
  });

  test('never claims from a CLOSED thread or another tenant', async () => {
    const s = await seedTenant(db.pool);
    const other = await seedTenant(db.pool);
    await insertNode(db.pool, s, await insertThread(db.pool, s, 'CLOSED'));
    await insertNode(db.pool, other, await insertThread(db.pool, other));
    assert.equal(await claimNextNode(db.pool, { tenantId: s.tenantId, workerId: 'w', leaseMs: 1000 }), null);
  });

  test('reclaims a RUNNING node whose lease expired, and records the new worker', async () => {
    const s = await seedTenant(db.pool);
    const t = await insertThread(db.pool, s);
    const stale = await insertNode(db.pool, s, t, { state: 'RUNNING', leasedBy: 'dead-worker', leaseExpiresAt: new Date(Date.now() - 1000) });
    const claim = await claimNextNode(db.pool, { tenantId: s.tenantId, workerId: 'w2', leaseMs: 5000 });
    assert.equal(claim?.nodeId, stale);
    assert.equal(claim?.workerId, 'w2');
    assert.ok(claim!.leaseExpiresAt.getTime() > Date.now());
  });

  test('concurrent workers never claim the same node twice', async () => {
    const s = await seedTenant(db.pool);
    const t = await insertThread(db.pool, s);
    const ids = new Set<string>();
    for (let i = 0; i < 30; i++) ids.add(await insertNode(db.pool, s, t));
    const claimed: string[] = [];
    await Promise.all(
      Array.from({ length: 10 }, async (_, w) => {
        for (;;) {
          const c = await claimNextNode(db.pool, { tenantId: s.tenantId, workerId: `w${w}`, leaseMs: 60_000 });
          if (!c) return;
          claimed.push(c.nodeId);
        }
      })
    );
    assert.equal(claimed.length, 30, 'every node claimed');
    assert.equal(new Set(claimed).size, 30, 'no node claimed twice');
    assert.deepEqual(new Set(claimed), ids);
  });

  test('rejects a non-positive leaseMs before touching the database', async () => {
    await assert.rejects(claimNextNode(db.pool, { tenantId: '00000000-0000-0000-0000-000000000000', workerId: 'w', leaseMs: 0 }), RangeError);
  });
});

describe('claim -> directives -> envelope -> runner (end to end)', () => {
  let db: TestDb;
  let s: Seed;
  before(async () => { db = await createTestDb(); });
  after(async () => { await db.drop(); });

  test('a claimed node reaches the provider adapter with the catalog prompt, node directives and model target', async () => {
    s = await seedTenant(db.pool, undefined, { provider: 'openai', modelId: 'gpt-test', parameters: { maxOutputTokens: 64 } });
    const t = await insertThread(db.pool, s);
    await insertNode(db.pool, s, t, { input: 'Summarise this.', directives: { active_lens: 'skeptical', system_instructions: 'Be brief.' } });

    const claim = await claimNextNode(db.pool, { tenantId: s.tenantId, workerId: 'w', leaseMs: 10_000 });
    assert.ok(claim);
    const directives = createResolveDirectivesFromNode({ roleProfile: 'analyst', activeGoggle: 'general', activeLens: 'balanced' })(claim);

    let seen: PromptEnvelopeDTO | undefined;
    const runner = new NodeExecutionRunner({
      getAdapter: (provider: string) => {
        assert.equal(provider, 'openai');
        return {
          provider: 'openai',
          dispatch: (env: PromptEnvelopeDTO) => {
            seen = env;
            return {
              stream: (async function* () { yield 'Short '; yield 'summary.'; })(),
              completed: Promise.resolve({ latencyMs: 1, finishReason: 'completed' as const }),
            };
          },
          normalizeExecution: () => { throw new Error('unused'); },
        };
      },
    } as never);

    const result = await runClaimedNode(runner, claim, directives);
    assert.equal(result.artifact?.rawOutput, 'Short summary.');
    assert.ok(seen);
    assert.equal(seen.nodeId, claim.nodeId);
    assert.equal(seen.threadId, t);
    assert.deepEqual(seen.target, { provider: 'openai', modelId: 'gpt-test', parameters: { maxOutputTokens: 64 } });
    assert.deepEqual(seen.directives, {
      roleProfile: 'analyst',
      activeGoggle: 'general',
      activeLens: 'skeptical',
      systemInstructions: 'You summarise.\n\nBe brief.',
    });
    assert.deepEqual(seen.input, { primaryText: 'Summarise this.', lineage: [] });
  });

  test('a catalog version with a bad model_config fails loudly before any provider call', async () => {
    const bad = await seedTenant(db.pool, undefined, { provider: 'anthropic', modelId: 'm', parameters: { max_tokens: 100 } });
    await insertNode(db.pool, bad, await insertThread(db.pool, bad));
    const claim = await claimNextNode(db.pool, { tenantId: bad.tenantId, workerId: 'w', leaseMs: 1000 });
    assert.ok(claim);
    assert.throws(
      () => assemblePromptEnvelope(claim, { roleProfile: 'r', activeGoggle: 'g', activeLens: 'l' }),
      (err: unknown) => err instanceof InvalidModelConfigFault && /unknown parameter "max_tokens"/.test(err.message)
    );
  });
});
