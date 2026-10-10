import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainPoolWithTimeout } from '../poolDrain.js';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('resolves "drained" when end() finishes before the timeout', async () => {
  const pool = { end: async () => {} };
  const result = await drainPoolWithTimeout(pool, 200);
  assert.equal(result.status, 'drained');
});

test('resolves "timeout" when end() takes longer than the timeout', async () => {
  const pool = { end: () => new Promise<void>((resolve) => setTimeout(resolve, 500)) };
  const result = await drainPoolWithTimeout(pool, 30);
  assert.equal(result.status, 'timeout');
});

test('resolves "error" (not a throw) when end() rejects before the timeout', async () => {
  const thrown = new Error('connection refused');
  const pool = { end: async () => { throw thrown; } };
  const result = await drainPoolWithTimeout(pool, 200);
  assert.equal(result.status, 'error');
  assert.equal(
    result.status === 'error' ? result.error : undefined,
    thrown,
    'the actual Error object must be exposed to the caller, not just swallowed into a status string'
  );
});

test('a late rejection after the timeout already won does not become an unhandled rejection', async () => {
  let unhandled: unknown = null;
  const onUnhandled = (err: unknown) => { unhandled = err; };
  process.on('unhandledRejection', onUnhandled);

  try {
    const pool = {
      end: () =>
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error('late failure')), 60);
        }),
    };

    const result = await drainPoolWithTimeout(pool, 10);
    assert.equal(result.status, 'timeout', 'the race should resolve via timeout first');
    await sleep(150);
    assert.equal(unhandled, null, `expected no unhandledRejection, got: ${unhandled}`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a late resolve after the timeout already won is harmless', async () => {
  const pool = { end: () => new Promise<void>((resolve) => setTimeout(resolve, 60)) };
  const result = await drainPoolWithTimeout(pool, 10);
  assert.equal(result.status, 'timeout');
  await sleep(100);
});
