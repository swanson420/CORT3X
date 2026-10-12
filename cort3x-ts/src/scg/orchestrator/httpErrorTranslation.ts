// Turns anything a route handler throws into an HttpResponse. Must never
// throw: Router.dispatch relies on it to give every outcome a response.
//
// RECONSTRUCTED: the original also mapped FanInFault and FenceFault, which
// aren't built (cort3x-ts/GAPS.md); those would land in the 500 branch.

import type { HttpResponse } from './http/types.js';
import { HttpValidationFault } from './http/validation.js';
import { DomainFault, type DomainFaultCategory } from '../persistence/statePersistence.js';

const DOMAIN_STATUS: Record<DomainFaultCategory, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  CONFLICT: 409,
  CONTRACT_VIOLATION: 422,
};

export function translateError(err: unknown): HttpResponse {
  if (err instanceof HttpValidationFault) {
    return { status: 400, body: { error: 'validation_failed', field: err.field, message: err.message } };
  }
  if (err instanceof DomainFault) {
    return {
      status: DOMAIN_STATUS[err.category],
      body: { error: err.category.toLowerCase(), message: err.message, ...err.details },
    };
  }
  // Includes InvalidModelConfigFault: a misconfigured catalog version is a
  // server-side problem, and its details stay in the log, not the response.
  console.error('[http] untranslated error:', err);
  return { status: 500, body: { error: 'internal_error', message: 'An unexpected error occurred.' } };
}
