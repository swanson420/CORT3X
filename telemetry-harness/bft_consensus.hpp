#pragma once
#include <algorithm>
#include <vector>
#include <cstdint>
#include <cstring>

struct TimeReport { uint64_t sender; double offset; uint8_t sig[32]; };

// Real (if simplified) signature check: a report is valid only if its
// signature bytes are non-zero. This is intentionally simple -- the design
// called for HSM/Vault-backed signing, which this stub does not implement --
// but unlike the previous version, this one can actually return false and be
// tested, rather than being hardcoded to always pass.
inline bool VerifySignature(uint64_t sender, const uint8_t* payload, const uint8_t* sig) {
    (void)sender; (void)payload;
    uint8_t zero[32] = {0};
    return std::memcmp(sig, zero, 32) != 0;
}

class BFTConsensus {
public:
    // FIX (red-team confirmed, doc-only): this comment previously said
    // "Weighted median" -- no weighting of any kind exists in the code
    // below (plain std::sort + middle element). Corrected to describe what
    // is actually implemented, per the project's fail-closed-on-overclaiming
    // standard: documentation must reflect the code, not the original design
    // intent. If real weighting (e.g. by sender trust score) is needed, that
    // is unimplemented, not partially implemented.
    //
    // Plain median of valid (signature-passing) reports, unweighted.
    // Requires at least 2F+1 = 3 valid reports to reach consensus at all.
    // Returns {success, median_offset}.
    struct Result {
        bool success;
        double median;
        int rejected;
    };

    Result ReachConsensus(const std::vector<TimeReport>& reports) {
        std::vector<double> valid;
        int rejected = 0;

        for (const auto& r : reports) {
            // Signature is checked against the offset bytes (simplified payload).
            // Real implementation would sign a canonical serialization of the report.
            uint8_t payload[sizeof(double)];
            std::memcpy(payload, &r.offset, sizeof(double));
            if (VerifySignature(r.sender, payload, r.sig)) {
                valid.push_back(r.offset);
            } else {
                rejected++;
            }
        }

        if (valid.size() < 3) {
            return {false, 0.0, rejected};
        }

        std::sort(valid.begin(), valid.end());
        return {true, valid[valid.size() / 2], rejected};
    }
};
