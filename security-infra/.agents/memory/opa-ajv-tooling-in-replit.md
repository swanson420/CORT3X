---
name: OPA / ajv-cli tooling quirks in this Replit environment
description: Version-specific gotchas hit when wiring up opa test + ajv validate as headless CI-style checks here.
---

- The Nix package for the OPA CLI is `open-policy-agent`, not `opa`.
- The `opa` version this pulls in (1.4.2) defaults to Rego v1 syntax.
- `ajv-cli@5.0.0` only ships meta-schemas through JSON Schema draft 2019-09.
