#pragma once
#include <cstdint>
#include <cstddef>
#include <vector>

// Fixed-capacity pool of equal-size buffers with explicit Allocate /
// Deallocate / AvailableCount semantics. Distinct from BFTAllocator
// (bump-style region) -- callers that pull a buffer out expect to put it
// back later, and expect Allocate() to return nullptr (not throw) when the
// pool is empty so the caller can choose its own fail-closed response.
class BFTMessagePool {
    std::vector<uint8_t> storage_;
    std::vector<void*>   free_list_;
    size_t              capacity_ = 0;

public:
    BFTMessagePool(size_t count, size_t buffer_size)
        : storage_(count * buffer_size), capacity_(count) {
        free_list_.reserve(count);
        for (size_t i = 0; i < count; ++i) {
            free_list_.push_back(storage_.data() + i * buffer_size);
        }
    }

    void* Allocate() {
        if (free_list_.empty()) return nullptr;
        void* p = free_list_.back();
        free_list_.pop_back();
        return p;
    }

    void Deallocate(void* p) {
        // Reject foreign / already-free pointers silently rather than
        // corrupting the free list. Valid buffers always round-trip:
        // AvailableCount is bounded by capacity_ at all times.
        auto base = reinterpret_cast<uintptr_t>(storage_.data());
        auto end  = base + storage_.size();
        auto addr = reinterpret_cast<uintptr_t>(p);
        if (addr < base || addr >= end) return;
        if (free_list_.size() >= capacity_) return;
        free_list_.push_back(p);
    }

    size_t AvailableCount() const { return free_list_.size(); }
};
