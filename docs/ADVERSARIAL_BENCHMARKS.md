# AIR adversarial and real-world benchmark suite

This suite complements unit and integration coverage with two different questions:

1. **Security invariants:** does AIR reject hostile inputs and preserve its enforcement boundaries?
2. **Task correctness:** did the runtime create the expected real artifact, independently of what the model claimed?

## Run on Windows

From the repository root:

```powershell
npm run test:benchmark
npm run test:security
npm run test:integration
npm run check
```

The focused benchmark command is deterministic and does not call a live model. The SSRF tests evaluate policy decisions only; they do not make outbound HTTP requests. The real-world simulation uses a scripted provider and a fresh temporary workspace.

## Included attack classes

| Boundary | Test behavior |
|---|---|
| Windows paths | Reject traversal, drive-relative paths, UNC/device namespaces, NTFS alternate data streams, reserved device names, trailing-dot/space aliases, encoded traversal, and null bytes |
| Network egress | Deny loopback, private ranges, link-local/cloud metadata, IPv6 local addresses, missing allowlists, wrong hosts, and wrong ports |
| Prompt injection | Detect instruction override patterns and prevent untrusted output from breaking its enclosing fence |
| Taint escalation | Require interactive approval for tainted medium/high/critical actions and deny those actions in headless mode |
| Process environment | Strip ambient API credentials, tokens, passwords, unlisted variables, and proxy configuration when egress is disabled |
| Real-world task | Agent writes a release-readiness report and reads it back; the test independently checks the exact file bytes and final runtime status |

## Benchmark rules

- A model response such as “done” is never accepted as proof of task completion.
- Test fixtures use isolated temporary directories and deterministic provider scripts.
- Attack tests assert decisions and observable side effects, not only error messages.
- Keep every discovered defect as a permanent regression case.
- Never run destructive payloads against the host as part of ordinary CI. Process-tree, filesystem-jail, DNS-rebinding, resource-exhaustion, and crash-recovery stress tests belong in isolated Windows workers/VMs.
- This focused suite is not a substitute for full Windows sandbox escape testing or live-model evaluation.

## Metrics to collect as the suite grows

Record these per runtime revision and provider/model configuration:

- task success rate based on external postcondition checks
- attack prevention rate, grouped by attack class and severity
- false-denial rate on benign controls
- policy-decision and task-completion latency (p50/p95)
- recovery success after injected interruption
- run-to-run variance across repeated scenario seeds
- regression count and security-invariant violations

Keep a fixed public regression corpus and a separate holdout corpus. Do not tune prompts or policy logic against holdout failures and then continue reporting the same holdout as an unbiased evaluation set.

## Promotion gates for self-improvement

Do not promote a learned strategy unless it passes the baseline and holdout suites, creates no critical policy/approval violations, causes no secret leakage, and improves the intended metric beyond normal run-to-run variance. Store the candidate version, test corpus revision, provider/model settings, raw scores, and decision rationale. Retain the last-known-good strategy for rollback. Irreversible external actions must be prevented or explicitly approved; rollback cannot undo them.
