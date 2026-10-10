# cort3x-ts

The TypeScript side of Cort3x, merged into one package:

| Path | What it is | Origin |
|---|---|---|
| `src/accountability/` | Module 4: hash-chained, encrypted SQLite audit trail | `CORT3X/accountability-module` |
| `src/scg/model-proxy/` | Provider-neutral model dispatch (Anthropic, OpenAI, Gemini), streaming, error classification | `swanson420/SCG` `backend/model-proxy` |
| `src/scg/orchestrator/` | Node-claim → envelope → runner bridge, HTTP router and thread routes, shutdown/drain helpers | `swanson420/SCG` `backend/orchestrator` |
| `src/scg/persistence/` | Postgres migrations (003/005/006) + the `statePersistence` contract | `swanson420/SCG` `backend/persistence` |
| `src/scg/db/` | `createPool()`: provider-neutral `pg.Pool` factory | `swanson420/SCG` `backend/db` |

ESM, `NodeNext` resolution, `strict` + `noUncheckedIndexedAccess`, and one tsconfig for everything. Needs Node ≥ 22.5 (for `node:sqlite`).

```bash
npm install
npm run typecheck          # tsc --noEmit over src/ and tests/
npm test                   # unit tests (node:test) + the 8 accountability suites
npm run test:unit          # just src/**/*.test.ts
npm run test:accountability
npm run build              # -> dist/ (copies .sql files alongside)
```

Some of what SCG imports was never committed. Those pieces are contract stubs here and are listed in [GAPS.md](GAPS.md).
