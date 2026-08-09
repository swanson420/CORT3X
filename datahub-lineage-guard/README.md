# DataHub Lineage Guard

An agent-facing gate that checks real lineage from DataHub before letting a
downstream agent act on it. Built for **Build with DataHub: The Agent
Hackathon**.

> **New for this submission:** the code in `datahub-lineage-guard/` —
> built during the July 6 – Aug 10, 2026 submission period, integrating
> DataHub's MCP Server as the source of truth. The core comparison
> pattern it implements (validate real state, don't trust a stored claim)
> was adapted from this repo's pre-existing `context-workspace` module —
> new integration, ported concept, not built from nothing.
>
> **Pre-existing, disclosed:** the rest of this repository (Gatekeeper,
> telemetry harness, accountability module, security-infra, clarification
> gate, and `context-workspace` itself) predates the submission period
> and is included as supporting architecture, not as part of the new work
> being judged. Full detail in "Built on," below.

**What it catches:** an agent about to run a pipeline, generate code, or
deploy a model based on assumed data lineage — this module queries DataHub's
real metadata graph first, diffs what's actually there against what's
expected, and stops the action if a dependency has quietly disappeared.

---

## Before you run anything — requirements

You need a **live, running DataHub instance with the MCP Server reachable**.
Nothing in this module works against mocks or fixtures at runtime — the
hermetic test suite proves the internal logic is correct in isolation, but
it does **not** prove this integration works. That only happens against a
real instance. Do not skip this step.

1. **Docker + Docker Compose** installed
2. **Python 3.10+**
3. Install the DataHub CLI:
   ```
   pip install --upgrade acryl-datahub
   ```
4. Start DataHub locally:
   ```
   datahub docker quickstart
   ```
5. Ingest sample metadata so there's real schema/lineage data to check
   against (an empty instance has nothing to diff).
6. Confirm the **MCP Server** is enabled and reachable from this project.
7. If you want write-back (tagging flagged entities) to work, confirm
   `TOOLS_IS_MUTATION_ENABLED=true` is set on your DataHub instance —
   without it, the guard still detects and reports problems, it just can't
   write findings back into the graph.

**Before trusting this against your instance**, run the contract
verification script once:

```
python scripts/verify_mcp_contract.py
```

This confirms three things that can't be assumed from documentation alone:
the real tool list your server exposes, the real shape of a `get_lineage`
response, and the real name of the mutation tool used for tagging. If any
of those differ from what this module assumes, fix the mismatch there
before running the guard for real.

---

## Running it

```
python -m pytest tests/ -v
```

Runs the hermetic test suite — proves the comparison and decision logic
behaves correctly against known-good and known-broken inputs, with zero
dependency on a live DataHub instance.

> **A green run here does not mean this works against your DataHub
> instance.** These tests inject fixture data directly — they never make
> a real MCP call. Passing tests confirm the logic is internally sound,
> nothing more. Live compatibility is only confirmed by running
> `scripts/verify_mcp_contract.py` against your actual running instance
> (see Requirements above). Do not treat a green `pytest` run as a
> substitute for that step.

To run the guard against real data, point it at a real entity URN from
your DataHub instance (see `scripts/verify_mcp_contract.py` for how to
find one via the `search` tool) and call it the same way the integration
test in the suite does.

---

## What it does, in one paragraph

For a given entity, the guard pulls real upstream lineage from DataHub via
the MCP `get_lineage` tool and compares it against an expected set of
dependencies. A **removed** dependency (something that used to be there and
isn't anymore) is treated as the higher-severity finding and stops the
action. An **added** dependency is lower-severity and gets flagged rather
than blocking, since it may just be legitimate pipeline evolution DataHub
hasn't caught up to yet. A malformed or empty response is treated as
ambiguous, not as proof of tampering — it gets flagged, not escalated to a
hard stop. On a confirmed halt, the guard writes the finding back into
DataHub as a tag on the entity, so the next agent that queries it inherits
the warning instead of hitting the same gap blind.

---

## Built on

This module is new for the hackathon submission period. It applies a
recompute-and-compare pattern (validate real state, don't trust a stored
claim) that was originally built and tested in this repo's
`context-workspace` module against a local Postgres-backed lineage
structure — here it's retargeted at DataHub's real metadata graph instead.
The rest of this repository (Gatekeeper, the telemetry harness, the
accountability module, security-infra, and the clarification gate)
predates the hackathon submission period and is included as supporting
architecture, disclosed here per the competition rules — it is not part
of the new work being judged.

## License

Apache License 2.0 — see `LICENSE`.
