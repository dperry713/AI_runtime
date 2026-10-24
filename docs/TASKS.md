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
