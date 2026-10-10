// The single point where translateError gets invoked -- every route
// handler can throw a DomainFault/FanInFault/FenceFault/anything else
// and never needs its own try/catch for it. That consistency is the
// actual point of this file: a route that forgets to translate its
// errors is impossible by construction, not a convention someone has to
// remember to follow in every handler.

import type { HttpRequest, HttpResponse, RequestContext, RouteHandler } from './types.js';
import { translateError } from '../httpErrorTranslation.js';

interface CompiledRoute {
  method: string;
  /** Split pattern segments, e.g. '/threads/:id' -> ['threads', ':id'].
   * Compared segment-by-segment against the request path rather than
   * compiled to a regex -- simpler to reason about, and none of this
   * codebase's routes need wildcard/regex matching. */
  segments: string[];
  handler: RouteHandler;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((seg) => seg.length > 0);
}

function matchSegments(routeSegments: string[], pathSegments: string[]): Record<string, string> | null {
  if (routeSegments.length !== pathSegments.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < routeSegments.length; i++) {
    // Lengths were checked equal above, so both are always defined here --
    // the explicit check just satisfies noUncheckedIndexedAccess honestly
    // instead of with a non-null assertion.
    const routeSeg = routeSegments[i];
    const pathSeg = pathSegments[i];
    if (routeSeg === undefined || pathSeg === undefined) {
      return null;
    }
    if (routeSeg.startsWith(':')) {
      params[routeSeg.slice(1)] = decodeURIComponent(pathSeg);
    } else if (routeSeg !== pathSeg) {
      return null;
    }
  }
  return params;
}

export class Router {
  private readonly routes: CompiledRoute[] = [];

  /** Registers a handler for an exact method + path pattern, e.g.
   * router.register('GET', '/threads/:id', getThreadHandler). */
  register(method: string, pattern: string, handler: RouteHandler): void {
    this.routes.push({ method: method.toUpperCase(), segments: splitPath(pattern), handler });
  }

  /**
   * Matches a raw method+path against the registered routes, extracts
   * path params, runs the matched handler, and translates any thrown
   * error into an HttpResponse. Never throws itself -- every possible
   * outcome (matched + succeeded, matched + threw, not matched) resolves
   * to a real HttpResponse, which is what makes this safe to call
   * directly from any adapter without that adapter needing its own
   * top-level try/catch either.
   */
  async dispatch(method: string, path: string, req: Omit<HttpRequest, 'params'>, ctx: RequestContext): Promise<HttpResponse> {
    const pathSegments = splitPath(path);
    const upperMethod = method.toUpperCase();

    let pathMatchedAnyMethod = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, pathSegments);
      if (params === null) continue;
      pathMatchedAnyMethod = true;
      if (route.method !== upperMethod) continue;

      try {
        return await route.handler({ ...req, method: upperMethod, params }, ctx);
      } catch (err) {
        return translateError(err);
      }
    }

    if (pathMatchedAnyMethod) {
      return { status: 405, body: { error: 'method_not_allowed', message: `${upperMethod} ${path} is not supported.` } };
    }
    return { status: 404, body: { error: 'not_found', message: `No route matches ${upperMethod} ${path}.` } };
  }
}
