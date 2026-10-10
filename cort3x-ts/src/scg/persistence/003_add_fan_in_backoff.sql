-- 003_add_fan_in_backoff.sql
--
-- Additive ALTER TABLE only, same shape as 002_add_lease_tracking.sql.
-- Supports the fan-in reconciliation sweep (see orchestrator/fanInReconciliationSweep.ts):
-- a node that fails executeAtomicFanIn for a structural reason (cycle,
-- cardinality, contract violation -- see FanInFaultReason in
-- statePersistence.ts) is quarantined with escalating backoff so repeated
-- sweep ticks stop re-selecting it ahead of newly-eligible nodes.
--
-- fan_in_fault_reason   -- last FanInFaultReason recorded, NULL if clean
-- fan_in_attempt_count  -- consecutive structural-fault count, reset to 0
--                          on a successful transition
-- fan_in_next_retry_at  -- NULL (immediately eligible) until a structural
--                          fault sets it; the sweep's candidate query
--                          excludes any node with a future value here

ALTER TABLE nodes
  ADD COLUMN fan_in_fault_reason TEXT,
  ADD COLUMN fan_in_attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN fan_in_next_retry_at TIMESTAMPTZ;
