import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { NodeExecutionRunner } from '../runner.js';
import type { ExecutionMetrics } from '../types.js';
import { makeEnvelope, withTimeout, collect, fromArray, factoryFor, OK_METRICS } from './helpers.js';

const env = makeEnvelope();

describe('NodeExecutionRunner', () => {
  test('streams tokens in order and commits them as the artifact', async () => {
    const runner = new NodeExecutionRunner(factoryFor(() => ({ stream: fromArray(['a', 'b', 'c']), completed: Promise.resolve(OK_METRICS) })));
    const ex = runner.execute(env);
    assert.deepEqual(await withTimeout(collect(ex.tokenStream), 1000, 'tokenStream'), ['a', 'b', 'c']);
    const { artifact, metrics } = await withTimeout(ex.completion, 1000, 'completion');
    assert.equal(metrics, OK_METRICS);
    assert.equal(artifact?.rawOutput, 'abc');
    assert.equal(artifact?.committedOutput, 'abc');
    assert.equal(artifact?.isEdited, false);
  });

  test('completion resolves with no tokenStream reader at all (runClaimedNode only awaits completion)', async () => {
    const tokens = Array.from({ length: 500 }, (_, i) => `t${i}`);
    const runner = new NodeExecutionRunner(factoryFor(() => ({ stream: fromArray(tokens), completed: Promise.resolve(OK_METRICS) })));
    const { artifact } = await withTimeout(runner.execute(env).completion, 1000, 'completion');
    assert.equal(artifact?.rawOutput, tokens.join(''));
  });

  test('no artifact when the adapter reports an error, even if some text streamed first', async () => {
    const errMetrics: ExecutionMetrics = {
      latencyMs: 1, finishReason: 'error',
      error: { category: 'transient', message: 'x', code: '503', failedAtMs: 1, retryable: true },
    };
    const runner = new NodeExecutionRunner(factoryFor(() => ({ stream: fromArray(['partial']), completed: Promise.resolve(errMetrics) })));
    const ex = runner.execute(env);
    await withTimeout(collect(ex.tokenStream), 1000, 'tokenStream');
    const { artifact, metrics } = await withTimeout(ex.completion, 1000, 'completion');
    assert.equal(artifact, undefined);
    assert.equal(metrics.error?.category, 'transient');
  });

  test('no artifact for an empty successful response', async () => {
    const runner = new NodeExecutionRunner(factoryFor(() => ({ stream: fromArray([]), completed: Promise.resolve(OK_METRICS) })));
    const { artifact } = await withTimeout(runner.execute(env).completion, 1000, 'completion');
    assert.equal(artifact, undefined);
  });

  test('a stream that throws surfaces the error to the reader; completion still settles', async () => {
    const boom = new Error('stream broke');
    const runner = new NodeExecutionRunner(factoryFor(() => ({ stream: fromArray(['a'], { throwAfter: boom }), completed: Promise.resolve(OK_METRICS) })));
    const ex = runner.execute(env);
    await assert.rejects(withTimeout(collect(ex.tokenStream), 1000, 'tokenStream'), /stream broke/);
    await withTimeout(ex.completion, 1000, 'completion');
  });

  test('completion rejects if the adapter metrics promise rejects', async () => {
    const runner = new NodeExecutionRunner(factoryFor(() => ({ stream: fromArray(['a']), completed: Promise.reject(new Error('metrics lost')) })));
    await assert.rejects(withTimeout(runner.execute(env).completion, 1000, 'completion'), /metrics lost/);
  });

  test('a reader that stops early does not stop the backend: completion has the full text', async () => {
    const runner = new NodeExecutionRunner(factoryFor(() => ({ stream: fromArray(['a', 'b', 'c', 'd']), completed: Promise.resolve(OK_METRICS) })));
    const ex = runner.execute(env);
    for await (const t of ex.tokenStream) {
      assert.equal(t, 'a');
      break;
    }
    const { artifact } = await withTimeout(ex.completion, 1000, 'completion');
    assert.equal(artifact?.rawOutput, 'abcd');
  });

  test('a reader that attaches after the stream already finished gets the tokens, not a hang', async () => {
    const runner = new NodeExecutionRunner(factoryFor(() => ({ stream: fromArray(['x', 'y']), completed: Promise.resolve(OK_METRICS) })));
    const ex = runner.execute(env);
    await withTimeout(ex.completion, 1000, 'completion');
    assert.deepEqual(await withTimeout(collect(ex.tokenStream), 1000, 'late tokenStream'), ['x', 'y']);
  });

  test('a reader too slow to keep up gets an explicit overflow error, not a hang', async () => {
    const tokens = Array.from({ length: 300 }, (_, i) => `t${i}`);
    const runner = new NodeExecutionRunner(factoryFor(() => ({ stream: fromArray(tokens), completed: Promise.resolve(OK_METRICS) })));
    const ex = runner.execute(env);
    // Let the backend run far ahead of the reader before it starts reading.
    await withTimeout(ex.completion, 1000, 'completion');
    await assert.rejects(withTimeout(collect(ex.tokenStream), 1000, 'overflowed tokenStream'), (err: Error) => {
      assert.equal((err as { code?: string }).code, 'OBSERVER_OVERFLOW');
      return true;
    });
  });

  test('an unregistered provider throws synchronously from execute()', () => {
    const runner = new NodeExecutionRunner({ getAdapter: () => { throw new Error('no adapter'); } } as never);
    assert.throws(() => runner.execute(env), /no adapter/);
  });
});
