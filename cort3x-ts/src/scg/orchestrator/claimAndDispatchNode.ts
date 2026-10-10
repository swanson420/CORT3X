// CONTRACT STUB -- the claim query/dispatch implementation was never
// committed to the SCG repo. NodeClaimPayload's fields are exactly the ones
// __tests__/resolveDirectivesFromNode.test.ts constructs; the four directive
// columns are nullable per 005_add_node_directives.sql, and the lease
// fields come from 002_add_lease_tracking.sql. See cort3x-ts/GAPS.md.

export interface NodeClaimPayload {
  nodeId: string;
  threadId: string;
  tenantId: string;
  catalogEntryId: string;
  catalogEntryVersionId: string;
  resolvedInputText: string;
  systemPrompt: string;
  /** catalog_entry_versions.model_config -- shape not yet specified. */
  modelConfig: Record<string, unknown>;
  roleProfile: string | null;
  activeGoggle: string | null;
  activeLens: string | null;
  systemInstructions: string | null;
  leaseExpiresAt: Date;
  workerId: string;
}
