# AIR Operator Guide (Phase 12: P12-T06)

This guide covers operational procedures for managing, supervising, and monitoring the **AIR Runtime (`aird`)** daemon and interactive **`air` shell** in production and development environments on Windows.

---

## 1. Starting and Managing the AIR Daemon (`aird`)

### Interactive / Development Mode
In development or manual operations, launch the daemon in the foreground:
```powershell
# Using the installed script or built binary
npm run dev:run -- developer "Audit the repository"

# Or run the compiled service directly
node dist/service/main.js
```

### Windows Service Mode (Production)
The daemon can run unattended as a managed Windows Service under the Service Control Manager (SCM):
```powershell
# Install the Windows Service (requires Admin)
.\scripts\install-air-service.ps1 -StartType Auto

# Query service status
sc query aird

# Start or stop the service
sc start aird
sc stop aird

# Uninstall the service
.\scripts\uninstall-air-service.ps1
```

---

## 2. Using the Shell REPL (`air`)

The `air` shell communicates with `aird` over a user-authenticated Windows Named Pipe (`\\.\pipe\air-<username>`).

```powershell
# Interactive REPL session
air

# Single-command execution
air health
air ps
air logs --tail 50
air --json ps
```

### Key CLI / REPL Commands
| Command | Alias | Purpose |
|---|---|---|
| `health` | — | Inspect daemon health, uptime, active runs, and protocol version |
| `session create` | — | Create an interactive conversation session |
| `run start` | `run` | Dispatch a run to an agent with a goal |
| `ps` | `runs` | List active, paused, and completed runs |
| `kill <id>` | `cancel` | Cancel an active run |
| `pause <id>` | — | Gracefully pause a run at the next turn boundary |
| `resume <id>` | — | Resume a paused run |
| `replay <id>` | — | Deterministically replay journal events for a run |
| `policy explain <tool>` | — | Explain policy rule evaluation for a tool call |
| `audit verify` | — | Cryptographically verify the SHA-256 audit hash chain |

---

## 3. Policy Profiles and Governance

AIR runs with a deny-by-default security kernel. All tool calls require policy authorization:

1. **`readonly`**: Safe inspection only. File reads allowed; file modifications, shell execution, and network egress are strictly denied.
2. **`project-write`**: Standard developer profile. File reads and workspace writes allowed; destructive actions and shell execution ask for operator approval.
3. **`dev-shell`**: Autonomous development with shell tools enabled within the workspace jail.
4. **`locked-down`**: Zero-trust profile. All writes, network egress, and shell execution denied; untrusted inputs reject immediately.

---

## 4. Telemetry and Event Streams

AIR provides dual-stream telemetry:
- **Audit Logs:** Hash-chained JSONL files at `%LOCALAPPDATA%\AIR\logs\audit.jsonl`.
- **ETW Telemetry:** Real-time Event Tracing for Windows provider (`Microsoft-AIR`) consumable by enterprise SIEM/EDR products.
