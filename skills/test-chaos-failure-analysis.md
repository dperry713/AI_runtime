# Test & Chaos Failure Analysis

## Mission

Turn a red test or chaos run into a minimal, reliable reproducer and a regression test that proves the intended contract. Prioritize correctness and security over making the suite green quickly.

## Failure triage

1. Record exact command, test file/name, seed, commit SHA, Node version, OS, and first meaningful failure.
2. Classify the failure: assertion, setup/teardown, timeout, unhandled rejection, resource leak, environmental dependency, coverage gate, or product defect.
3. Run the single test, then the containing file, then the relevant test group. Avoid repeatedly running the full suite before the failure is understood.
4. Preserve the first failure and logs; retries can hide race conditions.
5. Check whether the test assumes ordering, shared global state, wall-clock timing, a fixed port, a particular temp path, or a process that was not cleaned up.

## Vitest unit and integration tests

- Keep unit tests deterministic and isolated; use integration tests for filesystem, IPC, child process, native helper, and persistence contracts.
- Await all asynchronous work and ensure rejected promises fail the test.
- Restore mocks, environment variables, timers, signal handlers, and global state in teardown.
- Use explicit readiness signals instead of arbitrary startup sleeps.
- Assert externally observable behavior and security invariants, not private implementation details unless the internal invariant itself is the contract.
- For cancellation, assert the operation settled, child process exited, and temporary resources were removed—not merely that abort was requested.

## Flaky-test isolation

- Re-run with the same seed and with a changed seed when applicable; compare timestamps and scheduling.
- Test under constrained CPU/load only after a stable baseline exists.
- On Windows, check antivirus/file-indexer interference, file locks, path length, OneDrive synchronization, and process cleanup as hypotheses, not default excuses.
- Use unique temporary directories and ports; avoid shared mutable fixtures.
- Prefer fake clocks and explicit synchronization to increasing timeouts.
- If a retry is required for diagnosis, record retry count and first-run outcome. Do not add automatic retries that mask product races.

## Security and chaos intent

For every chaos test, identify the failure it injects and the invariant that must survive.

| Fault injected | Required evidence |
| --- | --- |
| Child killed during a tool run | Operation settles; child/descendants do not leak; journal state is coherent |
| IPC disconnect or truncated frame | Bounded failure; no protocol desynchronization or unsafe fallback |
| Corrupt/truncated journal | Recovery follows documented policy and preserves source evidence |
| Sandbox setup denied | Execution does not proceed unrestricted |
| Cancellation at each phase | No leaked process, handle, listener, timer, or temporary file |
| Invalid/oversized input | Boundary rejects it without crash or unbounded resource use |
| Native helper crash | Caller reports typed failure, cleans up, and does not claim isolation succeeded |
| Egress enforcement failure | Mandatory network restrictions fail closed |
| Credential backend unavailable | No secret leakage and no unintended plaintext fallback |

## Minimal reproduction workflow

- Reduce inputs, mocks, process count, and timing variation while retaining the failure.
- Turn the reproducer into a test before changing production code when feasible.
- Make the test fail for the original reason, not an incidental implementation detail.
- Fix the root cause, then run the reproducer repeatedly and the nearest regression group.
- Run the full repository pipeline once targeted tests are stable.

## Coverage gates

- Treat coverage thresholds as a risk signal, not a target to game.
- Add meaningful branch/error-path assertions for critical modules such as path canonicalization, policy decisions, and sandbox setup.
- Do not exclude code or lower thresholds solely to pass CI. If a threshold must change, document risk, rationale, and approval.
- Inspect uncovered branches corresponding to security denials, cancellation, recovery, and error translation.

## Definition of done

- The original failure has a minimal reproducer and a regression test.
- Cleanup is asserted and verified for resources created by the test.
- Security/chaos tests still exercise the threat model they claim to cover.
- Focused tests and required CI pass without hidden retries, broad skips, or weakened assertions.
