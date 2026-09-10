#pragma once
#include <string>
#include <mutex>
#include <vector>
#include <map>
#include <sstream>
#include <iomanip>
#include <ctime>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <functional>
#include <fcntl.h>
#include <unistd.h>
#include "harness_types.hpp"

inline std::string JsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (unsigned char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out;
}

// Defends against red-team item 5 (unbounded field size -> log bloat / OOM
// in downstream parsers). Not UTF-8-aware truncation -- can split a
// multi-byte sequence. Documented, not solved: real UTF-8-safe truncation
// is a bigger lift than this pass covers.
inline std::string TruncateField(const std::string& s, size_t max_len = 4096) {
    if (s.size() <= max_len) return s;
    return s.substr(0, max_len) + "...[truncated " +
           std::to_string(s.size() - max_len) + " bytes]";
}

inline std::string ToIso8601(std::chrono::system_clock::time_point tp) {
    using namespace std::chrono;
    auto t = system_clock::to_time_t(tp);
    auto ms = duration_cast<milliseconds>(tp.time_since_epoch()) % 1000;
    std::tm tm_buf{};
    gmtime_r(&t, &tm_buf);
    std::ostringstream oss;
    oss << std::put_time(&tm_buf, "%Y-%m-%dT%H:%M:%S");
    oss << '.' << std::setfill('0') << std::setw(3) << ms.count() << 'Z';
    return oss.str();
}

// FNV-1a, 64-bit. Chosen for tamper-evidence, not tamper-proofing -- see
// class comment on AuditLog for the honest limit of what this buys you.
inline std::string Fnv1aHex(const std::string& prev_hash_hex, const std::string& content) {
    uint64_t h = 1469598103934665603ULL;
    auto absorb = [&](const std::string& s) {
        for (unsigned char c : s) {
            h ^= c;
            h *= 1099511628211ULL;
        }
    };
    absorb(prev_hash_hex);
    absorb(content);
    std::ostringstream oss;
    oss << std::hex << std::setfill('0') << std::setw(16) << h;
    return oss.str();
}

inline std::string ExtractQuoted(const std::string& s, size_t start) {
    auto end = s.find('"', start);
    if (end == std::string::npos) throw std::runtime_error("ExtractQuoted: malformed field");
    return s.substr(start, end - start);
}

// Append-only JSONL is the source of truth. Any queryable index (SQLite,
// DuckDB, etc.) is a rebuildable view built FROM this file, never a
// replacement for it -- resolves open question 1 from the handoff.
//
// Each line is hash-chained to the previous one (prev_hash/hash fields),
// so a single-line edit either breaks that line's own hash (if content was
// changed without recomputing) or breaks the link to the next line (if it
// was). VerifyChain() checks both.
//
// Honest limit on what this actually buys you, stated plainly per
// red-team item 3: this is tamper-EVIDENT, not tamper-PROOF. FNV-1a is not
// a keyed MAC -- anyone with read/write access to the file and knowledge
// of this algorithm (i.e. this source file) can recompute a fully
// self-consistent alternate chain from any point forward, and VerifyChain
// would pass on the forged version. Real protection against a
// sophisticated attacker requires an external anchor: periodically
// publishing/transmitting the latest hash to a system the attacker doesn't
// also control (a separate log shipper, a remote append-only store, etc.),
// so a forged local chain can be caught by comparing against that anchor.
// Not implemented here -- would need a place to anchor to, which is a
// deployment decision, not something this Project can invent standalone.
class AuditLog {
    int fd_ = -1;
    std::mutex mtx;
    std::vector<ModuleResult> in_memory; // backs summary_by_module() for THIS process run only
    std::string last_hash_hex_ = "0000000000000000";
    bool durable_fsync_;
    std::function<void(const std::string& hash_hex)> on_new_hash_;

public:
    // on_new_hash, if set, is invoked once per successfully-written line,
    // under the same lock that serializes writes -- so callbacks fire in
    // the same order lines were actually written, with no risk of a
    // caller observing hash N+1 before hash N. This is the extension
    // point for real tamper-evidence: Module 6 has no visibility into
    // what a deployment's external anchor should look like (a separate
    // log shipper? periodic transmission to a remote append-only store?
    // something else entirely), so it doesn't build one -- it exposes the
    // one thing every anchoring strategy needs, which is "tell me the
    // latest hash the moment it exists." What the callback DOES with that
    // hash is a deployment decision, not this Project's.
    //
    // Keep the callback fast and non-throwing: it runs synchronously
    // inside WriteLine while the log's mutex is held. A slow or blocking
    // callback serializes every Record()/RecordHalt()/RecordTaskOutcome()
    // call across every caller; an exception escaping it would propagate
    // out of whatever audit call triggered it, which is not itself
    // guarded against here.
    explicit AuditLog(const std::string& path, bool durable_fsync = false,
                       std::function<void(const std::string&)> on_new_hash = nullptr)
        : durable_fsync_(durable_fsync), on_new_hash_(std::move(on_new_hash)) {
        SeedHashFromExistingFile(path);
        fd_ = ::open(path.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
        if (fd_ < 0) {
            throw std::runtime_error("AuditLog: failed to open " + path + ": " + std::strerror(errno));
        }
    }

    ~AuditLog() {
        if (fd_ >= 0) ::close(fd_);
    }

    AuditLog(const AuditLog&) = delete;
    AuditLog& operator=(const AuditLog&) = delete;

    // Current chain tip. Useful for a deployment wiring up external
    // anchoring to grab a starting point, or for a caller that wants to
    // confirm what the next line's prev_hash will be without waiting for
    // the on_new_hash callback.
    std::string current_hash() {
        std::lock_guard<std::mutex> lock(mtx);
        return last_hash_hex_;
    }

    void Record(const ModuleResult& r) {
        std::lock_guard<std::mutex> lock(mtx);
        std::ostringstream body;
        body << "\"event\":\"module_result\","
             << "\"task_id\":\"" << JsonEscape(TruncateField(r.task_id)) << "\","
             << "\"module_id\":\"" << JsonEscape(TruncateField(r.module_id)) << "\","
             << "\"status\":\"" << ToString(r.status) << "\","
             << "\"authority\":\"" << ToString(r.authority) << "\","
             << "\"reason_code\":\"" << ToString(r.reason_code) << "\","
             << "\"reason\":\"" << JsonEscape(TruncateField(r.reason)) << "\","
             << "\"input_ref\":\"" << JsonEscape(TruncateField(r.input_ref)) << "\","
             << "\"output_ref\":\"" << JsonEscape(TruncateField(r.output_ref)) << "\","
             << "\"started_at\":\"" << ToIso8601(r.started_at) << "\","
             << "\"completed_at\":\"" << ToIso8601(r.completed_at) << "\"";
        WriteLine(body.str());
        in_memory.push_back(r);
    }

    void RecordHalt(const std::string& task_id, const std::string& module_id,
                     ReasonCode reason_code, const std::string& reason) {
        std::lock_guard<std::mutex> lock(mtx);
        std::ostringstream body;
        body << "\"event\":\"pipeline_halted\","
             << "\"task_id\":\"" << JsonEscape(TruncateField(task_id)) << "\","
             << "\"halted_at_module\":\"" << JsonEscape(TruncateField(module_id)) << "\","
             << "\"reason_code\":\"" << ToString(reason_code) << "\","
             << "\"reason\":\"" << JsonEscape(TruncateField(reason)) << "\"";
        WriteLine(body.str());
    }

    void RecordTaskOutcome(const std::string& task_id, bool released) {
        std::lock_guard<std::mutex> lock(mtx);
        std::ostringstream body;
        body << "\"event\":\"task_outcome\","
             << "\"task_id\":\"" << JsonEscape(TruncateField(task_id)) << "\","
             << "\"released\":" << (released ? "true" : "false");
        WriteLine(body.str());
    }

    // Resolves the summary_by_module() question raised against the plan
    // doc: nothing else in this Project defines it, so it lives here.
    // NOTE: reads the in-memory vector, i.e. only what THIS process
    // instance has recorded -- not the full cross-run history in the
    // JSONL file on disk. A real dashboard (item 9) reading historical
    // data needs to parse the file (or an index built from it), not this
    // method.
    struct ModuleSummary {
        int pass = 0;
        int fail = 0;
        std::map<std::string, int> fail_by_reason;
    };

    std::map<std::string, ModuleSummary> summary_by_module() {
        std::lock_guard<std::mutex> lock(mtx);
        std::map<std::string, ModuleSummary> out;
        for (auto& r : in_memory) {
            auto& s = out[r.module_id];
            if (r.status == ModuleStatus::PASS) {
                s.pass++;
            } else {
                s.fail++;
                s.fail_by_reason[ToString(r.reason_code)]++;
            }
        }
        return out;
    }

    // Checks internal consistency of the hash chain in a JSONL file
    // written by this class: each line's prev_hash must match the
    // previous line's hash, and each line's own hash must match a
    // recompute of its content. Returns the 1-based line number of the
    // first break, or 0 if the whole file is internally consistent. Static
    // so an auditor can run it standalone against a log file without
    // constructing an AuditLog (which would append to it).
    static size_t VerifyChain(const std::string& path) {
        std::ifstream in(path);
        if (!in.is_open()) throw std::runtime_error("VerifyChain: cannot open " + path);
        std::string line;
        std::string expected_prev = "0000000000000000";
        size_t line_no = 0;
        while (std::getline(in, line)) {
            if (line.empty()) continue;
            line_no++;
            // rfind, not find: prev_hash/hash are always the LAST two
            // fields WriteLine appends, so searching from the end targets
            // them by construction -- doesn't depend on the (currently
            // true, but not worth relying on forever) fact that
            // JsonEscape prevents any field's escaped value from ever
            // producing this exact unescaped byte sequence. Verified by
            // deliberately crafting a module reason containing the raw
            // text of this search pattern and confirming find() was
            // already unfooled (escaping held) -- rfind removes the
            // dependency on that holding rather than fixing an observed
            // break.
            auto prev_pos = line.rfind("\"prev_hash\":\"");
            auto hash_pos = line.rfind("\"hash\":\"");
            if (prev_pos == std::string::npos || hash_pos == std::string::npos || line.front() != '{') {
                return line_no;
            }
            size_t content_end = prev_pos;
            while (content_end > 0 && line[content_end - 1] == ',') content_end--;
            std::string content = line.substr(1, content_end - 1);

            std::string decl_prev = ExtractQuoted(line, prev_pos + 13);
            std::string decl_hash = ExtractQuoted(line, hash_pos + 8);

            if (decl_prev != expected_prev) return line_no;
            if (Fnv1aHex(decl_prev, content) != decl_hash) return line_no;

            expected_prev = decl_hash;
        }
        return 0;
    }

private:
    void WriteLine(const std::string& content_json_body) {
        std::string prev = last_hash_hex_;
        std::string h = Fnv1aHex(prev, content_json_body);
        std::string line = "{" + content_json_body +
                            ",\"prev_hash\":\"" + prev + "\"" +
                            ",\"hash\":\"" + h + "\"}\n";

        // A single write() on a regular file returning fewer bytes than
        // requested is rare but not forbidden by POSIX -- signal
        // interruption (EINTR) is the common case, resource limits are
        // another. Previous version treated any short write as an
        // immediate fatal error with no retry. This loops until the full
        // line is written or a genuine (non-EINTR) error occurs.
        //
        // Note on what this does and doesn't fix: could not reproduce a
        // short-write-driven chain break in this environment across 15
        // TSAN runs with the assertion that would have caught it -- this
        // change is defensively correct per the POSIX spec, not a
        // confirmed fix for an observed failure.
        size_t total_written = 0;
        const char* data = line.data();
        const size_t len = line.size();
        while (total_written < len) {
            ssize_t n = ::write(fd_, data + total_written, len - total_written);
            if (n < 0) {
                if (errno == EINTR) continue;
                // Genuine I/O error partway through a line. Whatever bytes
                // already landed on disk form a torn/partial record.
                // last_hash_hex_ is deliberately NOT advanced below, so
                // the next successful line still declares the prev_hash
                // that SHOULD follow the last fully-written line, not the
                // torn one -- VerifyChain will correctly flag the torn
                // line as the break point rather than silently accepting
                // it or cascading the corruption forward.
                throw std::runtime_error(
                    "AuditLog: write failed after " + std::to_string(total_written) +
                    " of " + std::to_string(len) + " bytes: " + std::strerror(errno));
            }
            total_written += static_cast<size_t>(n);
        }

        if (durable_fsync_) {
            ::fsync(fd_);
        }
        last_hash_hex_ = h;
        if (on_new_hash_) on_new_hash_(h);
    }

    // Reopening the same log path (e.g. across process restarts) must
    // continue the SAME hash chain, not silently start a new one at
    // genesis while appending to a file whose last real link expects
    // something else. Seeds last_hash_hex_ from the existing file's final
    // line before any new line is written.
    //
    // Known limitation, stated not hidden: if the existing file is empty,
    // missing, or was written by something that didn't hash-chain (e.g. a
    // pre-chaining version of this log), this silently starts a fresh
    // chain at genesis rather than erroring. That means VerifyChain()
    // across such a boundary will report a break at the first
    // chain-formatted line, which is the correct signal but requires a
    // human to know why. Reading the whole file into memory to find the
    // last line is also not scalable to very large logs -- fine for this
    // pass, would need a tail-seek for a log expected to grow large.
    void SeedHashFromExistingFile(const std::string& path) {
        std::ifstream in(path);
        if (!in.is_open()) return;
        std::string line, last_line;
        while (std::getline(in, line)) {
            if (!line.empty()) last_line = line;
        }
        if (last_line.empty()) return;
        // rfind, not find: same fix as VerifyChain (Section 2), applied
        // here too -- this method was missed in that pass, creating an
        // asymmetry where the file-verification path was hardened but the
        // continue-writing-on-reopen path wasn't. "hash" is always the
        // LAST field WriteLine appends, so searching from the end targets
        // it by construction rather than depending on escaping correctness.
        auto pos = last_line.rfind("\"hash\":\"");
        if (pos == std::string::npos) return;
        pos += 8;
        auto end = last_line.find('"', pos);
        if (end == std::string::npos) return;
        last_hash_hex_ = last_line.substr(pos, end - pos);
    }
};
