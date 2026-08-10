# Module 6 — Harness / Evidence Layer

**Status: fourth-pass baseline. Sections 1–5 of a 6-section fix plan complete and verified. Section 6 deliberately not fixed (policy/design questions outside this Project's authority).**

## Build & run

```
g++ -std=c++20 -Wall -Wextra main_test.cpp -o main_test -pthread
./main_test

g++ -std=c++20 -fsanitize=thread -g main_test.cpp -o main_test_tsan -pthread
./main_test_tsan
```

52/52 tests passed (including ThreadSanitizer clean run).

## What was verified

Hash-chained audit log, durable fsync option, on_new_hash callback, concurrent writers under TSAN, and the evidence layer's ability to surface when the harness itself is unwell. Full details of the four-pass fix plan and the remaining design-policy open items are in the module source and the top-level README.

See top-level README for how this fits into the six modules.
