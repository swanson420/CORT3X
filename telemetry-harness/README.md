# Telemetry Harness -- Build & Verification Status

This package is the first real, compiled, and executed implementation of the
gate-system harness designed across an extended goggles/lens design process.
Everything below reflects what was ACTUALLY run and confirmed, not what was
merely designed or claimed.

## What is confirmed by execution

- Hard-halt path on genuine security failure (bad HMAC / checksum) triggers
  `std::abort()` and does not return.
- Per-sender sequence tracking (bug fix verified live).
- Sender-map growth bound at 128 (confirmed).
- Quarantine is lock-synchronized with ProcessTelemetry.
- BFT consensus requires 3 valid signature-passing reports for a median.
- Supervisor circuit-breaker trips after MAX_ATTEMPTS unhealthy checks.

## Known open items (documented, not silently fixed)

- Sequence wrap-around at UINT64_MAX has no epoch/reset (flagged).
- AlertingSidecar is a real shared-memory design but the production
  HSM/Vault signing path is still a stub.

See individual headers for the red-team confirmed fixes that were applied.
