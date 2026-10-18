# ADR-0006: Network egress control (Local loopback allowlist proxy with optional Windows Firewall management)

- Status: accepted
- Date: 2026-10-17
- Deciders: Antigravity Engineering Agent, AIR Core Team

## Context
Untrusted sandboxed agent processes (exec commands, tools, scripts) must be prevented from exfiltrating data, accessing sensitive internal services (SSRF), or opening arbitrary outbound network connections (Threat T5). In Phase 7 (P7-T04), we must decide between:
1. Per-process Windows Firewall rules (`New-NetFirewallRule` / `netsh advfirewall`), vs
2. A local allowlist proxy routing outbound requests through loopback, vs
3. A hybrid approach combining both.

## Decision
We implement a **deny-by-default local loopback allowlist proxy (`EgressProxy` / `NetworkEgressController`)** as the primary isolation mechanism, supplemented by an **optional Windows Firewall manager (`WindowsFirewallManager`)** for elevated deployment environments:

1. **Default Deny**: Sandboxed processes have `allowNetwork: false` by default. All standard network proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `http_proxy`, `https_proxy`, `all_proxy`) are scrubbed from the process environment.
2. **Local Allowlist Proxy (`EgressProxy`)**:
   - Runs in standard unprivileged user space without requiring Administrator elevation (essential for developer REPL, CLI, and non-elevated CI environments).
   - Listens on `127.0.0.1:<ephemeral-port>`.
   - Intercepts HTTP requests and HTTPS `CONNECT` tunnels.
   - Enforces host allowlist matching against exact hosts, port specifications, and wildcard domain patterns (`*.anthropic.com`, `api.github.com`).
   - Strictly enforces SSRF prevention: denies connections to IPv4/IPv6 loopback, RFC 1918 private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), Carrier-Grade NAT (`100.64.0.0/10`), link-local metadata addresses (`169.254.169.254`), and IPv6 unique-local addresses (`fc00::/7`).
   - Automatically injects `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` pointing to `127.0.0.1:<port>` when network access is explicitly granted with an allowlist.
   - Records structured audit logs and metrics for every egress attempt (allowed, denied, bytes transferred, duration).
3. **Windows Firewall Rule Manager (`WindowsFirewallManager`)**:
   - When running in an elevated context (e.g., Windows Service `aird` or administrative CI runner), provides helper routines to create/remove dedicated outbound block rules keyed to `air-sandbox.exe` or sandboxed process paths.
   - Gracefully detects non-elevated execution and operates in proxy-only mode without throwing or aborting.

## Consequences
+ Works out-of-the-box on standard Windows developer machines without UAC / admin prompts.
+ Granular domain-level, wildcard, and port filtering for HTTPS and HTTP.
+ Strong SSRF prevention defense-in-depth.
+ Seamless integration with `ProcessRunner` and `air-sandbox.exe`.
− Processes that do not honor `HTTP_PROXY` / `HTTPS_PROXY` (e.g. raw UDP or raw TCP sockets) require OS-level firewall blocking or AppContainer isolation (evaluated in P7-T06).
