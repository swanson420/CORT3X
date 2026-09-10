#pragma once

#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>
#include <pthread.h>
#include <atomic>
#include <cstdio>
#include <stdexcept>
#include <cstring>
#include <string>
#include <cerrno>
#include <ctime>

class AlertingSidecar {
public:
    struct Alert {
        uint64_t timestamp;
        uint64_t code;
        char msg[256];
    };

private:
    struct SharedBuffer {
        pthread_mutex_t mutex;
        std::atomic<size_t> head;
        std::atomic<size_t> tail;
        size_t capacity;
        // Ring buffer storage for alerts (e.g., 64 slots of 256-byte message structures)
        static constexpr size_t kCapacity = 64;
        Alert alerts[kCapacity];
    };

    SharedBuffer* shm_ptr;
    int fd;
    const char* shm_name;
    bool is_owner;

public:
    explicit AlertingSidecar(const char* name = "/bft_alerts_shared") 
        : shm_ptr(nullptr), fd(-1), shm_name(name), is_owner(false) {
        
        bool newly_created = false;
        fd = shm_open(shm_name, O_CREAT | O_RDWR | O_EXCL, 0666);
        if (fd >= 0) {
            newly_created = true;
            is_owner = true;
        } else if (errno == EEXIST) {
            // Already exists, open normally
            fd = shm_open(shm_name, O_RDWR, 0666);
        }

        if (fd < 0) {
            throw std::runtime_error("AlertingSidecar: shm_open failed with errno: " + std::string(strerror(errno)));
        }

        if (newly_created) {
            if (ftruncate(fd, sizeof(SharedBuffer)) != 0) {
                close(fd);
                throw std::runtime_error("AlertingSidecar: ftruncate failed");
            }
        }

        void* mapped = mmap(nullptr, sizeof(SharedBuffer), PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        if (mapped == MAP_FAILED) {
            close(fd);
            throw std::runtime_error("AlertingSidecar: mmap failed");
        }

        shm_ptr = static_cast<SharedBuffer*>(mapped);

        if (newly_created) {
            // Initialize shared memory control structures
            shm_ptr->head.store(0);
            shm_ptr->tail.store(0);
            shm_ptr->capacity = SharedBuffer::kCapacity;

            pthread_mutexattr_t attr;
            pthread_mutexattr_init(&attr);
            pthread_mutexattr_setpshared(&attr, PTHREAD_PROCESS_SHARED);
            pthread_mutexattr_setrobust(&attr, PTHREAD_MUTEX_ROBUST);
            
            pthread_mutex_init(&shm_ptr->mutex, &attr);
            pthread_mutexattr_destroy(&attr);
        } else {
            // If opening an existing shared region, check if mutex recovery is needed
            int val = pthread_mutex_lock(&shm_ptr->mutex);
            if (val == EOWNERDEAD) {
                pthread_mutex_consistent(&shm_ptr->mutex);
                pthread_mutex_unlock(&shm_ptr->mutex);
            } else if (val == 0) {
                pthread_mutex_unlock(&shm_ptr->mutex);
            }
        }
    }

    ~AlertingSidecar() {
        if (shm_ptr && shm_ptr != MAP_FAILED) {
            munmap(shm_ptr, sizeof(SharedBuffer));
        }
        if (fd >= 0) {
            close(fd);
        }
    }

    // FIX: original signature was NotifyOperator(uint64_t code, const char* msg),
    // which does not match main_test.cpp's single-argument call
    // (alerts.NotifyOperator("test message 1")) -- would not compile as
    // delivered. code is now optional and defaults to 0; nothing in the
    // test suite inspects it.
    //
    // FIX: original body called snprintf and discarded its return value,
    // so a message longer than the buffer was silently truncated and the
    // function still reported success (true) -- contradicted the README's
    // own claim that "the return value of snprintf is checked." snprintf's
    // return value is the length that WOULD have been written if the
    // buffer were large enough (excluding the NUL); if that is >=
    // sizeof(Alert::msg), the stored copy was truncated. The message is
    // still stored (truncated, NUL-terminated -- callers can still read
    // the valid prefix back via LastMessage()/PopAlert()), but the
    // function now returns false in that case instead of true, matching
    // what main_test.cpp checks.
    bool NotifyOperator(const char* msg, uint64_t code = 0) {
        if (!shm_ptr) return false;

        int lock_result = pthread_mutex_lock(&shm_ptr->mutex);
        if (lock_result == EOWNERDEAD) {
            pthread_mutex_consistent(&shm_ptr->mutex);
        } else if (lock_result != 0) {
            return false;
        }

        size_t current_head = shm_ptr->head.load(std::memory_order_relaxed);
        size_t current_tail = shm_ptr->tail.load(std::memory_order_relaxed);
        size_t cap = shm_ptr->capacity;

        // Check for ring buffer full condition
        if ((current_head - current_tail) >= cap) {
            pthread_mutex_unlock(&shm_ptr->mutex);
            return false; // Buffer overflow, drop or handle backpressure
        }

        size_t index = current_head % cap;
        shm_ptr->alerts[index].code = code;
        shm_ptr->alerts[index].timestamp = static_cast<uint64_t>(time(nullptr));

        bool truncated = false;
        if (msg) {
            int written = std::snprintf(shm_ptr->alerts[index].msg, sizeof(Alert::msg), "%s", msg);
            if (written < 0) {
                // Genuine encoding error from snprintf itself -- nothing
                // valid was stored, do not advance head, report failure.
                pthread_mutex_unlock(&shm_ptr->mutex);
                return false;
            }
            if (static_cast<size_t>(written) >= sizeof(Alert::msg)) {
                truncated = true;
            }
        } else {
            shm_ptr->alerts[index].msg[0] = '\0';
        }

        shm_ptr->head.store(current_head + 1, std::memory_order_release);
        
        pthread_mutex_unlock(&shm_ptr->mutex);
        return !truncated;
    }

    bool PopAlert(Alert& out_alert) {
        if (!shm_ptr) return false;

        int lock_result = pthread_mutex_lock(&shm_ptr->mutex);
        if (lock_result == EOWNERDEAD) {
            pthread_mutex_consistent(&shm_ptr->mutex);
        } else if (lock_result != 0) {
            return false;
        }

        size_t current_head = shm_ptr->head.load(std::memory_order_relaxed);
        size_t current_tail = shm_ptr->tail.load(std::memory_order_relaxed);

        if (current_tail >= current_head) {
            pthread_mutex_unlock(&shm_ptr->mutex);
            return false; // Queue is empty
        }

        size_t index = current_tail % shm_ptr->capacity;
        out_alert = shm_ptr->alerts[index];

        shm_ptr->tail.store(current_tail + 1, std::memory_order_release);

        pthread_mutex_unlock(&shm_ptr->mutex);
        return true;
    }

    // FIX: README claims the process-shared mutex "protects both the
    // write path (NotifyOperator) and the read path (LastMessage)" --
    // as delivered, this function took no lock at all (pure unsynchronized
    // peek at shared memory another process could be writing to
    // concurrently). Now takes the same lock/EOWNERDEAD-recovery pattern
    // used in NotifyOperator/PopAlert, so the README's claim is actually
    // true instead of overclaimed. shm_ptr is a pointer member, so its
    // pointee's mutability is unaffected by this method being const --
    // no const_cast needed.
    std::string LastMessage() const {
        if (!shm_ptr) return "";

        int lock_result = pthread_mutex_lock(&shm_ptr->mutex);
        if (lock_result == EOWNERDEAD) {
            pthread_mutex_consistent(&shm_ptr->mutex);
        } else if (lock_result != 0) {
            return "";
        }

        size_t current_head = shm_ptr->head.load(std::memory_order_relaxed);
        if (current_head == 0) {
            pthread_mutex_unlock(&shm_ptr->mutex);
            return "";
        }

        size_t index = (current_head - 1) % shm_ptr->capacity;
        std::string result(shm_ptr->alerts[index].msg);

        pthread_mutex_unlock(&shm_ptr->mutex);
        return result;
    }

    void Cleanup() {
        if (is_owner) {
            shm_unlink(shm_name);
        }
    }
};
