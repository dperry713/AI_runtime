# MEC: Phase 9 — Daemon, IPC, shell  (status: LOCKED 2026-10-19)

## Objective
Deliver the AIR daemon (`aird`), the JSON-RPC 2.0 IPC over Windows named pipe, the typed client SDK, and the `air` shell CLI/REPL, so operators can start a daemon, chat with an agent, approve actions, view logs, and replay runs end to end.

## Non-goals
- Linux/macOS support (Windows-first per PROJECT.md §2)
- Web UI, multi-machine clustering, public multi-tenant service
- GUI automation (out of scope for v1 per PROJECT.md §6)
- Windows Service packaging (P12-T01), Node SEA installer (P12-T02)

## Requirements

- **R-001 (IPC spec)** | `docs/specs/ipc.md` written: JSON-RPC 2.0 over NDJSON framing on Windows named pipe `\\.\pipe\air-<username>`, user-SID ACL, max frame 4 MiB, protocol version handshake, method list, server→client notifications. | Acceptance: file exists; reviewed against ARCHITECTURE.md §9.
- **R-002 (IPC implementation)** | `src/ipc/` module: `IpcServer`, `IpcClient`, protocol Zod schemas, method registry, NDJSON frame reader/writer with 4 MiB cap, named-pipe server/client with ACL, version mismatch refusal. Layer 7 per ARCHITECTURE §3 (may import layers 0–6 only through index.ts). | Acceptance: `npm run deps:check` 0 violations; typecheck clean; unit tests pass.
- **R-003 (Daemon host)** | `src/service/`: `aird` entrypoint `main()`, boot sequence (journal recovery, config load, policy load), IPC server bind, graceful shutdown, pidfile/lock, single-instance guard, health endpoint. | Acceptance: `aird` starts on a temp pipe, responds to `daemon.health`, shuts down gracefully on SIGINT/SIGTERM.
- **R-004 (Client SDK)** | Typed IPC client with reconnect, subscriptions, request timeouts, method wrappers for all R-002 methods. | Acceptance: client connects to real `aird`, round-trips a request, handles server-initiated `event` notification.
- **R-005 (Shell REPL)** | `src/shell/`: `air` entrypoint, `chat`/`run`/`ps`/`logs`/`replay`/`config`/`policy`/`audit verify`/`doctor`/`kill`/`pause`/`resume`/`approve`/`agents` commands, slash commands, approval prompts, history, `--json` output modes, documented exit codes. | Acceptance: `air chat` with mock provider completes a turn; `air --json` emits parseable JSON; exit codes match docs.
- **R-006 (Security)** | Named pipe ACL grants only current user SID; oversized frames (>4 MiB) rejected; malformed JSON rejected; protocol version mismatch refused; no secrets in logs/errors. | Acceptance: security tests pass; different-user connection refused (E2E).
- **R-007 (Observability)** | All IPC/daemon/shell actions logged via `src/observability` with correlation IDs; audit events journaled (Rule R8); metrics emitted. | Acceptance: log capture shows correlation IDs; no `console.log` in src (Rule R1).
- **R-008 (Tests)** | Unit + integration + E2E tests for IPC, daemon, shell; E2E spawns real `aird` on unique temp pipe: concurrent clients, client crash, daemon crash+restart with in-flight run recovery, oversized frame, malformed JSON, wrong-user ACL. | Acceptance: `npm test` green; `npm run test:e2e` green; coverage thresholds not reduced.

## Phases

- **P9-T01 IPC protocol spec + implementation** (covers R-001, R-002, R-006, R-007, R-008) | Exit gate: `docs/specs/ipc.md` written; `src/ipc/` implemented; `npm run check` green; IPC unit tests pass.
- **P9-T02 Daemon host (`aird`)** (covers R-003, R-006, R-007) | Exit gate: `aird` starts/health/shuts down on temp pipe; boot + recovery exercised.
- **P9-T03 Client SDK** (covers R-004, R-006, R-007) | Exit gate: typed client round-trips against real `aird`; reconnect + subscription tested.
- **P9-T04 Shell REPL (`air`)** (covers R-005, R-006, R-007, R-008) | Exit gate: `air chat` completes a turn with mock provider; `--json` mode validated.
- **P9-T05 Command set** (covers R-005) | Exit gate: all P9-T05 commands implemented and tested.
- **P9-T06 Optional TUI** (covers R-005) | Exit gate: ink-based dashboard (optional; may be deferred).
- **P9-T07 Output modes + exit codes** (covers R-005) | Exit gate: `--json` for every command; exit codes documented.

## Verification commands
- `npm run typecheck` — tsc --noEmit clean
- `npm run lint` — eslint clean, no console.log in src
- `npm run deps:check` — dependency-cruiser 0 violations (layer 7 → layers 0–6 via index.ts only)
- `npm test` — unit + integration green
- `npm run test:e2e` — real `aird` on temp pipe E2E green
- `npm run test:coverage` — thresholds not reduced

## Definition of done
All R-IDs met with evidence in `docs/PROGRESS.md`; no open stub blocks any R-ID; `npm run check` green on Windows; `BUILD_STATUS.md` updated with phase status and evidence.
