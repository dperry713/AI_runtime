# AIR Incident Response Runbook (Phase 12: P12-T06)

This runbook establishes response procedures for critical security, integrity, and stability incidents involving the AIR runtime.

---

## 1. Audit Chain Verification Failure (Tamper Detection)

### Severity: High
An audit hash chain break indicates unauthorized modification, truncation, or disk corruption in `%LOCALAPPDATA%\AIR\logs\audit.jsonl`.

### Response Workflow
1. **Immediate Execution Freeze:**
   ```powershell
   air audit verify
   ```
2. **Isolate Corrupted Entry:**
   - The verification output pinpoints the exact sequence index where `sha256(prev || canonicalJson)` diverged.
3. **Capture Forensic Artifacts:**
   - Copy `audit.jsonl` and journal segment files to a secure quarantine directory.
4. **Log Incident Event:**
   - Emit a Windows Event Log entry for audit compromise:
     ```powershell
     eventcreate /T ERROR /ID 1999 /L APPLICATION /SO AIR /D "Audit chain integrity failure detected at index <seq>"
     ```

---

## 2. Unapproved High-Risk Tool Attempt / Policy Bypass Probe

### Severity: Medium to High
An agent attempting repetitive unapproved tool calls or evasion patterns (e.g., path traversal, ADS syntax, process tree spawning).

### Response Workflow
1. **Cancel the Offending Run:**
   ```powershell
   air ps
   air kill <run-id>
   ```
2. **Review Taint Provenance:**
   - Inspect turn events in the journal stream:
     ```powershell
     air replay <run-id>
     ```
   - Identify whether prompt injection or untrusted data prompted the anomalous tool invocation.
3. **Enforce Lockdown Profile:**
   - Downgrade the active agent profile to `locked-down` or `readonly`.

---

## 3. Rogue or Runaway Child Process Tree

### Severity: High
A sandboxed process fails to exit within budget, exceeds memory limits, or attempts to evade cleanup.

### Response Workflow
1. **Trigger Immediate Sandbox Sweep:**
   ```powershell
   # Kill tracked child process trees via SCM / orphan reaper
   taskkill /F /T /IM air-sandbox.exe
   taskkill /F /T /IM pwsh.exe /FI "WINDOWTITLE eq AIR-Sandbox*"
   ```
2. **Inspect Resource Quotas:**
   - Check Job Object violation events in ETW stream (`Microsoft-AIR`).
   - Validate CPU rate limiting and memory byte ceilings in `air.config.json`.
