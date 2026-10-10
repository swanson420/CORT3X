-- 005_add_node_directives.sql
--
-- Resolves GAP 2 from workerLoop.ts's own comments: nothing in the schema
-- previously tied roleProfile/activeGoggle/activeLens to anything.
-- Resolved node-scoped, not catalog-scoped, because catalog_entry_versions
-- rows are strictly immutable (trg_lock_catalog_versions) -- that
-- immutability exists for reproducibility of system_prompt/model_config,
-- which changes rarely and needs an audit trail. Goggle/lens is a
-- per-invocation stance that changes per request; binding it into an
-- immutable, audited artifact would force a new frozen catalog version
-- for every new goggle/lens combination even when the underlying model
-- config hasn't changed at all.
--
-- All four columns are nullable with no default beyond NULL, on purpose:
-- existing nodes (created before this migration) get NULL directives,
-- which is a legitimate state -- not every node needs a goggle/lens
-- override -- and nothing downstream is required to treat NULL as an
-- error. This is what makes the migration backwards-compatible: no
-- existing row's meaning changes, and no existing write path is required
-- to start supplying these columns to keep inserting successfully.

ALTER TABLE nodes
  ADD COLUMN role_profile TEXT,
  ADD COLUMN active_goggle TEXT,
  ADD COLUMN active_lens TEXT,
  ADD COLUMN system_instructions TEXT;
