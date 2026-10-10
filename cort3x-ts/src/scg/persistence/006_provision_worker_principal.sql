-- 006_provision_worker_principal.sql
--
-- Closes GAP 1 from workerLoop.ts's own comments: nothing in this codebase
-- provisions a service-principal for a long-running background worker to
-- authenticate as. This script does that, and only that.
--
-- Run by the table-owner / migration role, NOT by state_app -- state_app
-- has SELECT only on principals/tenants/principal_tenant_memberships
-- (see 001_state_persistence_consolidated.sql's GRANT block). Provisioning
-- is a control-plane act, matching the doctrine already established for
-- fn_issue_reopen_ticket and every other "only the owner role can do this"
-- boundary in this codebase.
--
-- Identity shape: principals.issuer/subject is a stable cryptographic
-- identity locator (see that table's own column comments -- e.g. SPIFFE,
-- DID, or an OIDC issuer/sub pair), not a password. This script assumes
-- the deployer has a real issuer+subject pair from whatever workload
-- identity system actually issues credentials to the worker process
-- (a SPIFFE SVID, a signed JWT from the deployment platform, etc.).
-- Nothing here fabricates that pair -- it is supplied by the deployer,
-- same discipline as resolveDirectives' defaults in resolveDirectivesFromNode.ts.
--
-- What this script deliberately does NOT do:
--   - does not grant more than node.execute -- the one capability the
--     worker loop's own module comment says it needs
--   - does not set expires_at -- a background worker's credential is a
--     deployment/rotation decision, not something this migration should
--     guess an expiry for. If the deployer wants JIT/rotating creds, set
--     expires_at explicitly when calling this, and re-run before expiry.
--   - does not fabricate a tenant -- the tenant this worker serves must
--     already exist (created through whatever tenant-onboarding path
--     exists elsewhere; not this codebase's concern yet).

DO $$
DECLARE
    -- ---- deployer-supplied values -----------------------------------
    v_issuer          TEXT := :'worker_issuer';   -- e.g. 'spiffe://cluster.local'
    v_subject         TEXT := :'worker_subject';  -- e.g. '/ns/prod/sa/scg-worker'
    v_tenant_slug     TEXT := :'tenant_slug';      -- must already exist in tenants
    -- -------------------------------------------------------------------
    v_principal_id    UUID;
    v_tenant_id       UUID;
BEGIN
    IF v_issuer IS NULL OR v_subject IS NULL OR v_tenant_slug IS NULL THEN
        RAISE EXCEPTION
            'Provisioning Fault: worker_issuer, worker_subject, and tenant_slug '
            'must all be supplied (psql -v worker_issuer=... -v worker_subject=... -v tenant_slug=...).';
    END IF;

    SELECT id INTO v_tenant_id FROM tenants WHERE slug = v_tenant_slug;
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION
            'Provisioning Fault: no tenant with slug % exists. Provision the '
            'tenant itself first -- this script does not create tenants.', v_tenant_slug;
    END IF;

    INSERT INTO principals (issuer, subject, status)
    VALUES (v_issuer, v_subject, 'ACTIVE')
    ON CONFLICT ON CONSTRAINT uq_principal_issuer_subject DO NOTHING;

    SELECT id INTO v_principal_id
    FROM principals
    WHERE issuer = v_issuer AND subject = v_subject;

    INSERT INTO principal_tenant_memberships (principal_id, tenant_id, capabilities, status)
    VALUES (v_principal_id, v_tenant_id, ARRAY['node.execute']::TEXT[], 'ACTIVE')
    ON CONFLICT ON CONSTRAINT uq_principal_tenant
        DO UPDATE SET capabilities = ARRAY['node.execute']::TEXT[], status = 'ACTIVE';

    RAISE NOTICE 'Provisioned worker principal % (issuer=%, subject=%) with node.execute in tenant % (%).',
        v_principal_id, v_issuer, v_subject, v_tenant_slug, v_tenant_id;
END $$;
