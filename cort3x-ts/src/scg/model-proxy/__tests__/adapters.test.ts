import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAIError } from '@google/generative-ai';
import { AnthropicProviderAdapter } from '../anthropic-adapter.js';
import { OpenAIProviderAdapter } from '../openai-adapter.js';
import { GeminiProviderAdapter } from '../gemini-adapter.js';
import { ProviderAdapterFactory, UnregisteredProviderError } from '../factory.js';
import { makeEnvelope, withTimeout, collect, fromArray } from './helpers.js';

const EXPECTED_SYSTEM = 'ROLE: reviewer\n\nGOGGLES: security\n\nLENS: adversarial\n\nBe terse.';

/** Throws `err` once the signal has aborted -- how the SDKs behave when a
 * caller aborts mid-request. Checks `aborted` first, like the SDKs do, since
 * the abort can land before this generator body first runs. */
function abortableStream<T>(signal: AbortSignal | undefined, err: unknown): AsyncIterable<T> {
  return (async function* () {
    if (!signal?.aborted) {
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    }
    throw err;
  })();
}

async function run(adapter: { dispatch: AnthropicProviderAdapter['dispatch'] }, env = makeEnvelope(), signal?: AbortSignal) {
  const ex = adapter.dispatch(env, signal);
  const tokens = await withTimeout(collect(ex.stream), 1000, 'adapter stream');
  const metrics = await withTimeout(ex.completed, 1000, 'adapter completed');
  return { tokens, metrics };
}

describe('AnthropicProviderAdapter', () => {
  const events = [
    { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 11, output_tokens: 1 }, stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ];

  test('builds the request from the envelope and streams text deltas', async () => {
    let seen: any;
    const client = { messages: { create: async (params: any, opts: any) => { seen = { params, opts }; return fromArray(events); } } };
    const ctrl = new AbortController();
    const { tokens, metrics } = await run(new AnthropicProviderAdapter(client), makeEnvelope(), ctrl.signal);

    assert.deepEqual(tokens, ['Hel', 'lo']);
    assert.equal(seen.params.model, 'test-model');
    assert.equal(seen.params.system, EXPECTED_SYSTEM);
    assert.equal(seen.params.max_tokens, 256);
    assert.equal(seen.params.temperature, 0.2);
    assert.equal(seen.params.top_p, 0.9);
    assert.equal(seen.params.stream, true);
    assert.deepEqual(seen.params.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(seen.opts.signal, ctrl.signal);
    // input from message_start, output from message_delta.
    assert.deepEqual(metrics, { latencyMs: metrics.latencyMs, inputTokens: 11, outputTokens: 7, finishReason: 'completed', rawProviderRequestId: 'msg_1' });
  });

  test('max_tokens stop reason maps to length_exceeded; maxOutputTokens defaults to 4096', async () => {
    let seen: any;
    const evs = events.map((e) => (e.type === 'message_delta' ? { ...e, delta: { stop_reason: 'max_tokens' } } : e));
    const client = { messages: { create: async (params: any) => { seen = params; return fromArray(evs); } } };
    const env = makeEnvelope({ target: { provider: 'anthropic', modelId: 'm', parameters: {} } });
    const { metrics } = await run(new AnthropicProviderAdapter(client), env);
    assert.equal(metrics.finishReason, 'length_exceeded');
    assert.equal(seen.max_tokens, 4096);
  });

  test('omits empty systemInstructions from the system prompt', async () => {
    let seen: any;
    const client = { messages: { create: async (params: any) => { seen = params; return fromArray(events); } } };
    const env = makeEnvelope({ directives: { roleProfile: 'r', activeGoggle: 'g', activeLens: 'l' } });
    await run(new AnthropicProviderAdapter(client), env);
    assert.equal(seen.system, 'ROLE: r\n\nGOGGLES: g\n\nLENS: l');
  });

  test('an API error ends the stream cleanly and is reported in metrics', async () => {
    const err = Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }, undefined, { 'retry-after': '3' });
    const client = { messages: { create: async () => { throw err; } } };
    const { tokens, metrics } = await run(new AnthropicProviderAdapter(client));
    assert.deepEqual(tokens, []);
    assert.equal(metrics.finishReason, 'error');
    assert.equal(metrics.error?.category, 'capacity');
    assert.equal(metrics.error?.diagnostics?.retryAfterSeconds, 3);
  });

  test('a caller abort is reported as aborted', async () => {
    const ctrl = new AbortController();
    const client = { messages: { create: async (_p: any, opts: any) => abortableStream(opts.signal, new Anthropic.APIUserAbortError()) } };
    const ex = new AnthropicProviderAdapter(client).dispatch(makeEnvelope(), ctrl.signal);
    const tokens = collect(ex.stream);
    ctrl.abort();
    await withTimeout(tokens, 1000, 'aborted stream');
    const metrics = await withTimeout(ex.completed, 1000, 'completed');
    assert.equal(metrics.finishReason, 'aborted');
    assert.equal(metrics.error?.category, 'client_aborted');
  });
});

describe('OpenAIProviderAdapter', () => {
  const chunk = (content: string | undefined, finish: string | null = null) => ({ id: 'chatcmpl_1', choices: [{ index: 0, delta: content === undefined ? {} : { content }, finish_reason: finish }] });
  const usage = { id: 'chatcmpl_1', choices: [], usage: { prompt_tokens: 9, completion_tokens: 5 } };

  test('builds the request from the envelope and streams content deltas', async () => {
    let seen: any;
    const client = { chat: { completions: { create: async (params: any, opts: any) => { seen = { params, opts }; return fromArray([chunk('Hi'), chunk(' there'), chunk(undefined, 'stop'), usage]); } } } };
    const { tokens, metrics } = await run(new OpenAIProviderAdapter(client));
    assert.deepEqual(tokens, ['Hi', ' there']);
    assert.deepEqual(seen.params.messages, [{ role: 'system', content: EXPECTED_SYSTEM }, { role: 'user', content: 'hello' }]);
    assert.deepEqual(seen.params.stop, ['END']);
    assert.equal(seen.params.max_tokens, 256);
    assert.deepEqual(seen.params.stream_options, { include_usage: true });
    assert.deepEqual(metrics, { latencyMs: metrics.latencyMs, inputTokens: 9, outputTokens: 5, finishReason: 'completed', rawProviderRequestId: 'chatcmpl_1' });
  });

  test('length finish reason maps to length_exceeded', async () => {
    const client = { chat: { completions: { create: async () => fromArray([chunk('x'), chunk(undefined, 'length'), usage]) } } };
    assert.equal((await run(new OpenAIProviderAdapter(client))).metrics.finishReason, 'length_exceeded');
  });

  test('content_filter mid-stream is a guardrail_trip error, with the partial text still streamed', async () => {
    const client = { chat: { completions: { create: async () => fromArray([chunk('partial'), chunk(undefined, 'content_filter'), usage]) } } };
    const { tokens, metrics } = await run(new OpenAIProviderAdapter(client));
    assert.deepEqual(tokens, ['partial']);
    assert.equal(metrics.finishReason, 'content_filter');
    assert.equal(metrics.error?.category, 'guardrail_trip');
    assert.equal(metrics.outputTokens, 5);
  });

  test('a connection failure is retryable transient', async () => {
    const client = { chat: { completions: { create: async () => { throw new OpenAI.APIConnectionError({ message: 'Connection error.' }); } } } };
    const { metrics } = await run(new OpenAIProviderAdapter(client));
    assert.equal(metrics.error?.category, 'transient');
    assert.equal(metrics.error?.retryable, true);
  });

  test('a caller abort is reported as aborted', async () => {
    const ctrl = new AbortController();
    const client = { chat: { completions: { create: async (_p: any, opts: any) => abortableStream(opts.signal, new OpenAI.APIUserAbortError()) } } };
    const ex = new OpenAIProviderAdapter(client).dispatch(makeEnvelope(), ctrl.signal);
    const tokens = collect(ex.stream);
    ctrl.abort();
    await withTimeout(tokens, 1000, 'aborted stream');
    assert.equal((await withTimeout(ex.completed, 1000, 'completed')).finishReason, 'aborted');
  });
});

describe('GeminiProviderAdapter', () => {
  const geminiChunk = (text: string, finishReason?: string) => ({
    candidates: [{ finishReason, content: { parts: [{ text }] } }],
    text: () => text,
  });
  function geminiClient(chunks: any[], response: any, capture: any = {}) {
    return {
      getGenerativeModel: (cfg: any) => {
        capture.cfg = cfg;
        return {
          generateContentStream: async (req: any, opts: any) => {
            capture.req = req;
            capture.opts = opts;
            return { stream: fromArray(chunks), response: Promise.resolve(response) };
          },
        };
      },
    };
  }

  test('builds the model config from the envelope and streams chunk text', async () => {
    const capture: any = {};
    const response = { responseId: 'g1', candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6 } };
    const { tokens, metrics } = await run(new GeminiProviderAdapter(geminiClient([geminiChunk('Ho'), geminiChunk('la', 'STOP')], response, capture)));
    assert.deepEqual(tokens, ['Ho', 'la']);
    assert.equal(capture.cfg.systemInstruction, EXPECTED_SYSTEM);
    assert.deepEqual(capture.cfg.generationConfig, { temperature: 0.2, topP: 0.9, maxOutputTokens: 256, stopSequences: ['END'] });
    assert.deepEqual(capture.req.contents, [{ role: 'user', parts: [{ text: 'hello' }] }]);
    assert.deepEqual(metrics, { latencyMs: metrics.latencyMs, inputTokens: 4, outputTokens: 6, finishReason: 'completed', rawProviderRequestId: 'g1' });
  });

  test('a SAFETY stop mid-stream stops yielding and reports content_filter', async () => {
    const response = { candidates: [{ finishReason: 'SAFETY', safetyRatings: [{ category: 'HARM_CATEGORY_X', probability: 'HIGH', blocked: true }] }], usageMetadata: {} };
    const { tokens, metrics } = await run(new GeminiProviderAdapter(geminiClient([geminiChunk('ok'), geminiChunk('bad', 'SAFETY')], response)));
    assert.deepEqual(tokens, ['ok']);
    assert.equal(metrics.finishReason, 'content_filter');
    assert.equal(metrics.error?.code, 'CANDIDATE_HALTED_SAFETY');
    assert.deepEqual(metrics.error?.diagnostics?.safetyRatings, { HARM_CATEGORY_X: { probability: 'HIGH', blocked: true } });
  });

  test('a blocked prompt reports content_filter with the block reason', async () => {
    const response = { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 3 } };
    const { tokens, metrics } = await run(new GeminiProviderAdapter(geminiClient([], response)));
    assert.deepEqual(tokens, []);
    assert.equal(metrics.error?.code, 'PROMPT_BLOCKED_SAFETY');
    assert.equal(metrics.outputTokens, 0);
  });

  test('MAX_TOKENS maps to length_exceeded', async () => {
    const response = { candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: {} };
    const { metrics } = await run(new GeminiProviderAdapter(geminiClient([geminiChunk('x', 'MAX_TOKENS')], response)));
    assert.equal(metrics.finishReason, 'length_exceeded');
  });

  test("a caller abort is reported as aborted even though the SDK wraps it in a generic error", async () => {
    const ctrl = new AbortController();
    const client = {
      getGenerativeModel: () => ({
        generateContentStream: async (_req: any, opts: any) => {
          if (!opts.signal.aborted) {
            await new Promise<void>((r) => opts.signal.addEventListener('abort', () => r(), { once: true }));
          }
          throw new GoogleGenerativeAIError('Error fetching from https://x: This operation was aborted');
        },
      }),
    };
    const ex = new GeminiProviderAdapter(client).dispatch(makeEnvelope(), ctrl.signal);
    const tokens = collect(ex.stream);
    ctrl.abort();
    await withTimeout(tokens, 1000, 'aborted stream');
    const metrics = await withTimeout(ex.completed, 1000, 'completed');
    assert.equal(metrics.finishReason, 'aborted');
    assert.equal(metrics.error?.category, 'client_aborted');
  });
});

describe('ProviderAdapterFactory', () => {
  test('registers only the providers given a client, and refuses the rest loudly', () => {
    const factory = new ProviderAdapterFactory({ anthropic: {} });
    assert.equal(factory.isRegistered('anthropic'), true);
    assert.equal(factory.isRegistered('openai'), false);
    assert.ok(factory.getAdapter('anthropic') instanceof AnthropicProviderAdapter);
    assert.throws(() => factory.getAdapter('openai'), UnregisteredProviderError);
  });

  test('maps each provider key to the matching adapter', () => {
    const factory = new ProviderAdapterFactory({ anthropic: {}, google: {}, openai: {} });
    assert.equal(factory.getAdapter('anthropic').provider, 'anthropic');
    assert.equal(factory.getAdapter('google').provider, 'google');
    assert.equal(factory.getAdapter('openai').provider, 'openai');
  });
});
