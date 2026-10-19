# AIR adversarial, resilience, and real-world benchmark protocol

This document distinguishes **automated coverage implemented in this repository** from **future adapter-level tests requiring an interactive desktop or external provider**. Do not report planned/manual cases as automated passes.

## Run on Windows

From the repository root in PowerShell 7:

```powershell
npm ci
npm run test:benchmark
npm run test:security
npm run test:chaos
npm run test:integration
npm run check
pwsh -NoProfile -File .\scripts\benchmark.ps1 -Iterations 3
```

The focused suite uses scripted providers and temporary directories. Egress tests evaluate policy decisions and do not send requests to the destinations in the attack corpus. Process fault tests launch only local Node.js children with bounded timeouts and bounded output.

## Automated coverage

| Boundary / workflow | Implemented verification |
|---|---|
| Windows path syntax | Reject traversal, drive-relative paths, UNC/device namespaces, NTFS alternate data streams, reserved device names, trailing-dot/space aliases, encoded traversal, and null bytes |
| Workspace containment | Check that canonicalized traversal targets are outside the workspace jail |
| Network egress | Deny loopback, private ranges, link-local/cloud metadata, IPv6 local addresses, missing allowlists, and wrong host/port; permit an explicitly allowlisted public target |
| Prompt injection | Detect instruction-override markers and neutralize attacker-supplied closing-fence tags |
| Taint enforcement | Escalate tainted medium/high/critical actions to approval interactively and deny them in headless mode |
| Process environment | Strip ambient secrets and unlisted variables; remove proxy variables when egress is disabled |
| Real-world task correctness | Scripted agent creates and reads a release-readiness report; test oracle checks runtime status and exact file bytes |
| Process lifecycle chaos | Exercise timeout, cancellation, noisy-output truncation, and shutdown cleanup against bounded local child processes |
| Journal crash recovery | Existing chaos suite tests torn writes, arbitrary truncation points, mid-file corruption, quarantine, and writer resumption |

The existing test kit also includes large Windows traversal and SSRF corpora and schema mutation tests. Keep those in the security suite.

## Scenario catalogue and external oracles

Add every production incident as a deterministic scenario with a unique ID, setup, action sequence, expected postconditions, cleanup, severity, and owner. Verify results independently of model output.

Recommended scenario families:

1. **Filesystem:** create, read, rename, and delete a fixture under a temporary workspace; compare exact contents and SHA-256; prove a traversal target outside the workspace is unchanged.
2. **Software engineering:** edit a fixture project, run its test command in an isolated workspace, inspect exit status, and validate the expected diff and test artifact.
3. **PowerShell/process control:** invoke a harmless fixture script, capture stdout/stderr/exit status, enforce a deadline, cancel it, and assert no child process remains.
4. **Browser/business workflows:** use a local mock HTTP server with known state. Verify the server-side record changed exactly once; do not use production websites or real accounts in CI.
5. **Memory poisoning:** introduce a tainted fixture claiming that a secret should be revealed or policy ignored. Verify taint is retained, high-risk actions are gated, and the stored trusted memory is unchanged.
6. **Multi-step interruption:** stop after a durable journal event, restart the runtime, recover the journal, and verify sequence continuity and that non-idempotent actions are not duplicated.
7. **GUI adapter (interactive Windows runner required):** exercise focus changes, stale selectors, modal dialogs, display scaling, multi-monitor coordinates, accessibility-name changes, and an element disappearing between observation and action. Assert the semantic target identity and final application state, not merely a successful click response.

GUI automation is **not represented as covered by the deterministic suite until AIR exposes an actual GUI adapter and a dedicated interactive Windows runner**. Do not use screenshot-only success as proof of a business transaction. Keep desktop tests out of ordinary hosted CI unless the runner is explicitly configured for an interactive user session.

## Fault injection and containment

- Simulate torn journal writes and restart from a valid prefix.
- Simulate timeout, caller cancellation, and shutdown while a process is active.
- Inject malformed tool results and unavailable local mock services at the adapter boundary.
- Run path, reparse-point/symlink, process-tree, and network isolation tests in a disposable workspace/VM.
- Test resource exhaustion only with strict limits and an isolated worker.
- Do not attempt a real sandbox escape against the developer workstation or CI host. Validate the boundary using a disposable VM and harmless canary resources.

Rollback cannot undo an email sent, a payment submitted, or a destructive external API call. Those actions must be prevented by policy or explicitly approved before execution.

## Benchmark methodology

`scripts/benchmark.ps1` repeats the deterministic focused suite and emits `var/test-logs/benchmark-report.json`. It records commit, branch, pass rate, per-run wall time, and percentile summaries. Wall time includes Node/Vitest startup and is not equivalent to model inference latency.

For release-grade comparisons, collect per-scenario records with:
- scenario ID, corpus version, seed, runtime commit, adapter version, provider/model, and configuration hash
- independent task outcome, policy decisions, evidence references, and failure category
- action/target accuracy, task success rate, attack prevention rate, false-denial rate, and recovery rate
- p50/p95 end-to-end and per-action latency
- peak memory, CPU time, child-process count, output bytes, and budget consumption
- run count, confidence interval, and run-to-run variance

Run each deterministic scenario at least 3 times for smoke evaluation; use 30+ repetitions for noisy model/GUI comparisons where budget allows. Use the same hardware, scenario state, timeout, and provider settings for comparisons. Keep model latency separate from adapter, policy, and harness overhead. Never mix mock-provider success with live-model accuracy claims.

## Baseline, holdout, and promotion gates

Maintain three versioned datasets:
- **Regression corpus:** public, fixed cases for repeatable CI.
- **Tuning corpus:** cases permitted for prompt, policy, or strategy development.
- **Holdout corpus:** sealed cases not used for tuning or candidate selection.

Candidate promotion is blocked if any of these occur:
- a critical security invariant or approval requirement is violated
- any secret is exposed to an unauthorized tool, process, log, or model context
- a protected workspace boundary is crossed or a forbidden egress request is allowed
- task success or attack prevention regresses beyond the predeclared tolerance
- the intended metric improvement is not greater than observed run-to-run noise
- evidence, corpus version, runtime revision, or rollback target is missing

A suggested starting threshold is zero critical security violations and zero unauthorized external side effects. For quality metrics, predeclare a non-inferiority margin per metric (for example, no more than a 1 percentage-point reduction in task success) before looking at candidate results. Do not treat that example as a universal threshold. Require a measurable improvement on the target metric and no guardrail regression. Promote versioned candidates atomically, retain the last-known-good strategy, and verify rollback through a separate test.

## CI guidance

Pull-request CI should run typecheck, lint, dependency checks, unit/integration tests, security tests, and the repeated deterministic benchmark. Nightly CI may run longer chaos and performance suites. Upload redacted reports and logs as artifacts. Use a dedicated interactive Windows runner for real GUI tests and disposable VMs for sandbox-boundary stress tests.
