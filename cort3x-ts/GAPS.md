# Known gaps

SCG's backend imported four modules that are not in that repo or its git history. Its own `tsc` never got far enough to report this, because `tsconfig.json` had `ignoreDeprecations: "6.0"`, which TS 5.x rejects on startup. Its tests still passed because `tsx` doesn't typecheck.

In this merge, each missing module covers only what existing callers or tests already fix. Nothing else is invented.

| File | Status | What's pinned down | What's missing |
|---|---|---|---|
| `src/scg/persistence/statePersistence.ts` | **Types only** | `ShutdownMode` values; the 4 engine methods the HTTP layer calls | The engine itself, `RequestIdentity`'s real fields (opaque for now), `DomainFault`/`FanInFault`/`FenceFault`, and `001_state_persistence_consolidated.sql` |
| `src/scg/orchestrator/claimAndDispatchNode.ts` | **Types only** | `NodeClaimPayload` (exact fields from the resolveDirectives test + migrations 002/005) | The claim query and lease handling; `modelConfig`'s shape |
| `src/scg/orchestrator/assemblePromptEnvelope.ts` | **Throws `NotImplementedFault`** | Signature (from `runClaimedNode.ts`) | Mapping `modelConfig` → `ModelTarget` |
| `src/scg/orchestrator/httpErrorTranslation.ts` | **Partial** | Never throws; `HttpValidationFault` → 400; everything else → 500 | Per-category mapping for `DomainFault`/`FanInFault`/`FenceFault` |

The SCG source comments also mention files that nothing imports yet: `workerLoop.ts`, `fanInSweepLoop.ts`, `fanInReconciliationSweep.ts`, `bootstrap.ts`, and migrations `001` and `004`.

## Other fixes made during the merge
- `http/router.ts`: index access is guarded for `noUncheckedIndexedAccess`.
- `http/threadRoutes.ts`: reads `:id` through the new `requireParam()`. A missing param now becomes a 400 instead of being passed on as `undefined`.
- Accountability tests: import paths are fixed for Node16/NodeNext, and the race worker now checks its argv.
- `AccountabilityModule.ts`: `schema.sql` now sits next to the module, and the build copies it into `dist/`.
