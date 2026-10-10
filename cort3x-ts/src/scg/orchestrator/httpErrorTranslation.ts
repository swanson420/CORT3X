// PARTIAL -- the original translateError (mapping DomainFault's six
// categories, FanInFault and FenceFault to HTTP statuses) was never
// committed to the SCG repo. This version maps only the one fault type
// that actually exists in the codebase (HttpValidationFault -> 400) and
// sends everything else to a 500. It must never throw: Router.dispatch
// relies on it to turn every outcome into a real HttpResponse.
// See cort3x-ts/GAPS.md.
import type { HttpResponse } from './http/types.js';
import { HttpValidationFault } from './http/validation.js';

export function translateError(err: unknown): HttpResponse {
  if (err instanceof HttpValidationFault) {
    return { status: 400, body: { error: 'validation_failed', field: err.field, message: err.message } };
  }
  console.error('[http] untranslated error:', err);
  return { status: 500, body: { error: 'internal_error', message: 'An unexpected error occurred.' } };
}
