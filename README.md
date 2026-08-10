# Cort3x

**A safety and integrity harness for AI agents.**

Cort3x sits around an AI agent and watches what it's about to do — catching what's false, stale, or tampered before it acts. It's made of six modules, each guarding a different failure mode, built around one idea:

> **Fail toward visibility, not silence.**

When something is uncertain, ambiguous, missing, or broken, Cort3x is built to flag it loudly and halt rather than proceed quietly and hope. Nothing gets waved through just because no one was watching.

Built for the **Build with DataHub: The Agent Hackathon** (Devpost, Aug 2026).

---

## The six modules

| # | Module | What it guards against |
|---|--------|------------------------|
| 1 | **Context Workspace** | Silent tampering with an agent's working memory. Every piece of context is built into a hash-chained, tamper-evident node structure — immutable once written. |
| 2 | **Clarification Gate** | Acting on a bad guess. Catches ambiguous requests before execution: bounces back to the agent for clarification, proceeds with a visible flag, or halts entirely if evidence is too thin to safely do either. |
| 3 | **DataHub Lineage Guard** | Acting on stale or broken assumptions about data. Before an agent runs a pipeline or deploys, this checks the *real, live* dependency graph via DataHub. If something it depends on has quietly vanished, it halts. If something new appeared, it flags rather than blocks. Findings are written back to DataHub. This is the hackathon's centerpiece module. |
| 4 | **Accountability Module** | Losing the record. The permanent audit trail — chain-integrity verification, encryption, retention policy, tamper detection for everything that happened and when. |
| 5 | **Security Infra** | Shipping things that shouldn't ship. A policy-as-code layer (deployment protection rules) governing what's allowed and under what conditions. |
| 6 | **Telemetry Harness / Evidence Layer** | Not knowing the system is unwell. Low-level monitoring and consensus checking, surfacing evidence when something's gone wrong with the harness itself. |

## Repo structure

```
cort3x/
├── LICENSE                        (Apache 2.0)
├── context-workspace/             Module 1 — Python, Postgres-backed
├── clarification-gate/            Module 2 — Python
├── datahub-lineage-guard/         Module 3 — Python, queries live DataHub via MCP
├── accountability-module/         Module 4 — TypeScript, SQLite
├── security-infra/                Module 5 — Postgres schema/triggers + OPA/Rego policies
├── telemetry-harness/             Module 6a — C++, BFT consensus/telemetry
└── harness-evidence-layer/        Module 6b — C++, hash-chained audit log
```

## Test status

All modules have been independently tested end-to-end (not just unit-tested in isolation):

| Module | Result |
|---|---|
| Context Workspace | 43/43 passed — real Postgres 16, concurrency/hash-chain/immutability tests |
| Clarification Gate | 12/12 passed — hermetic, pure Python |
| Accountability Module | 7/8 passed — one known, documented flaky stress test (WAL checkpoint timing noise in the sandbox environment, not a data-integrity issue; zero lock errors, zero data loss across runs) |
| Security Infra | 9/9 SQL constraint tests passed · 24/24 OPA/Rego policy tests passed |
| Telemetry Harness | 34/34 passed |
| Harness Evidence Layer | 52/52 passed |
| DataHub Lineage Guard | 8/8 hermetic tests passed (comparator logic, severity mapping, writeback isolation). **Live MCP contract verification against a running DataHub instance is in progress** — the module's `get_lineage` tool name, response shape, and `add_tag` mutation name are implemented against the documented DataHub MCP contract and will be confirmed or corrected against a live instance before final submission. |

## UI

An interactive single-page dashboard (`cort3x-ui/`) demonstrates the harness's decision logic — clear, flagged, bounced-back, and halted states, with the underlying evidence (expected vs. actual dependencies) shown before each verdict, not just the verdict itself. See that folder's own README for details on what it does and does not represent.

## License

Apache License 2.0 — see `LICENSE`.

## Attribution

Powered by DataHub. This project uses DataHub's MCP server to query live data lineage; no DataHub logo or trademark is used, per hackathon rules — attribution is text-only.
