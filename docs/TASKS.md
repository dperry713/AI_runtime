# TASKS.md — AIR task tracker

## Phase 9 — Daemon, IPC, shell

| ID | Task | Status | Notes / evidence |
|---|---|---|---|
| P9-T01 | IPC protocol spec + implementation | DONE | docs/specs/ipc.md + src/ipc/; 93 unit + integration tests; npm run check PASS |
| P9-T02 | Daemon host (aird) | DONE | src/service/daemon.ts (Daemon class: boot, recovery, IPC bind, shutdown, pidfile/lock), src/service/main.ts (entrypoint), src/service/index.ts (public API). 14 unit + 3 integration tests. npm run check PASS 2026-10-20. |
| P9-T03 | Client SDK | TODO | (IpcClient implemented in P9-T01, needs daemon integration) |
| P9-T04 | Shell REPL (air) | TODO | |
| P9-T05 | Command set | TODO | |
| P9-T06 | Optional TUI | TODO | |
| P9-T07 | Output modes + exit codes | TODO | |

## Phase 10 — Extensibility

| ID | Task | Status | Notes |
|---|---|---|---|
| P10-T01 | MCP client | TODO | |
| P10-T02 | Plugin/skills loader | TODO | |
| P10-T03 | Hooks | TODO | |
| P10-T04 | Fake MCP server for tests | TODO | |

## Phase 11 — Multi-agent & scheduling

| ID | Task | Status | Notes |
|---|---|---|---|
| P11-T01 | Supervisor | TODO | |
| P11-T02 | Agent messaging | TODO | |
| P11-T03 | Scheduler | TODO | |
| P11-T04 | Concurrency & fairness | TODO | |
| P11-T05 | Orchestration tools | TODO | |

## Phase 12 — Hardening, packaging, release

| ID | Task | Status | Notes |
|---|---|---|---|
| P12-T01 | Windows Service | TODO | |
| P12-T02 | Packaging & installer | TODO | |
| P12-T03 | Upgrade & migration | TODO | |
| P12-T04 | Soak & performance | TODO | |
| P12-T05 | Security review | TODO | |
| P12-T06 | Docs & runbooks | TODO | |
| P12-T07 | v1.0 release checklist | TODO | |
