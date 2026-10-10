// Deliberately not Express's Request/Response, not Fastify's, not Node's
// raw http.IncomingMessage/ServerResponse. This is a plain data contract
// so route handlers never depend on which web framework (or none at all
// -- a serverless function invocation, a test harness) is doing the
// actual listening. Adapting any real framework to this shape is a thin
// translation layer at the very edge, not something route handlers ever
// need to know about.

export interface HttpRequest {
  method: string;
  /** Already matched against a route pattern -- path params extracted,
   * not raw URL parsing left to each handler. */
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Parsed, not a raw stream/buffer -- body parsing (JSON, size limits,
   * content-type negotiation) is the adapter's job, not a route
   * handler's. Undefined for methods with no body. */
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Resolved once per request, before any route handler runs. `identity`
 * is deliberately not derived here -- same discipline as
 * resolveDirectives/runner in bootstrap.ts: authentication is a real
 * deployment decision (which IdP, which token format, mTLS vs bearer)
 * this codebase has no way to guess at safely. A RequestContext arrives
 * already carrying a resolved identity; how it got resolved is the
 * adapter's problem, not the router's or any handler's.
 */
export interface RequestContext {
  identity: import('../../persistence/statePersistence.js').RequestIdentity;
  engine: import('../../persistence/statePersistence.js').StatePersistenceEngine;
}

export type RouteHandler = (req: HttpRequest, ctx: RequestContext) => Promise<HttpResponse>;
