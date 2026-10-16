# Lessons Learned

### Git Repository Scaffolding
- Problem: `git status` shows all files untracked and no commits yet.
- Cause: Repository was scaffolded with initial files but initial commit has not been made.
- Fix: Ensure non-destructive edits and follow BUILD_STATUS.md task tracking strictly.
- Verify: Run `git status` before and after operations.

### Flaky/Destructive Test in depcruise-violation.test.ts
- Problem: `src/util/paths.ts` kept getting deleted during test execution.
- Cause: `tests/unit/depcruise-violation.test.ts` wrote a dummy non-index file to `src/util/paths.ts` and removed it with `rmSync(utilPathsFile)`.
- Fix: Renamed fixture target to `src/util/_temp_fixture_for_depcruise.ts`.
- Verify: `src/util/paths.ts` persists before and after test execution.
