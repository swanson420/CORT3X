-- 001_state_persistence_consolidated.sql
--
-- RECONSTRUCTED. The original 001 was referenced throughout SCG but never
-- committed. This version is designed from what the rest of the codebase
-- already fixes, and nothing more (cort3x-ts/GAPS.md lists every guess):
--
--   * 002/003/005 ALTER `nodes` to add lease, fan-in and directive columns,
--     and 003/005 do so without IF NOT EXISTS -- so none of those columns
--     may appear here, or those migrations fail.
--   * 006 needs principals(issuer, subject, status) with constraint
--     uq_principal_issuer_subject, tenants(slug), and
--     principal_tenant_memberships(principal_id, tenant_id, capabilities,
--     status) with constraint uq_principal_tenant.
--   * 006: state_app has SELECT only on principals/tenants/memberships.
--   * 005: catalog_entry_versions rows are immutable (trg_lock_catalog_versions)
--     and carry system_prompt and model_config.
--   * NodeClaimPayload (orchestrator/claimAndDispatchNode.ts) needs, per
--     node: thread, tenant, catalog entry + version, resolved input text.
--
-- Deliberately NOT here (not needed by any current caller): edges/lineage,
-- fan-in merge tables, reopen tickets (fn_issue_reopen_ticket), node output
-- artifacts. Apply order: 001, orchestrator/002, 003, 005, then 006 via psql.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid() on PG < 13

CREATE TABLE tenants (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE principals (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Stable cryptographic identity locator (SPIFFE, DID, or an OIDC
    -- issuer/sub pair) -- not a password, never a secret.
    issuer      TEXT NOT NULL CHECK (length(issuer) > 0),
    subject     TEXT NOT NULL CHECK (length(subject) > 0),
    status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
    -- NULL = no expiry. 006 leaves this to the deployer.
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_principal_issuer_subject UNIQUE (issuer, subject)
);

CREATE TABLE principal_tenant_memberships (
    principal_id  UUID NOT NULL REFERENCES principals(id),
    tenant_id     UUID NOT NULL REFERENCES tenants(id),
    capabilities  TEXT[] NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_principal_tenant UNIQUE (principal_id, tenant_id)
);

CREATE TABLE catalog_entries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    name        TEXT NOT NULL CHECK (length(name) > 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE TABLE catalog_entry_versions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    catalog_entry_id  UUID NOT NULL REFERENCES catalog_entries(id),
    version           INTEGER NOT NULL CHECK (version > 0),
    system_prompt     TEXT NOT NULL,
    -- Shape validated at use time by assemblePromptEnvelope():
    -- { provider, modelId, parameters? }.
    model_config      JSONB NOT NULL CHECK (jsonb_typeof(model_config) = 'object'),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (catalog_entry_id, version)
);

-- Versions are immutable once written: reproducing a past run requires the
-- exact system_prompt/model_config it ran with. A change is a new version.
CREATE FUNCTION fn_lock_catalog_versions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'catalog_entry_versions rows are immutable (% on version %); insert a new version instead',
        TG_OP, OLD.id
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER trg_lock_catalog_versions
    BEFORE UPDATE OR DELETE ON catalog_entry_versions
    FOR EACH ROW EXECUTE FUNCTION fn_lock_catalog_versions();

CREATE TABLE threads (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(id),
    title             TEXT NOT NULL CHECK (length(title) > 0),
    metadata          JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
    status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
    created_by        UUID NOT NULL REFERENCES principals(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at         TIMESTAMPTZ,
    close_mode        TEXT CHECK (close_mode IN ('ABORT_ACTIVE', 'REQUIRE_QUIESCENCE')),
    -- closed_at/close_mode are both set when CLOSED and both NULL when OPEN.
    CONSTRAINT chk_thread_closed_fields CHECK (
        (status = 'CLOSED' AND closed_at IS NOT NULL AND close_mode IS NOT NULL)
        OR (status = 'OPEN' AND closed_at IS NULL AND close_mode IS NULL)
    )
);

CREATE INDEX idx_threads_tenant ON threads (tenant_id);

CREATE TABLE nodes (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id                 UUID NOT NULL REFERENCES threads(id),
    -- Denormalised from threads so every node query can filter by tenant
    -- without a join; kept honest by the trigger below.
    tenant_id                 UUID NOT NULL REFERENCES tenants(id),
    catalog_entry_version_id  UUID NOT NULL REFERENCES catalog_entry_versions(id),
    resolved_input_text       TEXT NOT NULL,
    lifecycle_state           TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (lifecycle_state IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'ABORTED')),
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_nodes_thread ON nodes (thread_id);
CREATE INDEX idx_nodes_claimable ON nodes (tenant_id, created_at) WHERE lifecycle_state = 'PENDING';

CREATE FUNCTION fn_check_node_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.tenant_id IS DISTINCT FROM (SELECT tenant_id FROM threads WHERE id = NEW.thread_id) THEN
        RAISE EXCEPTION 'node tenant_id % does not match its thread''s tenant', NEW.tenant_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_check_node_tenant
    BEFORE INSERT OR UPDATE OF tenant_id, thread_id ON nodes
    FOR EACH ROW EXECUTE FUNCTION fn_check_node_tenant();

-- Application role. Per 006: SELECT only on the identity tables; principal
-- provisioning is a control-plane act done by the owner/migration role.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'state_app') THEN
        CREATE ROLE state_app NOLOGIN;
    END IF;
END $$;

GRANT SELECT ON tenants, principals, principal_tenant_memberships TO state_app;
GRANT SELECT ON catalog_entries, catalog_entry_versions TO state_app;
GRANT SELECT, INSERT, UPDATE ON threads, nodes TO state_app;
