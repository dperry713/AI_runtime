# TESTING.md — AIR test strategy

Principle: **no test, no DONE.** Tests are written with the code, run on Windows, and are deterministic by default
(fake clock, seeded randomness, scripted provider). Live-model and long-running tests are opt-in.

## 1. Test pyramid and directories

| Kind | Dir | Speed | Runs in | What it proves |
|---|---|---|---|---|
| Unit | `tests/unit/<module>/` | ms | every `npm test`, CI | Pure logic: paths, config, policy rules, event schemas, backoff, redaction |
| Integration | `tests/integration/<area>/` | <5 s each | every `npm test`, CI | Real SQLite, real journal files (temp dir), real logger sinks, provider adapters vs local mock HTTP server |
| E2E | `tests/e2e/` | 5–60 s | CI + `npm run test:e2e` | Real `aird` process on a temp named pipe, real `air` client, scripted provider |
| Chaos | `tests/chaos/` | minutes | nightly CI + manual | Kill -9 at random points, torn writes, disk-full simulation, provider fault storms, clock jumps |
| Security | `tests/security/` | seconds–minutes | CI (core) + nightly (full corpora) | Path traversal, sandbox escape, prompt-injection, secret exfiltration, policy bypass, SSRF |
| Perf | `tests/perf/` | minutes | nightly, tracked | Throughput/latency budgets, memory growth, handle leaks |
| Eval | `tests/eval/` | varies | opt-in (`AIR_LIVE_TESTS=1`) | Agent task success with real models, retrieval quality |
| Soak | `tests/perf/soak/` | 72 h | pre-release | Leaks, drift, rotation, recovery over time |

Helpers live in `tests/helpers/` (fake clock, temp AIR_HOME factory, scripted provider builder, event assertions, log capture sink, mock MCP server, pipe-name generator). Fixtures in `tests/fixtures/` (`transcripts/`, `configs/`, `policies/`, `corpora/`).

## 2. Rules

1. **Deterministic**: inject `Clock`, `Random`, `IdGenerator`. No real sleeps (use fake timers / advance the fake clock). No network except localhost mock servers.
2. **Isolated**: every test that touches disk uses a fresh temp `AIR_HOME` under `var\test-tmp\<uuid>`; cleaned on success, kept on failure (path printed).
3. **Windows-first**: path tests must include Windows-specific cases; CI runs on `windows-latest`. Tests that cannot run on Windows are a bug.
4. **Regression-first**: every bug gets a failing test before the fix.
5. **No skipped tests** without a linked `BUILD_STATUS.md` blocker. `it.skip` fails lint.
6. **Behavior names**: `it('denies fs.write outside the jail')`, not `it('works')`.
7. **Logs are asserted**: tests for new behavior assert the expected log records (level, event name, correlation ids) via the capture sink; and assert **absence of secrets** in all captured records.
8. **Snapshots only for stable schemas** (log record shape, event envelopes, IPC messages). Snapshot changes require reviewer-visible justification in the commit.

## 3. Mandatory test suites (by area)

### Paths / fs-safe (`util`)
- ≥ 100 explicit Windows cases: `..\`, mixed `/` and `\`, `C:foo` (drive-relative), UNC `\\server\share`, `\\?\C:\`, `\\.\pipe\x`, device names (`CON, PRN, AUX, NUL, COM1..9, LPT1..9`, with extensions `NUL.txt`), trailing dots/spaces, alternate data streams `file.txt:stream`, `::$DATA`, 8.3 short names (`PROGRA~1`), case-insensitive roots, Unicode normalization & confusables, very long paths (> 260), junctions, symlinks, hardlinks, reparse points created in-test.
- Property tests (fast-check): for any generated path string, `isInside(root, p)` true ⇒ canonical resolved path starts with canonical root.

### Journal
- Replay equivalence: `fold(replay(events)) deepEquals live projection` (property test over random event sequences).
- Torn-write: truncate segment at every byte offset of the last record → recovery yields a valid prefix, `seq` gapless.
- Mid-file corruption: detected with line number; segment quarantined; rest readable.
- Index loss: delete `index.sqlite` → rebuilt from segments identically.
- Chaos: child process appending events killed with `taskkill /F` at random times, 1,000 iterations.
- Concurrency: N writers on distinct streams, 1 writer per stream serialized; no interleaving corruption.

### Policy
- Property tests: deny beats allow at equal specificity; adding a deny rule never increases permissions; evaluation order of rules doesn't change outcome.
- Bypass corpus: case tricks, path aliasing (8.3, junction, `..`), unicode confusables, argument smuggling (`;`, `&&`, backticks, `-EncodedCommand`), env var expansion, wildcard abuse.
- Taint: tainted args to `risk >= medium` tools escalate; headless mode denies.
- Audit: after every E2E run, `verifyAuditChain()` passes; tamper tests fail at the correct index.

### Providers
- Shared **contract suite** run against every adapter: text stream, tool call stream, parallel tool calls, usage reporting, abort mid-stream, malformed chunk, HTTP 429 with `Retry-After`, 5xx retry, timeout, connection reset.
- Resilience: circuit breaker opens/half-opens/closes under fake clock; fallback chain order.
- No API key ever in logs, errors, or recorded fixtures (scrubber test).

### Tools / Sandbox
- Schema fuzzing: random invalid inputs never crash executor; always `AirError{code:'TOOL_INVALID_ARGS'}`.
- Timeout/cancel: process tree fully dead within N ms; no orphan PIDs (checked by enumerating the job).
- Hostile processes: fork bomb, memory hog, infinite stdout, deep tree, detached `start`, writing outside jail, reading `%USERPROFILE%\.ssh`, env secret probing.
- SSRF corpus: private/loopback/link-local IPs in decimal/hex/octal/IPv6-mapped forms, DNS rebinding (resolve-twice), redirects to private IPs.
- Atomic write: kill during write never leaves a truncated target (temp+rename).

### Agent loop
- Golden-transcript E2E with scripted provider: single answer; multi-tool; parallel tools; tool error recovery; denial recovery; approval flow (approve/deny/timeout); budget exhaustion (each dimension); cancel mid-tool; pause/resume; crash-resume (idempotent vs non-idempotent tool); context compaction; stall detection.
- Replay: replaying any recorded run reproduces identical policy decisions and tool-call sequence.
- Provider event-ordering fuzz: shuffled/duplicated/dropped deltas never crash the engine.

### IPC / Daemon / Shell
- Real `aird` on unique pipe: concurrent clients, client crash mid-stream, daemon crash + restart with in-flight run, oversized frame (> 4 MiB) rejected, malformed JSON, protocol version mismatch, different-user connection refused (ACL).
- Shell: command outputs in `--json` mode validated against schemas; exit codes asserted.

### Memory
- Retrieval fixtures with expected top-k; poisoning tests; forget guarantees (row + FTS + vector); migration from every prior schema.

## 4. Coverage gates (`vitest.config.ts`)

- Global: lines ≥ 85%, functions ≥ 85%, branches ≥ 80%.
- Critical modules (`policy`, `journal`, `util/paths`, `sandbox` runner, `observability/audit`): lines ≥ 95%, branches ≥ 90%. (Per-module thresholds added in P1-T10 and extended as modules appear.)
- Coverage may not decrease; PRs lowering thresholds need an ADR.

## 5. Commands

```powershell
npm test                  # unit + integration (fast, default gate)
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:chaos        # long; set AIR_CHAOS_ITERATIONS to scale (default 200, nightly 1000)
npm run test:security
npm run test:perf
npm run test:coverage
.\scripts\test.ps1 -Kind unit|integration|e2e|chaos|security|perf|all   # same, with log capture to var\test-logs\
$env:AIR_LIVE_TESTS = "1"; npm run test:eval   # live provider tests (needs secrets in Credential Manager)
```

## 6. Test logging

Test runs capture all runtime logs into `var\test-logs\<run-ts>\` (JSONL) when a test fails; the failing test prints the path and the correlation ids so the exact run can be traced with `air logs --file <path> --run <RunId>` (once P9 ships) or `Select-String` / `jq` before that.

## 7. CI

`.github/workflows/ci.yml`: on push/PR → Windows runner, Node 22: install, typecheck, lint, deps:check, unit+integration+e2e, coverage. Nightly schedule: chaos (1,000 iterations), full security corpora, perf benchmarks (results uploaded as artifacts and compared with baseline; >15% regression fails).
