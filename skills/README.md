# AI Runtime Engineering Skills

These playbooks give coding agents and maintainers a repeatable, evidence-driven process for diagnosing failures in AI Runtime. They are operational checklists, not substitutes for repository policy, threat modeling, or tests.

## Skill index

- [TypeScript / Node.js Systems Debugging](typescript-node-systems-debugging.md)
- [Windows Process & Security Internals](windows-process-security-internals.md)
- [Native Interop: Rust ↔ Node.js](native-interop-rust-node.md)
- [Event-Sourced Journal Debugging](event-sourced-journal-debugging.md)
- [Test & Chaos Failure Analysis](test-chaos-failure-analysis.md)
- [Build / Tooling Fluency](build-tooling-fluency.md)

## Common debugging contract

1. Reproduce the failure on the smallest reliable scope before editing code.
2. Capture the exact command, exit code, environment, OS, Node/Rust versions, commit SHA, and relevant logs.
3. Form a falsifiable hypothesis and identify the test that would disprove it.
4. Fix the invariant at the correct boundary; do not weaken validation, security controls, lint rules, coverage gates, or tests just to obtain a green build.
5. Add a regression test for the original failure and adjacent edge cases.
6. Run focused tests first, then the required repository check pipeline and applicable Windows/native CI.
7. Review the diff for unintended API, layering, security, and observability changes.
8. Report evidence: what failed, root cause, exact change, commands run, results, and remaining uncertainty.

## Safety rules

- Treat tool inputs, journal entries, IPC payloads, paths, and child-process output as untrusted.
- Never log secrets, raw credential values, access tokens, or sensitive environment variables.
- Do not execute adversarial payloads against a host outside an isolated test fixture.
- Prefer temporary directories and disposable child processes for chaos tests; guarantee cleanup in test teardown.
- Never mark a test as flaky or skip it without recording evidence and a follow-up issue.
