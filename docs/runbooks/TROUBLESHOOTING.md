# AIR Troubleshooting Guide (Phase 12: P12-T06)

This runbook outlines diagnosis and remediation steps for operational issues encountered with the AIR Runtime daemon, IPC pipe, sandboxing, and policy engine.

---

## 1. Named Pipe Connection Failures

### Symptom
```text
air: Failed to connect to pipe "\\.\pipe\air-<username>"
```

### Potential Causes & Fixes
1. **Daemon is not running:**
   - Verify daemon status via PowerShell:
     ```powershell
     Get-Process aird -ErrorAction SilentlyContinue
     sc query aird
     ```
   - Start the daemon or service if stopped:
     ```powershell
     sc start aird
     ```
2. **Access Denied (ACL Mismatch):**
   - The named pipe enforces current-user SID ACLs. Connecting from a different user account or an un-elevated session running under a different token will be rejected by design (Rule R6/S2).
   - Ensure the shell runs under the same user session as `aird`.
3. **Stale Pipe or Lockfile:**
   - Check `%LOCALAPPDATA%\AIR\run\aird.pid`. If `aird` crashed uncleanly, verify whether the PID listed is still alive. If not, delete the stale lock file and restart the daemon.

---

## 2. Sandbox Process Execution Issues

### Symptom
Tool execution throws `TOOL_TIMEOUT`, `SANDBOX_ERROR`, or process tree remains active.

### Remediation
1. **Orphan Process Cleanup:**
   - AIR includes an automatic crash-safe orphan reaper:
     ```powershell
     # Force kill orphaned child process trees
     taskkill /F /T /IM air-sandbox.exe
     ```
   - Check `%LOCALAPPDATA%\AIR\run\children.json` for tracked active sandbox processes.
2. **Windows Job Object Limitations:**
   - If running inside a nested container or nested hypervisor without Job Object quota delegation, ensure the host OS permits Job Object creation.

---

## 3. Policy & Approval Inquiries

### Symptom
Agent turns stall or report `PERMISSION_DENIED` unexpectedly.

### Diagnostics
1. **Run Policy Explain:**
   ```powershell
   air policy explain "fs.write" --path "C:\Users\...\file.txt"
   ```
2. **Pending Approvals:**
   - Check if an action is queued awaiting operator approval:
     ```powershell
     air approval list
     air approval resolve <id> --decision allow
     ```
3. **Taint Escalation:**
   - Check if untrusted inputs from web or external tools escalated the action's risk level per Rule S9.

---

## 4. SQLite / Journal Recovery Issues

### Symptom
`sqlite3` locking errors (`EBUSY` or `database is locked`) or torn write warnings.

### Remediation
1. **Verify OneDrive Path Isolation:**
   - Ensure runtime databases live in `%LOCALAPPDATA%\AIR` per ADR-0003, never in the OneDrive synchronized folder.
2. **Journal Repair:**
   - AIR automatically runs torn-write inspection on boot. Review `system.recovered` and `system.quarantine` events in `%LOCALAPPDATA%\AIR\logs\runtime.jsonl`.
