# state/backend/model-proxy

Module scope: takes a PromptEnvelopeDTO, routes it to the correct AI provider
(Anthropic, Google, OpenAI), streams tokens back, and normalizes telemetry/errors
into a vendor-agnostic shape. Built via Distributed Systems Architecture +
State Machine & Graph Topology catalyst, hardened through Sull/Gogglemeister
passes #1-#21, traced pass-by-pass against ground truth.

## Files
- types.ts — shared types, DTOs, IModelProviderAdapter interface
- classifier.ts — ProviderErrorClassifier (6-category error taxonomy)
- anthropic-adapter.ts / openai-adapter.ts / gemini-adapter.ts — concrete adapters
- factory.ts — ProviderAdapterFactory (provider routing)
- runner.ts — NodeExecutionRunner (decoupled pump/tap streaming execution)

## Fixed during hardening (verified against real code, not narration)
- Adapter/interface method signature mismatch (extractMetrics vs normalizeExecution)
- Broken RawTransportHeaders import path
- Rate-limit header extraction never wired into classifier
- 400-status conflation (client param fault vs upstream transient)
- Streaming response-capture gap (dispatch() discarded final response/usage/finish
  reason; runner was synthesizing fake telemetry to compensate)
- Client-disconnect coupling (completion promise depended on client still consuming
  the stream; violated "server is the actor, client is an observer" invariant)
- Unbounded queue growth when stream consumed by completion-only callers
- Silent 'completed' default on unrecognized provider finish reasons — all three
  adapters now return 'unknown' instead, so an unrecognized stop/finish reason
  from any provider is surfaced honestly rather than mislabeled as success.

## Known open items (not yet resolved — do not assume closed)
- Fan-in merge strategy: RESOLVED in ../persistence (see that module's manifest).
- Catalog version pinning: RESOLVED in ../persistence.

## Not built yet (separate modules, not part of this zip)
- Persistence layer (nodes/edges/threads schema — designed narratively, no code)
- Catalog service (roster/sets/fix-library storage)
- HTTP layer (nothing exposes this module over a network yet)
