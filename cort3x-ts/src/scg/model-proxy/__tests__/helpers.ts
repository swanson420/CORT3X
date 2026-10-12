import type { PromptEnvelopeDTO, IModelProviderAdapter, DispatchedExecution, ExecutionMetrics } from '../types.js';
import type { ProviderAdapterFactory } from '../factory.js';

export function makeEnvelope(overrides: Partial<PromptEnvelopeDTO> = {}): PromptEnvelopeDTO {
  return {
    envelopeVersion: '1.0.0',
    envelopeId: 'env-1',
    nodeId: 'node-1',
    threadId: 'thread-1',
    target: { provider: 'anthropic', modelId: 'test-model', parameters: { temperature: 0.2, topP: 0.9, maxOutputTokens: 256, stopSequences: ['END'] } },
    directives: { roleProfile: 'reviewer', activeGoggle: 'security', activeLens: 'adversarial', systemInstructions: 'Be terse.' },
    input: { primaryText: 'hello', lineage: [] },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Fails the test instead of hanging it: a stream or promise that never
 * settles is exactly the bug class some of these tests look for. */
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const t of stream) out.push(t);
  return out;
}

export async function* fromArray<T>(items: readonly T[], opts: { throwAfter?: unknown } = {}): AsyncIterable<T> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
  if (opts.throwAfter !== undefined) throw opts.throwAfter;
}

export const OK_METRICS: ExecutionMetrics = { latencyMs: 5, inputTokens: 3, outputTokens: 4, finishReason: 'completed' };

/** A factory stand-in that hands the runner a fixed DispatchedExecution. */
export function factoryFor(dispatch: () => DispatchedExecution): ProviderAdapterFactory {
  const adapter: IModelProviderAdapter = {
    provider: 'anthropic',
    dispatch,
    normalizeExecution: () => OK_METRICS,
  };
  return { getAdapter: () => adapter, isRegistered: () => true } as unknown as ProviderAdapterFactory;
}
