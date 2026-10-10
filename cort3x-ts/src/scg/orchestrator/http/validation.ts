// Kept separate from DomainFault (persistence/statePersistence.ts) on
// purpose: DomainFault's six categories describe domain-state problems
// (a thread doesn't exist, a node is in the wrong state). A malformed
// request body -- a missing field, wrong type -- happens before any
// domain operation is even attempted, at the ingress boundary. Folding
// it into, say, CONTRACT_VIOLATION would conflate "the HTTP caller sent
// bad JSON" with "a catalog-declared output contract was violated" --
// two genuinely different things that happen to both sound like
// "contract."

export class HttpValidationFault extends Error {
  readonly code = 'HTTP_VALIDATION_FAULT';
  constructor(message: string, readonly field: string) {
    super(message);
    this.name = 'HttpValidationFault';
  }
}

export function requireString(body: unknown, field: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpValidationFault(`'${field}' is required and must be a non-empty string.`, field);
  }
  return value;
}

export function optionalObject(body: unknown, field: string): Record<string, unknown> {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpValidationFault(`'${field}' must be a JSON object if provided.`, field);
  }
  return value as Record<string, unknown>;
}

/** Path params are only present when the matched route pattern declares
 * them, so a handler reading one its pattern doesn't declare is a wiring
 * bug -- surfaced as a validation fault rather than passed on as undefined. */
export function requireParam(params: Record<string, string>, name: string): string {
  const value = params[name];
  if (value === undefined || value.length === 0) {
    throw new HttpValidationFault(`Path parameter '${name}' is required.`, name);
  }
  return value;
}
