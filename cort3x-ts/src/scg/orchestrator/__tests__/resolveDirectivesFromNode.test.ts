import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createResolveDirectivesFromNode } from '../resolveDirectivesFromNode.js';
import type { NodeClaimPayload } from '../claimAndDispatchNode.js';

const baseClaim: NodeClaimPayload = {
  nodeId: 'n1',
  threadId: 't1',
  tenantId: 'ten1',
  catalogEntryId: 'c1',
  catalogEntryVersionId: 'cv1',
  resolvedInputText: 'input',
  systemPrompt: 'prompt',
  modelConfig: {},
  roleProfile: null,
  activeGoggle: null,
  activeLens: null,
  systemInstructions: null,
  leaseExpiresAt: new Date(),
  workerId: 'w1',
};

const defaults = {
  roleProfile: 'default-role',
  activeGoggle: 'default-goggle',
  activeLens: 'default-lens',
  systemInstructions: 'default-instructions',
};

describe('createResolveDirectivesFromNode', () => {
  test('a node with no overrides falls back entirely to the supplied defaults', () => {
    const resolve = createResolveDirectivesFromNode(defaults);
    assert.deepEqual(resolve(baseClaim), defaults);
  });

  test('a node with all overrides ignores the defaults entirely', () => {
    const resolve = createResolveDirectivesFromNode(defaults);
    const claim: NodeClaimPayload = {
      ...baseClaim,
      roleProfile: 'node-role',
      activeGoggle: 'node-goggle',
      activeLens: 'node-lens',
      systemInstructions: 'node-instructions',
    };
    assert.deepEqual(resolve(claim), {
      roleProfile: 'node-role',
      activeGoggle: 'node-goggle',
      activeLens: 'node-lens',
      systemInstructions: 'node-instructions',
    });
  });

  test('per-field fallback: only the NULL columns fall back, overridden ones are kept', () => {
    const resolve = createResolveDirectivesFromNode(defaults);
    const claim: NodeClaimPayload = {
      ...baseClaim,
      activeGoggle: 'node-goggle',
    };
    const result = resolve(claim);
    assert.equal(result.roleProfile, defaults.roleProfile);
    assert.equal(result.activeGoggle, 'node-goggle');
    assert.equal(result.activeLens, defaults.activeLens);
    assert.equal(result.systemInstructions, defaults.systemInstructions);
  });

  test('different defaults produce independent resolvers (factory, not a singleton)', () => {
    const resolveA = createResolveDirectivesFromNode({ ...defaults, activeGoggle: 'A' });
    const resolveB = createResolveDirectivesFromNode({ ...defaults, activeGoggle: 'B' });
    assert.equal(resolveA(baseClaim).activeGoggle, 'A');
    assert.equal(resolveB(baseClaim).activeGoggle, 'B');
  });
});
