// Closes GAP 2 from workerLoop.ts's own comments, now that
// 005_add_node_directives.sql settled where roleProfile/activeGoggle/
// activeLens/systemInstructions actually live (node-scoped, not
// catalog-scoped -- see that migration's comment for the reasoning).
//
// With the schema question resolved, resolveDirectives stops being an
// open policy question and becomes a direct field read off the claimed
// node -- NodeClaimPayload already carries all four columns (added in
// claimAndDispatchNode.ts's claim query alongside them).
//
// The one thing this file does NOT decide: what a node with no override
// should fall back to. All four columns are nullable by design (not
// every node needs one), but EnvelopeDirectives' fields are required,
// non-null strings -- something has to fill that gap. Hardcoding a
// guessed default (e.g. 'general'/'balanced') here would be exactly the
// kind of unverified business-logic invention this codebase has
// consistently avoided elsewhere (see workerLoop.ts's own runner/
// resolveDirectives gaps). Instead, defaults are a required parameter
// the deployer supplies -- their product decision, not this file's.

import type { NodeClaimPayload } from './claimAndDispatchNode.js';
import type { EnvelopeDirectives } from '../model-proxy/types.js';

/**
 * Builds a resolveDirectives function (matching WorkerLoopOptions'
 * required signature) that reads directive fields straight off the
 * claimed node, falling back to `defaults` for any column left NULL.
 *
 * Pure and synchronous -- despite WorkerLoopOptions allowing an async
 * resolveDirectives, this implementation needs no additional lookup:
 * everything it needs already arrived on the claim payload from the same
 * query that claimed the node, so there's no second round trip to make.
 */
export function createResolveDirectivesFromNode(
  defaults: EnvelopeDirectives
): (claim: NodeClaimPayload) => EnvelopeDirectives {
  return (claim: NodeClaimPayload): EnvelopeDirectives => ({
    roleProfile: claim.roleProfile ?? defaults.roleProfile,
    activeGoggle: claim.activeGoggle ?? defaults.activeGoggle,
    activeLens: claim.activeLens ?? defaults.activeLens,
    systemInstructions: claim.systemInstructions ?? defaults.systemInstructions,
  });
}
