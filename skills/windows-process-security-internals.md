# Windows Process & Security Internals

## Mission

Diagnose Windows-specific sandbox, IPC, path, credential, networking, and process-lifecycle failures. Treat the sandbox boundary as a security boundary: verify behavior on supported Windows runners, not only by reasoning from portable code.

## Triage sequence

- Capture Windows edition/build, architecture, account context, elevation state, PowerShell version, Node version, and process bitness.
- Record process IDs, parent PIDs, exit codes, handles where available, and timestamps for start/cancel/exit.
- Reproduce in a disposable work directory and unprivileged test account when feasible.
- Separate an expected policy denial from a setup failure, access-denied error, timeout, and crash.
- Collect evidence before cleanup, then ensure test processes and temporary files are removed.

## Job Objects and process trees

- Verify whether the child is assigned to the intended Job Object before untrusted code starts.
- Check job limits and whether kill-on-job-close is configured and actually applied.
- Test descendants, not just the direct child: a shell may spawn another process that outlives its parent.
- On cancellation, distinguish request dispatch from confirmed process exit. Await process close/exit and enforce a bounded timeout.
- Test spawn failure, early exit, timeout, cancellation, daemon shutdown, and parent crash paths.
- Avoid unsafe process-name-based termination. Track process identity and ownership to prevent killing unrelated processes.

## Restricted tokens and AppContainer

- Confirm effective token/capabilities and integrity level rather than assuming requested restrictions were applied.
- Verify filesystem, registry, named-object, and network access with positive and negative tests.
- Treat profile creation, capability assignment, and access-denied results as explicit states with actionable diagnostics.
- Do not silently fall back to unsandboxed execution. Fail closed when the security contract cannot be established.
- Keep privileged setup code small, auditable, and separate from untrusted execution.

## Named pipes and ACLs

- Inspect pipe name construction, instance lifetime, server identity, client identity checks, and ACL/security descriptor.
- Verify only intended user/service principals can connect; an unpredictable pipe name is not authentication.
- Test unauthorized clients, simultaneous clients, stale pipe instances, daemon restart, disconnect mid-message, and partial reads/writes.
- Define framing, message-size limits, timeouts, and protocol version explicitly.
- Use Sysinternals tools such as Process Explorer and AccessChk where appropriate to inspect ownership, handles, and effective access. Record exact commands and output.

## Path canonicalization and filesystem jail

- Normalize paths and resolve them against a trusted root, but do not assume string-prefix checks establish containment.
- Account for drive-letter casing, relative segments, UNC paths, extended-length device paths, junctions/reparse points, alternate data streams, short 8.3 names, and symlink races.
- Check containment using canonical paths and actual filesystem semantics; consider reparse-point traversal between validation and open.
- Prefer handle-based validation or APIs that constrain traversal where feasible.
- Test sibling-prefix tricks, nested traversal, alternate streams, junctions pointing outside the root, UNC targets, short names, and paths that change between check and use.
- Ensure deny decisions are observable without leaking sensitive absolute paths to untrusted callers.

## Egress / Windows Filtering Platform

- Confirm which component owns policy, rule creation, rule cleanup, and recovery after crash.
- Test allowed and denied destinations, IPv4/IPv6, DNS resolution changes, loopback, proxy use, and existing host firewall policy.
- Verify effective traffic behavior; the presence of a rule is not proof that egress is blocked.
- Fail closed if mandatory egress enforcement cannot be installed. Do not represent best-effort application checks as OS-enforced isolation.

## Credential Manager and DPAPI-style secrets

- Keep secrets out of command-line arguments, logs, crash reports, and test snapshots.
- Verify intended user/machine scope, persistence behavior, and access identity.
- Test missing, corrupted, inaccessible, and rotated credentials, plus concurrent read/write and interrupted updates.
- Confirm plaintext exists only for the minimum lifetime and is cleared where practical; do not claim guaranteed zeroization for managed strings.
- Verify redaction in success, exception, and debug paths.

## Practice targets

- Reproduce a child or grandchild that survives cancellation and prove the Job Object lifecycle fix.
- Inspect named-pipe ACLs and verify unauthorized connection denial.
- Build path-jail regression cases for junctions, ADS, UNC, 8.3, and extended-length paths.
- Test that failed sandbox setup never falls back to unrestricted execution.
- Simulate daemon restart and ensure stale processes, handles, and network rules are reconciled.

## Definition of done

- The security property is demonstrated by a negative test and a positive control.
- Process-tree cleanup is observed, not inferred.
- Windows-specific tests run on Windows CI or are explicitly identified as not yet verified.
- Diagnostics are sufficient to investigate failures without exposing secrets.
