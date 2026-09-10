---
name: PL/pgSQL EXCEPTION WHEN condition-name pitfalls
description: "value_error" is not a real PL/pgSQL condition name; it silently aborts the DO block at parse time rather than failing the intended test.
---

`value_error` is not a valid PL/pgSQL exception condition name in PostgreSQL (checked on v16). Use `data_exception` (SQLSTATE 22000) instead.
