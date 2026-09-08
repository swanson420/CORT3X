#include "telemetry_core.hpp"
#include <cstring>
#include <iostream>

bool VerifyHMAC_Real(const TelemetryPacket& pkt) {
    return std::strncmp(reinterpret_cast<const char*>(pkt.hmac), "INVALID", 7) != 0;
}

int main() {
    TelemetryEngine engine;
    TelemetryPacket bad{};
    bad.sender_id = 1;
    bad.sequence_index = 1;
    std::strncpy(reinterpret_cast<char*>(bad.hmac), "INVALID", sizeof(bad.hmac));

    std::cout << "Sending packet with invalid HMAC -- expecting abort()...\n";
    engine.ProcessTelemetry(bad);
    std::cout << "ERROR: reached here, halt did not trigger!\n";
    return 1; // should never get here
}
