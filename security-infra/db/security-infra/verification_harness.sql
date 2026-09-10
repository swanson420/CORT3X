-- security-infra/db/verification_harness.sql
--
-- FIXED: Test 2 originally sent a 67-character string into a CHAR(64)
-- domain. Postgres raises `string_data_right_truncation` for the length
-- violation BEFORE it ever evaluates the CHECK constraint regex — but the
-- original EXCEPTION block only caught `value_error` and `check_violation`,
-- so the DO block would error out uncaught instead of hitting the intended
-- success path. Fixed by (a) adding string_data_right_truncation to the
-- WHEN clause, and (b) using a payload that is exactly 64 chars but
-- non-hex, so the test actually exercises the regex CHECK rather than the
-- length truncation path.

BEGIN;

-- ============================================================================
-- VERIFICATION TEST 1: IMMUTABILITY BYPASS ATTEMPT
-- ============================================================================
SAVEPOINT test_immutability;

INSERT INTO organizations (organization_id) VALUES ('00000000-0000-0000-0000-000000000001');

INSERT INTO context_nodes (node_id, payload_hash, mime_type, raw_payload)
VALUES (
    '11111111-1111-1111-1111-111111111111',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'text/plain',
    '\x53797374656d20436f6e74657874'::bytea
);

DO $$
BEGIN
    BEGIN
        UPDATE context_nodes
        SET mime_type = 'application/json'
        WHERE node_id = '11111111-1111-1111-1111-111111111111';

        RAISE EXCEPTION 'CRITICAL SECURITY FAILURE: Update operation was allowed on an immutable table.';
    EXCEPTION
        -- FIXED: was "WHEN raise_exception", which is the generic error
        -- class both the trigger's own exception AND this block's canary
        -- failure exception (immediately above) both raise. That made the
        -- test pass unconditionally regardless of whether the trigger
        -- actually fired. Now catches the trigger's specific SQLSTATE only.
        WHEN sqlstate 'ZZ001' THEN
            RAISE NOTICE 'SUCCESS: Immutability constraint successfully blocked UPDATE statement.';
    END;
END $$;

ROLLBACK TO test_immutability;


-- ============================================================================
-- VERIFICATION TEST 2a: DOMAIN LENGTH VIOLATION (truncation path)
-- Objective: Verify oversized hash strings are rejected.
-- ============================================================================
SAVEPOINT test_domain_length;

DO $$
BEGIN
    BEGIN
        INSERT INTO context_nodes (node_id, payload_hash, mime_type, raw_payload)
        VALUES (
            '22222222-2222-2222-2222-222222222222',
            'INVALID_HASH_NOT_64_CHARS_AND_NOT_HEX_!!!_XYZ_1234567890000000000',
            'text/plain',
            '\x00'::bytea
        );

        RAISE EXCEPTION 'CRITICAL SECURITY FAILURE: Oversized hash string was accepted by the domain.';
    EXCEPTION
        -- FIXED: added string_data_right_truncation, which is the actual
        -- error raised here since the value exceeds CHAR(64) length.
        -- NOTE: "value_error" is not a real PL/pgSQL condition name (the
        -- class-level name for SQLSTATE 22000 is "data_exception", which
        -- also matches its subclass 22001 string_data_right_truncation by
        -- prefix) -- using the invalid name aborts the DO block at parse
        -- time before any exception handling logic runs.
        WHEN string_data_right_truncation OR data_exception OR check_violation THEN
            RAISE NOTICE 'SUCCESS: Oversized hash payload rejected successfully.';
    END;
END $$;

ROLLBACK TO test_domain_length;


-- ============================================================================
-- VERIFICATION TEST 2b: DOMAIN REGEX VIOLATION (exactly 64 chars, non-hex)
-- Objective: Verify the CHECK regex itself, independent of length.
-- ============================================================================
SAVEPOINT test_domain_regex;

DO $$
BEGIN
    BEGIN
        INSERT INTO context_nodes (node_id, payload_hash, mime_type, raw_payload)
        VALUES (
            '22222222-2222-2222-2222-222222222223',
            -- exactly 64 chars, but contains uppercase/non-hex 'Z' and 'X'
            'ZZZZZZZZ48f6b96df89dda901c5176b10a6d83961XXXXXXXXXXXXXXXXXXXXXXX',
            'text/plain',
            '\x00'::bytea
        );

        RAISE EXCEPTION 'CRITICAL SECURITY FAILURE: Invalid SHA256 domain regex was bypassed.';
    EXCEPTION
        WHEN check_violation THEN
            RAISE NOTICE 'SUCCESS: Invalid SHA256 payload format rejected successfully by the regex CHECK.';
    END;
END $$;

ROLLBACK TO test_domain_regex;


-- ============================================================================
-- VERIFICATION TEST 3: MIME-TYPE MALICIOUS INJECTION
-- ============================================================================
SAVEPOINT test_mime;

DO $$
BEGIN
    BEGIN
        INSERT INTO context_nodes (node_id, payload_hash, mime_type, raw_payload)
        VALUES (
            '33333333-3333-3333-3333-333333333333',
            -- FIXED: original hash was 63 hex chars (one short of the
            -- sha256_hash domain's required 64), which tripped the hash
            -- domain check before the test ever reached the mime_type
            -- check it's meant to exercise. Replaced with a real,
            -- guaranteed-64-char sha256 hexdigest.
            '7eaa6b6685ce23927517b33318c41c50fbe418b80cf630ff33180045cd0c6b29'::sha256_hash,
            'text/html;<script>alert(1)</script>',
            '\x00'::bytea
        );

        RAISE EXCEPTION 'CRITICAL SECURITY FAILURE: XSS payload accepted into mime_type field.';
    EXCEPTION
        WHEN data_exception OR check_violation THEN
            RAISE NOTICE 'SUCCESS: Malicious mime_type injection blocked successfully.';
    END;
END $$;

ROLLBACK TO test_mime;


-- ============================================================================
-- VERIFICATION TEST 4: COMPLIANCE WITH 'ON DELETE RESTRICT'
-- ============================================================================
SAVEPOINT test_integrity;

INSERT INTO organizations (organization_id) VALUES ('00000000-0000-0000-0000-000000000002');
INSERT INTO prompt_registry (prompt_id, version_hash, body_text)
VALUES ('44444444-4444-4444-4444-444444444444', '692bd1c84c427f03cd074811bb33d2791fb536dc1c9d053dba15e48c99caaaa1', 'System Prompt');
INSERT INTO workflow_state_snapshots (snapshot_id, organization_id, root_entity_id, prompt_id, prompt_version_hash, target_provider, target_model)
VALUES ('55555555-5555-5555-5555-555555555555', '00000000-0000-0000-0000-000000000002', '66666666-6666-6666-6666-666666666666', '44444444-4444-4444-4444-444444444444', '692bd1c84c427f03cd074811bb33d2791fb536dc1c9d053dba15e48c99caaaa1', 'Anthropic', 'Claude-3');

DO $$
BEGIN
    BEGIN
        DELETE FROM prompt_registry WHERE version_hash = '692bd1c84c427f03cd074811bb33d2791fb536dc1c9d053dba15e48c99caaaa1';

        RAISE EXCEPTION 'CRITICAL SECURITY FAILURE: Dependency tracking failed; ON DELETE RESTRICT bypassed.';
    EXCEPTION
        WHEN foreign_key_violation THEN
            RAISE NOTICE 'SUCCESS: Referential integrity verification confirmed. Deletion blocked.';
    END;
END $$;

ROLLBACK TO test_integrity;


-- ============================================================================
-- VERIFICATION TEST 5: TRUNCATE BYPASS ATTEMPT
-- Objective: row-level BEFORE UPDATE/DELETE triggers do NOT fire for
-- TRUNCATE (it's a separate statement-level event in Postgres). This test
-- exercises the AFTER TRUNCATE FOR EACH STATEMENT trigger added to close
-- that gap; without it this would silently wipe the table with no
-- exception raised at all.
-- ============================================================================
SAVEPOINT test_truncate;

INSERT INTO organizations (organization_id) VALUES ('00000000-0000-0000-0000-000000000003');
INSERT INTO context_nodes (node_id, payload_hash, mime_type, raw_payload)
VALUES (
    '77777777-7777-7777-7777-777777777777',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'text/plain',
    '\x53797374656d20436f6e74657874'::bytea
);

DO $$
BEGIN
    BEGIN
        EXECUTE 'TRUNCATE context_nodes';

        RAISE EXCEPTION 'CRITICAL SECURITY FAILURE: TRUNCATE was allowed on an immutable audit table.';
    EXCEPTION
        WHEN sqlstate 'ZZ001' THEN
            RAISE NOTICE 'SUCCESS: AFTER TRUNCATE trigger blocked TRUNCATE statement.';
    END;
END $$;

ROLLBACK TO test_truncate;


-- ============================================================================
-- VERIFICATION TEST 6: METADATA SHAPE VIOLATION (nested value rejected)
-- Objective: confirm the DB-level mirror of the schema's scalar-only
-- metadata restriction actually rejects a nested value, not just a
-- too-large flat object.
-- ============================================================================
SAVEPOINT test_metadata_shape;

INSERT INTO organizations (organization_id) VALUES ('00000000-0000-0000-0000-000000000004');

DO $$
BEGIN
    BEGIN
        INSERT INTO context_nodes (node_id, payload_hash, mime_type, raw_payload, metadata)
        VALUES (
            '88888888-8888-8888-8888-888888888888',
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            'text/plain',
            '\x00'::bytea,
            '{"nested": {"a": {"b": {"c": "deep"}}}}'::jsonb
        );

        RAISE EXCEPTION 'CRITICAL SECURITY FAILURE: nested metadata value was accepted despite the scalar-only constraint.';
    EXCEPTION
        WHEN check_violation THEN
            RAISE NOTICE 'SUCCESS: nested metadata value rejected by context_node_metadata_is_safe.';
    END;
END $$;

ROLLBACK TO test_metadata_shape;


-- ============================================================================
-- VERIFICATION TEST 7: OVERSIZED raw_payload REJECTED
-- Objective: confirm the resource-exhaustion cap on raw_payload is actually
-- enforced, not just documented.
-- ============================================================================
SAVEPOINT test_payload_size;

INSERT INTO organizations (organization_id) VALUES ('00000000-0000-0000-0000-000000000005');

DO $$
BEGIN
    BEGIN
        INSERT INTO context_nodes (node_id, payload_hash, mime_type, raw_payload)
        VALUES (
            '99999999-9999-9999-9999-999999999999',
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            'text/plain',
            -- one byte over the 10 MiB (10485760-byte) cap
            (SELECT decode(repeat('00', 10485761), 'hex'))
        );

        RAISE EXCEPTION 'CRITICAL SECURITY FAILURE: oversized raw_payload was accepted despite the size cap.';
    EXCEPTION
        WHEN check_violation THEN
            RAISE NOTICE 'SUCCESS: oversized raw_payload rejected by the octet_length CHECK.';
    END;
END $$;

ROLLBACK TO test_payload_size;


-- ============================================================================
-- VERIFICATION TEST 8: NON-OBJECT METADATA REJECTED CLEANLY
-- Objective: the original context_node_metadata_is_safe() was a flat SQL
-- AND-chain that assumed jsonb_typeof(meta) = 'object' would be checked
-- before jsonb_each()/jsonb_object_keys() ran -- but Postgres does not
-- guarantee AND-operand evaluation order, and both those functions
-- hard-error on non-object JSONB. This is exactly the caller this function
-- exists for (writing directly to Postgres, bypassing the JSON Schema
-- layer, so nothing upstream already confirmed the shape). Confirms a
-- top-level array now fails via check_violation, not a raw type error.
-- ============================================================================
SAVEPOINT test_metadata_non_object;

INSERT INTO organizations (organization_id) VALUES ('00000000-0000-0000-0000-000000000006');

DO $$
BEGIN
    BEGIN
        INSERT INTO context_nodes (node_id, payload_hash, mime_type, raw_payload, metadata)
        VALUES (
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            'text/plain',
            '\x00'::bytea,
            '[1, 2, 3]'::jsonb
        );

        RAISE EXCEPTION 'CRITICAL SECURITY FAILURE: non-object metadata was accepted (or errored uncontrolled) instead of failing cleanly.';
    EXCEPTION
        WHEN check_violation THEN
            RAISE NOTICE 'SUCCESS: non-object metadata rejected cleanly by context_node_metadata_is_safe.';
    END;
END $$;

ROLLBACK TO test_metadata_non_object;

ROLLBACK;
