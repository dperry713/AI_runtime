# AGENTS.md — START HERE (for any AI agent or human contributor)

> This file is the entry point. Read it fully before touching anything.
> Project: **AIR — AI Runtime** (`C:\Users\d\OneDrive\Desktop\AI_runtime`)
> Platform: **Windows 10/11, PowerShell, Node.js 22 LTS, TypeScript (strict, ESM)**

## 1. What this project is (30-second version)

AIR is a **production-grade, AI-native agent runtime and shell for Windows**. It is a long-running
daemon (`aird`) that hosts LLM-driven agents as managed, supervised, observable, policy-governed
processes, plus an interactive shell (`air`) that talks to the daemon over a Windows named pipe.

Every agent action (model call, tool call, approval, memory write) is an **event** in an append-only
**journal**, so any run can be audited, resumed after a crash, and deterministically replayed.
Every tool call passes through a **deny-by-default policy engine** and, for process execution, an
OS-level **sandbox** (Windows Job Objects). Everything is **logged in structured form** and
**covered by extensive automated tests**.

Full detail: `docs/PROJECT.md`. Design: `docs/ARCHITECTURE.md`.

## 2. MANDATORY read order

1. `BUILD_STATUS.md` — what is done, what is in progress, what is next, blockers. **Source of truth for progress.**
2. `docs/PROJECT.md` — vision, concepts, glossary, scope, non-goals.
3. `docs/ARCHITECTURE.md` — modules, dependency rules, state machines, protocols, data layout.
4. `docs/BUILD_PLAN.md` — phase-by-phase plan; read the section for the **current phase** only, plus exit criteria.
5. As needed: `docs/TESTING.md`, `docs/LOGGING.md`, `docs/SECURITY.md`, `docs/MODULES.md`, `docs/DIRECTORY.md`, `docs/adr/`.

## 3. Operating protocol (follow every session)

1. Read the files above. Run `scripts\doctor.ps1` if the environment is unfamiliar.
2. Pick the first unblocked task under **NEXT UP** in `BUILD_STATUS.md`. Do not skip ahead to a later phase
   unless every task in earlier phases is `DONE` or explicitly `DEFERRED` with a reason.
3. **Before editing code**: set the task to `IN_PROGRESS` in `BUILD_STATUS.md` with your agent id and timestamp.
4. Implement the task **together with its tests** (tests are part of the task, not a follow-up).
5. Run `npm run check` (typecheck + lint + deps boundaries + tests). It must be green.
6. Verify the task's **exit criteria** in `docs/BUILD_PLAN.md`. Record evidence (command + result) in the session log.
7. Update `BUILD_STATUS.md`: task status, progress counters, `NEXT UP`, session log entry, any new decisions/blockers.
8. If you changed architecture, add an ADR in `docs/adr/` and update `docs/ARCHITECTURE.md` in the same change.
9. Never mark a task `DONE` if tests fail, are skipped, or were not written. Use `BLOCKED` or `IN_PROGRESS` honestly.
10. Leave the repo in a state where the next agent can continue with no verbal context.

## 4. Hard rules (non-negotiable)

| # | Rule |
|---|------|
| R1 | **No `console.log`** in `src/`. Use the logger from `src/observability`. (Lint-enforced.) |
| R2 | **No direct `node:fs` / `node:child_process` / `fetch` usage** outside the modules designated for them (`src/util/fs-safe`, `src/sandbox`, `src/tools/builtin/http`, `src/providers`). Everything else goes through those. (Dependency-cruiser enforced.) |
| R3 | **Every tool call goes through the policy engine.** There is no bypass path, including for "trusted" or built-in tools. |
| R4 | **Never log secrets.** All secrets are registered with the redactor. Tests assert redaction. |
| R5 | **All Windows paths go through `src/util/paths`** (normalization, reserved names, ADS `:stream`, UNC, 8.3 names, junctions, case-insensitivity, trailing dots/spaces, `\\?\` prefixes). |
| R6 | **Inject `Clock`, `Random`, and `IdGenerator`.** No raw `Date.now()` / `Math.random()` in domain logic (needed for deterministic replay). |
| R7 | **No `any`**, no non-null `!` without a comment justifying it, no floating promises. |
| R8 | **Every state change that matters is a journal event.** If it is not in the journal, it did not happen. |
| R9 | **Dependency direction is one-way** (see `docs/ARCHITECTURE.md` §3). Lower layers never import higher layers. |
| R10 | **Runtime data lives in `%LOCALAPPDATA%\AIR`**, never inside the OneDrive-synced repo (SQLite + OneDrive = corruption/locking). `var\` is dev/test scratch only and is git-ignored. |
| R11 | **Errors are typed** (`AirError` with `code`, `retryable`, `cause`, `context`). Never throw strings. Never swallow errors silently. |
| R12 | **Treat all model output and all tool output as untrusted input.** Validate with zod at every boundary. |

## 5. Commands (PowerShell, from repo root)

```powershell
.\scripts\bootstrap.ps1        # first-time setup: checks Node, installs deps, creates AIR_HOME, runs check
.\scripts\doctor.ps1           # environment diagnostics (Node, OneDrive path warning, long paths, disk, perms)
npm run check                  # typecheck + lint + deps:check + test  (MUST be green before DONE)
npm run typecheck
npm run lint
npm run deps:check             # dependency-cruiser layer rules
npm test                       # all fast tests (unit + integration)
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:chaos
npm run test:security
npm run test:perf
npm run test:coverage          # enforces coverage thresholds from vitest.config.ts
```

## 6. Conventions

- **Language**: TypeScript 5.x, `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, ESM (`"type": "module"`), `NodeNext` resolution.
- **Files**: `kebab-case.ts`; one primary export per file where practical; `index.ts` re-exports a module's public API only. Anything not exported from `index.ts` is private to the module.
- **Tests**: `tests/<kind>/<module>/<name>.test.ts`. Test names state behavior: `it('denies fs.write outside the jail')`.
- **Commits**: `type(scope): summary` (e.g. `feat(journal): add torn-write recovery`). Include task id: `[P2-T06]`.
- **IDs**: ULIDs with branded types (`RunId`, `AgentId`, `SessionId`, `TurnId`, `ToolCallId`, `EventId`).
- **Time**: UTC ISO-8601 strings in logs/events; monotonic clock for durations.
- **Config**: zod-validated, layered (defaults < file < env < CLI). Never read `process.env` outside `src/config`.

## 7. Definition of Done (applies to every task)

- [ ] Code implemented per spec in `docs/BUILD_PLAN.md`.
- [ ] Unit tests (and integration/security/chaos tests where listed) written and passing.
- [ ] Coverage thresholds not reduced.
- [ ] Structured logging added for new behavior at correct levels (see `docs/LOGGING.md`), with correlation ids.
- [ ] Journal events defined/emitted for any new state transition.
- [ ] Public API documented in `docs/MODULES.md` if changed.
- [ ] `npm run check` green on Windows.
- [ ] `BUILD_STATUS.md` updated (status, evidence, next up).

## 8. Environment notes (Windows)

- The repo currently sits under OneDrive Desktop. **Do not put runtime data, SQLite files, logs, or `node_modules` churn under OneDrive sync if avoidable.** Consider excluding `node_modules` and `var` from OneDrive sync, or move the repo to `C:\dev\AI_runtime` (see ADR-0003).
- Use PowerShell 7 (`pwsh`) when available; scripts are compatible with Windows PowerShell 5.1.
- Enable long paths: `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1`.
- Line endings: LF in repo (`.gitattributes` enforces); `.ps1` files use CRLF-tolerant syntax.
- The tools available to an agent may not include a shell. If you cannot run commands, say so in `BUILD_STATUS.md` and list the exact commands the human must run; do not claim verification you did not perform.
