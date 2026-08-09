#pragma once
#include <cstdint>
#include <vector>
#include <stdexcept>

// Simple fixed-capacity allocator for BFT message buffers.
// Intentionally no dynamic growth after construction -- allocation failures
// are hard errors (fail-closed). Real deployment may replace with a
// region-based or arena allocator backed by a memory pool.
class BFTAllocator {
    std::vector<uint8_t> pool_;
    size_t used_ = 0;

public:
    explicit BFTAllocator(size_t capacity_bytes) : pool_(capacity_bytes) {}

    // Allocate n bytes. Throws on exhaustion (no silent null return).
    uint8_t* allocate(size_t n) {
        if (used_ + n > pool_.size()) {
            throw std::runtime_error("BFTAllocator: pool exhausted");
        }
        uint8_t* p = pool_.data() + used_;
        used_ += n;
        return p;
    }

    size_t used() const { return used_; }
    size_t capacity() const { return pool_.size(); }
    void reset() { used_ = 0; }
};
