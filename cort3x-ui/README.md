# Cort3x Control Wall — UI Demo

A single-page interactive dashboard demonstrating how Cort3x's safety harness evaluates agent actions and decides to **clear, flag, bounce back, or halt** them.

## What this is

This is a **demonstration UI**, not a live connection to a running AI agent. Clicking a scenario button simulates "an agent just requested this action" so the harness's decision logic can be shown clearly and on-demand, rather than waiting for a live agent to happen to trigger each case.

The decision logic shown here matches exactly how the real `datahub-lineage-guard` module behaves — same three-way outcome structure (CLEARED / FLAGGED / HALTED, plus BOUNCED for the Clarification Gate), same evidence-before-verdict shape. The UI is a skin over that logic, built to make it visible and understandable at a glance — it is not itself performing the real DataHub queries. That live verification is done separately by the actual Python module in `datahub-lineage-guard/`, tested against a real DataHub instance.

## How to use it

1. Open `cort3x-ui.html` in any browser — no server, no install, no dependencies. Just double-click it or drag it into a browser tab.
2. **Top band** — the global system status. Green (OPERATIONAL), amber (WARNING), teal (AWAITING CLARIFICATION), or red (SYSTEM HALTED), driven by the worst state across all six modules.
3. **Select Scenario** — four one-click presets that walk through the real failure modes Cort3x is built to catch:
   - **Clean Run** — all dependencies verified, action authorized
   - **Missing Dependency** — an upstream table vanished from the live lineage graph, deployment blocked
   - **Bounced Back** — the request was too ambiguous to even flag and proceed; sent back to the agent, nothing executes
   - **Ambiguous Lineage** — evidence is incomplete; flagged for review rather than falsely asserting tampering
4. **The Check** — this is the important part. Every scenario plays out step by step: what the agent asked for, what dependencies were expected, the live query firing, what actually came back, and only then the verdict — worded to reference the specific evidence above it. This is deliberate: a verdict with no visible evidence behind it is just a color change, not a demonstration of reasoning.
5. **Explore modules individually** — expand this to see all six modules' status and manually trigger Clear / Flag / Bounce / Halt on any one of them to see how the global status band reacts. Any module that isn't CLEARED auto-expands itself so nothing important stays hidden behind a click.
6. **Audit Trail** — a running log of every state change, timestamped, for the "trustworthy history of everything that's happened" the project is built around.

## Presenting this honestly

When demoing or narrating this (video, live walkthrough, etc.), describe it as **"here's what the harness does when it receives a request like this"** — not as a live AI making decisions in real time. The scenario buttons are a stand-in for agent requests, used to show the logic on command. That's a normal, honest way to demo a safety/policy system; the dishonest version would be implying this dashboard is streaming from a live agent conversation when it isn't.

## Design notes

Built around Gestalt visual hierarchy principles: one dominant global status element (figure-ground), six modules sharing one identical card template so status can be scanned by color/position alone (similarity), and a left-to-right module order matching the actual pipeline flow (continuity). Color system: teal is the base/DataHub nod, orange is Cort3x's own identity, and status color (green/amber/red/teal) is a fully separate channel so brand color never gets mistaken for a warning.
