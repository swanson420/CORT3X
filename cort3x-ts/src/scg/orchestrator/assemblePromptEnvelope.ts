// CONTRACT STUB -- the signature is fixed by runClaimedNode.ts; the body
// was never committed to the SCG repo. Building a PromptEnvelopeDTO needs
// a ModelTarget (provider + modelId + parameters) out of
// NodeClaimPayload.modelConfig, whose shape nothing in this codebase
// defines yet -- so this refuses loudly rather than guessing a mapping.
// See cort3x-ts/GAPS.md.
import type { NodeClaimPayload } from './claimAndDispatchNode.js';
import type { EnvelopeDirectives, PromptEnvelopeDTO } from '../model-proxy/types.js';

export class NotImplementedFault extends Error {
  readonly code = 'NOT_IMPLEMENTED';
  constructor(what: string) {
    super(`${what} is not implemented yet (see cort3x-ts/GAPS.md).`);
    this.name = 'NotImplementedFault';
  }
}

export function assemblePromptEnvelope(
  _claim: NodeClaimPayload,
  _directives: EnvelopeDirectives
): PromptEnvelopeDTO {
  throw new NotImplementedFault('assemblePromptEnvelope');
}
