# security-infra/policies/deployment_protection_hardened.rego
#
# FIXED: the original relied on `to_number(val)` throwing/being-undefined
# for non-numeric and boolean inputs, then used `not to_number(val)` to
# catch it. Whether to_number() on a boolean produces "undefined" (silently
# skips the rule, POLICY BYPASSED) or a hard evaluation error depends on
# the OPA version and whether strict-builtin-errors is enabled. That's not
# something to build a security control on. Fixed by checking the JSON type
# explicitly first with `is_string`/`is_number`/`is_boolean` so behavior is
# deterministic across OPA versions.
#
# HARDENED (WEBSEC pass):
#   1. Original policy only matched manifest.kind == "Deployment", so the
#      exact same unsafe POSTGRES_CONNECTION_TIMEOUT value could ship
#      untouched via a raw Pod, StatefulSet, DaemonSet, Job, or CronJob.
#      Added pod_spec_containers() to extract containers across all of
#      those workload kinds instead of hardcoding one.
#   2. Original policy only inspected env_var.value (a literal string).
#      A caller could source POSTGRES_CONNECTION_TIMEOUT from a
#      ConfigMap/Secret via valueFrom and bypass the check entirely,
#      since env_var.value would just be undefined/missing. Added a
#      fail-closed deny rule for any valueFrom on this specific variable
#      name.
#
# RED-TEAM FIX: is_valid_number_string() itself still called to_number(val)
# directly and relied on its undefined/error behavior for non-numeric
# strings -- the exact class of bug the FIXED note above says was
# eliminated, just moved into a helper instead of removed. Replaced with an
# explicit regex check so to_number is only ever called on a value already
# confirmed numeric.
#
# RED-TEAM FIX: the policy previously allowed a container with no
# POSTGRES_CONNECTION_TIMEOUT env var at all (test_container_with_no_env_allowed
# proved it: count(deny) == 0 with the var absent). That's the most likely
# real-world misconfiguration and this policy provided zero protection
# against it. Added Rule 3 below: fail closed on absence, with an explicit
# annotation opt-out for workloads that don't talk to Postgres.
#
# KNOWN RESIDUAL GAP (not fixed here, flagging honestly rather than
# faking coverage): bulk-import via envFrom (a ConfigMap/Secret dumped
# wholesale into the container's environment) cannot be checked by this
# policy. The admission review payload does not contain the actual keys
# inside the referenced ConfigMap/Secret, so there's nothing here to
# pattern-match against. Closing that gap requires OPA to have synced,
# live cluster state for the referenced object (e.g. Gatekeeper's sync
# feature or `opa run` with an external data bundle), not just the
# AdmissionReview object. Treat that as a separate infra task, not a
# one-line Rego fix.

package kubernetes.admission

import rego.v1

default allow := false

# STATIC-ANALYSIS FIX: this was dead code -- defined, never referenced by
# any rule or test, never set true anywhere. If whatever consumes this
# policy reads `deny` (as every test here does), it was harmless but
# pointless. If it instead reads the `allow` convention some raw K8s
# admission webhook integrations use, this would have silently denied
# every request, unconditionally, regardless of `deny`, since nothing ever
# flipped it. Now genuinely derived from the same decision `deny` encodes,
# so it's correct under either consumption convention instead of being an
# inert (or silently catastrophic) leftover.
allow if {
	count(deny) == 0
}

# ---------------------------------------------------------------------------
# Workload-kind normalization: extract the container list regardless of
# which native Kubernetes workload wraps the pod template.
# ---------------------------------------------------------------------------

pod_spec_containers(manifest) := containers if {
	manifest.kind == "Pod"
	containers := manifest.spec.containers
}

pod_spec_containers(manifest) := containers if {
	manifest.kind == "Deployment"
	containers := manifest.spec.template.spec.containers
}

pod_spec_containers(manifest) := containers if {
	manifest.kind == "StatefulSet"
	containers := manifest.spec.template.spec.containers
}

pod_spec_containers(manifest) := containers if {
	manifest.kind == "DaemonSet"
	containers := manifest.spec.template.spec.containers
}

pod_spec_containers(manifest) := containers if {
	manifest.kind == "Job"
	containers := manifest.spec.template.spec.containers
}

pod_spec_containers(manifest) := containers if {
	manifest.kind == "CronJob"
	containers := manifest.spec.jobTemplate.spec.template.spec.containers
}

# STATIC-ANALYSIS FIX: pod_spec_containers was a partial function over
# manifest.kind -- Pod/Deployment/StatefulSet/DaemonSet/Job/CronJob were
# covered, but ReplicaSet and the legacy ReplicationController also carry
# spec.template.spec.containers and could bypass this policy entirely via
# a direct apply, the same gap already fixed once for bare Pod/Deployment.

pod_spec_containers(manifest) := containers if {
	manifest.kind == "ReplicaSet"
	containers := manifest.spec.template.spec.containers
}

pod_spec_containers(manifest) := containers if {
	manifest.kind == "ReplicationController"
	containers := manifest.spec.template.spec.containers
}

# ---------------------------------------------------------------------------
# Rule 1: literal (or string-encoded) timeout value is unsafe.
# ---------------------------------------------------------------------------

deny contains msg if {
	manifest := input.review.object
	containers := pod_spec_containers(manifest)

	container := containers[_]
	env_var := container.env[_]

	env_var.name == "POSTGRES_CONNECTION_TIMEOUT"
	is_unsafe_timeout(env_var.value)

	msg := sprintf("REMEDIATION FAILURE: Enforced variable '%v' contains an unsafe configuration value ('%v'). Infinite blocks are barred.", [env_var.name, env_var.value])
}

# ---------------------------------------------------------------------------
# Rule 2: dynamic sourcing (ConfigMap/Secret via valueFrom) is fail-closed
# for this specific variable, since we cannot statically verify what value
# it will resolve to at runtime.
# ---------------------------------------------------------------------------

deny contains msg if {
	manifest := input.review.object
	containers := pod_spec_containers(manifest)

	container := containers[_]
	env_var := container.env[_]

	env_var.name == "POSTGRES_CONNECTION_TIMEOUT"
	env_var.valueFrom
	not env_var.value

	msg := sprintf("REMEDIATION FAILURE: Enforced variable '%v' is sourced dynamically via valueFrom (ConfigMap/Secret reference). This critical timeout parameter must be a literal value so it can be statically verified.", [env_var.name])
}

# ---------------------------------------------------------------------------
# Rule 3: the variable must be set at all. An absent env var was previously
# treated as "no unsafe value present, allow" -- but omitting it entirely is
# the most realistic misconfiguration (a dev just forgot), and it means the
# app falls back to whatever its own internal default is, which this policy
# cannot verify. Fail closed: require the literal value, unless the
# workload is explicitly opted out via annotation for cases that provably
# don't talk to this Postgres instance.
# ---------------------------------------------------------------------------

workload_annotations(manifest) := annotations if {
	manifest.kind in {"Deployment", "StatefulSet", "DaemonSet", "Job", "ReplicaSet", "ReplicationController"}
	annotations := object.get(manifest.spec.template.metadata, "annotations", {})
}

workload_annotations(manifest) := annotations if {
	manifest.kind == "CronJob"
	annotations := object.get(manifest.spec.jobTemplate.spec.template.metadata, "annotations", {})
}

workload_annotations(manifest) := annotations if {
	manifest.kind == "Pod"
	annotations := object.get(manifest.metadata, "annotations", {})
}

opted_out(manifest) if {
	workload_annotations(manifest)["security-infra.io/no-postgres"] == "true"
}

deny contains msg if {
	manifest := input.review.object
	not opted_out(manifest)
	containers := pod_spec_containers(manifest)

	container := containers[_]
	env := object.get(container, "env", [])
	env_names := {e.name | e := env[_]}
	not "POSTGRES_CONNECTION_TIMEOUT" in env_names

	msg := sprintf("REMEDIATION FAILURE: container '%v' does not set 'POSTGRES_CONNECTION_TIMEOUT' explicitly. An absent value falls back to the application's unverified internal default. Set it explicitly, or add the 'security-infra.io/no-postgres: \"true\"' pod-template annotation if this workload does not connect to Postgres.", [container.name])
}

# ---------------------------------------------------------------------------
# Type-safe unsafe-value classification (verified compliant, unchanged).
# ---------------------------------------------------------------------------

# Explicitly reject non-string, non-number types up front (booleans, null,
# objects, arrays) instead of relying on to_number's undefined behavior.
is_unsafe_timeout(val) if {
	not is_string(val)
	not is_number(val)
}

# String "" is unsafe
is_unsafe_timeout(val) if {
	is_string(val)
	val == ""
}

# String that parses to <= 0
is_unsafe_timeout(val) if {
	is_string(val)
	val != ""
	is_valid_number_string(val)
	num := to_number(val)
	num <= 0
}

# String that does NOT parse as a number at all (e.g. "infinite_block_unassigned")
is_unsafe_timeout(val) if {
	is_string(val)
	val != ""
	not is_valid_number_string(val)
}

# Raw numeric value (unquoted in YAML/JSON) that is <= 0
is_unsafe_timeout(val) if {
	is_number(val)
	val <= 0
}

# RED-TEAM FIX (#6): this previously called `to_number(val)` directly and
# relied on its undefined/error behavior for non-numeric strings -- the
# exact pattern the header above says was eliminated for the boolean case,
# reintroduced here for the "doesn't parse as a number" case. A regex check
# means to_number is now only ever called (above) after this has already
# confirmed the string is numeric, so it can no longer be called on a value
# it can't parse.
is_valid_number_string(val) if {
	regex.match(`^-?[0-9]+(\.[0-9]+)?$`, val)
}
