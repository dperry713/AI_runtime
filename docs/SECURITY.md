# SECURITY.md — AIR threat model and security requirements

Status: living document. Any new tool, capability, or integration requires an entry here (cross-cutting requirement 4).

## 1. Assets

| Asset | Why it matters |
|---|---|
| User files & credentials on the Windows machine | Primary target of a misbehaving/injected agent |
| API keys (LLM providers, MCP servers) | Cost + data exposure |
| Journal, audit log, memory store | Integrity (forensics) and confidentiality (contains user data) |
| The daemon's authority (it runs as the user) | Pivot for privilege abuse |
| System resources (CPU, RAM, disk, handles, cost) | Denial-of-wallet / denial-of-service |

## 2. Trust boundaries & trust levels

| Source | Trust |
|---|---|
| Operator (the human at `air`) | Trusted, authenticated by Windows user identity (named pipe ACL) |
| Policy file, agent manifests, config | Trusted **if** ACL-protected and hash-verified at load; changes audited |
| LLM output | **Untrusted** (may be wrong, jailbroken, or injected) |
| Tool output, file contents, web pages, MCP responses | **Untrusted** and **tainted** |
| MCP servers, plugins | Untrusted code; run sandboxed, capabilities declared and policy-gated |
| Native helper `air-sandbox.exe` | Trusted component; signed/hash-checked at spawn |

## 3. Threats (STRIDE-oriented) and mitigations

| ID | Threat | Mitigation | Test |
|---|---|---|---|
| T1 | Prompt injection in web/file/tool output causes harmful tool calls | Taint tracking, escalation to approval/deny, output fencing, capability scoping, no ambient authority | `tests/security/injection` |
| T2 | Path traversal / escape from allowed roots (Windows aliasing: junctions, ADS, 8.3, UNC, device names) | `util/paths` canonicalization + realpath verification + handle-based checks | `tests/security/paths` |
| T3 | Command injection via arguments/shell metacharacters | Arg-array execution (no shell string concat), policy matching on parsed argv, `-EncodedCommand` flagged high-risk | `tests/security/exec` |
| T4 | Sandbox escape or resource exhaustion by child processes | Job Object limits, restricted token, env allowlist, kill-on-close, orphan reaping | `tests/security/sandbox`, chaos |
| T5 | Secret exfiltration (via logs, errors, tool args, network) | Redaction registry, no secrets in config, egress allowlist, taint-aware http policy, canary-secret tests | `tests/security/secrets` |
| T6 | Policy bypass (alternate code path to run a tool) | Single executor choke point; runtime assertion requiring decision id; lint/deps rules forbidding direct fs/spawn/fetch | `tests/security/bypass` |
| T7 | SSRF / internal network access via `http.fetch` | Block private, loopback, link-local, metadata IPs (all encodings), re-resolve at connect, redirect re-validation | `tests/security/ssrf` |
| T8 | Malicious MCP server / plugin (huge output, lying schemas, injection in descriptions) | Sandboxed process, output caps, schema re-validation, descriptions treated as tainted, hash pinning | `tests/security/mcp` |
| T9 | Local privilege abuse of IPC (other user/process connects to pipe) | Pipe ACL to current user SID only, `FILE_FLAG_FIRST_PIPE_INSTANCE`, request size limits, version handshake | `tests/e2e/ipc-security` |
| T10 | Tampering with journal/audit to hide actions | Per-line CRC, audit hash chain, `air audit verify`, restricted ACLs, rotation seals | `tests/security/audit` |
| T11 | Memory poisoning (injected content becomes trusted memory) | Provenance + taint stored; memory write policy; tainted memories retrieved as tainted | `tests/security/memory` |
| T12 | Runaway cost / infinite loops | Budgets (tokens, USD, steps, wall-clock), stall detection, supervisor spawn limits, children ⊆ parent budgets | chaos + unit |
| T13 | Supply-chain compromise (npm deps, native helper) | Lockfile committed, `npm audit` in CI, minimal deps, SBOM, pinned helper hash, provenance when releasing | CI |
| T14 | Crash/restart causing duplicate non-idempotent side effects | Write-ahead journal events; non-idempotent tools require operator decision on recovery | `tests/chaos/recovery` |
| T15 | OneDrive/sync/AV interference corrupting data | Runtime data in `%LOCALAPPDATA%`; retry-on-EBUSY/EPERM wrappers; documented AV exclusions | integration |

## 4. Security requirements (testable)

- **S1** Deny by default: with an empty policy, every tool call is denied.
- **S2** 100% of tool executions have a journaled `tool.policy_decided` event preceding `tool.started`.
- **S3** No secret value appears in any log stream, journal event, crash report, or error returned to the model.
- **S4** Filesystem tools can never read/write outside granted roots, including via links, ADS, short names, or case variants.
- **S5** Sandboxed process trees are fully terminated on timeout, cancel, or `aird` exit/crash.
- **S6** Child agents' capabilities and budgets are strict subsets of their parent's.
- **S7** Audit chain verifies after every test run; any tamper is detected.
- **S8** The daemon refuses connections from other Windows users.
- **S9** Tainted data cannot reach `risk >= medium` tools without approval (interactive) or denial (headless).
- **S10** Policy/agent/plugin files that fail hash/ACL checks are refused at load.

## 5. Secure development rules

- Dependencies: justify each new dependency in the PR/commit; prefer built-ins; run `npm audit --omit=dev` in CI; fail on high/critical.
- No `eval`, no `new Function`, no dynamic `require` of untrusted paths.
- Parse, don't validate: zod at every boundary (IPC, provider, tool args/results, config, MCP, plugin manifests).
- Least privilege: the daemon runs as the standard user (never elevated); the service runs as a dedicated low-privilege account where feasible.
- Fuzz the native helper protocol and the IPC framing.
- Keep a `docs/runbooks/incident-response.md` (P12-T06): revoke keys, `air kill --all`, verify audit chain, collect crash reports.

## 6. Known gaps / future work

- AppContainer isolation (P7-T06) is investigative; v1 relies on Job Objects + restricted token + jail.
- Network egress control mechanism decided in P7-T04 (firewall rule vs. proxy).
- Code signing and reproducible builds for the helper (P12-T05).
