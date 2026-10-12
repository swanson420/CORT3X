import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assemblePromptEnvelope, parseModelConfig, InvalidModelConfigFault } from '../assemblePromptEnvelope.js';
import type { NodeClaimPayload } from '../claimAndDispatchNode.js';

const claim: NodeClaimPayload = {
  nodeId: 'n1', threadId: 't1', tenantId: 'ten1', catalogEntryId: 'c1', catalogEntryVersionId: 'cv1',
  resolvedInputText: 'input', systemPrompt: 'Catalog prompt.',
  modelConfig: { provider: 'google', modelId: 'gemini-test', parameters: { temperature: 0.3, topP: 0.8, maxOutputTokens: 100, stopSequences: ['END'] } },
  roleProfile: null, activeGoggle: null, activeLens: null, systemInstructions: null,
  leaseExpiresAt: new Date(), workerId: 'w1',
};
const directives = { roleProfile: 'r', activeGoggle: 'g', activeLens: 'l' };

describe('assemblePromptEnvelope', () => {
  test('maps the claim and directives into a complete envelope', () => {
    const env = assemblePromptEnvelope(claim, { ...directives, systemInstructions: 'Node rule.' });
    assert.equal(env.envelopeVersion, '1.0.0');
    assert.match(env.envelopeId, /^[0-9a-f-]{36}$/);
    assert.equal(env.nodeId, 'n1');
    assert.equal(env.threadId, 't1');
    assert.deepEqual(env.target, { provider: 'google', modelId: 'gemini-test', parameters: { temperature: 0.3, topP: 0.8, maxOutputTokens: 100, stopSequences: ['END'] } });
    assert.deepEqual(env.directives, { roleProfile: 'r', activeGoggle: 'g', activeLens: 'l', systemInstructions: 'Catalog prompt.\n\nNode rule.' });
    assert.deepEqual(env.input, { primaryText: 'input', lineage: [] });
    assert.ok(!Number.isNaN(Date.parse(env.createdAt)));
  });

  test('the catalog system prompt is kept even with no node instructions; blank parts are dropped', () => {
    assert.equal(assemblePromptEnvelope(claim, directives).directives.systemInstructions, 'Catalog prompt.');
    const env = assemblePromptEnvelope({ ...claim, systemPrompt: '  ' }, { ...directives, systemInstructions: '' });
    assert.equal('systemInstructions' in env.directives, false);
  });

  test('each envelope gets its own id', () => {
    assert.notEqual(assemblePromptEnvelope(claim, directives).envelopeId, assemblePromptEnvelope(claim, directives).envelopeId);
  });
});

describe('parseModelConfig', () => {
  const bad = (config: Record<string, unknown>, msg: RegExp) =>
    assert.throws(() => parseModelConfig(config, 'cv9'), (err: unknown) => {
      assert.ok(err instanceof InvalidModelConfigFault);
      assert.equal(err.code, 'INVALID_MODEL_CONFIG');
      assert.equal(err.catalogEntryVersionId, 'cv9');
      assert.match(err.message, msg);
      return true;
    });

  test('accepts a minimal config with no parameters', () => {
    assert.deepEqual(parseModelConfig({ provider: 'anthropic', modelId: 'm' }, 'cv'), { provider: 'anthropic', modelId: 'm', parameters: {} });
  });

  test('rejects unknown providers, missing modelId and unknown keys', () => {
    bad({ provider: 'mistral', modelId: 'm' }, /provider must be one of/);
    bad({ modelId: 'm' }, /provider must be one of/);
    bad({ provider: 'openai' }, /modelId/);
    bad({ provider: 'openai', modelId: '' }, /modelId/);
    bad({ provider: 'openai', modelId: 'm', temperature: 1 }, /unknown model_config key "temperature"/);
    bad({ provider: 'openai', modelId: 'm', parameters: { max_tokens: 5 } }, /unknown parameter "max_tokens"/);
  });

  test('rejects out-of-range or mistyped parameters', () => {
    bad({ provider: 'openai', modelId: 'm', parameters: [] }, /parameters must be an object/);
    bad({ provider: 'openai', modelId: 'm', parameters: { temperature: -1 } }, /temperature/);
    bad({ provider: 'openai', modelId: 'm', parameters: { temperature: '0.5' } }, /temperature/);
    bad({ provider: 'openai', modelId: 'm', parameters: { topP: 0 } }, /topP/);
    bad({ provider: 'openai', modelId: 'm', parameters: { topP: 1.5 } }, /topP/);
    bad({ provider: 'openai', modelId: 'm', parameters: { maxOutputTokens: 1.5 } }, /maxOutputTokens/);
    bad({ provider: 'openai', modelId: 'm', parameters: { maxOutputTokens: 0 } }, /maxOutputTokens/);
    bad({ provider: 'openai', modelId: 'm', parameters: { stopSequences: 'END' } }, /stopSequences/);
    bad({ provider: 'openai', modelId: 'm', parameters: { stopSequences: [''] } }, /stopSequences/);
  });
});
