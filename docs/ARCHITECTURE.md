# ARCHITECTURE.md — AIR design reference

Status: **normative**. Changes require an ADR (`docs/adr/`) and an update here in the same change.

## 1. Overview

AIR is a single TypeScript package organized into strictly layered modules under `src/`.
A daemon (`aird`) hosts agent runs; a shell (`air`) is a thin client over a named pipe.
State is event-sourced. Security is enforced in the kernel path, not in prompts.

## 2. Modules

| Module | Responsibility | Layer |
|---|---|---|
| `types` | Branded IDs, shared primitives, event type definitions | 0 |
| `errors` | `AirError`, error codes, retry classification | 0 |
| `util` | Clock, Random, IdGenerator, `paths` (Windows-safe), `fs-safe`, abort helpers, backoff | 0 |
| `config` | zod schema, layered loader, env/CLI parsing, `AIR_HOME` resolution | 1 |
| `secrets` | Credential Manager access, redaction registry | 1 |
| `observability` | Logger, correlation context, audit chain, metrics, tracing | 1 |
| `journal` | Event envelope, JSONL writer, SQLite index, replay, recovery, event bus | 2 |
| `policy` | Capabilities, rules, decision engine, approvals, budgets, taint | 3 |
| `sandbox` | Process runner, native helper client, jail, limits | 3 |
| `providers` | LLM adapters, resilience, usage/cost accounting | 3 |
| `memory` | Memory stores, retrieval, write policy | 3 |
| `tools` | Tool contract, registry, executor, built-in tools | 4 |
| `mcp` | MCP client and tool import | 4 |
| `agent` | Agent manifests, turn engine, context assembly/compaction, run state machine | 5 |
| `kernel` | Supervisor, scheduler, run registry, lifecycle, budgets enforcement wiring | 6 |
| `ipc` | JSON-RPC protocol, named pipe server/client, auth | 7 |
| `service` | `aird` entrypoint, Windows Service integration, health | 8 |
| `shell` | `air` CLI/REPL, rendering, approval UI, commands | 8 |

## 3. Dependency rules (enforced by `dependency-cruiser`, config in `.dependency-cruiser.cjs` — created in P0/P1)

A module may import only from **equal-or-lower layers** and only through the other module's `index.ts`.

```
Layer 8  service, shell
Layer 7  ipc
Layer 6  kernel
Layer 5  agent
Layer 4  tools, mcp
Layer 3  policy, sandbox, providers, memory
Layer 2  journal
Layer 1  config, secrets, observability
Layer 0  types, errors, util
```
Additional rules:
- `node:child_process` only in `sandbox`. `node:fs` only in `util/fs-safe`, `journal` (writers), `config` (loader), `observability` (log sinks), `memory` (sqlite).
- Network (`fetch`, `undici`, `http`) only in `providers`, `mcp`, `tools/builtin/http`.
- `process.env` only in `config`.
- `tests/` may import anything.

## 4. Event model (the heart of the system)

### 4.1 Envelope (versioned, zod discriminated union on `type`)
```ts
interface EventEnvelope<T extends string = string, P = unknown> {
  v: 1;                     // schema version
  id: EventId;              // ULID, monotonic
  ts: string;               // ISO-8601 UTC (from injected Clock)
  seq: number;              // per-stream sequence, gapless
  stream: string;           // e.g. "run:<RunId>", "session:<SessionId>", "system"
  type: T;                  // e.g. "run.started"
  payload: P;               // zod-validated
  causation?: EventId;      // what caused this event
  correlation: {            // always present when applicable
    sessionId?: SessionId; runId?: RunId; turnId?: TurnId;
    toolCallId?: ToolCallId; traceId?: string; spanId?: string;
  };
  actor: { kind: 'user'|'agent'|'system'|'tool'|'provider'; id: string };
  hash?: string;            // optional chain hash for audit-class events
}
```
On disk each line is `<crc32hex> <json>\n` for torn-write detection.

### 4.2 Core event types (initial set; extend via ADR-free additive changes with version bump rules in `docs/specs/events.md`)
`run.created, run.started, run.paused, run.resumed, run.completed, run.failed, run.cancelled, run.budget_exceeded`
`turn.started, turn.completed`
`model.requested, model.stream_delta (optional, sampled), model.responded, model.failed`
`tool.requested, tool.policy_decided, tool.approval_requested, tool.approval_resolved, tool.started, tool.output, tool.completed, tool.failed, tool.cancelled`
`memory.read, memory.written`
`context.compacted`
`child.spawned, child.exited, message.sent, message.received`
`system.started, system.stopping, system.recovered`

### 4.3 Guarantees
- **Append-only**, never mutated. Corrections are new events.
- **Gapless `seq` per stream**; recovery truncates to the last valid line and emits `system.recovered`.
- **State = fold(events)**. In-memory run state is a projection; `replay()` rebuilds it identically.
- **Write-ahead rule**: `tool.requested` and `tool.policy_decided` are durably journaled *before* the tool starts. `tool.started` before side effects. Outcome after.
- **Idempotency**: tools declare `idempotent: boolean`. On crash recovery, a tool with `tool.started` but no terminal event is retried only if idempotent; otherwise the run is paused for operator decision.

## 5. State machines

### 5.1 Run
```
created → starting → running ⇄ paused
                       │  ├→ waiting_approval → running
                       │  └→ waiting_user → running
                       ├→ completed
                       ├→ failed
                       ├→ cancelled
                       └→ budget_exceeded (terminal)
```
Transitions are only made by the turn engine/kernel and each emits an event. Illegal transitions throw `AirError{code:'RUN_ILLEGAL_TRANSITION'}`.

### 5.2 Tool call
```
requested → policy_decided ─┬ deny → (failed: POLICY_DENIED)
                            ├ allow → started → (output*)* → completed | failed | cancelled | timed_out
                            └ ask → approval_requested → approved → started
                                                      └ denied/expired → (failed: APPROVAL_DENIED)
```

## 6. Turn engine (`agent`)

```
loop until terminal:
  1. check budgets (tokens/usd/steps/wall) → may terminate: run.budget_exceeded
  2. assemble context (system prompt + memory retrieval + history, compact if > threshold)
  3. journal model.requested ; call provider (stream) with timeout/abort ; journal model.responded
  4. if no tool calls → run.completed (or waiting_user if agent policy says so)
  5. for each tool call (parallel up to limit, respecting declared dependencies):
        validate args (zod) → policy decide → [approval] → execute (sandbox if needed) → journal result
  6. fence tool outputs (untrusted, tainted), append to history
  7. loop/stall detection (repeated identical calls, no-progress heuristic)
```
Cancellation uses `AbortSignal` threaded through provider, tools, sandbox.

## 7. Policy engine

Input: `{ agent, run, tool, args, capabilities[], taint, context }`  → Output: `{ decision: allow|deny|ask, rule, reason, scope? }`.
- **Deny by default.** Explicit allow rules only.
- Precedence: explicit deny > ask > allow; more specific path/host/command patterns beat general ones; ties → deny.
- **Taint escalation**: if any argument derives from tainted content (web, tool output, file content marked untrusted) and the tool is `risk >= medium`, decision is escalated to `ask` (or `deny` in non-interactive mode).
- Every decision is written to the **audit log** (hash-chained) and journaled as `tool.policy_decided` with the matched rule id and a human-readable reason.
- Budgets are enforced here too (pre-call estimates, post-call actuals).

## 8. Sandbox (Windows)

- `sandbox.ProcessRunner` is the only code allowed to spawn processes.
- Runner launches `air-sandbox.exe` (native Rust helper) which: creates a **Job Object** (`KILL_ON_JOB_CLOSE`, process-count, memory, CPU-rate limits), optionally a **restricted token** (drop privileges / deny-only groups), sets cwd jail, scrubs environment to an allowlist, and execs the target.
- Output capture has hard byte caps and truncation markers; stdin optional.
- Timeouts → graceful close then job termination; orphans reaped on `aird` start.
- Before any fs tool operates, `util/paths` + `fs-safe` canonicalize and verify the path is inside an allowed root, resolving junctions/symlinks/reparse points (`realpath`) and rejecting ADS, device names, UNC (unless granted), `\\?\` abuse.
- Network egress per sandboxed process: default none; allow via policy (implemented by Windows Firewall rule keyed to helper path or by routing through a local allowlist proxy — decided in P7-T04).

## 9. IPC protocol

- Transport: Windows named pipe `\\.\pipe\air-<username>` with an ACL granting only the current user SID.
- Framing: NDJSON (one JSON-RPC 2.0 message per line, max 4 MiB).
- Methods (initial): `daemon.health`, `daemon.shutdown`, `session.create`, `session.list`, `run.start`, `run.cancel`, `run.pause`, `run.resume`, `run.list`, `run.get`, `run.replay`, `approval.list`, `approval.resolve`, `logs.tail`, `config.get`, `config.explain`.
- Server→client notifications: `event` (live journal events filtered by subscription), `approval.requested`.
- Protocol version in `daemon.health`; clients refuse mismatched major version.
- Spec: `docs/specs/ipc.md` (to be written in P9-T01).

## 10. Providers

```ts
interface Provider {
  id: string;
  capabilities: { tools: boolean; streaming: boolean; vision: boolean; maxContext: number; ... };
  stream(req: NormalizedRequest, opts: { signal: AbortSignal }): AsyncIterable<ProviderEvent>;
  countTokens?(req): Promise<number>;
}
```
- `NormalizedRequest`/`ProviderEvent` are vendor-neutral (text delta, tool-call delta, usage, stop reason).
- Resilience wrapper adds: timeout, retry (full-jitter exponential backoff, only for `retryable` errors), 429 `Retry-After`, circuit breaker, fallback chain.
- API keys come from `secrets`, never config plaintext.
- Adapters: `anthropic`, `openai-compat` (OpenAI, LM Studio, llama.cpp server, etc.), `ollama`, plus `mock` (scripted; testkit).

## 11. Observability

- **Logs**: pino JSONL, correlation fields auto-injected via `AsyncLocalStorage`. Streams: `runtime`, `audit`, `llm`, `tools`. See `docs/LOGGING.md`.
- **Audit**: separate hash-chained log; `air audit verify` validates the chain.
- **Metrics**: in-process counters/histograms (runs, turns, tool latency, tokens, cost, policy decisions, errors) snapshotted to `logs\metrics.jsonl` and exposed via `daemon.health`.
- **Tracing**: lightweight span API producing `traceId/spanId` in logs and events; OpenTelemetry exporter optional later.

## 12. Concurrency model

- Single Node process for `aird`; one async task per run; tool execution in child processes (sandbox) so CPU-heavy/untrusted work never blocks the event loop.
- Global and per-agent concurrency limits (config). Fair scheduling via kernel run queue.
- All shared mutable state is owned by a single module and mutated only through its API; journal writer is a single serialized queue per stream.

## 13. Configuration

Layering: `defaults < %AIR_HOME%\config\air.config.json < environment (AIR_*) < CLI flags`. Validated by zod; unknown keys are errors.
`air config explain <key>` prints the effective value and which layer set it. Secrets are referenced by name (`"apiKeySecret": "anthropic"`), resolved from Credential Manager.

## 14. Error handling

`AirError { code: string; message; retryable: boolean; cause?; context?; exposeToModel: boolean }`.
- Codes are stable, UPPER_SNAKE (e.g. `POLICY_DENIED`, `TOOL_TIMEOUT`, `PROVIDER_RATE_LIMITED`, `JOURNAL_CORRUPT`, `PATH_ESCAPE`).
- Errors shown to the model are sanitized (`exposeToModel`) — never leak stack traces, secrets, or internal paths.

## 15. Versioning & migration

- Event schema: additive changes only within a major `v`; breaking change → new `v` with upcaster functions in `journal/upcasters`.
- SQLite: numbered migrations in `src/journal/migrations` and `src/memory/migrations`, forward-only, tested from every prior version.
- Config: `version` field; migrator in `config`.
