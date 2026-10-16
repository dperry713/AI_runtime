---
project: AI_runtime
codename: AIR
status_schema: 1
last_updated: 2026-10-16
current_phase: P2
current_phase_name: Journal & event bus
overall_tasks_total: 94
overall_tasks_done: 19
overall_progress_pct: 20
repo_path: C:\Users\d\OneDrive\Desktop\AI_runtime
runtime_home_default: "%LOCALAPPDATA%\\AIR"
last_check_result: PASS (2026-10-16)   # update to PASS/FAIL with date after each `npm run check`
---

# BUILD_STATUS.md — live build tracker

> **Every agent: read this first, update it last.** Protocol is in `AGENTS.md` §3.
> Status values: `TODO` · `IN_PROGRESS` · `BLOCKED` · `DONE` · `DEFERRED`
> Only mark `DONE` when tests pass and exit criteria in `docs/BUILD_PLAN.md` are met. Record evidence.

## 1. Snapshot

| Item | Value |
|---|---|
| Current phase | **P2 — Journal & event bus** |
| Phase progress | Phase 2: 1 / 7 tasks done |
| Overall | 19 / 94 tasks done (Phase 0 complete + Phase 1 complete + P2-T01 + planner protocol) |
| Last `npm run check` | PASS (2026-10-16) — typecheck, lint, deps:check, 247 unit tests green |
| Coverage gate | PASS (2026-10-16) — 93.09% stmts, 80.68% branches, 97.36% funcs, 93.72% lines; `src/journal/**` 100% lines, 95.45% branches; `util/paths` 98.71% stmts, 92.53% branches |
| Known blockers | None |

## 2. NEXT UP (ordered — take the first unblocked item)

1. **P2-T02** — JSONL segment writer: `<crc32> <json>\n`, single serialized queue per stream, fsync policy (`always|batch|never` config), segment rotation, atomic segment sealing (`src/journal/segment-writer.ts`).
2. **P2-T03** — SQLite index + migrations: better-sqlite3, WAL, `PRAGMA synchronous=NORMAL/FULL` per config (`src/journal/index-store.ts`).
3. **P2-T04** — Typed event bus: in-process pub/sub, per-subscriber bounded queues with backpressure/drop policy and metrics (`src/journal/event-bus.ts`).

## 3. Blockers / human actions required

| # | Blocker | Owner | Since |
|---|---|---|---|

## 4. Task tracker

### Phase 0 — Foundations & scaffolding
| ID | Task | Status | Notes / evidence |
|---|---|---|---|
| P0-T01 | Documentation set | DONE | AGENTS, PROJECT, ARCHITECTURE, BUILD_PLAN, BUILD_STATUS, TESTING, LOGGING, SECURITY, MODULES, DIRECTORY, ADR-0001..0004 written 2026-10-15 |
| P0-T02 | Scaffolding files | DONE | package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, eslint.config.js, .prettierrc.json, .gitignore, .editorconfig, .gitattributes, config/air.config.example.json, src/index.ts + tests/unit/smoke.test.ts (skeleton so typecheck/test have inputs), CLAUDE.md. **Written but never executed**: dependency versions are resolved at first `npm install`; configs may need small fixes at P0-T06 |
| P0-T03 | Directory tree created | DONE | See `docs/DIRECTORY.md`; empty dirs have no files yet (git ignores empty dirs; first real file lands in each during its phase) |
| P0-T04 | PowerShell scripts | DONE | scripts/bootstrap.ps1, check.ps1, doctor.ps1, test.ps1 — **not yet executed** |
| P0-T05 | CI workflow | DONE | .github/workflows/ci.yml — **not yet executed** (no git remote yet) |
| P0-T06 | Run bootstrap; `npm run check` green on skeleton | DONE | `npm run check` PASS 2026-10-15 (typecheck, lint, deps:check, 1 test) |
| P0-T07 | dependency-cruiser layer rules + violation fixture test | DONE | `.dependency-cruiser.cjs` written and verified; violation-fixture tests pass (5 tests covering layer rules, index-only, child_process, fs restrictions). `npm run deps:check` green. |
| P0-T08 | Repo location vs OneDrive decision | DONE | Decision: keep repo at `C:\Users\d\OneDrive\Desktop\AI_runtime` (human confirmed 2026-10-15). Risk accepted: OneDrive sync may cause SQLite locking/corruption; mitigation is to ensure runtime data lives in `%LOCALAPPDATA%\AIR` per ADR-0003 and exclude `node_modules`/`var` from OneDrive sync. |

### Phase 1 — Core types, errors, config, logging
| ID | Task | Status | Notes |
|---|---|---|---|
| P1-T01 | Branded IDs & core types | DONE | `src/types/ids.ts` + `src/types/schemas.ts`: `RunId, AgentId, SessionId, TurnId, ToolCallId, EventId` (ULID-backed), constructors, parse functions, zod schemas. 20 unit tests pass. |
| P1-T02 | Error taxonomy | DONE | `src/errors/AirError.ts`: `AirError`, error codes, `isRetryable`, `toModelSafeMessage`, serialization. Fixed override & exactOptionalPropertyTypes compliance. 32 unit tests pass. |
| P1-T03 | Determinism abstractions (Clock/Random/Id/backoff) | DONE | `src/util`: `Clock` (SystemClock, FakeClock), `Random` (SystemRandom, SeededRandom), `IdGenerator` (UlidIdGenerator, FakeIdGenerator), `sleep(abortable)`, `backoff` (full jitter). 32 unit tests pass. |
| P1-T04 | Windows path library + fs-safe | DONE | `src/util/paths.ts` + `src/util/fs-safe.ts`: canonicalization, `isInside`, `assertInside` with realpath/junction handling, DOS device/ADS/UNC defenses, atomic writes, EBUSY retries. Fixed destructive test in `depcruise-violation.test.ts`. 29 unit tests pass. |
| P1-T05 | Config system | DONE | `src/config`: Zod schema (`AirConfigSchema`), `AIR_HOME` resolution (`%LOCALAPPDATA%\AIR`), versioned migrator (`migrateConfig`), provenance-aware `explainConfig`, layered loader (`loadConfig`). 20 unit tests pass. |
| P1-T06 | Logger (pino, streams, rotation, correlation, redaction) | DONE | `src/observability`: JSONL multi-streams (runtime, audit, llm, tools), `AsyncLocalStorage` correlation context, redaction engine (exact, base64, URL, JSON, regex), file rotation with audit preservation, 14 unit tests pass. |
| P1-T07 | Audit hash chain | DONE | `src/observability/audit.ts`: append-only hash chain (`sha256(prev || canonical-json)`), `AuditLog`, `verifyAuditChain`, `canonicalJson`, tamper detection tests. 14 unit tests pass. |
| P1-T08 | Metrics | DONE | `src/observability/metrics.ts`: counters, gauges, histograms, snapshot API, rotating `metrics.jsonl` persistence, standard catalogue. 12 unit tests pass. |
| P1-T09 | Secrets (Credential Manager + redaction registry) | DONE | `src/secrets`: `SecretStore`, `MemorySecretStore`, `CredentialManagerStore` (AES-256-GCM encrypted vault routing through safe fs jail), `redactor` facade integrated with logger. 6 unit tests pass. |
| P1-T10 | Coverage gate | DONE | `vitest.config.ts`: global thresholds (lines ≥ 85%, functions ≥ 85%, branches ≥ 80%, statements ≥ 85%) and critical module threshold (`src/util/paths.ts` lines ≥ 95%, branches ≥ 90%, funcs ≥ 95%, stmts ≥ 95%). `npm run test:coverage` PASS: 92.74% stmts, 80.26% branches, 97.23% funcs, 93.4% lines. Exit Gate P1 fully satisfied. |

### Phase 2 — Journal & event bus
| ID | Task | Status | Notes |
|---|---|---|---|
| P2-T01 | Event envelope & registry | DONE | `src/journal/envelope.ts`, `src/journal/registry.ts`, `docs/specs/events.md`: Zod discriminated union (`AirEventEnvelopeSchema`), 34 lifecycle event schemas across run, turn, model, tool, memory, system categories. Additive versioning rules documented. Injected determinism (Clock + IdGenerator). 10 unit tests pass (100% coverage). |
| P2-T02 | JSONL segment writer | TODO | |
| P2-T03 | SQLite index + migrations | TODO | |
| P2-T04 | Typed event bus | TODO | |
| P2-T05 | Reader & replay engine | TODO | |
| P2-T06 | Crash recovery | TODO | |
| P2-T07 | Upcasters framework | TODO | |

### Phase 3 — Provider layer
| ID | Task | Status | Notes |
|---|---|---|---|
| P3-T01 | Provider interface & normalized types | TODO | |
| P3-T02 | Mock/scripted provider | TODO | |
| P3-T03 | Anthropic adapter | TODO | |
| P3-T04 | OpenAI-compatible adapter | TODO | |
| P3-T05 | Ollama adapter | TODO | |
| P3-T06 | Resilience wrapper | TODO | |
| P3-T07 | Token & cost accounting | TODO | |
| P3-T08 | Record/replay harness | TODO | |
| P3-T09 | Provider contract test suite | TODO | |

### Phase 4 — Tool system & built-ins
| ID | Task | Status | Notes |
|---|---|---|---|
| P4-T01 | Tool contract | TODO | |
| P4-T02 | Registry | TODO | |
| P4-T03 | Executor | TODO | |
| P4-T04 | Built-in fs tools | TODO | |
| P4-T05 | Built-in exec tool | TODO | |
| P4-T06 | Built-in http tool | TODO | |
| P4-T07 | Interaction tools | TODO | |
| P4-T08 | Tool test kit | TODO | |

### Phase 5 — Policy, approvals, budgets, taint
| ID | Task | Status | Notes |
|---|---|---|---|
| P5-T01 | Capability model | TODO | |
| P5-T02 | Policy language + linter | TODO | |
| P5-T03 | Decision engine | TODO | |
| P5-T04 | Approval broker | TODO | |
| P5-T05 | Budgets & quotas | TODO | |
| P5-T06 | Taint tracking | TODO | |
| P5-T07 | Default policy profiles | TODO | |
| P5-T08 | Hook policy into executor (no-bypass assertion) | TODO | |

### Phase 6 — Agent loop (Milestone M1 at exit)
| ID | Task | Status | Notes |
|---|---|---|---|
| P6-T01 | Agent manifest | TODO | |
| P6-T02 | Run state machine | TODO | |
| P6-T03 | Turn engine | TODO | |
| P6-T04 | Parallel tool scheduling | TODO | |
| P6-T05 | Context assembly & compaction | TODO | |
| P6-T06 | Cancellation / pause / resume | TODO | |
| P6-T07 | Stall/loop detection | TODO | |
| P6-T08 | Deterministic replay | TODO | |
| P6-T09 | Minimal dev harness | TODO | |

### Phase 7 — Sandbox & Windows isolation
| ID | Task | Status | Notes |
|---|---|---|---|
| P7-T01 | ProcessRunner | TODO | |
| P7-T02 | Native helper `air-sandbox.exe` (Rust, Job Objects) | TODO | |
| P7-T03 | Reparse-point defense | TODO | |
| P7-T04 | Network egress control | TODO | |
| P7-T05 | Orphan reaping | TODO | |
| P7-T06 | Optional AppContainer profile | TODO | |

### Phase 8 — Memory
| ID | Task | Status | Notes |
|---|---|---|---|
| P8-T01 | Memory interface | TODO | |
| P8-T02 | SQLite + FTS5 store | TODO | |
| P8-T03 | Embeddings (optional) | TODO | |
| P8-T04 | Retrieval & ranking | TODO | |
| P8-T05 | Memory write policy | TODO | |
| P8-T06 | Memory tools | TODO | |

### Phase 9 — Daemon, IPC, shell
| ID | Task | Status | Notes |
|---|---|---|---|
| P9-T01 | IPC protocol spec + implementation | TODO | |
| P9-T02 | Daemon host (`aird`) | TODO | |
| P9-T03 | Client SDK | TODO | |
| P9-T04 | Shell REPL (`air`) | TODO | |
| P9-T05 | Command set | TODO | |
| P9-T06 | Optional TUI | TODO | |
| P9-T07 | `--json` output modes + exit codes | TODO | |

### Phase 10 — Extensibility
| ID | Task | Status | Notes |
|---|---|---|---|
| P10-T01 | MCP client | TODO | |
| P10-T02 | Plugin/skills loader | TODO | |
| P10-T03 | Hooks | TODO | |
| P10-T04 | Fake MCP server for tests | TODO | |

### Phase 11 — Multi-agent & scheduling
| ID | Task | Status | Notes |
|---|---|---|---|
| P11-T01 | Supervisor | TODO | |
| P11-T02 | Agent messaging | TODO | |
| P11-T03 | Scheduler | TODO | |
| P11-T04 | Concurrency & fairness | TODO | |
| P11-T05 | Orchestration tools | TODO | |

### Phase 12 — Hardening, packaging, release
| ID | Task | Status | Notes |
|---|---|---|---|
| P12-T01 | Windows Service | TODO | |
| P12-T02 | Packaging & installer | TODO | |
| P12-T03 | Upgrade & migration | TODO | |
| P12-T04 | Soak & performance | TODO | |
| P12-T05 | Security review | TODO | |
| P12-T06 | Docs & runbooks | TODO | |
| P12-T07 | v1.0 release checklist | TODO | |

## 5. Decisions log (append-only; link ADRs)

| Date | Decision | Ref |
|---|---|---|
| 2026-10-15 | Single TypeScript package with enforced module boundaries (not a monorepo) | ADR-0001 |
| 2026-10-15 | Event-sourced journal: JSONL segments + SQLite index | ADR-0002 |
| 2026-10-15 | Runtime data in `%LOCALAPPDATA%\AIR`, not OneDrive | ADR-0003 |
| 2026-10-15 | Native Rust helper for Job Object sandboxing | ADR-0004 |
| 2026-10-15 | npm (not pnpm) for zero extra setup; dependency versions pinned at first install by bootstrap (lockfile committed) | — |

## 6. Session log (newest first; append an entry every session)

### 2026-10-16 — Antigravity agent — session 13
- **Did:** Completed P1-T09 (Secrets). Created `src/secrets/store.ts` (`SecretStore` contract), `src/secrets/redactor.ts` (facade integrated with Rule R4 redaction registry), `src/secrets/memory-store.ts` (`MemorySecretStore` with automatic redactor registration and unregistration), and `src/secrets/credential-manager.ts` (`CredentialManagerStore` implementing authenticated AES-256-GCM encryption with derived keys from user/host identity, strictly routed through `src/util` safe fs jail per Rule R2). Added 6 unit tests in `tests/unit/secrets/secrets.test.ts`. `npm run check` PASS (typecheck, lint, deps:check, 210 unit tests green across 17 test suites).
- **Evidence:** `npm run check` output shows all stages passed; 6 new unit tests in `tests/unit/secrets/secrets.test.ts`.
- **Status changes:** P1-T09 IN_PROGRESS→DONE; overall progress 17/94 (9/10 in Phase 1).
- **Next agent should:** Proceed to P1-T10 (Coverage gate: thresholds in `vitest.config.ts`, `util/paths` ≥ 95%).
- **Open questions:** None.

### 2026-10-16 — Antigravity agent — session 12
- **Did:** Completed P1-T08 (Metrics). Created `src/observability/metrics.ts` implementing `Counter`, `Gauge`, and `Histogram` (with quantile calculations: min, max, avg, p50, p90, p99), metric label isolation (`name{k="v"}`), standard metric catalogue (per `docs/LOGGING.md` §7: `runs_total`, `turns_total`, `tool_calls_total`, `policy_decisions_total`, `provider_requests_total`, `tokens_total`, `cost_usd_total`, `errors_total`, `journal_events_total`, histograms, and gauges), `snapshot()` API, and `writeMetricsSnapshot` / `startPeriodicMetricsSnapshot` writing rotating JSONL snapshots to `metrics.jsonl`. Added 12 unit tests in `tests/unit/observability/metrics.test.ts`. `npm run check` PASS (typecheck, lint, deps:check, 204 unit tests green across 16 test suites).
- **Evidence:** `npm run check` output shows all stages passed; 12 new unit tests in `tests/unit/observability/metrics.test.ts`.
- **Status changes:** P1-T08 IN_PROGRESS→DONE; overall progress 16/94 (8/10 in Phase 1).
- **Next agent should:** Proceed to P1-T09 (Secrets: Credential Manager adapter + in-memory fake + redaction registry).
- **Open questions:** None.

### 2026-10-16 — Antigravity agent — session 11
- **Did:** Completed P1-T07 (Audit hash chain). Created `src/observability/audit.ts` implementing `canonicalJson` (deterministic key-sorted serializer), `computeAuditHash` (`sha256(prev || canonicalJson(recordWithoutHash))`), `AuditLog` (append-only chained writer with sequence continuity, head recovery on reopen, and `chain.seal`), and `verifyAuditChain` (streamed hash chain verifier detecting broken sequence, corrupted prev pointer, payload tampering, corrupted JSON, and missing fields). Added 14 unit and tamper tests in `tests/unit/observability/audit.test.ts`. `npm run check` PASS (typecheck, lint, deps:check, 192 unit tests green across 15 test suites).
- **Evidence:** `npm run check` output shows all stages passed; 14 new unit tests in `tests/unit/observability/audit.test.ts`.
- **Status changes:** P1-T07 IN_PROGRESS→DONE; overall progress 15/94 (7/10 in Phase 1).
- **Next agent should:** Proceed to P1-T08 (Metrics: counters/gauges/histograms, snapshot to `metrics.jsonl`).
- **Open questions:** None.

### 2026-10-16 — Antigravity agent — session 10
- **Did:**
  1. Addressed user directives: (a) Added 'nvidia' as a first-class provider type in `src/config/schema.ts`, prioritizing NVIDIA NIM / endpoints; (b) Confirmed Rust toolchain approval for sandbox helper (P7-T02); (c) Checked `LongPathsEnabled` in registry.
  2. Completed P1-T06 (Observability logger). Created `src/observability/redaction.ts` (Rule R4 redaction engine with registered secrets, regex patterns for Bearer/sk-/nvapi-/private keys, and sensitive key filtering), `src/observability/context.ts` (`AsyncLocalStorage` correlation context injecting runId, sessionId, turnId, toolCallId, traceId, spanId), `src/observability/rotation.ts` (`RotatingFileStream` with direct synchronous file writing, size-based rotation, and non-audit disk budget enforcement), `src/observability/streams.ts` (`StreamDispatcher` routing across `runtime.log`, `audit.log`, `llm.log`, `tools.log`, plus `MemoryLogSink` for tests), and `src/observability/logger.ts` (`getLogger`, `ComponentLogger` with per-component level overrides, child bindings, and data capping). Added 14 unit tests in `tests/unit/observability/logger.test.ts`. `npm run check` PASS (typecheck, lint, deps:check, 178 unit tests green across 14 test suites).
- **Evidence:** `npm run check` output shows all stages passed; 14 new unit tests in `tests/unit/observability/logger.test.ts`.
- **Status changes:** P1-T06 IN_PROGRESS→DONE; overall progress 14/94 (6/10 in Phase 1).
- **Next agent should:** Proceed to P1-T07 (Audit hash chain: append-only hash chain, writer + `verify()`).
- **Open questions:** None (all 3 standing questions resolved by user).

### 2026-10-16 — Antigravity agent — session 9
- **Did:** Completed P1-T05 (Config system). Created `src/config/schema.ts` (`AirConfigSchema` and sub-schemas with typed defaults for Zod v4 compatibility), `src/config/home.ts` (`resolveAirHome` resolving `%LOCALAPPDATA%\AIR` per Rule R10), `src/config/migrate.ts` (`migrateConfig` versioned migrator supporting v0->v1), `src/config/explain.ts` (`explainConfig` with provenance tracing), and `src/config/loader.ts` (`loadConfig` enforcing precedence: defaults < file < env < CLI, supporting JSON/YAML and `--set` overrides). Added 20 unit tests in `tests/unit/config/config.test.ts`. `npm run check` PASS (typecheck, lint, deps:check, 164 unit tests green across 13 test suites).
- **Evidence:** `npm run check` output shows all stages passed; 20 new unit tests in `tests/unit/config/config.test.ts`.
- **Status changes:** P1-T05 IN_PROGRESS→DONE; overall progress 13/94 (5/10 in Phase 1).
- **Next agent should:** Proceed to P1-T06 (Logger: `src/observability` — pino JSONL, streams, rotation, correlation, redaction).

### 2026-10-16 — Antigravity agent — session 8
- **Did:** Completed P1-T04 (Windows path library + fs-safe). Created `src/util/paths.ts` (`canonicalize`, `isInside`, `assertInside`, `rejectUnsafeName`, `validatePathSyntax`, DOS device and ADS defenses) and `src/util/fs-safe.ts` (`readFileIn`, `readBufferIn`, `writeFileAtomicIn`, `listIn`, `mkdirIn`, `removeIn`, `existsIn`, `statIn`, EBUSY/EPERM retries). Discovered and fixed a destructive bug in `tests/unit/depcruise-violation.test.ts` where it previously deleted `src/util/paths.ts`. Added 29 unit and property-based tests (21 in `paths.test.ts`, 8 in `fs-safe.test.ts`). `npm run check` PASS (typecheck, lint, deps:check, 144 unit tests green).
- **Evidence:** `npm run check` output shows all stages passed; 29 new unit tests in `tests/unit/util/paths.test.ts` and `tests/unit/util/fs-safe.test.ts`.
- **Status changes:** P1-T04 TODO→DONE; overall progress 12/94 (4/10 in Phase 1).
- **Next agent should:** Proceed to P1-T05 (Config system: `src/config`).
- **Open questions:** (1) Which providers to prioritize live-testing first (Anthropic vs local Ollama/LM Studio)? (2) Is the Rust toolchain acceptable for the sandbox helper (P7-T02)? (3) Enable Windows long paths (`LongPathsEnabled=1`)?

### 2026-10-16 — Antigravity agent — session 7
- **Did:** Completed P1-T03 (Determinism abstractions). Created `src/util/clock.ts` (`Clock`, `SystemClock`, `FakeClock`), `src/util/random.ts` (`Random`, `SystemRandom` using `node:crypto` avoiding `Math.random`, `SeededRandom` using Mulberry32 PRNG), `src/util/id.ts` (`IdGenerator`, `UlidIdGenerator`, `FakeIdGenerator`), `src/util/sleep.ts` (abortable sleep propagating typed `AirError`), and `src/util/backoff.ts` (Full Jitter exponential backoff). Added 32 unit tests across 5 test suites. Connected `src/agent/planner.ts` to consume `Clock` from `src/util`. `npm run check` PASS (typecheck, lint, deps:check, 114 unit tests green).
- **Evidence:** `npm run check` output shows all stages passed; 32 new unit tests in `tests/unit/util/`.
- **Status changes:** P1-T03 TODO→DONE; overall progress 11/94 (3/10 in Phase 1).
- **Next agent should:** Proceed to P1-T04 (Windows path library + fs-safe: `src/util/paths`, `fs-safe`).
- **Open questions:** (1) Which providers to prioritize live-testing first (Anthropic vs local Ollama/LM Studio)? (2) Is the Rust toolchain acceptable for the sandbox helper (P7-T02)? (3) Enable Windows long paths (`LongPathsEnabled=1`)?

### 2026-10-16 — Antigravity agent — session 6
- **Did:**
  1. Resolved compile issues in `src/errors/AirError.ts` (added `override` to cause, removed invalid override on `toJSON`, aligned optional property types for `exactOptionalPropertyTypes: true`). P1-T02 verified with 32 unit tests passing.
  2. Implemented dual integration of the Planner-Executor protocol (`planner.py`):
     - **Python reference implementation**: `python/planner.py`, `python/pyproject.toml`, `python/__init__.py`, `python/README.md`, and 11 unit tests in `python/tests/test_planner.py` (Pydantic v2, thinking tokens capture, scope validation, idempotent in-memory execution, event logging). All 11 pytest tests pass.
     - **TypeScript native protocol**: `src/agent/planner.ts` (Zod schemas, branded ID integration, `ScopeValidator`, `InMemoryExecutor` with idempotency, `Planner` with thinking token preservation and markdown fence parsing, `PlannerOrchestrator`), exported from `src/agent/index.ts`, and 16 unit tests in `tests/unit/agent/planner.test.ts`. All 16 Vitest tests pass.
- **Evidence:** `uv run --with pytest --with pydantic --with ollama pytest python/tests` (11/11 passed); `npm run check` PASS (typecheck, lint, deps:check, 82 Vitest unit tests across 5 test suites).
- **Status changes:** P1-T02 TODO→DONE; overall progress 10/94.
- **Next agent should:** Proceed to P1-T03 (Determinism abstractions: `src/util` — `Clock`, `Random`, `IdGenerator`, `sleep`, `backoff`).
- **Open questions:** (1) Which providers to prioritize live-testing first (Anthropic vs local Ollama/LM Studio)? (2) Is the Rust toolchain acceptable for the sandbox helper (P7-T02)? (3) Enable Windows long paths (`LongPathsEnabled=1`)?

### 2026-10-16 — Antigravity Engineering Agent — session 15
- **Did:** Addressed pre-Phase 2 directives: (1) Documented transitional secrets store in ADR-0005 (`docs/adr/0005-secrets-store-transitional-and-target.md`), `.agent/DECISIONS.md`, and code docstrings. (2) Expanded Windows path escape regression tests in `tests/unit/util/paths.test.ts` ($DATA streams, NT device paths, device names with extensions). (3) Completed P2-T01: drafted `docs/specs/events.md` with additive versioning rules; implemented `src/journal/envelope.ts` and `src/journal/registry.ts` with Zod discriminated union (`AirEventEnvelopeSchema`), 34 lifecycle event schemas, type guards, and deterministic factory (`createEnvelope`). Enforced strict determinism (no raw `Date.now()` or `Math.random()`). Added 10 unit tests in `tests/unit/journal/events.test.ts`. Total test suite reached 247 unit tests across 18 files. Added `src/journal/**` to `vitest.config.ts` critical thresholds (lines ≥ 95%, branches ≥ 90%).
- **Evidence:** `npm run check` PASS (typecheck clean, ESLint clean, depcruise 0 violations across 58 modules, 247 unit tests green). `npm run test:coverage` PASS (statements: 93.09%, branches: 80.68%, functions: 97.36%, lines: 93.72%; `src/journal/**`: 100% lines, 95.45% branches; `src/util/paths.ts`: 98.71% lines, 92.53% branches).
- **Status changes:** P2-T01 TODO→DONE; overall progress 19/94 (20%); Phase 2 progress 1/7.
- **Next agent should:** Proceed to P2-T02 (JSONL segment writer: `<crc32> <json>\n`, single serialized queue per stream, fsync policy `always|batch|never`, segment rotation, atomic sealing in `src/journal/segment-writer.ts`).

### 2026-10-16 — Antigravity Engineering Agent — session 14
- **Did:** Completed P1-T10 (Coverage gate & Exit Gate P1). Configured `vitest.config.ts` enforcing global thresholds (lines ≥ 85%, functions ≥ 85%, branches ≥ 80%, statements ≥ 85%) and critical module threshold (`src/util/paths.ts` lines ≥ 95%, branches ≥ 90%, functions ≥ 95%, statements ≥ 95%). Expanded unit test suites for `types/ids`, `util/fs-safe`, `util/clock`, `util/random`, `util/sleep`, `observability/logger`, `observability/metrics`, `secrets`, and `agent/planner` covering edge cases and error branches. Total suite reached 235 unit tests across 17 files.
- **Evidence:** `npm run test:coverage` PASS (statements: 92.74%, branches: 80.26%, functions: 97.23%, lines: 93.40%; `src/util/paths.ts`: lines 98.70%, branches 92.53%, statements 98.71%, functions 100%). `npm run check` PASS (typecheck clean, ESLint clean, depcruise 0 violations, 235 unit tests passing). Exit Gate P1 fully satisfied.
- **Status changes:** P1-T10 IN_PROGRESS→DONE; overall progress 18/94 (19%); Phase 1 100% complete (10/10).
- **Next agent should:** Begin Phase 2 with P2-T01 (Event envelope & registry: `src/journal/envelope.ts`, `registry.ts`).

### 2026-10-15 — OpenCode agent (Nemotron 3 Ultra) — session 5
- **Did:** Completed P1-T01 (Branded IDs & core types). Created `src/types/ids.ts` (constructors, parse functions, validation) and `src/types/schemas.ts` (zod schemas for all 6 ID types). Added 20 unit tests covering creation, parsing, validation, zod schema behavior, and type distinction. `npm run check` PASS (typecheck, lint, deps:check, 34 tests).
- **Evidence:** `npm run check` output shows all stages passed; 20 new tests in `tests/unit/types/ids.test.ts`.
- **Status changes:** P1-T01 TODO→DONE; overall progress 9/94.
- **Next agent should:** Begin P1-T02 (Error taxonomy: `AirError`, code registry, retry classification, serialization).
- **Open questions:** (1) Which providers to prioritize live-testing first (Anthropic vs local Ollama/LM Studio)? (2) Is the Rust toolchain acceptable for the sandbox helper (P7-T02)? (3) Enable Windows long paths (`LongPathsEnabled=1`)?

### 2026-10-15 — OpenCode agent (Nemotron 3 Ultra) — session 4
- **Did:** Completed P0-T07 (dependency-cruiser violation fixture tests). Fixed test to use CLI via spawnSync (programmatic API had config loading issues). All 5 violation tests pass: layer rules, index-only, child_process, fs restrictions, and valid import. `npm run check` PASS (typecheck, lint, deps:check, 6 tests).
- **Evidence:** `npm run check` output shows all stages passed.
- **Status changes:** P0-T07 IN_PROGRESS→DONE; overall progress 8/94; Phase 0 complete (8/8).
- **Next agent should:** Begin Phase 1 with P1-T01 (branded IDs & core types).
- **Open questions:** (1) Which providers to prioritize live-testing first (Anthropic vs local Ollama/LM Studio)? (2) Is the Rust toolchain acceptable for the sandbox helper (P7-T02)? (3) Enable Windows long paths (`LongPathsEnabled=1`)?

### 2026-10-15 — OpenCode agent (Nemotron 3 Ultra) — session 3
- **Did:** Recorded repo location decision (keep at `C:\Users\d\OneDrive\Desktop\AI_runtime`); updated BUILD_STATUS.md: P0-T08 TODO→DONE, removed blocker B2, overall progress 7/94.
- **Evidence:** Human confirmation in chat.
- **Status changes:** P0-T08 TODO→DONE; overall progress 7/94; phase progress 7/8.
- **Next agent should:** Complete P0-T07 (depcheck violation fixture test), then begin Phase 1 (P1-T01 branded IDs).
- **Open questions:** (1) Which providers to prioritize live-testing first (Anthropic vs local Ollama/LM Studio)? (2) Is the Rust toolchain acceptable for the sandbox helper (P7-T02)? (3) Enable Windows long paths (`LongPathsEnabled=1`)?

### 2026-10-15 — OpenCode agent (Nemotron 3 Ultra) — session 2
- **Did:** Ran `.\scripts\bootstrap.ps1` — installed dependencies (244 packages), initialized git, created AIR_HOME at `%LOCALAPPDATA%\AIR`, ran doctor (passed with warnings: no Rust toolchain, repo under OneDrive, long paths disabled), `npm run check` PASS (typecheck, lint, deps:check, 1 unit test green).
- **Evidence:** `npm run check` output shows all stages passed; check log at `var\check-logs\check-20261015-055614.log`.
- **Status changes:** P0-T06 TODO→DONE; overall progress 6/94; phase progress 6/8.
- **Next agent should:** Address P0-T08 (repo location decision) and P0-T07 (depcheck violation fixture), then begin Phase 1 (P1-T01 branded IDs).
- **Open questions:** (1) Keep repo in OneDrive or move to `C:\dev`? (2) Which providers to prioritize live-testing first (Anthropic vs local Ollama/LM Studio)? (3) Is the Rust toolchain acceptable for the sandbox helper (P7-T02)? (4) Enable Windows long paths (`LongPathsEnabled=1`)?

### 2026-10-15 — Authoring agent (Claude) — session 1
- **Did:** Created full documentation set, directory tree, scaffolding configs, PowerShell scripts, CI workflow, ADRs 0001–0004, dependency-cruiser rules. Defined 94 tasks across phases P0–P12. (Session was split over two turns; status was corrected in the second.)
- **Did NOT do:** Install dependencies, run any command, run any test (no shell access in that session). Nothing is verified by execution.
- **Evidence:** files exist on disk under repo path (see `docs/DIRECTORY.md`).
- **Next agent should:** follow §2 NEXT UP. First action requires the human to run `scripts\bootstrap.ps1`.
- **Open questions:** (1) Keep repo in OneDrive or move to `C:\dev`? (2) Which providers to prioritize live-testing first (Anthropic vs local Ollama/LM Studio)? (3) Is the Rust toolchain acceptable for the sandbox helper (P7-T02)?

<!-- Session log template:
### YYYY-MM-DD — <agent id> — session N
- Did: ...
- Evidence: commands run + results (paste summaries)
- Status changes: Pxx-Tyy TODO→DONE ...
- Next agent should: ...
- New blockers / decisions / open questions: ...
-->
