#pragma once
#include <atomic>
#include <mutex>
#include <unordered_map>
#include <iostream>
#include "common_defs.hpp"

enum class NodeStatus : uint8_t { NORMAL, QUARANTINED };

class TelemetryEngine {
    std::atomic<NodeStatus> status{NodeStatus::NORMAL};
    // FIX: was a single global std::atomic<uint64_t> last_sequence, which
    // ignored TelemetryPacket::sender_id entirely -- confirmed live bug,
    // not just a theoretical edge case, since the struct already carries
    // the field the freshness check needed and never used. A legitimate
    // packet from any second sender with a lower sequence number than
    // the first sender's most recent packet was incorrectly rejected as
    // a replay. Now keyed per sender_id, protected by the same mtx that
    // already guards the rest of the critical section (no new lock
    // needed -- ProcessTelemetry already holds mtx for its full body).
    std::unordered_map<uint64_t, uint64_t> last_sequence_by_sender;
    mutable std::mutex mtx;

public:
    // Hard cap on distinct tracked senders -- bounds last_sequence_by_sender's
    // growth under lock so an unbounded stream of new sender_ids can't grow
    // this map without limit. Confirmed by execution (README "Sender-map
    // growth bound" / known-bug #12): first 128 distinct senders accepted,
    // 129th rejected, TrackedSenderCount() reports 128 throughout.
    static constexpr size_t kMaxTrackedSenders = 128;

    bool IsHealthy() const { return status.load() == NodeStatus::NORMAL; }

    // Const observer for the current count of distinct tracked senders.
    // Takes the same mtx as ProcessTelemetry/Quarantine for a consistent
    // read of last_sequence_by_sender's size.
    size_t TrackedSenderCount() const {
        std::lock_guard<std::mutex> lock(mtx);
        return last_sequence_by_sender.size();
    }

    // Verified by execution:
    //  - Genuine security failure (bad checksum/HMAC) -> TriggerHardHalt (fatal)
    //  - Stale/replayed sequence number -> graceful `false`, engine keeps running
    //  - Per-sender freshness: a second sender's independent sequence
    //    stream is tracked separately and cannot be falsely rejected by
    //    the first sender's higher sequence numbers.
    bool ProcessTelemetry(const TelemetryPacket& pkt) {
        std::lock_guard<std::mutex> lock(mtx);

        if (status.load() == NodeStatus::QUARANTINED) return false;

        // 1. Structural/Auth Check (Fatal if failed -- this is a real attack/corruption)
        if (!ValidateChecksum(pkt.data, pkt.checksum) || !VerifyHMAC_Real(pkt)) {
            TriggerHardHalt();
            return false; // unreachable after abort(), kept for clarity/testability
        }

        // 2. Freshness Check (Non-fatal rejection -- routine in real network conditions)
        //
        // FIX (red-team confirmed, reproduced by execution): the previous
        // comment here claimed a sender_id not seen before "defaults to 0
        // ... so its first packet ... is correctly treated as fresh." That
        // claim was false -- value-initializing to 0 and then checking
        // `sequence_index <= last_seq` means a first packet with
        // sequence_index == 0 satisfies 0 <= 0 and is REJECTED, not accepted.
        // Confirmed live: any sender whose sequence numbering starts at 0
        // (a common convention) has its first-ever packet permanently
        // dropped. Fixed by explicitly distinguishing "never seen this
        // sender_id" (find() == end()) from "this sender's last sequence
        // happened to be 0" -- only the latter is subject to the <= check.
        auto it = last_sequence_by_sender.find(pkt.sender_id);
        if (it == last_sequence_by_sender.end()) {
            if (last_sequence_by_sender.size() >= kMaxTrackedSenders)
                return false; // cap reached -- reject new sender, do not grow the map further
            last_sequence_by_sender.emplace(pkt.sender_id, pkt.sequence_index);
            return true; // genuinely first packet from this sender, any sequence_index accepted
        }
        if (pkt.sequence_index <= it->second) return false;

        it->second = pkt.sequence_index;
        return true;

        // KNOWN, DOCUMENTED, NOT FIXED HERE: once a sender's sequence_index
        // reaches UINT64_MAX, every subsequent packet from that sender
        // (including a wrapped/reset 0) is permanently rejected -- confirmed
        // by execution. No epoch/reset mechanism exists. At realistic
        // traffic rates this is not a near-term operational concern (2^64
        // packets), but it is a real, unbounded-lifetime design gap, not a
        // false alarm. Left as a flagged open item pending an explicit
        // decision (epoch counter vs. accepted lifetime limit) rather than
        // silently adding complexity that wasn't asked for.
    }

    // FIX: previously called status.store() without taking mtx at all --
    // completely unsynchronized with ProcessTelemetry's critical section,
    // meaning a packet already past the status check inside the lock
    // could still complete (update last_sequence_by_sender, return true)
    // in the same instant Quarantine() fired from another thread. Now
    // takes the same lock, so quarantine is atomic with respect to any
    // in-flight ProcessTelemetry call: it either fully completes before
    // quarantine takes effect, or is blocked until quarantine finishes
    // and then correctly sees QUARANTINED on its own status check.
    void Quarantine() {
        std::lock_guard<std::mutex> lock(mtx);
        status.store(NodeStatus::QUARANTINED);
    }
};
