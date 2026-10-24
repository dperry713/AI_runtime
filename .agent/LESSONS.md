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

### Node.js Writable Stream Error Handling in Tests
- Problem: Vitest fails with unhandled error when testing `_write` or `_final` callback error paths.
- Cause: Node.js `stream.Writable` emits an `'error'` event when `callback(err)` is called. Without an `'error'` listener on the stream instance, Node treats it as an unhandled error.
- Fix: Attach `stream.on('error', errorHandler)` in tests that deliberately pass errors to stream callbacks.
- Verify: `npm run check` passes without unhandled errors.
