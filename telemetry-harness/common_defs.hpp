#pragma once
#include <cstdint>
#include <cstdlib>
#include <iostream>

struct TelemetryPacket {
    uint64_t sender_id;
    uint64_t sequence_index;
    uint32_t checksum;
    uint8_t  hmac[32];
    uint8_t  data[128];
};

// Structural integrity check (stub: real implementation would compute CRC32/xxHash)
inline bool ValidateChecksum(const uint8_t* data, uint32_t checksum) {
    (void)data; (void)checksum;
    return true;
}

// Forward declaration: real signature verification, defined by the application
// (kept out of the header so different callers can supply real crypto)
bool VerifyHMAC_Real(const TelemetryPacket& pkt);

// Fatal, uncatchable halt path for genuine security violations.
// Deliberately does not attempt cleanup here beyond what's shown --
// real deployment should route through the kernel-delegated cleanup
// path designed earlier (no local mutex/fd cleanup, rely on OS).
inline void TriggerHardHalt() {
    std::cerr << "[CRITICAL] Security violation detected. Halting process.\n";
    std::abort();
}
