# ADR-0003: Runtime data lives in %LOCALAPPDATA%\AIR, not in the OneDrive-synced repo

- Status: accepted (repo-location follow-up tracked as P0-T08)
- Date: 2026-10-15

## Context
The repo currently lives at `C:\Users\d\OneDrive\Desktop\AI_runtime`. OneDrive sync can lock, rename, or
conflict-copy files that are being written, which is hazardous for SQLite (WAL), append-only journals, and
high-volume logs. It also uploads `node_modules` churn.

## Decision
`AIR_HOME` defaults to `%LOCALAPPDATA%\AIR` (config, journal, memory, logs, run state). `var\` inside the repo is
git-ignored scratch for dev/test only. Code resolves the home directory only via `config/home.ts`, and `doctor.ps1`
warns when the repo path or `AIR_HOME` is under OneDrive.

## Consequences
+ Avoids sync-induced corruption and sync CPU/network load.
+ Uninstall/backup semantics are explicit.
− Developers must remember logs are not in the repo (documented in LOGGING.md §10).
− Recommended follow-up: move the repo to `C:\dev\AI_runtime` (or exclude `node_modules` and `var` from OneDrive).

## Alternatives considered
- Keep everything in the repo folder: simplest, but unsafe under OneDrive.
- `%APPDATA%` (roaming): may sync across machines in domain setups; unsuitable for DBs.
