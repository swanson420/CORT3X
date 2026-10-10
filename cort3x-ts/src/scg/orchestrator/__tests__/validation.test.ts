import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { requireString, optionalObject, HttpValidationFault } from '../http/validation.js';

describe('requireString', () => {
  test('returns the value when present and non-empty', () => {
    assert.equal(requireString({ title: 'hello' }, 'title'), 'hello');
  });

  test('throws HttpValidationFault when missing', () => {
    assert.throws(() => requireString({}, 'title'), HttpValidationFault);
  });

  test('throws when present but empty string', () => {
    assert.throws(() => requireString({ title: '' }, 'title'), HttpValidationFault);
  });

  test('throws when wrong type', () => {
    assert.throws(() => requireString({ title: 123 }, 'title'), HttpValidationFault);
  });

  test('throws when body itself is undefined', () => {
    assert.throws(() => requireString(undefined, 'title'), HttpValidationFault);
  });

  test('the thrown fault names the offending field', () => {
    try {
      requireString({}, 'title');
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof HttpValidationFault);
      assert.equal(err.field, 'title');
    }
  });
});

describe('optionalObject', () => {
  test('returns {} when field is absent', () => {
    assert.deepEqual(optionalObject({}, 'metadata'), {});
  });

  test('returns the object when present', () => {
    assert.deepEqual(optionalObject({ metadata: { a: 1 } }, 'metadata'), { a: 1 });
  });

  test('throws when the field is an array, not a plain object', () => {
    assert.throws(() => optionalObject({ metadata: [1, 2] }, 'metadata'), HttpValidationFault);
  });

  test('throws when the field is a string, not an object', () => {
    assert.throws(() => optionalObject({ metadata: 'nope' }, 'metadata'), HttpValidationFault);
  });
});
