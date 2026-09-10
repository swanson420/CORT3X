#include "telemetry_core.hpp"
#include "bft_allocator.hpp"
#include "bft_consensus.hpp"
#include "supervisor.hpp"
#include "alerting.hpp"
#include <cassert>
#include <iostream>
#include <cstring>
#include <vector>
#include <string>

// Real (test-controllable) HMAC check: fails only if hmac field spells "INVALID"
bool VerifyHMAC_Real(const TelemetryPacket& pkt) {
    return std::strncmp(reinterpret_cast<const char*>(pkt.hmac), "INVALID", 7) != 0;
}

int pass_count = 0;
int fail_count = 0;

void check(bool cond, const char* label) {
    std::cout << (cond ? "[PASS] " : "[FAIL] ") << label << "\n";
    if (cond) pass_count++; else fail_count++;
}

int main() {
    std::cout << "=== Telemetry Engine: Core Logic ===\n";
    {
        TelemetryEngine engine;
        TelemetryPacket p1{}; p1.sender_id = 1; p1.sequence_index = 100;
        check(engine.ProcessTelemetry(p1) == true, "First packet accepted");
        check(engine.ProcessTelemetry(p1) == false, "Replay of same sequence rejected (non-fatal)");
        check(engine.IsHealthy() == true, "Engine still healthy after replay rejection (no crash)");

        TelemetryPacket p2{}; p2.sender_id = 1; p2.sequence_index = 101;
        check(engine.ProcessTelemetry(p2) == true, "Next valid sequence accepted");
    }

    std::cout << "\n=== Telemetry Engine: Per-sender sequence tracking (regression test) ===\n";
    {
        // Reproduces the confirmed bug: a single global last_sequence
        // caused a legitimate second sender's lower sequence number to
        // be falsely rejected as a replay. This is now per-sender.
        TelemetryEngine engine;
        TelemetryPacket sender_a{}; sender_a.sender_id = 1; sender_a.sequence_index = 500;
        check(engine.ProcessTelemetry(sender_a) == true, "Sender 1: high sequence accepted");

        TelemetryPacket sender_b{}; sender_b.sender_id = 2; sender_b.sequence_index = 1;
        check(engine.ProcessTelemetry(sender_b) == true,
              "Sender 2: low sequence (1) NOT falsely rejected despite sender 1 being at 500");

        TelemetryPacket sender_b_replay{}; sender_b_replay.sender_id = 2; sender_b_replay.sequence_index = 1;
        check(engine.ProcessTelemetry(sender_b_replay) == false,
              "Sender 2: actual replay of its own sequence still correctly rejected");

        TelemetryPacket sender_a_next{}; sender_a_next.sender_id = 1; sender_a_next.sequence_index = 501;
        check(engine.ProcessTelemetry(sender_a_next) == true,
              "Sender 1: independent sequence stream unaffected by sender 2's activity");
    }

    std::cout << "\n=== Telemetry Engine: Quarantine synchronization (regression test) ===\n";
    {
        // Quarantine() takes the lock; effect is visible to subsequent ProcessTelemetry.
        TelemetryEngine engine;
        TelemetryPacket p{}; p.sender_id = 1; p.sequence_index = 1;
        check(engine.ProcessTelemetry(p) == true, "Pre-quarantine packet accepted normally");

        engine.Quarantine();
        check(engine.IsHealthy() == false, "Engine reports unhealthy immediately after Quarantine()");

        TelemetryPacket p2{}; p2.sender_id = 1; p2.sequence_index = 2;
        check(engine.ProcessTelemetry(p2) == false, "Post-quarantine packet correctly rejected");
    }

    std::cout << "\n=== Telemetry Engine: First-packet / seq=0 + wrap-around constraint ===\n";
    {
        TelemetryEngine engine;
        TelemetryPacket p0{}; p0.sender_id = 42; p0.sequence_index = 0;
        check(engine.ProcessTelemetry(p0) == true,
              "First packet with sequence_index==0 is accepted (new sender)");

        TelemetryPacket p0_replay{}; p0_replay.sender_id = 42; p0_replay.sequence_index = 0;
        check(engine.ProcessTelemetry(p0_replay) == false,
              "Replay of sequence 0 still rejected");

        // Drive to near-max then attempt wrap
        TelemetryPacket pmax{}; pmax.sender_id = 42; pmax.sequence_index = UINT64_MAX;
        check(engine.ProcessTelemetry(pmax) == true, "UINT64_MAX accepted after 0");

        TelemetryPacket pwrap{}; pwrap.sender_id = 42; pwrap.sequence_index = 0;
        check(engine.ProcessTelemetry(pwrap) == false,
              "Wrap-around (0 after UINT64_MAX) permanently rejected — known lifetime constraint");
    }

    std::cout << "\n=== Telemetry Engine: Sender-cap (unbounded-map fix) ===\n";
    {
        TelemetryEngine engine;
        // Fill up to the documented cap of 128
        bool all_accepted = true;
        for (uint64_t id = 1; id <= 128; ++id) {
            TelemetryPacket pkt{};
            pkt.sender_id = id;
            pkt.sequence_index = 1;
            if (!engine.ProcessTelemetry(pkt)) {
                all_accepted = false;
                break;
            }
        }
        check(all_accepted, "First 128 distinct senders accepted");
        check(engine.TrackedSenderCount() == 128, "TrackedSenderCount reports 128");

        TelemetryPacket overflow{};
        overflow.sender_id = 9999;
        overflow.sequence_index = 1;
        check(engine.ProcessTelemetry(overflow) == false,
              "129th distinct sender rejected (cap enforced)");
    }

    std::cout << "\n=== Memory Pool: Allocate/Deallocate restored ===\n";
    {
        BFTMessagePool pool(10, 128);
        void* a = pool.Allocate();
        check(a != nullptr, "Allocate returns valid pointer");
        check(pool.AvailableCount() == 9, "Pool count decremented after allocate");
        pool.Deallocate(a);
        check(pool.AvailableCount() == 10, "Pool count restored after deallocate");

        // Exhaust the pool
        std::vector<void*> all;
        for (int i = 0; i < 10; ++i) all.push_back(pool.Allocate());
        check(pool.Allocate() == nullptr, "Allocate returns nullptr when pool exhausted");
        for (auto* p : all) pool.Deallocate(p);
    }

    std::cout << "\n=== BFT Consensus: Real signature check ===\n";
    {
        BFTConsensus bft;
        uint8_t valid_sig[32]; std::memset(valid_sig, 0xAB, 32);
        uint8_t zero_sig[32];  std::memset(zero_sig, 0x00, 32);

        std::vector<TimeReport> reports = {
            {1, 0.5, {}}, {2, 0.2, {}}, {3, 0.8, {}}
        };
        std::memcpy(reports[0].sig, valid_sig, 32);
        std::memcpy(reports[1].sig, valid_sig, 32);
        std::memcpy(reports[2].sig, valid_sig, 32);

        auto result = bft.CalculateConsensus(reports);
        check(result.valid == true, "Consensus reached with 3 valid signatures");
        check(result.median == 0.5, "Median offset correctly calculated");

        // Now inject a Byzantine (unsigned/zero-sig) report
        std::vector<TimeReport> byz_reports = reports;
        std::memcpy(byz_reports[0].sig, zero_sig, 32); // invalidate one
        auto result2 = bft.CalculateConsensus(byz_reports);
        check(result2.rejected_count == 1, "Byzantine (invalid signature) report rejected");
        check(result2.valid == false, "Consensus fails when below quorum (2 valid < 3 required)");
    }

    std::cout << "\n=== Supervisor: Real health-check wiring (atomic attempts) ===\n";
    {
        TelemetryEngine engine;
        Supervisor sup;
        bool healthy = sup.RunWatchdog(engine, 5);
        check(healthy == true, "Supervisor reports healthy engine stays healthy");

        // Force quarantine and confirm supervisor's IsHealthy() call actually reflects it
        engine.Quarantine();
        check(engine.IsHealthy() == false, "Engine reports unhealthy after quarantine");
        // Note: NOT running RunWatchdog to trip the circuit breaker here,
        // since it calls TriggerHardHalt() -> abort() by design (fatal path).
        // That path is validated separately, see fatal_path_test.
    }

    std::cout << "\n=== Alerting Sidecar: Real SHM + process-shared mutex + truncation ===\n";
    {
        AlertingSidecar alerts("/bft_alerts_test");

        // Empty read before any write
        check(alerts.LastMessage().empty(), "LastMessage() returns empty when head==0");

        bool ok = alerts.NotifyOperator("test message 1");
        check(ok == true, "NotifyOperator returns true for short message");
        check(alerts.LastMessage() == "test message 1", "Message written and read back from SHM");

        // Truncation test: 300-char payload into 256-byte slot
        std::string longmsg(300, 'A');
        bool truncated = alerts.NotifyOperator(longmsg.c_str());
        check(truncated == false, "NotifyOperator returns false on truncation (>255 chars)");
        // The stored message is still null-terminated and readable (prefix)
        std::string stored = alerts.LastMessage();
        check(stored.size() == 255, "Truncated message is 255 chars (256 incl. NUL)");
        check(stored.find_first_not_of('A') == std::string::npos, "Truncated payload is all 'A's");

        alerts.Cleanup();
    }

    std::cout << "\n=== SUMMARY: " << pass_count << " passed, " << fail_count << " failed ===\n";
    return fail_count > 0 ? 1 : 0;
}
