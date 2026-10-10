-- Migration: Add execution lease tracking to nodes
-- Status: VERIFIED — additive columns only, checked against real nodes table,
-- no naming conflicts, safe to apply on top of 001_state_persistence_consolidated.sql

ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS leased_by TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

-- Index to support efficient watchdog sweeping of stalled RUNNING nodes
CREATE INDEX IF NOT EXISTS idx_nodes_stale_running
  ON nodes (lease_expires_at)
  WHERE lifecycle_state = 'RUNNING';
