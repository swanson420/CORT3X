import type { Router } from './router.js';
import type { HttpRequest, RequestContext } from './types.js';
import { requireString, requireParam, optionalObject, HttpValidationFault } from './validation.js';
import type { ShutdownMode } from '../../persistence/statePersistence.js';

const VALID_SHUTDOWN_MODES: readonly ShutdownMode[] = ['ABORT_ACTIVE', 'REQUIRE_QUIESCENCE'];

function parseShutdownMode(body: unknown): ShutdownMode {
  const raw = (body as { mode?: unknown } | undefined)?.mode;
  if (raw === undefined) {
    return 'ABORT_ACTIVE';
  }
  if (typeof raw !== 'string' || !VALID_SHUTDOWN_MODES.includes(raw as ShutdownMode)) {
    throw new HttpValidationFault(
      `'mode' must be one of [${VALID_SHUTDOWN_MODES.join(', ')}] if provided.`,
      'mode'
    );
  }
  return raw as ShutdownMode;
}

export function registerThreadRoutes(router: Router): void {
  router.register('POST', '/threads', async (req: HttpRequest, ctx: RequestContext) => {
    const title = requireString(req.body, 'title');
    const metadata = optionalObject(req.body, 'metadata');
    const threadId = await ctx.engine.createThread(ctx.identity, title, metadata);
    return { status: 201, body: { id: threadId } };
  });

  router.register('GET', '/threads/:id', async (req: HttpRequest, ctx: RequestContext) => {
    const thread = await ctx.engine.getThreadById(ctx.identity, requireParam(req.params, 'id'));
    return { status: 200, body: thread };
  });

  router.register('POST', '/threads/:id/close', async (req: HttpRequest, ctx: RequestContext) => {
    const mode = parseShutdownMode(req.body);
    const summary = await ctx.engine.closeThread(ctx.identity, requireParam(req.params, 'id'), mode);
    return { status: 200, body: summary };
  });

  router.register('POST', '/threads/:id/reopen', async (req: HttpRequest, ctx: RequestContext) => {
    const summary = await ctx.engine.reopenThread(ctx.identity, requireParam(req.params, 'id'));
    return { status: 200, body: summary };
  });
}
