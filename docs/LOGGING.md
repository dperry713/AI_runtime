# LOGGING.md — structured logging, audit, metrics, tracing

Goal: any run can be fully reconstructed and any failure diagnosed from logs alone, without leaking secrets,
on a Windows machine, with bounded disk usage.

## 1. Streams and locations (`%AIR_HOME%\logs`, default `%LOCALAPPDATA%\AIR\logs`)

| File | Content | Default level | Retention |
|---|---|---|---|
| `runtime.log` | Daemon, kernel, config, IPC, supervisor, recovery, general component logs | `info` | 50 MB × 10 files |
| `audit.log` | Policy decisions, approvals, tool executions (who/what/why), config changes. **Hash-chained.** | always | 100 MB × 20 (never silently deleted: rotation seals file and records the chain head) |
| `llm.log` | Model request/response metadata: provider, model, tokens, cost, latency, finish reason, retries. Payload bodies per `logging.llmPayloads` | `info` | 50 MB × 10 |
| `tools.log` | Tool call lifecycle: args summary, capability set, decision id, duration, exit status, output size | `info` | 50 MB × 10 |
| `metrics.jsonl` | Periodic metric snapshots (every 60 s) | n/a | 20 MB × 5 |
| `crash\*.json` | Uncaught exception / unhandled rejection last-gasp reports (stack, active runs, recent log tail) | n/a | 30 days |

Windows Event Log (source `AIR`): only service start/stop and fatal errors (P12-T01).
Format: **JSON Lines**, UTF-8 without BOM, `\n` line endings, one record per line.

## 2. Record schema (v1) — every record

```json
{
  "v": 1,
  "ts": "2026-10-15T14:03:22.114Z",
  "level": "info",
  "stream": "runtime",
  "component": "kernel.supervisor",
  "event": "run.started",
  "msg": "run started",
  "pid": 12345,
  "host": "DESKTOP-XXXX",
  "sessionId": "01J...",
  "runId": "01J...",
  "turnId": "01J...",
  "toolCallId": "01J...",
  "traceId": "...",
  "spanId": "...",
  "durationMs": 12.4,
  "err": { "code": "TOOL_TIMEOUT", "message": "...", "retryable": true, "stack": "..." },
  "data": { }
}
```
- `event` is a **stable, dot-separated machine name** (grep-able, aggregated). `msg` is human text.
- `data` carries event-specific fields; sizes are capped (default 8 KB per record; larger values are truncated with `"_truncated":true`).
- Correlation ids are injected automatically from `AsyncLocalStorage` (`withContext({runId, ...}, fn)`). Never pass them manually in `data`.
- A **log-schema snapshot test** guards the record shape; changes need a `v` bump.

## 3. Levels

| Level | Use |
|---|---|
| `fatal` | Process cannot continue; written synchronously, then exit |
| `error` | Operation failed and was not recovered (include `err`) |
| `warn` | Recovered/degraded: retries, fallbacks, truncated outputs, policy denies, budget 80% |
| `info` | Lifecycle & business events: run/turn/tool start/end, decisions, config load |
| `debug` | Detailed internals: provider chunks (counts), queue depths, cache hits |
| `trace` | Very verbose, per-event; off in production; never contains secrets |

Level via config `logging.level` and per-component overrides `logging.levels["providers.anthropic"]="debug"`; runtime change via `air config set` / IPC `config.set` without restart.

## 4. Redaction (non-negotiable — rule R4)

- All secrets resolved by `secrets` are registered with the **redaction registry**; any occurrence (exact, base64, URL-encoded, JSON-escaped, and last-4 prefix patterns) in any log field is replaced by `[REDACTED:<name>]`.
- Pattern redactors: bearer tokens, `sk-…` style keys, AWS keys, private-key blocks, `Authorization`/`Cookie`/`Set-Cookie` headers, connection strings with passwords.
- Field-name redaction: keys matching `(?i)(password|secret|token|apikey|authorization|cookie)` are always redacted.
- **LLM payloads**: `logging.llmPayloads = off | redacted | full` (default `redacted`). `full` requires explicit opt-in and writes to a separate file with restrictive ACL. Prompts can contain user data; treat as sensitive.
- Tests: a canary secret is injected into config, env, tool output, and provider responses; assert it never appears in any stream, crash report, or journal payload.

## 5. What MUST be logged (minimum event catalogue)

- **system**: `system.starting`, `system.config_loaded` (effective config hash, not secrets), `system.recovered`, `system.stopping`, `system.stopped`.
- **run**: `run.created|started|paused|resumed|completed|failed|cancelled|budget_exceeded` with budget snapshot.
- **turn/model**: `model.requested` (provider, model, msg count, est. tokens), `model.responded` (usage, cost, latency, stop reason), `model.retry`, `model.failed`, `context.compacted`.
- **tool**: `tool.requested`, `tool.policy_decided` (decision, rule id, reason), `tool.approval_requested|resolved`, `tool.started`, `tool.completed|failed|timed_out|cancelled` (duration, output bytes, truncated?).
- **sandbox**: spawn (command hash + redacted argv, job id, limits), exit code, kill reason, resource peaks.
- **ipc**: client connected/disconnected (pid, version), request errors, oversized frames.
- **journal**: segment rotated, fsync batch stats, recovery actions, corruption detected.
- **provider health**: circuit state changes, fallback activations, rate-limit waits.
- **security**: path escape attempts, injection heuristics hits, denied capabilities (also to `audit.log`).

## 6. Audit log (`audit.log`)

Record = log record + `{ "seq": n, "prev": "<sha256>", "hash": "<sha256>" }` where `hash = sha256(prev || canonicalJSON(record without hash))`.
`air audit verify [--file]` walks the chain and reports the first broken `seq`. Rotation writes a final `chain.seal` record containing the head hash, and the next file's first record references it.
Audit covers: every policy decision, approval request/resolution (including the human identity = Windows username), every tool execution outcome, config/policy changes, daemon start/stop, plugin/MCP loads.

## 7. Metrics

Counters: `runs_total{state}`, `turns_total`, `tool_calls_total{tool,outcome}`, `policy_decisions_total{decision}`, `provider_requests_total{provider,outcome}`, `tokens_total{provider,model,kind}`, `cost_usd_total`, `errors_total{code}`, `journal_events_total{type}`.
Histograms: `tool_duration_ms{tool}`, `model_latency_ms{provider,model}`, `turn_duration_ms`, `journal_append_ms`, `ipc_request_ms{method}`.
Gauges: `active_runs`, `pending_approvals`, `eventbus_queue_depth`, `rss_bytes`, `open_handles`, `child_processes`.
Snapshot every 60 s to `metrics.jsonl`; also via IPC `daemon.health`.

## 8. Tracing

Lightweight spans: `withSpan('tool.exec', fn)` → `traceId`/`spanId` in logs and journal correlation. One trace per run; child spans per turn/model/tool. OpenTelemetry export is optional later (P12).

## 9. Operational behavior

- **Async, bounded**: logging never blocks the event loop; in-memory buffer capped (default 10k records); on overflow, drop `debug/trace` first, never drop `warn+` or audit; count drops in a metric and emit a `logging.dropped` warn.
- **Flush on exit**: `fatal`, `SIGINT/SIGTERM`-equivalents (Windows console ctrl events, service stop) flush all streams.
- **Disk safety**: total log size budget (`logging.maxTotalMb`, default 1024); if exceeded, oldest non-audit files are deleted first; audit never auto-deleted.
- **Permissions**: logs directory ACL restricted to the current user + SYSTEM + Administrators.
- **Clock**: timestamps from injected `Clock`; durations from monotonic clock.

## 10. Reading logs on Windows (before `air logs` exists)

```powershell
Get-Content "$env:LOCALAPPDATA\AIR\logs\runtime.log" -Tail 50 -Wait | ForEach-Object { $_ | ConvertFrom-Json } | Format-Table ts,level,component,event,msg
Select-String -Path "$env:LOCALAPPDATA\AIR\logs\*.log" -Pattern '"runId":"<RUNID>"'
```

## 11. Developer rules

- Get a logger with `getLogger('component.name')`; never construct pino directly outside `observability`.
- Log **events with fields**, not interpolated sentences: `log.info({ event:'tool.started', data:{ tool, bytes } }, 'tool started')`.
- Log errors once, at the boundary that handles them, with `err`. Don't log-and-rethrow.
- Never log full file contents, full prompts (unless `llmPayloads` allows), or environment dumps.
