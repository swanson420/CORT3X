import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachShutdownSignals } from '../shutdownSignals.js';

function fakeProcess() {
  const emitter = new EventEmitter();
  const exitCalls: number[] = [];
  const fake = emitter as unknown as NodeJS.Process;
  (fake as any).exit = (code?: number) => exitCalls.push(code ?? 0);
  return { fake, emitter, exitCalls };
}

test('a registered signal aborts the returned controller', () => {
  const { fake, emitter } = fakeProcess();
  const controller = attachShutdownSignals(['SIGTERM'], fake);

  assert.equal(controller.signal.aborted, false);
  emitter.emit('SIGTERM');
  assert.equal(controller.signal.aborted, true, 'SIGTERM should abort the controller');
});

test('multiple registered signal names all abort the same controller', () => {
  const { fake, emitter } = fakeProcess();
  const controller = attachShutdownSignals(['SIGINT', 'SIGTERM'], fake);

  emitter.emit('SIGINT');
  assert.equal(controller.signal.aborted, true);
});

test('a second signal during drain forces exit rather than hanging silently', () => {
  const { fake, emitter, exitCalls } = fakeProcess();
  attachShutdownSignals(['SIGTERM'], fake);

  emitter.emit('SIGTERM');
  assert.equal(exitCalls.length, 0);
  emitter.emit('SIGTERM');
  assert.equal(exitCalls.length, 1);
  assert.equal(exitCalls[0], 1);
});

test('an unregistered signal does not abort the controller', () => {
  const { fake, emitter } = fakeProcess();
  const controller = attachShutdownSignals(['SIGTERM'], fake);

  emitter.emit('SIGHUP');
  assert.equal(controller.signal.aborted, false);
});
