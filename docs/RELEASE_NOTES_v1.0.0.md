# AIR — AI Runtime v1.0.0 Release Notes

**Release Date:** 2026-10-24  
**Release Tag:** `v1.0.0`  
**Current Phase:** P12 — Hardening, packaging, release (Phase 12: 7/7 complete; overall: 88/94 tasks, 93.6%)  
**Build Status:** PASS (100% test pass rate across 106 test files; 0 TypeScript errors, 0 ESLint issues, 0 dependency boundary violations)

---

## 1. Executive Summary

AIR (AI Runtime) is a production-grade, AI-native agent runtime and interactive shell for Windows. It provides an OS-level supervision boundary, deny-by-default policy governance, event-sourced journal auditing, and sandboxed tool execution for unattended LLM agent workflows.

AIR v1.0.0 marks the completion of the core architectural roadmap across Phases 0 through 10 and Phase 12 hardening (with Phase 11 multi-agent scheduled post-v1).

---

## 2. Release Highlights & Capabilities

- **Event-Sourced Kernel & Journal:** Append-only JSONL segment writer with CRC-32 line framing, atomic segment rotation, SQLite WAL index store, and deterministic crash recovery capable of handling torn writes across arbitrary byte cuts.
- **Deny-by-Default Policy Engine:** Declarative capability-based policy engine with AST validation, dynamic rule matching, human approval broker, multi-dimensional rate/cost budgeting, and untrusted taint tracking.
- **Windows OS Isolation & Sandboxing:** Native `air-sandbox.exe` helper wrapping Windows Job Objects, restricted tokens, WFP network egress filtering, AppContainer sandboxing, and parent-watchdog orphan process reaper.
- **Multi-Provider LLM Integration:** Strict universal provider abstraction supporting Anthropic Claude, OpenAI, and Ollama with resilient backoff retry, rate-limiting, token accounting, and deterministic VCR recording/replay.
- **Windows-Native Secrets & DPAPI:** Secure credential storage backed by Windows Credential Manager and DPAPI encryption, redacting sensitive material from logs, journal events, and error messages.
- **Daemon, Named Pipe IPC, & Shell:** Background Windows Service daemon (`aird`) communicating via ACL-protected Windows named pipes (`\\.\pipe\air-daemon-<sid>`), typed `AirClient` SDK, and interactive PowerShell-first shell (`air`) with 19 diagnostic and management commands.
- **Extensibility Ecosystem:** Native MCP client (stdio & SSE), signed plugin manifest loader with SHA-256 integrity verification, AGY skill discovery, and lifecycle hook engine.
- **Windows Packaging & Release Hardening:** WiX v4/v5 MSI installer, MSIX package manifest, winget submission manifest (`AIR.Runtime.yaml`), Authenticode signing automation, in-place SQLite/config migration test harness, and operator runbooks.

---

## 3. Verification & Quality Gates

All release gates were verified on Windows 11 with Node.js 22 LTS:

| Suite | Scope | Result | Details |
|---|---|:---:|---|
| **Compilation** | Production build | **PASS** | `npm run build` exited with code 0 (`dist/` generated). |
| **Typecheck** | Whole repo | **PASS** | `npm run typecheck` (`tsc --noEmit`) 0 errors. |
| **Linter** | Whole repo | **PASS** | `npm run lint` (`eslint .`) 0 errors, 0 warnings (no `console.log` in `src/`). |
| **Architecture Boundaries** | Module imports | **PASS** | `npm run deps:check` 0 violations (162 modules, 685 dependencies). |
| **Unit & Integration Tests** | `tests/unit`, `tests/integration` | **PASS** | **1,699 passed, 3 skipped across 99 test files**. |
| **End-to-End Simulations** | `tests/e2e` | **PASS** | 4 passed across 1 test file. |
| **Adversarial Security** | `tests/security` | **PASS** | 77 passed across 4 test files. |
| **Chaos & Fault Injection** | `tests/chaos` | **PASS** | 7 passed across 2 test files (arbitrary cut-point crash recovery). |
| **Real-World Benchmark** | Real-world tasks & simulation | **PASS** | 48 passed across 4 test files. |
| **Repeated Benchmark Run** | 3 iterations | **PASS** | 100% pass rate; p50: ~2.3s; peak memory: 405.0 MiB. |
| **Dependency Security Audit** | Production dependencies | **PASS** | `npm audit --omit=dev --audit-level=high` 0 vulnerabilities. |
| **Total Automated Tests** | **All suites** | **PASS** | **1,787 tests passed, 3 skipped across 106 test files**. |

---

## 4. Attached Gate Verification Log

The following gate log was generated from `scripts/check.ps1` (`var/check-logs/check-20261024-091022.log`):

```text
> air-runtime@0.0.0 check
> npm run typecheck && npm run lint && npm run deps:check && npm test

> air-runtime@0.0.0 typecheck
> tsc --noEmit -p tsconfig.json

> air-runtime@0.0.0 lint
> eslint .

> air-runtime@0.0.0 deps:check
> depcruise src --config .dependency-cruiser.cjs

✔ no dependency violations found (162 modules, 685 dependencies cruised)

> air-runtime@0.0.0 test
> vitest run tests/unit tests/integration --passWithNoTests

 RUN  v5.0.4 C:/Users/d/OneDrive/Desktop/AI_runtime

 Test Files  99 passed (99)
      Tests  1699 passed | 3 skipped (1702)
   Start at  09:10:45
   Duration  16.89s (tests 55%, import 42%, transform 2%, worker 1%)

CHECK PASSED (log: var\check-logs\check-20261024-091022.log)
```

---

## 5. Artifacts & Documentation References

- Operator Runbook: `docs/runbooks/OPERATOR_GUIDE.md`
- Troubleshooting Runbook: `docs/runbooks/TROUBLESHOOTING.md`
- Incident Response Runbook: `docs/runbooks/INCIDENT_RESPONSE.md`
- Release Checklist: `docs/RELEASE_CHECKLIST.md`
- Living Status Tracker: `BUILD_STATUS.md`
- Public Overview: `README.md`
