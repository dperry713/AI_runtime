# Build / Tooling Fluency

## Mission

Diagnose build and CI failures in AI Runtime from evidence and preserve repository quality gates. A local pass is useful but does not substitute for the actual Windows GitHub Actions result.

## Canonical check pipeline

Use current package scripts as the source of truth. The expected high-level order is:

1. Typecheck
2. Lint
3. Dependency architecture check (deps:check or the script currently defined)
4. Unit/integration tests and applicable coverage gates

Start with npm run to inspect available scripts and package.json to confirm exact names. Do not invent aliases or assume a script exists. Run the narrowest failing command first, then the canonical check command.

## Dependency-cruiser

- Read the exact rule ID, severity, source/target paths, and dependency trace.
- Determine whether the import direction violates a layer boundary or reveals misplaced shared contracts.
- Prefer extracting a small port/interface into an allowed lower-level module and injecting the implementation at the composition root.
- Add a regression test for the boundary where possible.
- Do not silence the rule, broaden an allowed path, or add an exception simply to unblock CI.

## PowerShell bootstrap and doctor scripts

- Run scripts from a clean PowerShell session and record PowerShell version, exit code, and sanitized output.
- Check quoting, paths containing spaces, execution policy scope, current working directory, environment assumptions, and idempotency.
- Distinguish a missing script from access denied, a failed prerequisite, and an internal script error.
- Doctor scripts should report actionable checks and return a nonzero exit code when required prerequisites fail.
- Avoid logging secrets or dumping the entire environment.

## GitHub Actions on Windows

- Identify exact workflow, run ID, job, step, runner image, and commit SHA.
- Read the first failing step and preceding setup output; later failures may be cascading symptoms.
- Compare local and CI versions of Node, npm, Rust, MSVC, Windows SDK, and native dependencies.
- Cache package/build artifacts only with keys that include relevant lockfiles, OS, architecture, toolchain, and configuration.
- Validate cache-hit and cache-miss paths; caching must not hide stale generated output or skip required validation.
- For native dependencies, verify architecture and toolchain compatibility rather than assuming the cache is valid.
- After pushing a fix, wait for the associated workflow to complete and inspect each required job. Do not report green based only on commit success or a queued run.

## Coverage failures

- Identify the module and uncovered branches from the report; prioritize security-sensitive paths, including path handling, policy enforcement, sandbox setup, cancellation, and recovery.
- Add assertions that prove both allow and deny outcomes and relevant failure cleanup.
- Do not add meaningless tests, exclude difficult files, or lower thresholds to manufacture a pass.
- If generated or platform-specific code is excluded, ensure the exclusion is explicit, justified, and consistent with project policy.

## Efficient command sequence

1. Run npm ci for a clean dependency install when lockfile and network conditions permit.
2. Inspect npm run and the repository's check script.
3. Run the narrowest failing script or test.
4. Run typecheck, lint, dependency checks, and focused tests.
5. Run the canonical full check pipeline.
6. Reproduce platform-specific behavior on Windows; use CI for final runner-specific verification.
7. Inspect git diff --check, git status --short, and the final diff.
8. Record exact commands and results; explicitly list checks that were not run.

## Definition of done

- Root cause and first failing CI step are identified.
- The fix preserves all applicable architecture, security, and coverage gates.
- Local and Windows CI evidence is reported separately.
- The commit is verified against the correct workflow run and SHA.
