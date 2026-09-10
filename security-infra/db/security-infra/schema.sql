-- security-infra/db/schema.sql
--
-- Schema for the workflow-state-snapshot pipeline. Mirrors the constraints
-- enforced by schemas/workflow-state-snapshot.schema.json (JSON Schema) so
-- that a payload accepted by one is accepted by the other:
--   - payload_hash / prompt_version_hash: lowercase hex SHA-256 (64 chars)
--   - mime_type: RFC-2045-ish media type, no HTML/script injection
--   - context_nodes: immutable once written (append-only audit trail)
--   - prompt_registry rows cannot be deleted while referenced (ON DELETE RESTRICT)

-- ============================================================================
-- Domains
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sha256_hash') THEN
        CREATE DOMAIN sha256_hash AS CHAR(64)
            CHECK (VALUE ~ '^[a-f0-9]{64}$');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mime_type_safe') THEN
        CREATE DOMAIN mime_type_safe AS TEXT
            CHECK (
                length(VALUE) <= 100
                AND VALUE ~ '^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$'
            );
    END IF;
END $$;

-- ============================================================================
-- Tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS organizations (
    organization_id UUID PRIMARY KEY,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only: rows are written once by the ingestion pipeline and never
-- mutated afterward. Immutability is enforced by trigger below, not just
-- convention, so a bug or a compromised caller can't quietly rewrite history.
-- RED-TEAM FIX (#5): docs/security-infra.md claims the DB and JSON Schema
-- "mirror the same constraints", but JSONB has no native key-count/depth
-- constraint, so a caller writing directly to Postgres (bypassing the
-- API/schema layer) was bound by nothing. This function makes that claim
-- true for metadata: at most 50 top-level keys, and every value a scalar
-- (no nested object/array), matching the JSON Schema's additionalProperties
-- restriction exactly.
--
-- STATIC-ANALYSIS FIX: the first version was a flat SQL AND-chain relying
-- on jsonb_typeof(meta) = 'object' being checked before jsonb_object_keys()
-- / jsonb_each() ran -- but Postgres does not guarantee AND/OR operand
-- evaluation order or short-circuiting; that's exactly the scenario this
-- function's own docstring says it exists for (a direct write that never
-- went through the schema layer, so nothing upstream already confirmed
-- `meta` is an object). jsonb_each/jsonb_object_keys both hard-error on
-- non-object JSONB, so a top-level array/scalar could raise a raw
-- type error instead of failing cleanly via check_violation. Rewritten as
-- plpgsql with real IF/RETURN control flow (guaranteed order), and
-- consolidated the three separate traversals (jsonb_object_keys for count,
-- jsonb_each for type-check, meta::text for size) into a single
-- jsonb_each loop that does all three checks in one pass.
CREATE OR REPLACE FUNCTION context_node_metadata_is_safe(meta JSONB)
RETURNS BOOLEAN AS $$
DECLARE
    kv RECORD;
    key_count INT := 0;
BEGIN
    IF jsonb_typeof(meta) IS DISTINCT FROM 'object' THEN
        RETURN FALSE;
    END IF;

    IF octet_length(meta::text) > 20000 THEN
        RETURN FALSE;
    END IF;

    FOR kv IN SELECT * FROM jsonb_each(meta) LOOP
        key_count := key_count + 1;
        IF key_count > 50 THEN
            RETURN FALSE;
        END IF;
        IF jsonb_typeof(kv.value) IN ('object', 'array') THEN
            RETURN FALSE;
        END IF;
    END LOOP;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE TABLE IF NOT EXISTS context_nodes (
    node_id      UUID PRIMARY KEY,
    payload_hash sha256_hash NOT NULL,
    mime_type    mime_type_safe NOT NULL,
    -- RED-TEAM FIX (#4): raw_payload had no size cap, an unbounded-size
    -- resource-exhaustion vector identical in kind to the nodes-array gap
    -- below. 10 MiB is a starting bound -- adjust to the pipeline's real
    -- max payload size, not left unbounded.
    raw_payload  BYTEA NOT NULL CHECK (octet_length(raw_payload) <= 10485760),
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb
                 CHECK (context_node_metadata_is_safe(metadata)),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prompt_registry (
    prompt_id    UUID PRIMARY KEY,
    version_hash sha256_hash NOT NULL UNIQUE,
    body_text    TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_state_snapshots (
    snapshot_id         UUID PRIMARY KEY,
    organization_id     UUID NOT NULL REFERENCES organizations(organization_id),
    root_entity_id      UUID NOT NULL,
    prompt_id           UUID NOT NULL REFERENCES prompt_registry(prompt_id) ON DELETE RESTRICT,
    prompt_version_hash sha256_hash NOT NULL,
    target_provider     TEXT NOT NULL CHECK (length(target_provider) BETWEEN 1 AND 64),
    target_model        TEXT NOT NULL CHECK (length(target_model) BETWEEN 1 AND 128),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Immutability trigger for context_nodes
-- ============================================================================

CREATE OR REPLACE FUNCTION reject_context_node_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'CONTEXT_NODES_IMMUTABLE: context_nodes rows cannot be updated or deleted once written (node_id=%)',
        COALESCE(OLD.node_id, NEW.node_id)
        USING ERRCODE = 'ZZ001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_context_nodes_no_update ON context_nodes;
CREATE TRIGGER trg_context_nodes_no_update
    BEFORE UPDATE ON context_nodes
    FOR EACH ROW
    EXECUTE FUNCTION reject_context_node_mutation();

DROP TRIGGER IF EXISTS trg_context_nodes_no_delete ON context_nodes;
CREATE TRIGGER trg_context_nodes_no_delete
    BEFORE DELETE ON context_nodes
    FOR EACH ROW
    EXECUTE FUNCTION reject_context_node_mutation();

-- SECURITY FIX (red-team #1): row-level BEFORE UPDATE/DELETE triggers do NOT
-- fire for TRUNCATE -- it is a distinct statement-level event in Postgres.
-- Without this, anyone able to run `TRUNCATE context_nodes;` wiped the
-- entire audit trail with zero exceptions raised. TRUNCATE triggers must be
-- FOR EACH STATEMENT (row-level is not supported for this event).
CREATE OR REPLACE FUNCTION reject_context_node_truncate()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'CONTEXT_NODES_IMMUTABLE: context_nodes cannot be truncated (append-only audit trail)'
        USING ERRCODE = 'ZZ001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_context_nodes_no_truncate ON context_nodes;
CREATE TRIGGER trg_context_nodes_no_truncate
    AFTER TRUNCATE ON context_nodes
    FOR EACH STATEMENT
    EXECUTE FUNCTION reject_context_node_truncate();

-- ============================================================================
-- Application role (red-team #2: no privilege model existed at all)
-- ============================================================================
-- Triggers are a data-integrity control, not an access-control boundary: a
-- role with ownership (or superuser) can run
-- `ALTER TABLE context_nodes DISABLE TRIGGER ALL;`, mutate rows, then
-- re-enable -- trusting the same principal the trigger is meant to
-- constrain. The pipeline must connect as a non-owner role limited to the
-- operations it actually performs. This role has no LOGIN/password set
-- here deliberately -- that belongs in deployment secrets, not this file.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
        CREATE ROLE app_role NOLOGIN;
    END IF;
END $$;

-- Start from zero and grant back only what the ingestion pipeline needs.
-- Deliberately no UPDATE/DELETE/TRUNCATE/TRIGGER on context_nodes: granting
-- any of those would let a buggy or compromised app connection defeat the
-- immutability guarantee above, either directly or via DISABLE TRIGGER.
REVOKE ALL ON organizations, context_nodes, prompt_registry, workflow_state_snapshots FROM app_role;
GRANT SELECT, INSERT ON organizations TO app_role;
GRANT SELECT, INSERT ON context_nodes TO app_role;
GRANT SELECT, INSERT ON prompt_registry TO app_role;
GRANT SELECT, INSERT ON workflow_state_snapshots TO app_role;

-- ============================================================================
-- Indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_workflow_state_snapshots_org
    ON workflow_state_snapshots (organization_id);

CREATE INDEX IF NOT EXISTS idx_workflow_state_snapshots_prompt
    ON workflow_state_snapshots (prompt_id);
