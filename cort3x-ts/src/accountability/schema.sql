CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  engineer_id TEXT NOT NULL,
  module_name TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  last_updated_at_utc TEXT NOT NULL,
  session_outcome TEXT NOT NULL DEFAULT 'IN_PROGRESS'
    CHECK(session_outcome IN ('IN_PROGRESS', 'COMPLETED', 'ABANDONED', 'DRIFTED')),
  usability_rating TEXT CHECK(usability_rating IS NULL OR usability_rating IN ('USABLE', 'DEGRADED', 'UNUSABLE')),
  fault_attribution TEXT CHECK(fault_attribution IS NULL OR fault_attribution IN ('HUMAN_ENGINEER', 'AI_AGENT', 'SYSTEM_ENVIRONMENT', 'UNDETERMINED')),
  attribution_reason TEXT,
  drift_trigger TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT closed_sessions_need_attribution CHECK (
    session_outcome = 'IN_PROGRESS' OR (
      usability_rating IS NOT NULL AND
      fault_attribution IS NOT NULL AND
      attribution_reason IS NOT NULL
    )
  ),
  CONSTRAINT drifted_sessions_need_trigger CHECK (
    session_outcome != 'DRIFTED' OR drift_trigger IS NOT NULL
  )
);

CREATE TABLE IF NOT EXISTS actions (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  timestamp_utc TEXT NOT NULL,
  initiator_role TEXT NOT NULL CHECK(initiator_role IN ('HUMAN_ENGINEER', 'AI_AGENT', 'SYSTEM_ENVIRONMENT')),
  action_name TEXT NOT NULL,
  alignment_state TEXT NOT NULL CHECK(alignment_state IN ('ALIGNED', 'OFF_TARGET', 'UNRESOLVED')),
  input_payload TEXT NOT NULL,
  output_payload TEXT NOT NULL,
  action_notes TEXT,
  idempotency_key TEXT,
  chain_seq INTEGER NOT NULL,
  row_hash TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_archived_updated
  ON sessions(is_archived, last_updated_at_utc);
CREATE INDEX IF NOT EXISTS idx_sessions_outcome
  ON sessions(session_outcome);
CREATE INDEX IF NOT EXISTS idx_actions_session_id
  ON actions(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_idempotency
  ON actions(session_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_chain_seq
  ON actions(chain_seq) WHERE chain_seq IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS prevent_reclosing_sessions
BEFORE UPDATE OF session_outcome, usability_rating, fault_attribution, attribution_reason, drift_trigger, last_updated_at_utc
ON sessions
WHEN OLD.session_outcome != 'IN_PROGRESS'
  AND (
    NEW.session_outcome IS NOT OLD.session_outcome OR
    NEW.usability_rating IS NOT OLD.usability_rating OR
    NEW.fault_attribution IS NOT OLD.fault_attribution OR
    NEW.attribution_reason IS NOT OLD.attribution_reason OR
    NEW.drift_trigger IS NOT OLD.drift_trigger OR
    NEW.last_updated_at_utc IS NOT OLD.last_updated_at_utc
  )
BEGIN
  SELECT RAISE(ABORT, 'session already closed; outcome and attribution fields are frozen');
END;
