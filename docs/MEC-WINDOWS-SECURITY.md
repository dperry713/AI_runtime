# MEC: Windows Security Hardening — WFP, AppContainer, Credential Manager, ETW, Packaging, Group Policy, AMSI

**Status: LOCKED 2026-10-24**

## Objective
Harden AIR on Windows with kernel-enforced security boundaries: WFP-based egress enforcement, AppContainer as the default sandbox, Windows Credential Manager secret protection, ETW audit telemetry, signed MSI/MSIX + Windows Service distribution, Group Policy/ADMX admin policy, and AMSI/Defender integration.

## Non-goals
- Linux/macOS support (Windows-first per PROJECT.md §2)
- Replacing the existing JSONL audit chain (ETW runs alongside it)
- Replacing the existing `EgressProxy` (it remains as a convenience layer for SSRF/DNS, not the boundary)
- Third-party EDR integrations beyond ETW

## Requirements

### W-001: WFP egress enforcement (kernel-level)
**R-001:** Implement Windows Filtering Platform (WFP) outbound connection filtering via the existing `air-sandbox.exe` Rust helper, blocking connections per-process or per-AppContainer SID at the kernel level, independent of environment variables.
- **Acceptance:** A test process that ignores `HTTP_PROXY`/`HTTPS_PROXY` and attempts an outbound connection to a non-allowlisted host is blocked at the kernel level (connection refused/reset), verified on Windows.

**R-002:** The existing `EgressProxy` remains as a convenience layer for SSRF prevention and DNS inspection, but is no longer the sole egress boundary.
- **Acceptance:** `EgressProxy` still performs SSRF/host-allowlist checks; WFP enforcement is the authoritative block.

### W-002: AppContainer default sandbox
**R-003:** AppContainer becomes the default sandbox for risky tools (`exec.run`, `http.fetch`, and any tool with risk ≥ medium), using `CreateAppContainerProfile` + `LaunchProcessInAppContainer` via `air-sandbox.exe`.
- **Acceptance:** A risky tool launched without explicit opt-in runs inside an AppContainer; process token shows AppContainer SID (`S-1-15-2-...`).

**R-004:** Job Objects + restricted token remain as the fallback when AppContainer is unavailable (non-Windows, older Windows, or AppContainer creation fails).
- **Acceptance:** On AppContainer failure, the runner transparently falls back to Job Objects + `CreateRestrictedToken` with `DISABLE_MAX_PRIVILEGE`, and logs the fallback.

**R-005:** AppContainer profile lifecycle (create, grant ACLs, delete) is wired into the sandbox runner via `air-sandbox.exe`, not just SID derivation helpers.
- **Acceptance:** `AppContainerManager` calls actual Windows APIs through the helper, not just `icacls` wrappers.

### W-003: Windows-native secrets (Credential Manager)
**R-006:** Vault master key is protected with Windows Credential Manager (`CredWriteW`/`CredReadW`/`CredDeleteW`), replacing the transitional PBKDF2/AES-GCM key derivation.
- **Acceptance:** Secret store encrypts/decrypts the master key via Credential Manager; round-trypt encrypt→decrypt succeeds; tampered/invalid credentials fail.

**R-007:** Credential injection through the egress proxy — secrets never enter the agent or tool process in plaintext; the proxy injects credentials at the TLS layer for allowlisted hosts.
- **Acceptance:** A tool process making an outbound request to an allowlisted host receives injected credentials via the proxy; the tool process memory does not contain the secret.

### W-004: ETW audit and telemetry
**R-008:** ETW provider registered and events emitted for security-relevant actions (tool execution, policy decisions, approvals, sandbox events, secret access) alongside the existing hash-chained JSONL audit log, using `node:eventsource`.
- **Acceptance:** An ETW consumer can capture AIR events; each ETW event carries correlation IDs matching the JSONL audit record.

**R-009:** ETW provider registration is part of the build output.
- **Acceptance:** Build artifacts include ETW provider registration code/manifest.

### W-005: Signed packaging + Windows Service
**R-010:** `aird` installs and runs as a Windows Service (SCM registration, recovery actions, service start/stop).
- **Acceptance:** `sc query air` shows the service installed; `net start air` / `net stop air` work; service survives daemon process crash with recovery action.

**R-011:** Ship as signed MSI and MSIX packages with Authenticode-signed binaries (`aird.exe`, `air.exe`, `air-sandbox.exe`).
- **Acceptance:** Installer artifacts (`.msi` and `.msix`) exist; Authenticode signing configured in the build pipeline.

**R-012:** winget distribution manifest with SmartScreen-friendly release path.
- **Acceptance:** winget manifest YAML exists; release process documented for SmartScreen reputation.

### W-006: Group Policy / ADMX admin policy
**R-013:** ADMX templates for machine-wide policy floor that users cannot loosen (e.g., default sandbox mode, egress default-deny, secret store type, audit level).
- **Acceptance:** `.admx` and `.adml` files exist; a sample Group Policy setting is readable via registry (`HKLM\SOFTWARE\Policies\AIR`).

**R-014:** Registry-backed admin policy is read at daemon boot and enforced as a floor (runtime config cannot override downward).
- **Acceptance:** Daemon reads `HKLM\SOFTWARE\Policies\AIR` at boot; a policy floor setting (e.g., `SandboxMode=AppContainer`) cannot be overridden by user config to a weaker value.

### W-007: AMSI / Defender integration
**R-015:** Tool output and scripts (PowerShell, batch) pass through AMSI (`AmsiScanBuffer`) where appropriate before execution or display.
- **Acceptance:** A script containing known malicious content (e.g., AMSI test string) is detected and blocked/sanitized by AMSI integration.

**R-016:** Windows Defender integration for file writes/downloads where appropriate.
- **Acceptance:** Downloaded or written files are submitted to Defender scanning when configured.

## Phases

| Phase | Name | Covers | Exit Gate |
|-------|------|--------|-----------|
| W1 | WFP egress enforcement | R-001, R-002 | WFP blocks non-allowlisted outbound connections from a process ignoring env vars; proxy still does SSRF/DNS |
| W2 | AppContainer default sandbox | R-003, R-004, R-005 | Risky tools run in AppContainer by default; Job Objects fallback verified |
| W3 | Windows-native secrets | R-006, R-007 | Credential Manager protects master key; credential injection via proxy verified |
| W4 | ETW telemetry | R-008, R-009 | ETW consumer captures AIR events with correlation IDs; registration in build output |
| W5 | Packaging + Windows Service | R-010, R-011, R-012 | `aird` installs as service; MSI + MSIX + winget manifest exist; Authenticode configured |
| W6 | Group Policy / ADMX | R-013, R-014 | ADMX templates exist; registry policy floor enforced at boot |
| W7 | AMSI / Defender | R-015, R-016 | AMSI blocks malicious script content; Defender scan integration verified |

## Verification commands
- `npm run typecheck` — tsc clean
- `npm run lint` — eslint clean
- `npm run deps:check` — dependency-cruiser 0 violations
- `npm test` — unit + integration green
- `npm run test:security` — security suite green (including new WFP/AppContainer/CredentialManager/ETW/AMSI tests)
- Windows-specific: `sc query air`, `net start/stop air`, ETW capture, Authenticode signature verification

## Definition of done
All R-IDs met with evidence in `docs/PROGRESS.md`; no open stub blocks any R-ID; `npm run check` green on Windows; `BUILD_STATUS.md` updated; ADRs written for each architectural decision.

## Implementation preferences (user-directed)
- WFP/AppContainer: extend existing `native/air-sandbox/` Rust helper via its JSON protocol
- Secrets: Windows Credential Manager (`CredWriteW`/`CredReadW`), not DPAPI
- ETW: `node:eventsource`
- Packaging: both MSI and MSIX
