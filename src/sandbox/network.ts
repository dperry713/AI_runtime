/**
 * Sandbox Network Egress Control (Phase 7 - P7-T04).
 *
 * Implements deny-by-default network egress control for sandboxed processes:
 * 1. EgressProxy: Lightweight local loopback HTTP and HTTPS CONNECT proxy with:
 *    - Strict deny-by-default host allowlisting (*.example.com, api.foo.org:443)
 *    - SSRF prevention (denies IPv4/IPv6 loopback, RFC1918 private IPs, carrier NAT, cloud metadata 169.254.169.254)
 *    - Audit logging and connection tracking for forensic traceability
 *    - Active socket tracking and graceful teardown
 * 2. NetworkEgressController:
 *    - Lifecycle management of the proxy
 *    - Automatic environment variable configuration (injects HTTP_PROXY/HTTPS_PROXY or scrubs all network env)
 * 3. WindowsFirewallManager:
 *    - Optional elevated Windows Firewall rule management for defense-in-depth
 *
 * Adheres to:
 * - Rule R1: Structured logging via src/observability
 * - Rule R2: Process execution boundaries
 * - Rule R4: Secret scrubbing
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 * - Threat T5: Data exfiltration & SSRF prevention
 */

import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import dns from 'node:dns/promises';
import { AirError } from '../errors/index.js';
import { getLogger, type ComponentLogger } from '../observability/index.js';
import { parseIpv4ToUint32, isPrivateOrReservedIpv4 } from '../util/index.js';
import { type Clock, SystemClock } from '../util/index.js';

const defaultLogger = getLogger('egress-proxy');

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface EgressDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly host: string;
  readonly port: number;
}

export interface EgressLogEvent {
  readonly timestamp: string;
  readonly method: string;
  readonly host: string;
  readonly port: number;
  readonly allowed: boolean;
  readonly reason: string;
  readonly bytesTransferred?: number | undefined;
}

export interface EgressProxyOptions {
  /** Allowed host patterns (e.g. ['api.github.com', '*.anthropic.com', 'npm.pkg.github.com:443']). */
  readonly allowedHosts?: readonly string[] | undefined;
  /** Whether to allow loopback addresses (default false). */
  readonly allowLoopback?: boolean | undefined;
  /** Whether to allow RFC1918 and private IP subnets (default false). */
  readonly allowPrivateIps?: boolean | undefined;
  /** Connection timeout in milliseconds (default 15000). */
  readonly timeoutMs?: number | undefined;
  /** Optional structured event callback. */
  readonly onEvent?: ((event: EgressLogEvent) => void) | undefined;
  /** Optional logger instance. */
  readonly logger?: ComponentLogger | undefined;
}

// ============================================================================
// Host Pattern Matching & Validation
// ============================================================================

/**
 * Normalizes host and port from a target string.
 */
export function parseHostAndPort(rawHost: string, defaultPort = 80): { host: string; port: number } {
  let host = rawHost.trim().toLowerCase();
  let port = defaultPort;

  // Handle IPv6 bracket notation: [::1]:8080 or [::1]
  if (host.startsWith('[')) {
    const closingBracket = host.indexOf(']');
    if (closingBracket !== -1) {
      const rest = host.slice(closingBracket + 1);
      host = host.slice(1, closingBracket);
      if (rest.startsWith(':')) {
        const parsedPort = parseInt(rest.slice(1), 10);
        if (Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
          port = parsedPort;
        }
      }
      return { host, port };
    }
  }

  const colonIdx = host.lastIndexOf(':');
  if (colonIdx !== -1) {
    const portStr = host.slice(colonIdx + 1);
    const parsedPort = parseInt(portStr, 10);
    if (Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
      port = parsedPort;
      host = host.slice(0, colonIdx);
    }
  }

  return { host, port };
}

/**
 * Tests if candidate host matches an allowlist pattern.
 * Supports:
 * - Exact host: 'api.github.com'
 * - Subdomain wildcard: '*.github.com' (matches 'api.github.com', 'raw.github.com', not 'github.com')
 * - Wildcard with root: '.github.com' (matches 'github.com' and 'api.github.com')
 * - Port specification: 'api.github.com:443' or '*:443'
 */
export function matchesHostPattern(candidateHost: string, candidatePort: number, pattern: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  const { host: patHost, port: patPort } = parseHostAndPort(normalizedPattern, 0);

  // If pattern specified a specific non-zero port, it must match
  if (patPort !== 0 && patPort !== candidatePort) {
    return false;
  }

  const host = candidateHost.toLowerCase();

  // Universal wildcard
  if (patHost === '*' || patHost === '') {
    return true;
  }

  // Exact host match
  if (patHost === host) {
    return true;
  }

  // Subdomain wildcard: *.domain.com
  if (patHost.startsWith('*.')) {
    const suffix = patHost.slice(2);
    if (host.endsWith('.' + suffix)) {
      return true;
    }
  }

  // Leading dot shorthand: .domain.com
  if (patHost.startsWith('.')) {
    const suffix = patHost.slice(1);
    if (host === suffix || host.endsWith('.' + suffix)) {
      return true;
    }
  }

  return false;
}

/**
 * Validates a target host against SSRF defenses and host allowlist.
 */
export async function evaluateEgressPolicy(
  host: string,
  port: number,
  options: EgressProxyOptions = {},
): Promise<EgressDecision> {
  const normHost = host.trim().toLowerCase();

  // 1. SSRF Check: Cloud metadata & IPv6 link-local
  if (
    normHost === '169.254.169.254' ||
    normHost.startsWith('169.254.') ||
    normHost === 'metadata.google.internal' ||
    normHost.startsWith('fe80:') ||
    normHost.startsWith('fc00:') ||
    normHost.startsWith('fd')
  ) {
    return {
      allowed: false,
      reason: 'DENIED_METADATA_OR_LINK_LOCAL: Access to link-local or metadata endpoint is blocked',
      host: normHost,
      port,
    };
  }

  // 2. SSRF Check: Loopback / Localhost
  const isLoopbackCandidate =
    normHost === 'localhost' ||
    normHost.endsWith('.localhost') ||
    normHost === '127.0.0.1' ||
    normHost === '::1' ||
    normHost === '0.0.0.0';

  if (isLoopbackCandidate && !options.allowLoopback) {
    return {
      allowed: false,
      reason: 'DENIED_LOOPBACK: Access to loopback address is blocked',
      host: normHost,
      port,
    };
  }

  // 3. SSRF Check: IPv4 representations
  const ipUint = parseIpv4ToUint32(normHost);
  if (ipUint !== null) {
    const b0 = (ipUint >>> 24) & 0xff;
    const isLoopbackIp = b0 === 127;
    if (isLoopbackIp && options.allowLoopback) {
      // Loopback explicitly permitted for testing / local origin
    } else if (!options.allowPrivateIps && isPrivateOrReservedIpv4(ipUint)) {
      return {
        allowed: false,
        reason: 'DENIED_PRIVATE_IP: Access to private/reserved IP is blocked by SSRF policy',
        host: normHost,
        port,
      };
    }
  }

  // 4. Allowlist evaluation
  const allowedHosts = options.allowedHosts ?? [];
  if (allowedHosts.length === 0) {
    return {
      allowed: false,
      reason: 'DENIED_DEFAULT: Network egress is deny-by-default; no allowed hosts configured',
      host: normHost,
      port,
    };
  }

  let matched = false;
  for (const pat of allowedHosts) {
    if (matchesHostPattern(normHost, port, pat)) {
      matched = true;
      break;
    }
  }

  if (!matched) {
    return {
      allowed: false,
      reason: `DENIED_ALLOWLIST: Host ${normHost}:${port} is not in the egress allowlist`,
      host: normHost,
      port,
    };
  }

  // 5. DNS Rebinding / IP Resolution Guard for domain names
  if (ipUint === null && normHost !== 'localhost') {
    try {
      const addresses = await dns.lookup(normHost, { all: true });
      if (!options.allowPrivateIps) {
        for (const addr of addresses) {
          const resolvedUint = parseIpv4ToUint32(addr.address);
          if (resolvedUint !== null && isPrivateOrReservedIpv4(resolvedUint)) {
            return {
              allowed: false,
              reason: `DENIED_DNS_REBINDING: Host ${normHost} resolved to private IP ${addr.address}`,
              host: normHost,
              port,
            };
          }
          if (addr.address === '127.0.0.1' || addr.address === '::1') {
            return {
              allowed: false,
              reason: `DENIED_DNS_REBINDING: Host ${normHost} resolved to loopback IP ${addr.address}`,
              host: normHost,
              port,
            };
          }
        }
      }
    } catch (err) {
      return {
        allowed: false,
        reason: `DENIED_DNS_LOOKUP_FAILED: Failed to resolve ${normHost}: ${(err as Error).message}`,
        host: normHost,
        port,
      };
    }
  }

  return {
    allowed: true,
    reason: 'ALLOWED: Host matches policy allowlist',
    host: normHost,
    port,
  };
}

// ============================================================================
// Egress Proxy Implementation
// ============================================================================

export class EgressProxy {
  private server: http.Server | null = null;
  private readonly sockets = new Set<net.Socket | Duplex>();
  private readonly options: EgressProxyOptions;
  private readonly logger: ComponentLogger;
  private readonly clock: Clock;
  private listeningPort = 0;

  constructor(options: EgressProxyOptions = {}, clock?: Clock) {
    this.options = {
      timeoutMs: 15_000,
      allowLoopback: false,
      allowPrivateIps: false,
      ...options,
    };
    this.logger = options.logger ?? defaultLogger;
    this.clock = clock ?? new SystemClock();
  }

  /**
   * Starts the egress proxy on loopback (127.0.0.1) on an ephemeral port.
   */
  async start(preferredPort = 0): Promise<number> {
    if (this.server) {
      return this.listeningPort;
    }

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleHttpRequest(req, res);
      });

      server.on('connect', (req, clientSocket, head) => {
        void this.handleConnectRequest(req, clientSocket, head);
      });

      server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.once('close', () => {
          this.sockets.delete(socket);
        });
      });

      server.on('error', (err) => {
        reject(new AirError('RUNTIME_ERROR', `Failed to start egress proxy: ${err.message}`, { cause: err }));
      });

      server.listen(preferredPort, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr !== null) {
          this.listeningPort = addr.port;
          this.server = server;
          this.logger.info({ event: 'sandbox.egress_proxy.started', port: this.listeningPort }, 'Sandbox egress proxy started on 127.0.0.1');
          resolve(this.listeningPort);
        } else {
          reject(new AirError('RUNTIME_ERROR', 'Failed to acquire listening address for egress proxy'));
        }
      });
    });
  }

  /**
   * Returns current listening port, or 0 if not running.
   */
  getPort(): number {
    return this.listeningPort;
  }

  /**
   * Returns proxy URL formatted for environment variables (http://127.0.0.1:<port>).
   */
  getProxyUrl(): string {
    if (this.listeningPort === 0) {
      throw new AirError('INVALID_STATE', 'Egress proxy is not running');
    }
    return `http://127.0.0.1:${this.listeningPort}`;
  }

  /**
   * Shuts down the proxy server and destroys all active client sockets.
   */
  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        // ignore errors on forced socket closure
      }
    }
    this.sockets.clear();

    if (!this.server) {
      return;
    }

    const currentServer = this.server;
    this.server = null;
    this.listeningPort = 0;

    await new Promise<void>((resolve) => {
      currentServer.close(() => resolve());
    });
    this.logger.info({ event: 'sandbox.egress_proxy.stopped' }, 'Sandbox egress proxy stopped');
  }

  /**
   * Handles forward HTTP requests.
   */
  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reqUrl = req.url ?? '';
    let targetHost: string;
    let targetPort: number;
    let targetPath = reqUrl;

    try {
      if (reqUrl.startsWith('http://') || reqUrl.startsWith('https://')) {
        const parsed = new URL(reqUrl);
        targetHost = parsed.hostname;
        targetPort = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;
        targetPath = parsed.pathname + parsed.search;
      } else {
        const hostHeader = req.headers.host ?? '';
        const parsed = parseHostAndPort(hostHeader, 80);
        targetHost = parsed.host;
        targetPort = parsed.port;
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid request target');
      return;
    }

    const decision = await evaluateEgressPolicy(targetHost, targetPort, this.options);
    this.options.onEvent?.({
      timestamp: this.clock.iso(),
      method: req.method ?? 'GET',
      host: targetHost,
      port: targetPort,
      allowed: decision.allowed,
      reason: decision.reason,
    });

    if (!decision.allowed) {
      res.writeHead(403, {
        'Content-Type': 'application/json',
        'x-air-egress-denied': 'true',
      });
      res.end(JSON.stringify({ error: 'EGRESS_DENIED', message: decision.reason }));
      return;
    }

    // Forward allowed HTTP request
    const proxyReq = http.request(
      {
        host: targetHost,
        port: targetPort,
        method: req.method,
        path: targetPath,
        headers: req.headers,
        timeout: this.options.timeoutMs,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`Bad Gateway: ${err.message}`);
      }
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'text/plain' });
        res.end('Gateway Timeout');
      }
    });

    req.pipe(proxyReq);
  }

  /**
   * Handles HTTPS CONNECT tunnels.
   */
  private async handleConnectRequest(
    req: http.IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    this.sockets.add(clientSocket);
    clientSocket.once('close', () => {
      this.sockets.delete(clientSocket);
    });

    const rawTarget = req.url ?? '';
    const { host, port } = parseHostAndPort(rawTarget, 443);

    const decision = await evaluateEgressPolicy(host, port, this.options);
    this.options.onEvent?.({
      timestamp: this.clock.iso(),
      method: 'CONNECT',
      host,
      port,
      allowed: decision.allowed,
      reason: decision.reason,
    });

    if (!decision.allowed) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n' + decision.reason);
      clientSocket.end();
      return;
    }

    const destSocket = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) {
        destSocket.write(head);
      }
      destSocket.pipe(clientSocket);
      clientSocket.pipe(destSocket);
    });

    this.sockets.add(destSocket);
    destSocket.once('close', () => {
      this.sockets.delete(destSocket);
    });

    destSocket.setTimeout(this.options.timeoutMs ?? 15_000, () => {
      destSocket.destroy();
      clientSocket.destroy();
    });

    destSocket.on('error', () => {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.end();
    });

    clientSocket.on('error', () => {
      destSocket.destroy();
    });
  }
}

// ============================================================================
// Network Egress Controller
// ============================================================================

export interface EgressControllerConfig {
  readonly allowedHosts?: readonly string[] | undefined;
  readonly defaultAllowNetwork?: boolean | undefined;
}

export class NetworkEgressController {
  private proxy: EgressProxy | null = null;
  private readonly config: EgressControllerConfig;

  constructor(config: EgressControllerConfig = {}) {
    this.config = config;
  }

  /**
   * Starts the internal egress proxy if hosts are configured.
   */
  async start(): Promise<string | undefined> {
    if (!this.proxy) {
      this.proxy = new EgressProxy({
        allowedHosts: this.config.allowedHosts,
      });
      await this.proxy.start();
    }
    return this.proxy.getProxyUrl();
  }

  /**
   * Shuts down the egress proxy.
   */
  async stop(): Promise<void> {
    if (this.proxy) {
      await this.proxy.stop();
      this.proxy = null;
    }
  }

  /**
   * Returns current proxy URL if active.
   */
  getProxyUrl(): string | undefined {
    return this.proxy ? this.proxy.getProxyUrl() : undefined;
  }

  /**
   * Configures process environment variables according to network egress policy:
   * - If allowNetwork is false (default): strips all proxy variables.
   * - If allowNetwork is true: injects HTTP_PROXY, HTTPS_PROXY, ALL_PROXY pointing to local proxy.
   */
  configureEnvironment(
    baseEnv: Record<string, string>,
    allowNetwork = false,
  ): Record<string, string> {
    const result = { ...baseEnv };
    const proxyVars = [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'NO_PROXY',
      'no_proxy',
    ];

    if (!allowNetwork || !this.proxy) {
      // Actively remove any ambient proxy variables to ensure no unauthorized outbound proxying
      for (const key of proxyVars) {
        delete result[key];
      }
      return result;
    }

    const proxyUrl = this.proxy.getProxyUrl();
    result.HTTP_PROXY = proxyUrl;
    result.HTTPS_PROXY = proxyUrl;
    result.ALL_PROXY = proxyUrl;
    result.http_proxy = proxyUrl;
    result.https_proxy = proxyUrl;
    result.all_proxy = proxyUrl;
    result.NO_PROXY = 'localhost,127.0.0.1';
    result.no_proxy = 'localhost,127.0.0.1';

    return result;
  }
}

// ============================================================================
// Windows Firewall Rule Manager (Elevated Helper)
// ============================================================================

export interface FirewallRuleResult {
  readonly success: boolean;
  readonly message: string;
}

export class WindowsFirewallManager {
  /**
   * Tests if the current process is running with elevated / administrative privileges on Windows.
   */
  static async isElevated(): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    try {
      const { execFile } = await import('node:child_process');
      return await new Promise<boolean>((resolve) => {
        execFile('net', ['session'], { timeout: 3000 }, (err) => {
          // If net session returns 0, we have admin rights; otherwise non-elevated
          resolve(!err);
        });
      });
    } catch {
      return false;
    }
  }

  /**
   * Attempts to add an outbound block rule for a specific program path.
   */
  static async addOutboundBlockRule(ruleName: string, programPath: string): Promise<FirewallRuleResult> {
    if (process.platform !== 'win32') {
      return { success: false, message: 'Windows Firewall is only supported on Windows' };
    }

    const elevated = await this.isElevated();
    if (!elevated) {
      return {
        success: false,
        message: 'Elevation required: cannot create Windows Firewall rules without Administrator privileges',
      };
    }

    try {
      const { execFile } = await import('node:child_process');
      return await new Promise<FirewallRuleResult>((resolve) => {
        const args = [
          'advfirewall',
          'firewall',
          'add',
          'rule',
          `name=${ruleName}`,
          'dir=out',
          'action=block',
          `program=${programPath}`,
          'enable=yes',
        ];
        execFile('netsh', args, { timeout: 5000 }, (err, stdout, stderr) => {
          if (err) {
            resolve({ success: false, message: stderr.trim() || err.message });
          } else {
            resolve({ success: true, message: stdout.trim() || 'Rule added' });
          }
        });
      });
    } catch (err) {
      return { success: false, message: (err as Error).message };
    }
  }

  /**
   * Attempts to remove a firewall rule by name.
   */
  static async removeRule(ruleName: string): Promise<FirewallRuleResult> {
    if (process.platform !== 'win32') {
      return { success: false, message: 'Windows Firewall is only supported on Windows' };
    }

    try {
      const { execFile } = await import('node:child_process');
      return await new Promise<FirewallRuleResult>((resolve) => {
        const args = ['advfirewall', 'firewall', 'delete', 'rule', `name=${ruleName}`];
        execFile('netsh', args, { timeout: 5000 }, (err, stdout, stderr) => {
          if (err) {
            resolve({ success: false, message: stderr.trim() || err.message });
          } else {
            resolve({ success: true, message: stdout.trim() || 'Rule removed' });
          }
        });
      });
    } catch (err) {
      return { success: false, message: (err as Error).message };
    }
  }
}
