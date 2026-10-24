# MEC: Interactive GUI & One-Click Auto-Installer (status: LOCKED 2026-10-24)

## Objective
Deliver an interactive, glassmorphic GUI dashboard ("AIR Control Center") that connects to the running AIR daemon over the Windows named pipe via `AirClient`, plus a zero-friction auto-installer (`install.cmd` and `scripts/setup.ps1`) for first-time installation, desktop shortcuts, and environment setup on Windows.

## Non-goals
- Multi-tenant cloud hosting / public WAN exposure (local-only `127.0.0.1:4100` binding with user authorization).
- Heavy external web frameworks like React/Tailwind/Next.js (vanilla HTML/CSS/JS with zero runtime bloat).
- Bypassing the policy engine or named pipe ACL (all GUI commands route through `AirClient`).

## Requirements
- **R-GUI-001 (Auto-Installer)** | Root double-clickable `install.cmd` and `scripts/setup.ps1` that verify Node >= 22, install dependencies, compile TypeScript (`npm run build`), initialize `%LOCALAPPDATA%\AIR`, create a Windows Desktop shortcut, and verify health. | Acceptance: `install.cmd` runs successfully; shortcut created; verification passes.
- **R-GUI-002 (GUI Server)** | `src/gui/`: Lightweight Node HTTP/SSE server binding `127.0.0.1:4100`, connecting to `aird` via `AirClient`. Exposes REST/SSE endpoints for health, sessions, runs, chat turn execution, approvals, and logs. Layer 8 module adhering to all architectural boundaries. | Acceptance: `npm run deps:check` 0 violations; server responds to HTTP requests; routes through `AirClient`.
- **R-GUI-003 (Interactive Dashboard UI)** | Premium glassmorphism dark-mode UI (HTML5 + Vanilla CSS + JS) featuring:
  - Header: Live daemon status, uptime, active model badge, and system metrics.
  - Chat & Command Studio: Agent selector (Developer, Reviewer, Dev-Shell, Auditor), goal input, and live response stream.
  - Process Manager: List runs, view details, Pause / Resume / Cancel.
  - Approvals Center: View pending tool call approvals, Approve / Deny with reason.
  - Telemetry & Logs: Real-time viewer of runtime logs and audit status.
  | Acceptance: UI renders cleanly, responsive layout, interactive features operational.
- **R-GUI-004 (CLI Integration)** | Add `air gui` command to `src/shell/commands.ts` that boots the GUI server and automatically launches the user's default browser. | Acceptance: `node dist/shell/main.js gui` launches the server and opens `http://127.0.0.1:4100`.
- **R-GUI-005 (Automated Tests)** | Unit tests in `tests/unit/gui/` testing server routing, API handlers, client proxying, and error handling. | Acceptance: `npm run check` passes 100% green.

## Phases
- **P-GUI-01 Auto-Installer** | `install.cmd` + `scripts/setup.ps1`.
- **P-GUI-02 GUI Backend Server** | `src/gui/server.ts`, `src/gui/index.ts`, layer configuration.
- **P-GUI-03 GUI Client Dashboard** | `src/gui/public/` (HTML/CSS/JS assets).
- **P-GUI-04 CLI Command & Integration** | `src/shell/commands.ts` `gui` command.
- **P-GUI-05 Tests & Verification** | Unit tests in `tests/unit/gui/`, `npm run check` green.

## Verification Commands
- `npm run typecheck`
- `npm run lint`
- `npm run deps:check`
- `npm test`
- `npm run check`

## Definition of Done
All requirements R-GUI-001 through R-GUI-005 met; `npm run check` green with 0 errors and no regression; installer verified on Windows.
