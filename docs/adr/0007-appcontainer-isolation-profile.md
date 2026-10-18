# ADR-0007: Optional Windows AppContainer isolation profile

- Status: accepted
- Date: 2026-10-17
- Deciders: Antigravity Engineering Agent, AIR Core Team

## Context
Under Threat T5 (Network Exfiltration) and Threat T6 (Sandbox Escape), AIR executes untrusted code and tools on Windows. In P7-T01 through P7-T05, we implemented:
1. `StandardProcessRunner` with environment allowlisting, path jailing, and tree termination.
2. `air-sandbox.exe` (Rust native helper) with Windows Job Objects (kill-on-close, memory byte limits, process count, CPU rate limiting, and restricted token).
3. `reparse.ts` (NTFS junction, symlink, and hardlink defense).
4. `network.ts` (deny-by-default local loopback allowlist proxy with SSRF protection).
5. `orphan-reaper.ts` (startup crash recovery and orphan process reaping).

In P7-T06, we investigate and evaluate **Windows AppContainer isolation** as an optional profile.

## Windows AppContainer Capabilities & Mechanics
Windows AppContainers (introduced in Windows 8 and leveraged by Chromium sandboxes and Windows Defender) provide OS-enforced isolation:
1. **AppContainer SID**: Every profile has a unique security identifier derived from `DeriveAppContainerSidFromAppContainerName` (format: `S-1-15-2-...`).
2. **Deny-by-Default Filesystem & Registry Access**: Processes running inside an AppContainer cannot read or write any files, registry keys, or named pipes unless an Access Control Entry (ACE) explicitly grants access to the AppContainer SID.
3. **Kernel-Enforced Network Isolation**: The Windows Filtering Platform (WFP) automatically blocks all outbound and inbound network traffic for an AppContainer unless specific network capabilities (`internetClient`, `privateNetworkClientServer`) are explicitly configured.
4. **Desktop & IPC Isolation**: AppContainers run in an isolated session/desktop namespace, preventing window message injection (`WM_COPYDATA`), shredding cross-process handle inheritance.

## Findings & Trade-offs
While AppContainers provide kernel-level isolation, deploying them for general-purpose developer agent tooling presents practical challenges:
1. **Developer Tooling Incompatibility**:
   - Compilers and interpreters (`node.exe`, `python.exe`, `git.exe`, `npm`) require read access to system DLLs, runtime assemblies (`C:\Program Files\nodejs`, `C:\Windows\System32`), and configuration files. Without recursive DACL grants (`icacls`), standard CLI commands fail with `Access is denied` (0x80070005).
2. **DACL Grant Overhead**:
   - Enabling a workspace directory for AppContainer execution requires setting filesystem ACLs for the AppContainer SID (`icacls <dir> /grant *<SID>:(OI)(CI)F`). Modifying disk ACLs in user directories can conflict with OneDrive synchronization or corporate group policies.
3. **Privilege Requirements**:
   - Calling `CreateAppContainerProfile` and managing user profiles can require elevated privileges or interact with Windows User Profile services, whereas Windows Job Objects (`CreateJobObjectW`, `SetInformationJobObject`) and Restricted Tokens (`CreateRestrictedToken`) run completely in unprivileged user space.

## Decision
1. **Optional Flag**: AppContainer isolation is implemented as an **opt-in security profile** (`useAppContainer: boolean`, `appContainerProfileName?: string`) behind a configuration flag, keeping Job Objects + Restricted Tokens + Reparse Defense as the default production foundation.
2. **AppContainer Management Abstraction (`src/sandbox/appcontainer.ts`)**:
   - Profile management: Creation and deletion of named AppContainer profiles (`AppContainerManager`).
   - SID derivation: Deterministic derivation of AppContainer SIDs from profile names (`deriveAppContainerSid`).
   - Capability management: Standard capability constants (`CAPABILITY_INTERNET_CLIENT`, `CAPABILITY_PRIVATE_NETWORK`).
   - ACL helper: Generates or applies the required ICACLS permission grants for target workspace jails.
   - Diagnostic status: Exposes platform capability checks and fallback detection for unsupported environments.

## Consequences
+ Kernel-level file, network, and IPC isolation for zero-trust untrusted script execution.
+ True OS-level network blocking without relying on proxy environment variables.
+ Retains high developer velocity: standard development runs on Job Objects by default without invasive ACL modifications.
− Running complex CLI tools inside an AppContainer requires ACL preparation for tool dependencies.
