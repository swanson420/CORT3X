// CONTRACT STUB -- the real StatePersistenceEngine (and the
// 001_state_persistence_consolidated.sql schema it runs against) was never
// committed to the SCG repo. Only the shapes the existing callers already
// pin down live here: ShutdownMode's two values (threadRoutes.ts), and the
// four engine methods the HTTP layer calls (threadRoutes.ts/types.ts).
// Nothing in this file invents persistence behavior. See cort3x-ts/GAPS.md.

export type ShutdownMode = 'ABORT_ACTIVE' | 'REQUIRE_QUIESCENCE';

declare const requestIdentityBrand: unique symbol;

/**
 * Opaque on purpose: no current caller reads a field off an identity, and
 * how one is resolved (IdP, token format, mTLS vs bearer) is a deployment
 * decision -- see RequestContext's comment in orchestrator/http/types.ts.
 * The real engine will define the fields; until then nothing can depend on
 * a guessed shape.
 */
export type RequestIdentity = { readonly [requestIdentityBrand]: 'RequestIdentity' };

/** The subset of the engine the HTTP layer depends on today. Thread and
 * summary results are passed straight through as response bodies, so
 * they stay `unknown` until the real engine defines them. */
export interface StatePersistenceEngine {
  createThread(identity: RequestIdentity, title: string, metadata: Record<string, unknown>): Promise<string>;
  getThreadById(identity: RequestIdentity, threadId: string): Promise<unknown>;
  closeThread(identity: RequestIdentity, threadId: string, mode: ShutdownMode): Promise<unknown>;
  reopenThread(identity: RequestIdentity, threadId: string): Promise<unknown>;
}
