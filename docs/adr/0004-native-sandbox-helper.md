# ADR-0004: Native Rust helper (`air-sandbox.exe`) for Windows process isolation

- Status: accepted (implementation in P7-T02; AppContainer evaluated in P7-T06)
- Date: 2026-10-15

## Context
Node.js has no API for Windows Job Objects, restricted tokens, or kill-on-close semantics. `child_process` alone
cannot reliably kill process trees, cap memory/CPU/process count, or survive parent crashes without orphans.

## Decision
Ship a small native helper written in Rust (`native/air-sandbox`) that: creates a Job Object
(`KILL_ON_JOB_CLOSE`, active-process limit, memory limit, CPU rate), optionally launches the target with a
restricted token, enforces a working-directory jail and scrubbed environment, and reports exit status and
resource peaks over a versioned JSON protocol on stdin/stdout. `sandbox.ProcessRunner` is the only code that spawns processes
and always goes through the helper (a naive runner exists only as a test double in P4).

## Consequences
+ Real containment and no orphan processes even if `aird` crashes.
− Adds a Rust toolchain to the build and a signed binary to the release (hash-checked at spawn).
− Helper protocol must be versioned and fuzzed.

## Alternatives considered
- npm native addon via node-gyp (C++): heavier toolchain, ABI churn.
- PowerShell/P-Invoke: slower, harder to harden, easy to misuse.
- Windows Sandbox / containers: far too heavy for per-command isolation.
- `taskkill /T` only: race-prone, no resource limits.
