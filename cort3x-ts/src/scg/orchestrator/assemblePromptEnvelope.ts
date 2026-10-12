// Builds the model-proxy PromptEnvelopeDTO for a claimed node.
//
// RECONSTRUCTED: the signature is fixed by runClaimedNode.ts; the body was
// never committed. The model_config shape below is this reconstruction's
// (see cort3x-ts/GAPS.md) and is validated strictly -- a catalog version
// with a bad config fails loudly here instead of reaching a provider.

import { randomUUID } from 'node:crypto';
import type { NodeClaimPayload } from './claimAndDispatchNode.js';
import type { EnvelopeDirectives, ModelProvider, ModelTarget, PromptEnvelopeDTO } from '../model-proxy/types.js';

/** A catalog version's model_config can't be turned into a ModelTarget.
 * That is catalog misconfiguration, not a caller error. */
export class InvalidModelConfigFault extends Error {
  readonly code = 'INVALID_MODEL_CONFIG';
  constructor(
    message: string,
    readonly catalogEntryVersionId: string
  ) {
    super(`catalog version ${catalogEntryVersionId}: ${message}`);
    this.name = 'InvalidModelConfigFault';
  }
}

const PROVIDERS: readonly ModelProvider[] = ['anthropic', 'google', 'openai'];
const PARAMETER_KEYS = ['temperature', 'topP', 'maxOutputTokens', 'stopSequences'] as const;

/**
 * Expected model_config shape:
 *   { "provider": "anthropic" | "google" | "openai",
 *     "modelId": "<non-empty string>",
 *     "parameters"?: { "temperature"?: number, "topP"?: number,
 *                      "maxOutputTokens"?: positive integer,
 *                      "stopSequences"?: string[] } }
 * Unknown keys are rejected rather than ignored, so a typo like
 * "max_tokens" can't silently fall back to a provider default.
 */
export function parseModelConfig(config: Record<string, unknown>, catalogEntryVersionId: string): ModelTarget {
  const fail = (msg: string): never => {
    throw new InvalidModelConfigFault(msg, catalogEntryVersionId);
  };
  for (const key of Object.keys(config)) {
    if (!['provider', 'modelId', 'parameters'].includes(key)) fail(`unknown model_config key ${JSON.stringify(key)}`);
  }
  const { provider, modelId, parameters = {} } = config as { provider?: unknown; modelId?: unknown; parameters?: unknown };
  if (typeof provider !== 'string' || !PROVIDERS.includes(provider as ModelProvider)) {
    fail(`provider must be one of ${PROVIDERS.join(', ')} (got ${JSON.stringify(provider)})`);
  }
  if (typeof modelId !== 'string' || modelId.length === 0) fail('modelId must be a non-empty string');
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
    fail('parameters must be an object if present');
  }
  const p = parameters as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!(PARAMETER_KEYS as readonly string[]).includes(key)) fail(`unknown parameter ${JSON.stringify(key)}`);
  }
  const num = (key: string, ok: (n: number) => boolean, rule: string): number | undefined => {
    const v = p[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) fail(`parameters.${key} must be ${rule}`);
    return v as number;
  };
  const temperature = num('temperature', (n) => n >= 0, 'a number >= 0');
  const topP = num('topP', (n) => n > 0 && n <= 1, 'a number in (0, 1]');
  const maxOutputTokens = num('maxOutputTokens', (n) => Number.isInteger(n) && n > 0, 'a positive integer');
  let stopSequences: readonly string[] | undefined;
  if (p.stopSequences !== undefined) {
    if (!Array.isArray(p.stopSequences) || !p.stopSequences.every((s) => typeof s === 'string' && s.length > 0)) {
      fail('parameters.stopSequences must be an array of non-empty strings');
    }
    stopSequences = p.stopSequences as string[];
  }

  return {
    provider: provider as ModelProvider,
    modelId: modelId as string,
    parameters: {
      ...(temperature !== undefined && { temperature }),
      ...(topP !== undefined && { topP }),
      ...(maxOutputTokens !== undefined && { maxOutputTokens }),
      ...(stopSequences !== undefined && { stopSequences }),
    },
  };
}

export function assemblePromptEnvelope(claim: NodeClaimPayload, directives: EnvelopeDirectives): PromptEnvelopeDTO {
  const target = parseModelConfig(claim.modelConfig, claim.catalogEntryVersionId);
  // The adapters build their system prompt from directives only, so the
  // catalog version's system_prompt has to travel in systemInstructions or
  // it would never reach the model. Catalog prompt first, then the node's
  // own instructions.
  const systemInstructions = [claim.systemPrompt, directives.systemInstructions]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .join('\n\n');
  return {
    envelopeVersion: '1.0.0',
    envelopeId: randomUUID(),
    nodeId: claim.nodeId,
    threadId: claim.threadId,
    target,
    directives: {
      roleProfile: directives.roleProfile,
      activeGoggle: directives.activeGoggle,
      activeLens: directives.activeLens,
      ...(systemInstructions.length > 0 && { systemInstructions }),
    },
    // Lineage needs the edges table, which isn't built (GAPS.md).
    input: { primaryText: claim.resolvedInputText, lineage: [] },
    createdAt: new Date().toISOString(),
  };
}
