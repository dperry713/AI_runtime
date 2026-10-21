# PROGRESS.md — AIR build evidence log

## P9-T02: Daemon host (`aird`) (DONE 2026-10-20)

**Requirements covered:** R-003, R-006, R-007

**Files created:**
- `src/service/daemon.ts` — `Daemon` class: boot sequence (config load → logging init → journal recovery → IPC bind), single-instance pidfile/lock guard, graceful shutdown, `daemon.health` status, signal handlers
- `src/service/main.ts` — `aird` process entrypoint (`Daemon.main()`)
- `src/service/index.ts` — Public API re-exports
- `tests/unit/service/daemon.test.ts` — 14 unit tests (initial state, boot, status, shutdown, signal handlers)
- `tests/integration/service/daemon.integration.test.ts` — 3 integration tests (real named pipe boot → health → shutdown, unknown method rejection, client count tracking)

**Commands run:**
- `npm run typecheck` — PASS
- `npm run lint` — PASS
- `npm run deps:check` — PASS (0 violations, 138 modules / 575 dependencies)
- `npm test` — PASS (80 test files, 1466 tests passed, 3 skipped)

**Result:** All P9-T02 exit gate criteria met. `aird` starts on a temp pipe, responds to `daemon.health`, and shuts down gracefully.

---

## P9-T01: IPC protocol spec + implementation (DONE 2026-10-19)

**Requirements covered:** R-001, R-002, R-006, R-007, R-008

**Files created:**
- `docs/specs/ipc.md` — IPC protocol specification (JSON-RPC 2.0 over NDJSON named pipe)
- `src/ipc/protocol.ts` — JSON-RPC 2.0 schemas, types, error codes, response builders
- `src/ipc/framing.ts` — NDJSON frame reader/writer with 4 MiB max frame size
- `src/ipc/pipe.ts` — Windows named pipe server/client with user-scoped pipe names
- `src/ipc/registry.ts` — MethodRegistry for JSON-RPC method/notification dispatch
- `src/ipc/server.ts` — IpcServer with built-in daemon.health/daemon.shutdown, event broadcasting
- `src/ipc/client.ts` — IpcClient with typed request/response, timeouts, notifications, reconnect
- `src/ipc/index.ts` — Public API re-exports
- `tests/unit/ipc/protocol.test.ts` — 30 unit tests
- `tests/unit/ipc/framing.test.ts` — 21 unit tests
- `tests/unit/ipc/registry.test.ts` — 17 unit tests
- `tests/unit/ipc/server.test.ts` — 8 unit tests
- `tests/unit/ipc/client.test.ts` — 11 unit tests
- `tests/integration/ipc/ipc-e2e.test.ts` — 6 E2E tests (real named pipe round-trip)

**Commands run:**
- `npm run typecheck` — PASS
- `npm run lint` — PASS
- `npm run deps:check` — PASS (0 violations, 136 modules / 564 dependencies)
- `npm test` — PASS (78 test files, 1449 tests passed, 3 skipped)

**Result:** All P9-T01 exit gate criteria met. IPC module is fully implemented and tested.
