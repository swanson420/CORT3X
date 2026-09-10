#!/usr/bin/env bash
# security-infra/scripts/validate-all.sh
#
# Single headless entrypoint. No prompts, no manual step-through — designed
# to run identically whether invoked by a human, a devcontainer hook, or a
# CI job. Emits a structured result summary and a single process exit code
# (0 = all checks passed, 1 = at least one failed). Use --quiet to suppress
# per-step narration and only print the final JSON summary (for machine
# consumption / CI log parsing).
#
# REPLIT ADAPTATION: the original DB integrity check spun up an ephemeral
# Postgres via Docker. This environment has no container runtime, but it
# does have a pre-provisioned Postgres reachable via $DATABASE_URL, so that
# path is tried first. Docker remains as a fallback for environments where
# DATABASE_URL isn't set (e.g. a laptop or a CI runner without a shared DB),
# preserving the original portability.

set -uo pipefail  # deliberately NOT -e: we want every check to run even if
                   # an earlier one fails, so the summary is complete.

QUIET=false
[[ "${1:-}" == "--quiet" ]] && QUIET=true

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESULTS=()
OVERALL_STATUS=0

log() {
  [[ "$QUIET" == false ]] && echo "[validate] $*"
}

record() {
  local name="$1" status="$2" detail="$3"
  RESULTS+=("{\"check\":\"${name}\",\"status\":\"${status}\",\"detail\":$(printf '%s' "$detail" | jq -Rs .)}")
  [[ "$status" != "pass" ]] && OVERALL_STATUS=1
}

# ----------------------------------------------------------------------------
# CHECK 1: OPA policy unit tests (deployment_protection_hardened.rego)
# ----------------------------------------------------------------------------
log "Running OPA policy test suite..."
if command -v opa >/dev/null 2>&1; then
  OPA_OUT=$(opa test "${REPO_ROOT}/policies" -v 2>&1)
  OPA_EXIT=$?
  if [[ $OPA_EXIT -eq 0 ]]; then
    record "opa_policy_tests" "pass" "$OPA_OUT"
    log "  OPA: PASS"
  else
    record "opa_policy_tests" "fail" "$OPA_OUT"
    log "  OPA: FAIL"
  fi
else
  record "opa_policy_tests" "skip" "opa binary not found on PATH"
  log "  OPA: SKIPPED (not installed)"
fi

# ----------------------------------------------------------------------------
# CHECK 2: JSON Schema validation (workflow-state-snapshot.schema.json)
# ----------------------------------------------------------------------------
log "Running JSON Schema validation against fixtures..."
if command -v ajv >/dev/null 2>&1; then
  SCHEMA="${REPO_ROOT}/schemas/workflow-state-snapshot.schema.json"
  VALID_FIXTURE="${REPO_ROOT}/schemas/fixtures/valid.json"
  INVALID_FIXTURE="${REPO_ROOT}/schemas/fixtures/invalid.json"

  VALID_OUT=$(ajv validate --spec=draft2019 -c ajv-formats -s "$SCHEMA" -d "$VALID_FIXTURE" 2>&1)
  VALID_EXIT=$?
  INVALID_OUT=$(ajv validate --spec=draft2019 -c ajv-formats -s "$SCHEMA" -d "$INVALID_FIXTURE" 2>&1)
  INVALID_EXIT=$?

  # Correct behavior: valid fixture passes (exit 0), invalid fixture fails (exit != 0)
  if [[ $VALID_EXIT -eq 0 && $INVALID_EXIT -ne 0 ]]; then
    record "json_schema" "pass" "valid.json accepted, invalid.json correctly rejected"
    log "  Schema: PASS"
  else
    record "json_schema" "fail" "valid_exit=${VALID_EXIT} invalid_exit=${INVALID_EXIT} :: ${VALID_OUT} :: ${INVALID_OUT}"
    log "  Schema: FAIL (validator did not discriminate valid/invalid correctly)"
  fi
else
  record "json_schema" "skip" "ajv not found on PATH"
  log "  Schema: SKIPPED (not installed)"
fi

# ----------------------------------------------------------------------------
# CHECK 3: DB integrity harness
# Prefer the environment's pre-provisioned Postgres ($DATABASE_URL) since
# that's always available here; fall back to an ephemeral Docker Postgres
# for environments without a shared dev database.
# ----------------------------------------------------------------------------
log "Running DB integrity harness..."

run_db_harness() {
  local psql_target="$1"
  local schema_out schema_exit harness_out harness_exit success_count failure_count expected_count

  schema_out=$(psql "$psql_target" -v ON_ERROR_STOP=1 -f "${REPO_ROOT}/db/schema.sql" 2>&1)
  schema_exit=$?

  if [[ $schema_exit -ne 0 ]]; then
    record "db_integrity" "fail" "schema.sql failed to apply: ${schema_out}"
    log "  DB integrity: FAIL (schema did not apply)"
    return
  fi

  # RED-TEAM FIX: this used to be a hardcoded "success_count -ge 5", set to
  # match the harness's 5 tests at the time. It silently stopped meaning
  # anything the moment tests were added -- 3 new tests (TRUNCATE,
  # metadata-shape, payload-size) could each emit zero SUCCESS: lines
  # (the exact "generic exception swallowed the specific one" class of bug
  # this file has already hit twice, per .agents/memory/) and this gate
  # would still report pass, because 5 old successes alone already clear
  # a threshold of 5. Deriving the expected count from the harness file
  # itself means it can't silently drift out of sync again.
  expected_count=$(grep -c "^SAVEPOINT test_" "${REPO_ROOT}/db/verification_harness.sql")

  harness_out=$(psql "$psql_target" -v ON_ERROR_STOP=1 -f "${REPO_ROOT}/db/verification_harness.sql" 2>&1)
  harness_exit=$?
  success_count=$(echo "$harness_out" | grep -c "SUCCESS:")
  failure_count=$(echo "$harness_out" | grep -c "CRITICAL SECURITY FAILURE")

  if [[ $harness_exit -eq 0 && "$failure_count" -eq 0 && "$success_count" -eq "$expected_count" ]]; then
    record "db_integrity" "pass" "${success_count}/${expected_count} assertions passed, 0 critical failures"
    log "  DB integrity: PASS (${success_count}/${expected_count} assertions)"
  else
    record "db_integrity" "fail" "exit=${harness_exit} successes=${success_count}/${expected_count} failures=${failure_count} :: ${harness_out}"
    log "  DB integrity: FAIL"
  fi
}

if command -v psql >/dev/null 2>&1 && [[ -n "${DATABASE_URL:-}" ]]; then
  run_db_harness "$DATABASE_URL"
elif command -v docker >/dev/null 2>&1; then
  CONTAINER_NAME="validate-all-pg-$$"

  # Register comprehensive cleanup hook to prevent orphaned containers on interrupt/exit
  cleanup_container() {
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1
  }
  trap cleanup_container EXIT INT TERM

  # Bind to loopback interface specifically to avoid external port exposure during runtime
  docker run -d --name "$CONTAINER_NAME" \
    -e POSTGRES_PASSWORD=headless_test \
    -p 127.0.0.1::5432 \
    postgres:16-alpine >/dev/null 2>&1

  # Resolve the ephemeral host port Docker assigned
  PG_PORT=$(docker port "$CONTAINER_NAME" 5432/tcp | cut -d: -f2)

  # Wait for readiness, bounded — do not hang forever on a headless run
  READY=false
  for i in $(seq 1 20); do
    # Targeted use of 127.0.0.1 replaces 'localhost' to avoid dual-stack DNS lookup lag
    if PGPASSWORD=headless_test psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -c '\q' >/dev/null 2>&1; then
      READY=true
      break
    fi
    sleep 1
  done

  if [[ "$READY" == true ]]; then
    run_db_harness "postgresql://postgres:headless_test@127.0.0.1:${PG_PORT}/postgres"
  else
    record "db_integrity" "fail" "Postgres container did not become ready within 20s"
    log "  DB integrity: FAIL (container not ready)"
  fi

  # Explicit cleanup and trap disarm (trap still fires on later interrupt/exit as backstop)
  cleanup_container
  trap - EXIT INT TERM
else
  record "db_integrity" "skip" "neither DATABASE_URL+psql nor docker available"
  log "  DB integrity: SKIPPED (no usable Postgres target)"
fi

# ----------------------------------------------------------------------------
# SUMMARY (always machine-readable, always printed regardless of --quiet)
# ----------------------------------------------------------------------------
JOINED=$(IFS=,; echo "${RESULTS[*]}")
echo "{\"overall\":\"$( [[ $OVERALL_STATUS -eq 0 ]] && echo pass || echo fail )\",\"checks\":[${JOINED}]}" | jq .

exit $OVERALL_STATUS
