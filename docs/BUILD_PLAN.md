# BUILD_PLAN.md — Phase-by-phase plan for AIR

Rules:
- Task IDs (`P<phase>-T<nn>`) are stable and mirrored in `BUILD_STATUS.md`. Never renumber; append new tasks at the end of a phase.
- Phases are gated: a phase is complete only when **all** its tasks are `DONE` (or `DEFERRED` with reason) **and** its **Exit Gate** passes.
- Every task includes its tests. "Tests" below are minimums.
- Size guide: S ≈ ≤½ day, M ≈ 1–2 days, L ≈ 3–5 days (for a focused agent/human session set).

Dependency order: P0 → P1 → P2 → P3 → P4 → P5 → P6 → (P7, P8 in parallel after P4/P5) → P9 → P10 → P11 → P12.
Vertical-slice milestone **M1 (end of P6+P9-lite)**: `air chat` with mock provider, fs tools, policy, journal, logs.

---

## Phase 0 — Foundations & scaffolding
**Goal:** a repo any agent can navigate, build, test, and run CI on, on Windows.

| ID | Task | Size |
|---|---|---|
| P0-T01 | Documentation set: AGENTS, PROJECT, ARCHITECTURE, BUILD_PLAN, BUILD_STATUS, TESTING, LOGGING, SECURITY, MODULES, DIRECTORY, ADRs | M |
| P0-T02 | Scaffolding files: package.json, tsconfig, vitest config, eslint, prettier, gitignore, editorconfig, gitattributes, example config | S |
| P0-T03 | Directory tree created | S |
| P0-T04 | PowerShell scripts: bootstrap, check, doctor, test wrapper | S |
| P0-T05 | CI workflow (windows-latest, Node 22) incl. nightly chaos/security | S |
| P0-T06 | Run `scripts\bootstrap.ps1` on dev machine: `git init`, install deps, ensure `npm run check` passes on the empty skeleton | S |
| P0-T07 | Add `.dependency-cruiser.cjs` implementing layer rules from ARCHITECTURE §3; add smoke test that fails on a deliberate violation fixture | S |
| P0-T08 | Decide repo location vs OneDrive (ADR-0003 follow-up): move to `C:\dev\AI_runtime` or exclude `node_modules`/`var` from sync | S |

**Exit Gate P0:** fresh clone → `scripts\bootstrap.ps1` → `npm run check` green on Windows CI and locally; dependency-cruiser rules active.

---

## Phase 1 — Core types, errors, config, logging (foundation libraries)
**Goal:** the primitives everything else depends on, with logging first so every later phase is observable.

| ID | Task | Detail | Size |
|---|---|---|---|
| P1-T01 | Branded IDs & core types | `src/types`: `RunId, AgentId, SessionId, TurnId, ToolCallId, EventId` (ULID-backed), constructors + zod schemas | S |
| P1-T02 | Error taxonomy | `src/errors`: `AirError`, code registry, `isRetryable`, `toModelSafeMessage`, serialization | S |
| P1-T03 | Determinism abstractions | `src/util`: `Clock` (system + fake), `Random`, `IdGenerator`, `sleep(abortable)`, `backoff` (full jitter) | S |
| P1-T04 | Windows path library | `src/util/paths`, `fs-safe`: normalize, `isInside(root, p)` with realpath/junction handling, reject ADS/device names/trailing dot-space/UNC/`\\?\` abuse, 8.3 expansion, case-insensitive compare | M |
| P1-T05 | Config system | zod schema, layered loader (defaults<file<env<CLI), `AIR_HOME` resolution to `%LOCALAPPDATA%\AIR`, `explain`, versioned migrator | M |
| P1-T06 | Logger | pino JSONL; streams runtime/audit/llm/tools; rotation (size+count); `AsyncLocalStorage` correlation; redaction; level via config; `child(bindings)`; flush-on-exit; test sink | M |
| P1-T07 | Audit chain | append-only hash chain (`sha256(prev || canonical-json)`), writer + `verify()` CLI function, tamper tests | S |
| P1-T08 | Metrics | counters/gauges/histograms, snapshot to `metrics.jsonl`, `snapshot()` API | S |
| P1-T09 | Secrets | Credential Manager adapter (get/set/delete), in-memory fake, redaction registry integrated with logger | M |
| P1-T10 | Coverage gate | thresholds enforced in `vitest.config.ts`; per-module thresholds for `util/paths` ≥ 95% | S |

**Tests:** unit for all; property tests (fast-check) for path library (random mixes of `..`, separators, ADS, device names, case) asserting `isInside` never true for escapes; log redaction tests (secret never appears in any stream); audit tamper test (flip a byte → `verify` fails at exact index).
**Exit Gate P1:** logs from a sample program appear in all streams with correlation ids and no secrets; path suite passes with ≥ 95% coverage; config `explain` works.

---

## Phase 2 — Journal & event bus (event sourcing)
**Goal:** crash-safe, replayable record of everything.

| ID | Task | Detail | Size |
|---|---|---|---|
| P2-T01 | Event envelope & registry | zod discriminated union; additive-versioning rules in `docs/specs/events.md` | M |
| P2-T02 | JSONL segment writer | `<crc32> <json>\n`, single serialized queue per stream, fsync policy (`always|batch|never` config), segment rotation, atomic segment sealing | M |
| P2-T03 | SQLite index + migrations | better-sqlite3, WAL, `PRAGMA synchronous=NORMAL/FULL` per config; tables: streams, events(index), runs, sessions; migration runner with tests from v0 | M |
| P2-T04 | Typed event bus | in-process pub/sub, per-subscriber bounded queues with backpressure/drop policy and metrics | S |
| P2-T05 | Reader & replay engine | iterate by stream/range, fold into projections, snapshots every N events | M |
| P2-T06 | Crash recovery | detect torn/corrupt tail, truncate to last valid, emit `system.recovered`, rebuild index from segments if index missing/stale | M |
| P2-T07 | Upcasters framework | stub + test with synthetic v1→v2 | S |

**Tests:** property: `fold(replay(events)) == live projection`; chaos: kill child process writer at random byte offsets 1,000× → always valid prefix; corruption: flip bytes in the middle → detected with line number and quarantine; perf: ≥ 20k events/s with `fsync=batch`.
**Exit Gate P2:** chaos suite green; replay equivalence property test green; index rebuild from segments verified.

---

## Phase 3 — Provider layer
**Goal:** vendor-neutral, resilient, testable LLM access.

| ID | Task | Detail | Size |
|---|---|---|---|
| P3-T01 | Provider interface & normalized types | request, message parts (text/tool_call/tool_result/image), stream events, usage, stop reasons, capability flags | M |
| P3-T02 | Mock/scripted provider | deterministic scripts, latency/error injection, usage simulation (used by nearly all later tests) | M |
| P3-T03 | Anthropic adapter | streaming, tool use, usage, error mapping to `AirError` | M |
| P3-T04 | OpenAI-compatible adapter | works with OpenAI and local servers (LM Studio, llama.cpp); tool-call delta assembly | M |
| P3-T05 | Ollama adapter | native API, tool support detection | S |
| P3-T06 | Resilience wrapper | timeout, retry (jitter), 429/`Retry-After`, circuit breaker, fallback chain, abort propagation | M |
| P3-T07 | Token & cost accounting | per-model price table in config, running totals per run, pre-call estimates | S |
| P3-T08 | Record/replay harness | VCR-style recording of provider streams to `tests/fixtures/transcripts`, scrubbing of secrets | M |
| P3-T09 | Provider contract test suite | one shared suite executed against every adapter (mock server + recorded fixtures); live tests opt-in via `AIR_LIVE_TESTS=1` | M |

**Tests:** contract suite; fault injection (mid-stream disconnect, malformed JSON, 429 storms, hangs → timeouts); no key leakage in logs.
**Exit Gate P3:** all adapters pass contract suite offline; live smoke test passes when enabled.

---

## Phase 4 — Tool system & built-in tools
**Goal:** typed, validated, cancellable tools.

| ID | Task | Detail | Size |
|---|---|---|---|
| P4-T01 | Tool contract | zod input/output, derived JSON Schema, `risk: low|medium|high|critical`, `idempotent`, `capabilities(args)`, `timeoutMs`, `maxOutputBytes` | M |
| P4-T02 | Registry | register/list/get, namespacing (`fs.read`), versioning, conflict detection | S |
| P4-T03 | Executor | arg validation, timeout, `AbortSignal`, output truncation, error normalization, journal/log hooks (policy hook injected; real engine in P5) | M |
| P4-T04 | Built-in fs tools | `fs.read, fs.write, fs.edit (exact-match patch), fs.list, fs.glob, fs.grep, fs.stat, fs.mkdir, fs.move, fs.delete` — all via `fs-safe` jail, atomic writes (temp+rename), size caps | L |
| P4-T05 | Built-in exec tool | `exec.run` (PowerShell/pwsh/cmd), through `sandbox.ProcessRunner` interface (temporary naive runner until P7) | M |
| P4-T06 | Built-in http tool | `http.fetch` with host allowlist, SSRF guard (block private/link-local/loopback unless granted), size/time caps, content tainted | M |
| P4-T07 | Interaction tools | `user.ask`, `plan.update` (todo list), `run.finish` | S |
| P4-T08 | Tool test kit | helper to run a tool under fake clock/fs/policy; fuzz harness for schemas | S |

**Tests:** schema fuzzing; path traversal corpus (≥ 100 Windows-specific cases); timeout and cancel mid-execution; output truncation boundaries; atomic write crash test; SSRF corpus (decimal/hex IPs, DNS rebinding simulation, redirects to private IPs).
**Exit Gate P4:** all built-ins pass corpora; no direct `fs`/`child_process` imports outside allowed modules (deps:check).

---

## Phase 5 — Policy engine, approvals, budgets, taint
**Goal:** deny-by-default governance with explainable decisions.

| ID | Task | Detail | Size |
|---|---|---|---|
| P5-T01 | Capability model | typed capability atoms and glob/pattern matching (paths, hosts, command patterns) | M |
| P5-T02 | Policy language | JSON schema for rules (`effect`, `match{agent,tool,args,capabilities}`, `scope`, `reason`), loader, linter (`air policy lint`) | M |
| P5-T03 | Decision engine | precedence rules, specificity ordering, explain output, audit + journal emission | M |
| P5-T04 | Approval broker | request/resolve, scopes (once/run/session), timeouts, headless-deny, persisted pending approvals across restart | M |
| P5-T05 | Budgets & quotas | tokens, USD, steps, tool-calls, wall-clock; pre-check + in-flight enforcement; `run.budget_exceeded` | M |
| P5-T06 | Taint tracking | provenance labels on messages/tool outputs; escalation rules; output fencing format | M |
| P5-T07 | Default policy profiles | `readonly`, `project-write`, `dev-shell`, `locked-down` | S |
| P5-T08 | Hook policy into executor | single choke point; runtime assertion that executor cannot run a tool without a decision id | S |

**Tests:** property tests (random rule sets: deny always beats allow, specificity monotonic); bypass corpus (arg smuggling, case tricks, path aliasing, unicode confusables); taint escalation tests; approval persistence across simulated restart; audit-chain verification after a run.
**Exit Gate P5:** "no bypass" runtime assertion + test; every decision explainable via `air policy explain`.

---

## Phase 6 — Agent loop (turn engine)
**Goal:** a correct, interruptible, replayable agent runner. **Milestone M1 achieved at end of P6 (with CLI harness).**

| ID | Task | Detail | Size |
|---|---|---|---|
| P6-T01 | Agent manifest | schema, loader, validation, policy profile binding | S |
| P6-T02 | Run state machine | transitions + events + illegal-transition guards | M |
| P6-T03 | Turn engine | streaming provider consumption, tool-call assembly, execution, result fencing, loop | L |
| P6-T04 | Parallel tool scheduling | concurrency limits, dependency hints, ordered result delivery | M |
| P6-T05 | Context assembly & compaction | token-aware history, summarization step (journaled `context.compacted`), old tool-output pruning | L |
| P6-T06 | Cancellation / pause / resume | AbortSignal propagation, safe pause points, resume from journal | M |
| P6-T07 | Stall/loop detection | repeated identical calls, no-progress heuristics, max-steps | S |
| P6-T08 | Deterministic replay | re-run a run from journal with recorded provider/tool outputs; assert identical decisions | M |
| P6-T09 | Minimal dev harness | `npm run dev:run -- <agent> "<goal>"` for manual slice testing (not the final shell) | S |

**Tests:** E2E with scripted provider (golden transcripts): simple answer, multi-tool, parallel tools, tool failure recovery, denial recovery, approval flow, budget exhaustion, cancellation mid-tool, crash-resume; replay equivalence test; fuzz of provider event orderings.
**Exit Gate P6 / M1:** end-to-end run with mock provider produces a complete journal, logs in all streams, audit chain valid, replay identical.

---

## Phase 7 — Sandbox & Windows process isolation  *(parallel with P8)*
**Goal:** untrusted commands cannot escape, hang, or exhaust the machine.

| ID | Task | Detail | Size |
|---|---|---|---|
| P7-T01 | ProcessRunner | spawn, stdio caps, env allowlist scrubbing, timeout → kill tree, structured result | M |
| P7-T02 | Native helper `air-sandbox.exe` | small Rust crate in `native/air-sandbox`: Job Object limits (kill-on-close, process count, memory, CPU rate), restricted token, cwd jail, versioned stdin JSON protocol | L |
| P7-T03 | Reparse-point defense | junction/symlink/hardlink checks for jail; TOCTOU-resistant open (open then verify handle path) | M |
| P7-T04 | Network egress control | decide & implement: per-process Windows Firewall rule vs local allowlist proxy; default no network | L |
| P7-T05 | Orphan reaping | on `aird` start, kill leftover jobs/processes recorded in `run\children.json` | S |
| P7-T06 | Optional AppContainer profile | investigate/implement behind flag; ADR with findings | L |

**Tests (security + chaos):** fork bomb, memory hog, infinite output, deep process tree, `cmd /c start` detachment, junction escape, ADS write, device-name write, env secret leakage, kill-on-parent-crash, helper protocol fuzzing.
**Exit Gate P7:** escape/exhaustion suite green on Windows CI; helper rebuilt reproducibly.

---

## Phase 8 — Memory  *(parallel with P7)*
| ID | Task | Detail | Size |
|---|---|---|---|
| P8-T01 | Memory interface | episodic/semantic/working, scopes (agent/session/global), TTL | S |
| P8-T02 | SQLite + FTS5 store | migrations, BM25 retrieval | M |
| P8-T03 | Embeddings (optional) | embedding provider interface; `sqlite-vec` or in-process cosine; behind config flag | M |
| P8-T04 | Retrieval & ranking | recency/importance/relevance blend; token-budgeted injection | M |
| P8-T05 | Memory write policy | allow/deny rules, secret/PII scrub, provenance & taint stored with entries | M |
| P8-T06 | Memory tools | `memory.search`, `memory.write`, `memory.forget` (policy-governed) | S |

**Tests:** retrieval relevance fixtures with expected top-k; poisoning tests (tainted content cannot silently become trusted memory); forget guarantees (row + FTS + vectors removed); migration tests.
**Exit Gate P8:** retrieval eval ≥ target recall on fixture set; poisoning suite green.

---

## Phase 9 — Daemon, IPC, shell
| ID | Task | Detail | Size |
|---|---|---|---|
| P9-T01 | IPC protocol spec + implementation | JSON-RPC 2.0/NDJSON over named pipe, user-SID ACL, max frame size, versioning (`docs/specs/ipc.md`) | L |
| P9-T02 | Daemon host (`aird`) | boot sequence, recovery, graceful shutdown, health, pidfile/lock, single-instance | L |
| P9-T03 | Client SDK | typed client, reconnect, subscriptions, request timeouts | M |
| P9-T04 | Shell REPL (`air`) | sessions, streaming render, slash commands, approval prompts, history | L |
| P9-T05 | Command set | `chat, run, ps, logs, replay, config, policy, audit verify, doctor, kill, pause, resume, approve, agents` | L |
| P9-T06 | Optional TUI | ink-based live run dashboard | M |
| P9-T07 | Output modes | `--json` for every command (agent-friendly), exit codes documented | S |

**Tests:** E2E spawning real `aird` on a unique temp pipe: concurrent clients, client crash, daemon crash and restart with in-flight run recovery, oversized frames, malformed JSON, wrong-user connection attempt (ACL).
**Exit Gate P9:** full operator story works: start daemon → chat → approve → logs → replay.

---

## Phase 10 — Extensibility
| ID | Task | Detail | Size |
|---|---|---|---|
| P10-T01 | MCP client | stdio + streamable HTTP, tool import into registry namespaced `mcp.<server>.<tool>`, all under policy; server processes run in sandbox | L |
| P10-T02 | Plugin/skills loader | manifest, hash pinning, permissions declaration, load under policy | M |
| P10-T03 | Hooks | pre/post tool, on-event; sandboxed, timeout, cannot weaken policy | M |
| P10-T04 | Fake MCP server for tests | scripted tool server incl. malicious behaviors | S |

**Tests:** malicious MCP server (huge outputs, injection in tool descriptions, slowloris, schema lies); plugin hash mismatch refusal.
**Exit Gate P10:** imported tools are indistinguishable from built-ins to policy/logging; malicious-server suite green.

---

## Phase 11 — Multi-agent & scheduling
| ID | Task | Detail | Size |
|---|---|---|---|
| P11-T01 | Supervisor | spawn child runs, inherited/narrowed capabilities and budgets (children can never exceed parent), restart policies | L |
| P11-T02 | Agent messaging | mailbox via journal streams, message taint labels | M |
| P11-T03 | Scheduler | cron-like + file-watch + one-shot triggers, persisted, missed-run policy | M |
| P11-T04 | Concurrency & fairness | global/per-agent limits, queueing, starvation tests | M |
| P11-T05 | Orchestration tools | `agent.spawn`, `agent.send`, `agent.wait` under policy | M |

**Tests:** capability narrowing property test (child ⊆ parent); runaway-spawn bomb; scheduler time-travel tests with fake clock; crash during spawn.
**Exit Gate P11:** supervisor tree survives chaos suite; budgets provably non-escalating.

---

## Phase 12 — Hardening, packaging, release
| ID | Task | Detail | Size |
|---|---|---|---|
| P12-T01 | Windows Service | WinSW-based install/uninstall scripts, recovery actions, Windows Event Log for critical errors | M |
| P12-T02 | Packaging | Node SEA/bundled exe, bundled `air-sandbox.exe`, installer (MSI/MSIX/winget manifest) | L |
| P12-T03 | Upgrade & migration | in-place upgrade, schema/config migration tests from every prior release | M |
| P12-T04 | Soak & performance | 72h soak, perf budgets as CI-tracked benchmarks | L |
| P12-T05 | Security review | threat model update, dependency audit, SBOM, code signing, secret scanning | M |
| P12-T06 | Docs & runbooks | operator guide, troubleshooting, incident runbooks in `docs/runbooks` | M |
| P12-T07 | v1.0 release checklist | all exit gates re-verified on clean machine | S |

**Exit Gate P12 / v1.0:** all PROJECT.md §10 success metrics met and evidenced in `BUILD_STATUS.md`.

---

## Cross-cutting requirements (apply to every phase)

1. **Logging**: new behavior logged per `docs/LOGGING.md`; log-schema snapshot tests prevent accidental field drift.
2. **Journal**: every state transition is an event; no hidden state.
3. **Testing**: pyramid per `docs/TESTING.md`; new bug → regression test first.
4. **Security**: new tool/capability → threat-model note in `docs/SECURITY.md`.
5. **Docs**: public API changes reflected in `docs/MODULES.md`; architecture changes need an ADR.
6. **Performance**: no unbounded memory (bounded queues, output caps, log size caps).
