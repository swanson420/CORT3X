import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateError } from '../httpErrorTranslation.js';
import { HttpValidationFault } from '../http/validation.js';
import { DomainFault } from '../../persistence/statePersistence.js';
import { InvalidModelConfigFault } from '../assemblePromptEnvelope.js';

test('each DomainFault category maps to its status, with details in the body', () => {
  const cases = [['UNAUTHENTICATED', 401], ['FORBIDDEN', 403], ['NOT_FOUND', 404], ['INVALID_STATE', 409], ['CONFLICT', 409], ['CONTRACT_VIOLATION', 422]] as const;
  for (const [category, status] of cases) {
    const res = translateError(new DomainFault(category, 'msg', { threadId: 't1' }));
    assert.equal(res.status, status, category);
    assert.deepEqual(res.body, { error: category.toLowerCase(), message: 'msg', threadId: 't1' });
  }
});

test('HttpValidationFault is a 400 naming the field', () => {
  assert.deepEqual(translateError(new HttpValidationFault('bad', 'title')), { status: 400, body: { error: 'validation_failed', field: 'title', message: 'bad' } });
});

test("anything else -- including a misconfigured catalog version -- is a 500 that doesn't leak the message", () => {
  for (const err of [new Error('db password is hunter2'), new InvalidModelConfigFault('secret detail', 'cv'), 'a string', undefined]) {
    const res = translateError(err);
    assert.equal(res.status, 500);
    assert.doesNotMatch(JSON.stringify(res.body), /hunter2|secret detail/);
  }
});
