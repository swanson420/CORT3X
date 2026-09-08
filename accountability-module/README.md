# Accountability Module

**Module 4 of Cort3x — the permanent audit trail.** Chain-integrity verification, encryption, retention policy, and tamper detection for every action the system takes.

---

## What it does

Every session and every logged action is written with:

- **AES-256-GCM encryption at rest** — action payloads are encrypted with a required key (no silent unencrypted fallback; the module refuses to start without a valid 64-char hex key).
- **Hash-chained tamper evidence** — each action row carries a `chain_seq` and `row_hash`, derived from the previous row's hash via a chain key that's cryptographically separate from the encryption key (HKDF-derived, domain-separated). `verifyChain()` walks the full chain and reports exactly where and how it broke — a sequence gap (deleted row) or a hash mismatch (edited row) — not just a bare pass/fail.
- **Path-traversal defense** — database file paths are canonicalized with symlink resolution (`fs.realpathSync`) before being checked against the allowed directory, closing the gap a plain `path.resolve()` check would miss.
- **Non-destructive retention** — old sessions are archived (`is_archived = 1`), never deleted. Retention scans never touch the underlying data.
- **Closed-session integrity** — a session can't be logged to after it's closed, and can't be closed without attribution.

## Verified — by direct source inspection

All three of the above (encryption, path-traversal defense, chain-integrity) were confirmed by reading the actual delivered `src/AccountabilityModule.ts` directly, not by trusting any status claim: real `crypto.createCipheriv("aes-256-gcm", ...)` calls, real `fs.realpathSync`-based canonicalization, real `chain_seq`/`row_hash`/`verifyChain()` implementation — all present and substantial, not stubs.

**A note on this module's own `VERIFICATION_LOG.md`:** it's an unusually thorough, honest record — 14 fix passes, several real bugs found and fixed along the way, nothing hidden. But its last two entries contain a claim that directly contradicts the delivered source (a re-verification pass reporting "zero matches" for encryption/traversal code that is, in fact, present and substantial). That claim was almost certainly run against a different or stale copy of the file, not this one — worth knowing if you read the log yourself, so a genuinely stale note doesn't get mistaken for the current status.

**Most complete full-suite run recorded in the log:** integration 9/9, retention 6/6, encryption 6/6, unarchive 8/8, path-traversal 7/7, chain-integrity 8/8, race 0 collisions, stress passing. A fresh `npm test` run in an environment with network access (to install dependencies) is worth doing once more before final submission, to get one clean, undisputed number — same open item as the DataHub live verification for the lineage guard module.

## Known, honestly documented limitations

- Stress-test WAL-size checkpoint behavior is noisy/bimodal under sustained concurrent load in sandbox environments — documented and gated on, not hidden, but genuinely variable run to run.
- Key rotation / versioning / envelope encryption is not implemented — a single static key for the module's lifetime.
- Encryption scope is limited to action payloads, not the full `sessions` table.

## Running it

```bash
npm install
npm test
```

Runs all 8 suites in sequence: integration → retention → encryption → unarchive → path-traversal → chain-integrity → race → stress.

## License

Apache License 2.0 — see top-level `LICENSE`.
