// Narrow execution bridge: claimed node -> prompt envelope -> model-proxy runner.
// Persistence fencing is deliberately outside this build boundary.
import { assemblePromptEnvelope } from './assemblePromptEnvelope.js';
import type { NodeClaimPayload } from './claimAndDispatchNode.js';
import type { NodeExecutionRunner } from '../model-proxy/runner.js';
import type { EnvelopeDirectives } from '../model-proxy/types.js';

export type RunClaimedNodeResult = Awaited<
  ReturnType<NodeExecutionRunner['execute']>['completion']
>;

export async function runClaimedNode(
  runner: NodeExecutionRunner,
  claim: NodeClaimPayload,
  directives: EnvelopeDirectives,
  abortSignal?: AbortSignal
): Promise<RunClaimedNodeResult> {
  const envelope = assemblePromptEnvelope(claim, directives);
  const execution = runner.execute(envelope, abortSignal);
  return execution.completion;
}
