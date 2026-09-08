#pragma once
#include <thread>
#include <chrono>
#include <iostream>
#include <atomic>
#include "telemetry_core.hpp"

class Supervisor {
    // Atomic so concurrent watchdog instances (or concurrent calls from
    // different threads) do not race on the attempt counter.
    std::atomic<int> attempts{0};
    static constexpr int MAX_ATTEMPTS = 3;

public:
    // Runs up to max_checks health-check cycles (bounded so it's testable;
    // real deployment would run this as `while(true)` in its own thread).
    // Returns true if the engine remained healthy throughout, false if
    // the circuit breaker tripped.
    bool RunWatchdog(TelemetryEngine& engine, int max_checks,
                      std::chrono::milliseconds interval = std::chrono::milliseconds(10)) {
        for (int i = 0; i < max_checks; ++i) {
            if (!engine.IsHealthy()) {
                int n = attempts.fetch_add(1, std::memory_order_relaxed) + 1;
                std::cerr << "[Supervisor] Unhealthy check #" << n << "\n";
                if (n > MAX_ATTEMPTS) {
                    std::cerr << "[Supervisor] Fatal Service Halt: exceeded "
                                 "max unhealthy attempts.\n";
                    TriggerHardHalt();
                    return false; // unreachable after abort(), kept for clarity
                }
            } else {
                attempts.store(0, std::memory_order_relaxed); // reset on recovery
            }
            std::this_thread::sleep_for(interval);
        }
        return true;
    }
};
