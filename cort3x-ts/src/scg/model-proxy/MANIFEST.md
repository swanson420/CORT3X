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

## Tests and fixes from the first test pass (cort3x-ts)
`__tests__/` has 44 tests:
- **Classifier:** tested against the *real* Anthropic, OpenAI and Gemini SDK error classes, not hand-built shapes.
- **Adapters:** each one gets a fake client that streams the same event shapes as the real SDK. The tests check request building, token streaming, usage, finish reasons, provider errors and aborts.
- **Runner and factory.**

Against the code as it was before this pass, 12 of the 44 fail and the other 32 pass. The 12 failures were these bugs, now fixed:
- **Aborts were misclassified.** A caller abort came back as `protocol_violation` / `finishReason: 'error'` from all three providers. Anthropic and OpenAI throw `APIUserAbortError` with name "Error", and Gemini wraps the abort in a generic `GoogleGenerativeAIError`. Adapters now pass `abortSignal.aborted` to the classifier.
- **Anthropic 400 `invalid_request_error`** came back as `protocol_violation`, because Anthropic nests the type at `error.error.type`.
- **SDK `APIConnectionError`** (no status, no code) and socket errors on `.cause` came back as non-retryable `protocol_violation`. They are now retryable `transient`.
- **OpenAI 429 `insufficient_quota`** was marked retryable. It's a billing limit, so it is now not retryable.
- **Runner: late reader hung.** A `tokenStream` reader that attached after the stream finished waited forever. Items were dropped until a reader attached, including the final `done`. They are now buffered from the start, within the same 100-item bound.
- **Runner: slow reader hung.** A reader more than 100 chunks behind was silently detached and then waited forever. It now gets an `ObserverOverflowError` (`code: 'OBSERVER_OVERFLOW'`). `completion` still has the full artifact.

## Known open items (not yet resolved — do not assume closed)
- Fan-in merge strategy: RESOLVED in ../persistence (see that module's manifest).
- Catalog version pinning: RESOLVED in ../persistence.

## Not built yet (separate modules, not part of this zip)
- Persistence layer (nodes/edges/threads schema — designed narratively, no code)
- Catalog service (roster/sets/fix-library storage)
- HTTP layer (nothing exposes this module over a network yet)
