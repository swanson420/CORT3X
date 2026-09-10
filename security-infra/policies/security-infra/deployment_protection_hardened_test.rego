# security-infra/policies/deployment_protection_hardened_test.rego
#
# Unit tests for deployment_protection_hardened.rego. Run with:
#   opa test security-infra/policies -v

package kubernetes.admission

import rego.v1

# ---------------------------------------------------------------------------
# helpers to build AdmissionReview-shaped input for each workload kind
# ---------------------------------------------------------------------------

review_for(kind, containers) := {"review": {"object": manifest}} if {
	manifest := object.union({"kind": kind}, workload_spec(kind, containers))
}

workload_spec("Pod", containers) := {"spec": {"containers": containers}}

workload_spec("Deployment", containers) := {"spec": {"template": {"spec": {"containers": containers}}}}

workload_spec("StatefulSet", containers) := {"spec": {"template": {"spec": {"containers": containers}}}}

workload_spec("DaemonSet", containers) := {"spec": {"template": {"spec": {"containers": containers}}}}

workload_spec("Job", containers) := {"spec": {"template": {"spec": {"containers": containers}}}}

workload_spec("ReplicaSet", containers) := {"spec": {"template": {"spec": {"containers": containers}}}}

workload_spec("ReplicationController", containers) := {"spec": {"template": {"spec": {"containers": containers}}}}

workload_spec("CronJob", containers) := {"spec": {"jobTemplate": {"spec": {"template": {"spec": {"containers": containers}}}}}}

container_with_env(env_value) := [{"name": "app", "env": [{"name": "POSTGRES_CONNECTION_TIMEOUT", "value": env_value}]}]

container_with_valuefrom := [{"name": "app", "env": [{
	"name": "POSTGRES_CONNECTION_TIMEOUT",
	"valueFrom": {"configMapKeyRef": {"name": "db-config", "key": "timeout"}},
}]}]

# ---------------------------------------------------------------------------
# Rule 1: unsafe literal values are denied, across every workload kind
# ---------------------------------------------------------------------------

test_deployment_negative_string_denied if {
	count(deny) > 0 with input as review_for("Deployment", container_with_env("-1"))
}

test_deployment_zero_string_denied if {
	count(deny) > 0 with input as review_for("Deployment", container_with_env("0"))
}

test_deployment_empty_string_denied if {
	count(deny) > 0 with input as review_for("Deployment", container_with_env(""))
}

test_deployment_non_numeric_string_denied if {
	count(deny) > 0 with input as review_for("Deployment", container_with_env("infinite_block_unassigned"))
}

test_deployment_negative_number_denied if {
	count(deny) > 0 with input as review_for("Deployment", container_with_env(-1))
}

test_deployment_zero_number_denied if {
	count(deny) > 0 with input as review_for("Deployment", container_with_env(0))
}

test_deployment_boolean_value_denied if {
	count(deny) > 0 with input as review_for("Deployment", container_with_env(true))
}

test_pod_unsafe_denied if {
	count(deny) > 0 with input as review_for("Pod", container_with_env("-5"))
}

test_statefulset_unsafe_denied if {
	count(deny) > 0 with input as review_for("StatefulSet", container_with_env("0"))
}

test_daemonset_unsafe_denied if {
	count(deny) > 0 with input as review_for("DaemonSet", container_with_env("not_a_number"))
}

test_job_unsafe_denied if {
	count(deny) > 0 with input as review_for("Job", container_with_env("-30"))
}

test_cronjob_unsafe_denied if {
	count(deny) > 0 with input as review_for("CronJob", container_with_env("0"))
}

test_replicaset_unsafe_denied if {
	count(deny) > 0 with input as review_for("ReplicaSet", container_with_env("-5"))
}

test_replicationcontroller_unsafe_denied if {
	count(deny) > 0 with input as review_for("ReplicationController", container_with_env("0"))
}

# ---------------------------------------------------------------------------
# Rule 2: dynamic sourcing via valueFrom is fail-closed denied
# ---------------------------------------------------------------------------

test_valuefrom_configmap_denied if {
	count(deny) > 0 with input as review_for("Deployment", container_with_valuefrom)
}

# ---------------------------------------------------------------------------
# Safe values must NOT be denied
# ---------------------------------------------------------------------------

test_safe_string_value_allowed if {
	count(deny) == 0 with input as review_for("Deployment", container_with_env("30"))
}

test_safe_number_value_allowed if {
	count(deny) == 0 with input as review_for("Deployment", container_with_env(30))
}

test_unrelated_env_var_allowed if {
	# Isolates Rule 1's value-matching from Rule 3's presence requirement:
	# an unrelated var's value must never trigger denial on its own, but
	# POSTGRES_CONNECTION_TIMEOUT still needs to be present and safe.
	containers := [{"name": "app", "env": [
		{"name": "OTHER_VAR", "value": "-1"},
		{"name": "POSTGRES_CONNECTION_TIMEOUT", "value": "30"},
	]}]
	count(deny) == 0 with input as review_for("Deployment", containers)
}

# ---------------------------------------------------------------------------
# Rule 3: missing env var is denied by default (red-team fix), unless the
# workload is explicitly opted out via annotation.
# ---------------------------------------------------------------------------

test_container_with_no_env_denied if {
	containers := [{"name": "app"}]
	count(deny) > 0 with input as review_for("Deployment", containers)
}

test_container_with_no_env_pod_denied if {
	containers := [{"name": "app"}]
	count(deny) > 0 with input as review_for("Pod", containers)
}

test_container_with_no_env_cronjob_denied if {
	containers := [{"name": "app"}]
	count(deny) > 0 with input as review_for("CronJob", containers)
}

test_container_with_no_env_opted_out_allowed if {
	containers := [{"name": "app"}]
	count(deny) == 0 with input as review_for_deployment_annotated(containers, {"security-infra.io/no-postgres": "true"})
}

review_for_deployment_annotated(containers, annotations) := {"review": {"object": {
	"kind": "Deployment",
	"spec": {"template": {
		"metadata": {"annotations": annotations},
		"spec": {"containers": containers},
	}},
}}}

# ---------------------------------------------------------------------------
# `allow` must track `deny` -- previously dead code (defined, never set
# true, never referenced), which is safe only if nothing downstream reads
# it as the decision. Testing it directly closes that gap.
# ---------------------------------------------------------------------------

test_allow_true_when_no_deny if {
	allow with input as review_for("Deployment", container_with_env("30"))
}

test_allow_false_when_denied if {
	not allow with input as review_for("Deployment", container_with_env("-1"))
}
