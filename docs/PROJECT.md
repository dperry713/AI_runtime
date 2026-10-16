# PROJECT.md — AIR (AI Runtime): what it is, why, and how to think about it

Audience: any AI agent or human who must understand the whole project without prior context.

## 1. Vision

Operating systems manage *processes*. AIR manages *agents*. It is the layer between "an LLM API" and
"something you can trust to run unattended on your Windows machine": lifecycle, isolation, permissions,
budgets, memory, observability, recovery, and an interactive shell — all treated as first-class runtime
concerns rather than prompt-engineering afterthoughts.

**AI-native** means:
- The unit of execution is an **agent run** (model + tools + policy + budget + memory), not a script.
- The "syscalls" are **tool calls**, mediated by a kernel that validates, authorizes, sandboxes, meters, and logs them.
- The "filesystem of record" is an **event journal** from which any run can be replayed.
- Model output is **untrusted input**; the kernel never assumes the model is aligned, correct, or uninjected.
- Humans are in the loop through **approvals**, not through hoping the prompt says "be careful".

## 2. What AIR is / is not

| AIR is | AIR is not |
|---|---|
| A daemon + CLI shell hosting many agent runs | A chatbot UI |
| Provider-agnostic (Anthropic, OpenAI-compatible, Ollama/local) | Tied to one vendor |
| Deny-by-default security with explainable decisions | A "YOLO mode" agent loop |
| Event-sourced, replayable, auditable | A black box with print statements |
| Windows-first (Job Objects, named pipes, Credential Manager, Windows Service) | A cross-platform lowest-common-denominator tool (Linux/macOS are out of scope for v1) |
| Extensible via MCP and plugins under policy | An unrestricted plugin free-for-all |

## 3. Core concepts (glossary — use these exact terms)

| Term | Definition |
|---|---|
| **Agent** | A definition (manifest): system prompt, model/provider preference, allowed tools, policy profile, budgets. Static. |
| **Run** | One execution of an agent toward a goal. Has a `RunId`, state machine, budget, journal stream. |
| **Session** | A user-facing conversation container that can hold multiple runs and shared context. |
| **Turn** | One model invocation plus the tool calls it requests and their results. |
| **Step** | A single atomic unit inside a turn (model call, tool call, approval wait, compaction). |
| **Tool** | A typed, schema-validated capability the agent can invoke (e.g. `fs.read`, `exec.run`, `http.fetch`). |
| **Capability** | A fine-grained permission atom a tool needs (e.g. `fs.write:C:\work\**`, `net:api.example.com`). |
| **Grant** | A capability allowed by policy (statically, or dynamically via approval). |
| **Policy** | Declarative rules mapping (agent, tool, args, context, taint) → allow / deny / ask. Default: deny. |
| **Approval** | A human decision on an `ask` outcome; may be remembered for scope (once / run / session). |
| **Event** | Immutable, versioned record of something that happened. The only source of truth for state. |
| **Journal** | Append-only, checksummed event log (JSONL segments) + SQLite index. |
| **Provider** | Adapter that turns a normalized request into a model API call and normalizes the response/stream. |
| **Sandbox** | OS-level containment for spawned processes (Job Object limits, restricted token, cwd jail). |
| **Taint** | Provenance flag marking data from untrusted sources (web, files, tool output) to escalate policy. |
| **Memory** | Persistent, policy-governed store (episodic / semantic / working) with retrieval. |
| **Supervisor** | Component that spawns/restarts child agent runs with inherited budgets. |
| **aird** | The daemon process (optionally a Windows Service). |
| **air** | The CLI/REPL shell client. |
| **AIR_HOME** | Runtime data root: `%LOCALAPPDATA%\AIR` by default. |

## 4. Principles (tie-breakers when design is ambiguous)

1. **Safety over convenience.** If unsure, deny or ask.
2. **If it isn't journaled, it didn't happen.** State is derived from events.
3. **Determinism where possible.** Inject time/randomness/IDs; replay must reproduce decisions.
4. **Observability is a feature.** Logs, metrics, traces exist before the feature they observe ships.
5. **Fail loudly, recover quietly.** Typed errors, explicit retry classification, crash-safe persistence.
6. **Boundaries are enforced by tooling**, not by good intentions (lint + dependency-cruiser + tests).
7. **Windows is the real target.** Test on Windows; model its path/process/ACL quirks explicitly.
8. **Small kernel, big ecosystem.** Keep the kernel minimal; push features to tools, MCP, plugins.
9. **Untrusted by default.** Model output, tool output, files, web content, MCP servers, plugins.
10. **Every claim needs a test.** No test, no DONE.

## 5. Primary user stories

1. *As an operator*, I run `air chat` and converse with an agent that can read/edit files in my project, run PowerShell commands, and browse allowed hosts — and I approve risky actions.
2. *As an operator*, I run `air run <agent> "<goal>" --budget 2usd` and walk away; the daemon enforces budget, time and policy and I can `air logs` / `air replay` later.
3. *As an auditor*, I can reconstruct exactly what an agent did, what it was allowed to do, and why, from the journal + audit log (hash-chained).
4. *As a developer*, I can write a new tool or connect an MCP server and have it automatically governed by policy, logging, and sandboxing.
5. *As an operator*, if the machine crashes mid-run, `aird` restarts, detects the unfinished run, and resumes or safely aborts it.
6. *As a maintainer*, I can run the full test suite (including chaos and security suites) with one command and trust the result.

## 6. Scope

### v1.0 in scope
Daemon + shell, kernel/agent loop, providers (Anthropic, OpenAI-compatible, Ollama), tool system with fs/exec/http built-ins,
policy + approvals + budgets, Windows sandbox via native helper, event-sourced journal with replay, memory (SQLite FTS5),
MCP client, supervisor/sub-agents, scheduler, Windows Service, packaging, extensive tests, structured logging and audit trail.

### Explicit non-goals for v1.0
Linux/macOS support; web UI; multi-machine clustering; training/fine-tuning; hosting a public multi-tenant service;
GUI automation (may come later as a plugin, always under policy).

## 7. Technology decisions (summary — see ADRs)

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript 5 strict, Node.js 22 LTS, ESM | Fast iteration, rich ecosystem, existing expertise |
| Layout | Single package with enforced internal module boundaries (ADR-0001) | Simpler than monorepo; boundaries enforced by dependency-cruiser |
| Validation | zod | Runtime schemas = single source of truth for types + JSON Schema for tools |
| Logging | pino (JSONL), pino-roll rotation, AsyncLocalStorage correlation | Fast, structured, redaction built in |
| Persistence | JSONL journal segments + SQLite (better-sqlite3, WAL) (ADR-0002) | Crash-safe append log + queryable index |
| IPC | JSON-RPC 2.0, NDJSON framing over Windows named pipe | Native, ACL-securable, no open TCP port |
| Sandbox | Native Rust helper `air-sandbox.exe` using Job Objects + restricted token (ADR-0004) | Node has no Job Object API |
| Secrets | Windows Credential Manager | OS-protected storage; no plaintext keys in config |
| Tests | vitest, fast-check (property), v8 coverage | Fast, TS-native |
| Packaging | Node SEA / bundled exe + WinSW service wrapper | Single deployable, proper Windows Service |

## 8. Runtime topology

```
 ┌───────────────┐   named pipe (JSON-RPC/NDJSON)   ┌────────────────────────────────────────┐
 │  air (shell)  │ ◄──────────────────────────────► │                 aird (daemon)          │
 │  CLI / REPL   │                                  │  ┌──────────┐  ┌────────────────────┐  │
 └───────────────┘                                  │  │ Supervisor│─►│ Agent runs (N)     │  │
                                                    │  └──────────┘  │  turn engine       │  │
 ┌───────────────┐                                  │                │  ↓        ↑        │  │
 │ MCP servers   │ ◄────────── stdio/HTTP ───────── │  ┌─────────┐   │ providers  tools   │  │
 └───────────────┘                                  │  │ Policy  │◄──┤            │       │  │
                                                    │  └─────────┘   └────────────┼───────┘  │
 ┌───────────────┐                                  │  ┌─────────┐  ┌────────────▼───────┐  │
 │ LLM providers │ ◄────────── HTTPS ────────────── │  │ Journal │  │ Sandbox (air-      │  │
 └───────────────┘                                  │  │ + Audit │  │ sandbox.exe, Job   │  │
                                                    │  └─────────┘  │ Objects)           │  │
                                                    │  Logging • Metrics • Memory • Config │  │
                                                    └────────────────────────────────────────┘
```

## 9. Data layout on disk (runtime)

```
%LOCALAPPDATA%\AIR\                (AIR_HOME)
  config\air.config.json           user config (layered over defaults)
  config\policy.json               policy rules
  agents\*.agent.json              agent manifests
  journal\segments\*.jsonl         append-only event segments (checksummed lines)
  journal\index.sqlite             SQLite index (WAL)
  memory\memory.sqlite             memory store (FTS5)
  logs\runtime.log                 structured JSONL, rotated
  logs\audit.log                   hash-chained policy/approval/tool audit trail
  logs\llm.log                     model request/response metadata (payloads per config)
  logs\tools.log                   tool execution records
  logs\crash\                      crash dumps / last-gasp reports
  run\aird.pid, run\aird.lock      process control
  tmp\                             scratch, per-run workdirs
```

## 10. Success metrics (v1.0 acceptance)

- 100% of tool calls pass through policy (verified by test that greps/lints for bypass + runtime assertion).
- Crash-recovery suite: kill `aird` at random points 1,000×; journal always recovers to a valid prefix; no duplicate side effects for idempotent tools.
- Replay fidelity: replayed runs reproduce identical policy decisions and tool-call sequences from the journal.
- Coverage: ≥ 85% lines overall; ≥ 95% for `policy`, `journal`, `util/paths`, `sandbox` runners.
- Security suite: path traversal corpus, prompt-injection corpus, secret-exfil corpus all pass.
- 72-hour soak: no memory growth > 10%, no handle leaks, no unrecovered errors.
- Cold start of `aird` < 1.5 s; shell command latency (excluding model) < 100 ms p95.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Prompt injection via tool output / web | Taint tracking, policy escalation, approvals, output fencing, injection corpus tests |
| Sandbox escape on Windows | Job Object + restricted token + cwd jail + reparse-point checks; security tests; optional AppContainer later |
| Journal corruption / torn writes | Per-line checksum, fsync policy, tail recovery, chaos tests |
| OneDrive sync corrupting data | Runtime data under `%LOCALAPPDATA%` (ADR-0003) |
| Provider API drift | Contract tests per adapter, record/replay fixtures, normalized interface |
| Runaway cost | Hard budgets (tokens, USD, steps, wall time) enforced pre-call and in-flight |
| Native helper maintenance burden | Keep helper tiny; versioned stdin/stdout protocol; fuzz it |
| Scope creep | Phase gates in `docs/BUILD_PLAN.md`; non-goals above |
