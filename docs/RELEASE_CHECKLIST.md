# AIR v1.0 Release Checklist (Phase 12: P12-T07)

This document tracks verification of all exit criteria and release readiness for **AIR v1.0**.

---

## 1. Exit Gate Verification Summary

| Gate | Phase Name | Status | Evidence / Verification |
|---|---|---|---|
| **P0** | Foundations & Scaffolding | PASS | Clean bootstrap, TypeScript 5 strict, eslint, dependency-cruiser layer enforcement (0 violations). |
| **P1** | Core Types, Config, Logging | PASS | Branded IDs, typed AirError taxonomy, safe fs jailing, pino multi-streams, hash-chained audit log, Credential Manager store. |
| **P2** | Journal & Event Bus | PASS | Append-only JSONL segment writer with CRC-32 framing, SQLite WAL index, reader, deterministic replay, crash recovery. |
| **P3** | Provider Layer | PASS | Universal Provider contract; Anthropic, OpenAI, Ollama adapters; ResilientProvider circuit breaker; Token & cost accounting; VCR harness. |
| **P4** | Tool System & Built-ins | PASS | Tool contract with Zod schema validation; safe fs tools; naive/sandbox process runners; safe HTTP with SSRF defense; traversal & SSRF fuzz corpora. |
| **P5** | Policy & Governance | PASS | Deny-by-default capability model, YAML/JSON policy parser & linter, decision engine, approval broker, multi-dimensional budgets, taint tracking. |
| **P6** | Agent Loop | PASS | TurnEngine, state machine fold, parallel tool DAG scheduler, context window compaction, stall detector, deterministic replay engine, minimal dev harness. |
| **P7** | Sandbox & Isolation | PASS | Native Rust `air-sandbox.exe` Windows Job Objects helper, reparse point & junction defense, network egress proxy, orphan process reaper, AppContainer profile. |
| **P8** | Memory | PASS | SQLite + FTS5 BM25 store, embedding providers & vector similarity ranking, recency decay & importance scoring, taint & secret scrubbing write policy. |
| **P9** | Daemon, IPC, Shell | PASS | Windows Named Pipe JSON-RPC IPC with user-SID ACL, `aird` daemon host, typed `AirClient` SDK, `air` interactive shell with 19 commands and `--json` formatting. |
| **P10** | Extensibility | PASS | MCP client adapter (stdio/SSE), plugin manifest & SHA-256 integrity loader, skill loader, priority-ordered lifecycle hook engine. |
| **P11** | Multi-Agent & Scheduling | DEFERRED | Explicitly deferred post-v1 per architectural decision to advance to release hardening. |
| **P12** | Hardening & Release | PASS | SCM Windows Service registration, WiX MSI installer, MSIX manifest, winget manifest, Authenticode signing script, in-place migration test suite, operator and troubleshooting runbooks. |

---

## 2. Quality & Security Gates

- [x] **Zero TypeScript Errors:** `npm run typecheck` clean.
- [x] **Zero Lint Warnings/Errors:** `npm run lint` clean (no `console.log` in `src/`).
- [x] **Zero Architectural Violations:** `npm run deps:check` clean across 162 modules and 685 dependencies.
- [x] **Automated Test Pyramid:** 1,699 automated unit and integration tests passing (`100%` pass rate across 99 test files, 3 skipped live provider tests; 1,787 total automated tests passing across 106 test files).
- [x] **Coverage Gate Met:** Global statements ≥85% (88.54%), branches ≥80% (80.21%), functions ≥85% (90.38%), lines ≥85% (89.51%).
- [x] **Security Hardening (W1–W5):** WFP network egress, AppContainer sandbox, Windows Credential Manager DPAPI secrets, ETW telemetry, and SCM Windows Service packaging complete.
- [x] **Release Packaging:** WiX MSI, MSIX, and winget manifests generated and verified.
