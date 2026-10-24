# TASKS.md — AIR task tracker

## Phase 9 — Daemon, IPC, shell

| ID | Task | Status | Notes / evidence |
|---|---|---|---|
| P9-T01 | IPC protocol spec + implementation | DONE | docs/specs/ipc.md + src/ipc/; 93 unit + integration tests; npm run check PASS |
| P9-T02 | Daemon host (aird) | DONE | src/service/daemon.ts (Daemon class: boot, recovery, IPC bind, shutdown, pidfile/lock), src/service/main.ts (entrypoint), src/service/index.ts (public API). 14 unit + 3 integration tests. npm run check PASS 2026-10-20. |
| P9-T03 | Client SDK | DONE | src/client/air-client.ts (AirClient with typed requests, session lifecycle, runs, events, health, ping). 14 unit + 6 integration tests PASS. |
| P9-T04 | Shell REPL (air) | DONE | src/shell/repl.ts (AirRepl: interactive prompt, command parsing, tab completion, history). 4 integration tests PASS. |
| P9-T05 | Command set | DONE | src/shell/commands.ts (run, session, memory, policy, ps, kill, health, config, explain). 13 unit tests PASS. |
| P9-T06 | Optional TUI | DEFERRED | CLI-first approach confirmed in DECISIONS.md; simple terminal formatting prioritized. |
| P9-T07 | Output modes + exit codes | DONE | src/shell/output.ts, src/shell/exit-codes.ts (table, json, plain, streaming text; standardized POSIX exit codes). 8 unit tests PASS. |

## Phase 10 — Extensibility

| ID | Task | Status | Notes |
|---|---|---|---|
| P10-T01 | MCP client | DONE | src/tools/builtin/mcp.ts (Model Context Protocol client adapter over stdio/SSE, tool registration, schema translation). 10 unit tests PASS. |
| P10-T02 | Plugin/skills loader | DONE | src/plugins/ (PluginLoader, manifest schema, SHA-256 integrity, policy gating), src/skills/ (SkillLoader, SKILL.md parser, artifact verification). 26 unit tests PASS. |
| P10-T03 | Hooks | DONE | src/hooks/ (HookRegistry, HookRunner, pre/post-tool, pre/post-model, on-event, session/run lifecycle hooks, timeout bounds, fail-open/fail-closed modes, policy non-weakening assertion). 22 unit tests PASS. |
| P10-T04 | Fake MCP server for tests | DONE | tests/unit/tools/builtin-mcp.test.ts (in-memory mock MCP server with notifications and tool call responses) |

## Phase 11 — Multi-agent & scheduling

| ID | Task | Status | Notes |
|---|---|---|---|
| P11-T01 | Supervisor | DEFERRED | Deferred post-v1 per user directive to advance directly to Phase 12 |
| P11-T02 | Agent messaging | DEFERRED | Deferred post-v1 per user directive |
| P11-T03 | Scheduler | DEFERRED | Deferred post-v1 per user directive |
| P11-T04 | Concurrency & fairness | DEFERRED | Deferred post-v1 per user directive |
| P11-T05 | Orchestration tools | DEFERRED | Deferred post-v1 per user directive |

## Phase 12 — Hardening, packaging, release

| ID | Task | Status | Notes |
|---|---|---|---|
| P12-T01 | Windows Service | DONE | src/sandbox/windows-service.ts (WindowsService, SCM registration, recovery actions, writeWindowsEventLog, install/uninstall scripts). 20 unit tests PASS. |
| P12-T02 | Packaging & installer | DONE | packaging/msi/ (WiX MSI), packaging/msix/ (MSIX manifest), packaging/winget/ (winget manifest), scripts/sign-air.ps1 (Authenticode). |
| P12-T03 | Upgrade & migration | DONE | tests/unit/service/upgrade-migration.test.ts: config migrations, SQLite migrations, event upcasters across versions. 5 unit tests PASS. |
| P12-T04 | Soak & performance | DONE | scripts/benchmark.ps1, tests/integration/real-world-task-simulation.test.ts, promotion-gate.test.ts. |
| P12-T05 | Security review | DONE | Verified W1–W5 Windows Security Hardening requirements (WFP, AppContainer, DPAPI, ETW, MSI/MSIX). |
| P12-T06 | Docs & runbooks | DONE | docs/runbooks/OPERATOR_GUIDE.md, docs/runbooks/TROUBLESHOOTING.md, docs/runbooks/INCIDENT_RESPONSE.md. |
| P12-T07 | v1.0 release checklist | DONE | docs/RELEASE_CHECKLIST.md verifying all quality, security, and architecture exit gates. |
