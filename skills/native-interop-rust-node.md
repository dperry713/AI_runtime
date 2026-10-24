# Native Interop: Rust ↔ Node.js

## Mission

Debug the trust boundary between Node.js and the native Windows sandbox helper (for example, air-sandbox.exe). Establish whether the fault is in the TypeScript caller, protocol contract, Rust implementation, toolchain/linking, or process environment.

## Choose and verify the boundary

- Identify whether integration uses a child-process protocol or an in-process Node-API addon; do not mix assumptions from both models.
- For child processes, treat stdin/stdout as a framed protocol. Reserve stdout for protocol messages and send diagnostics to stderr.
- For Node-API, verify ABI/runtime compatibility, thread affinity, async-work lifecycle, and finalizer/resource ownership.
- Document request/response versions, maximum frame size, encoding, required fields, error codes, and compatibility policy.

## Structured protocol debugging

1. Capture a sanitized request, response, stderr, exit code, and timing for one correlation ID.
2. Validate framing independently from JSON/schema validation.
3. Test empty input, malformed JSON, missing fields, unknown versions, oversized messages, truncated input, extra output, and abrupt EOF.
4. Ensure one malformed request cannot desynchronize the next request or corrupt daemon state.
5. Bound reads/writes and process startup; propagate cancellation to the helper and wait for termination.
6. Treat helper output as untrusted even though it is a project-owned component.
7. Keep secrets and sensitive filesystem paths out of fixtures and captured logs.

## Rust and Windows toolchain

- Record rustc -Vv, cargo -V, target triple, MSVC toolchain version, Windows SDK, linker, and environment.
- Run cargo check and focused tests before a full release build; then build the exact target/configuration used by CI.
- For MSVC link errors, verify Visual Studio C++ build tools, Windows SDK, target architecture, and library search paths.
- Distinguish compilation failures from linker failures, runtime loader failures, missing DLLs, and ABI mismatches.
- Do not solve a clean-machine build issue by hardcoding a developer-specific absolute path.
- Keep dependency versions and lockfile behavior reproducible; test from a clean checkout or clean CI runner.

## Crash and hang diagnosis

- Reproduce with the smallest request and preserve helper binary, symbols/PDBs, build configuration, and crash timestamp.
- Use Windows Error Reporting dumps or an approved local dump workflow; inspect with WinDbg when available.
- Start with exception code, faulting module, native stack, loaded modules, and matching symbols.
- For hangs, collect process state and thread stacks before terminating the helper.
- Compare debug/release builds only as a diagnostic, not as proof release behavior is correct.
- Confirm the parent translates native failures into bounded, typed errors and always releases handles/temp files.

## Security invariants

- Validate all native requests at the boundary; TypeScript types are not runtime validation.
- Enforce least privilege in the helper and avoid adding a broad privileged command to fix a narrow failure.
- Check the helper cannot be redirected to arbitrary executables, paths, or protocol endpoints by untrusted input.
- Treat unexpected stdout, nonzero exit, timeout, and malformed responses as explicit failures; never silently continue without sandbox guarantees.

## Practice targets

- Diagnose a protocol framing bug using captured sanitized frames.
- Reproduce truncated output and prove the next request remains correctly framed or the helper is restarted safely.
- Fix a clean Windows MSVC/linker failure without machine-specific paths.
- Produce and symbolicate a native crash dump, then add a regression test at the highest reliable layer.

## Definition of done

- Protocol and failure semantics are documented and covered by tests.
- Clean Windows CI builds the helper reproducibly.
- Cancellation, timeout, malformed output, and crash paths release resources.
- Security-critical failure modes fail closed and remain observable.
