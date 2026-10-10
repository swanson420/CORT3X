# state/backend/db

STATUS: Built directly (not via the Grok/Gemini build loop — this one was
small, fully specified after several rounds of goggles/lens discussion with
no artifact produced, and written straight to close the stall).

## pool.ts

Exports `createPool(): Pool`. Provider-neutral — has no knowledge of Neon,
RDS, Supabase, or any other host; just resolves standard PostgreSQL
connection info and returns a real `pg.Pool`.

Contract (verified against own source, not assumed):
- `DATABASE_URL`, if set, wins — passed straight to `pg.Pool`'s own
  `connectionString` option. No manual URL parsing.
- Otherwise, falls back to discrete vars: requires both `PGHOST` and
  `PGDATABASE`; `PGPORT`/`PGUSER`/`PGPASSWORD` optional. `PGPORT` is
  validated as a real number before use — throws if set but not numeric.
- If neither path resolves, throws before any `Pool` is constructed.
- Confirmed by direct grep: every `throw` in this file precedes its
  corresponding `new Pool(...)` call. No path constructs a Pool first and
  validates after — the exact failure mode Sull's passes (#13, #14) were
  watching for.

## Consumers
../persistence/statePersistence.ts and ../orchestrator/claimAndDispatchNode.ts
both take a `Pool` as a constructor/function argument and know nothing about
this file — createPool() is what a caller (eventually the HTTP layer, or a
worker entrypoint) uses to actually produce that Pool before wiring it in.
Nothing in this file has been wired into either consumer yet — that's a
separate, still-unbuilt step (likely part of "wire" or the eventual
HTTP/worker entrypoint).
