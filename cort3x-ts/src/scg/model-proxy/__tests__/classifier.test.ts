import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAIError, GoogleGenerativeAIFetchError } from '@google/generative-ai';
import { ProviderErrorClassifier } from '../classifier.js';

// Errors are built with the real SDK classes wherever possible: the
// classifier is a set of guesses about these shapes, so hand-written fakes
// would only test the guesses against themselves.
const classify = ProviderErrorClassifier.classify.bind(ProviderErrorClassifier);
const anthropicErr = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, undefined, headers);
const openaiErr = (status: number, type: string, code: string | null, message: string, headers: Record<string, string> = {}) =>
  OpenAI.APIError.generate(status, { error: { type, code, message } }, undefined, headers);

describe('ProviderErrorClassifier: aborts', () => {
  test('Anthropic and OpenAI APIUserAbortError are client_aborted, not protocol_violation', () => {
    for (const err of [new Anthropic.APIUserAbortError(), new OpenAI.APIUserAbortError()]) {
      const d = classify(err, 10);
      assert.equal(d.category, 'client_aborted');
      assert.equal(d.retryable, false);
    }
  });

  test("Gemini's wrapped abort is client_aborted when the caller's signal fired", () => {
    const wrapped = new GoogleGenerativeAIError('Error fetching from https://x: This operation was aborted');
    assert.equal(classify(wrapped, 10, undefined, { aborted: true }).category, 'client_aborted');
    // Without the signal there is nothing reliable to go on, so it is not guessed.
    assert.notEqual(classify(wrapped, 10).category, 'client_aborted');
  });

  test('a DOM AbortError is client_aborted', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    assert.equal(classify(e, 1).category, 'client_aborted');
  });
});

describe('ProviderErrorClassifier: capacity', () => {
  test('Anthropic 429 is retryable capacity with Retry-After parsed', () => {
    const d = classify(anthropicErr(429, 'rate_limit_error', 'slow down', { 'retry-after': '7' }), 10);
    assert.equal(d.category, 'capacity');
    assert.equal(d.retryable, true);
    assert.equal(d.diagnostics?.retryAfterSeconds, 7);
  });

  test('OpenAI rate-limit headers are surfaced', () => {
    const d = classify(openaiErr(429, 'requests', 'rate_limit_exceeded', 'Rate limit reached', {
      'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1s',
    }), 10);
    assert.equal(d.category, 'capacity');
    assert.equal(d.retryable, true);
    assert.equal(d.diagnostics?.remainingRequests, 0);
    assert.equal(d.diagnostics?.resetRequestsWindow, '1s');
  });

  test('OpenAI insufficient_quota is capacity but NOT retryable (billing, not a rate window)', () => {
    const d = classify(openaiErr(429, 'insufficient_quota', 'insufficient_quota', 'You exceeded your current quota'), 10);
    assert.equal(d.category, 'capacity');
    assert.equal(d.retryable, false);
  });

  test('Gemini 429 and RESOURCE_EXHAUSTED are retryable capacity', () => {
    assert.equal(classify(new GoogleGenerativeAIFetchError('[429] quota', 429, 'Too Many Requests', []), 1).category, 'capacity');
    assert.equal(classify({ code: 'RESOURCE_EXHAUSTED', message: 'x' }, 1).category, 'capacity');
  });
});

describe('ProviderErrorClassifier: request faults', () => {
  test('Anthropic 400 invalid_request_error is invalid_parameters (nested error.error.type)', () => {
    const d = classify(anthropicErr(400, 'invalid_request_error', 'temperature: range: 0..1'), 10);
    assert.equal(d.category, 'invalid_parameters');
    assert.equal(d.retryable, false);
  });

  test('OpenAI 400 invalid_request_error is invalid_parameters', () => {
    assert.equal(classify(openaiErr(400, 'invalid_request_error', null, "Invalid value for 'temperature'"), 1).category, 'invalid_parameters');
  });

  test('context overflow is recognised for each provider phrasing', () => {
    assert.equal(classify(anthropicErr(400, 'invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum'), 1).category, 'context_overflow');
    assert.equal(classify(openaiErr(400, 'invalid_request_error', 'context_length_exceeded', "This model's maximum context length is 128000 tokens"), 1).category, 'context_overflow');
    assert.equal(classify({ status: 400, message: 'The input token count exceeds the maximum' }, 1).category, 'context_overflow');
  });

  test('a 400 that is really an upstream outage is retryable transient', () => {
    const d = classify({ status: 400, message: 'upstream connect error' }, 1);
    assert.equal(d.category, 'transient');
    assert.equal(d.retryable, true);
  });

  test('safety refusals are guardrail_trip', () => {
    assert.equal(classify({ code: 'SAFETY', message: 'x' }, 1).category, 'guardrail_trip');
    assert.equal(classify({ status: 400, message: 'Request blocked by safety policy' }, 1).category, 'guardrail_trip');
  });
});

describe('ProviderErrorClassifier: transport', () => {
  test('5xx (incl. Anthropic 529 overloaded) is retryable transient', () => {
    for (const s of [500, 503, 529]) {
      const d = classify(anthropicErr(s, 'overloaded_error', 'Overloaded'), 1);
      assert.equal(d.category, 'transient', `status ${s}`);
      assert.equal(d.retryable, true);
    }
  });

  test('SDK APIConnectionError (no status, no code) is retryable transient, not protocol_violation', () => {
    for (const err of [
      new Anthropic.APIConnectionError({ message: 'Connection error.' }),
      new OpenAI.APIConnectionError({ message: 'Connection error.' }),
      new OpenAI.APIConnectionTimeoutError(),
    ]) {
      const d = classify(err, 1);
      assert.equal(d.category, 'transient', err.constructor.name);
      assert.equal(d.retryable, true);
    }
  });

  test('a socket error code on .cause is retryable transient', () => {
    const e = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
    assert.equal(classify(e, 1).category, 'transient');
  });

  test('anything unrecognised is a non-retryable protocol_violation with the message kept', () => {
    const d = classify(new Error('something odd'), 42);
    assert.equal(d.category, 'protocol_violation');
    assert.equal(d.retryable, false);
    assert.equal(d.message, 'something odd');
    assert.equal(d.failedAtMs, 42);
  });

  test('null/undefined errors do not throw', () => {
    assert.equal(classify(undefined, 1).category, 'protocol_violation');
    assert.equal(classify(null, 1).category, 'protocol_violation');
  });
});
