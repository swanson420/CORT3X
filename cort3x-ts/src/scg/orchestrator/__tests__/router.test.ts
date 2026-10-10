import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../http/router.js';
import { HttpValidationFault } from '../http/validation.js';
import type { RequestContext } from '../http/types.js';

// Handlers under test never touch ctx, so an empty stand-in is enough.
const ctx = {} as RequestContext;
// dispatch() overwrites method with its own argument, so this value is irrelevant.
const req = { method: 'IGNORED', query: {}, headers: {} };

describe('Router.dispatch', () => {
  test('extracts and URI-decodes path params', async () => {
    const router = new Router();
    router.register('GET', '/threads/:id', async (r) => ({ status: 200, body: r.params }));
    const res = await router.dispatch('get', '/threads/a%20b', req, ctx);
    assert.deepEqual(res, { status: 200, body: { id: 'a b' } });
  });

  test('404 when no pattern matches, 405 when only the method differs', async () => {
    const router = new Router();
    router.register('GET', '/threads/:id', async () => ({ status: 200 }));
    assert.equal((await router.dispatch('GET', '/threads', req, ctx)).status, 404);
    assert.equal((await router.dispatch('GET', '/threads/1/extra', req, ctx)).status, 404);
    assert.equal((await router.dispatch('DELETE', '/threads/1', req, ctx)).status, 405);
  });

  test('a thrown HttpValidationFault becomes a 400, anything else a 500 -- dispatch never throws', async () => {
    const router = new Router();
    router.register('POST', '/bad', async () => { throw new HttpValidationFault('nope', 'title'); });
    router.register('POST', '/boom', async () => { throw new Error('kaboom'); });
    const bad = await router.dispatch('POST', '/bad', req, ctx);
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body, { error: 'validation_failed', field: 'title', message: 'nope' });
    const boom = await router.dispatch('POST', '/boom', req, ctx);
    assert.equal(boom.status, 500);
    assert.doesNotMatch(JSON.stringify(boom.body), /kaboom/);
  });
});
