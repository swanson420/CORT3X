# security-infra

Validation and policy tooling for the workflow-state-snapshot pipeline: a Postgres schema with an immutable audit trail, a JSON Schema that mirrors the same constraints for API payloads, and an OPA/Rego admission policy that blocks an unsafe Postgres connection-timeout configuration from reaching Kubernetes.
