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
