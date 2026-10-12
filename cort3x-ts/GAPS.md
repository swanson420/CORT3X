# SCG reconstruction: what was built, what was assumed, what's missing

SCG's backend imported four modules that were never committed: `statePersistence`, `claimAndDispatchNode`, `assemblePromptEnvelope` and `httpErrorTranslation`. The `001_state_persistence_consolidated.sql` schema they run against was missing too. Those modules are now implemented, but only for what today's callers use. All of it is tested against a real Postgres 16 (`npm run test:pg`, and the `postgres` CI job).

## Built

| File | What it does |
|---|---|
| `persistence/001_state_persistence_consolidated.sql` | Creates tenants, principals, memberships, catalog entries and versions (immutable), threads and nodes, plus the `state_app` role. Leaves out the columns 002, 003 and 005 add, so those migrations apply on top. |
| `persistence/statePersistence.ts` | `resolveRequestIdentity()` and `PgStatePersistenceEngine` (create, get, close, reopen thread). Every query is scoped to the caller's tenant. |
| `orchestrator/claimAndDispatchNode.ts` | `claimNextNode()`: atomic, `SKIP LOCKED`, leases nodes, reclaims expired leases. |
| `orchestrator/assemblePromptEnvelope.ts` | Validates `model_config` strictly and builds the `PromptEnvelopeDTO`. |
| `orchestrator/httpErrorTranslation.ts` | Maps `DomainFault` categories to HTTP statuses. Everything else becomes a 500 that doesn't leak the error. |

**Bug found in existing code:** `006_provision_worker_principal.sql` was a syntax error on every run. It put `:'worker_issuer'` inside a `DO $$` block, and psql doesn't substitute variables there. It now copies the values into session settings outside the block. The test runs it through psql as documented: it provisions the principal, a re-run is a no-op, and both of its error paths fail cleanly without writing anything.

## Assumptions: decisions this reconstruction made that the original may have made differently

1. **Lifecycle states.** Threads are `OPEN` or `CLOSED`. Nodes are `PENDING`, `RUNNING`, `COMPLETED`, `FAILED` or `ABORTED`. Only `RUNNING` appeared in the original (in 002).
2. **The six `DomainFault` categories** are `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `INVALID_STATE`, `CONFLICT` and `CONTRACT_VIOLATION`. Only `CONTRACT_VIOLATION` was named anywhere. They map to HTTP 401, 403, 404, 409, 409 and 422.
3. **Close modes.** `ABORT_ACTIVE` moves `PENDING` and `RUNNING` nodes to `ABORTED`. `REQUIRE_QUIESCENCE` refuses with `CONFLICT` while any node is `PENDING` or `RUNNING`. Closing a closed thread, or reopening an open one, is `INVALID_STATE`.
4. **Reopen** is a plain `CLOSED` → `OPEN` change. Aborted nodes stay aborted.
5. **Authorization** is tenant membership only. Any active member can create, read, close and reopen threads in their tenant. Capabilities are loaded onto `RequestIdentity` but not checked yet, because only `node.execute` was ever named.
6. **Identity errors don't reveal what exists.** An unknown, suspended or expired principal is `UNAUTHENTICATED`. An unknown tenant looks the same as no membership (`FORBIDDEN`). Another tenant's thread looks the same as a missing one (`NOT_FOUND`).
7. **`model_config` shape:** `{ provider: 'anthropic' | 'google' | 'openai', modelId, parameters?: { temperature, topP, maxOutputTokens, stopSequences } }`. Unknown keys are rejected.
8. **The catalog version's `system_prompt` comes first in `systemInstructions`, followed by the node's own instructions.** The adapters only read directives, so without this the catalog prompt would never reach the model.
9. **Claim order and scope.** Nodes are claimed oldest first, one tenant per worker (as 006 provisions it). A `RUNNING` node whose lease has expired can be claimed again.

## Not built: no current caller needs these yet

- **Completing or failing a claimed node, and fencing.** Nothing writes a result back yet, and nothing stops a worker whose lease expired from writing over the worker that reclaimed the node. This is the biggest gap: a claimed node stays `RUNNING` until its lease expires and it is reclaimed.
- **Edges and lineage.** There is no edges table, so `input.lineage` is always `[]` and `resolved_input_text` is stored as-is.
- **Fan-in.** Migration 003 adds its columns, but there's no merge, no `executeAtomicFanIn`, no `FanInFault`, and no reconciliation sweep.
- **Reopen tickets** (`fn_issue_reopen_ticket`).
- **Node output artifacts.** There's nowhere to store what a run produced.
- **Entry points.** `workerLoop.ts`, `fanInSweepLoop.ts` and `bootstrap.ts` are mentioned in comments but don't exist. Nothing wires the pool, engine, router and runner into a running process yet.
- **Migration 004** is mentioned but was never written.
