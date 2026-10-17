/**
 * Built-in HTTP Tool: http.fetch (P4-T06).
 *
 * Provides safe HTTP fetching with:
 * - SSRF guard blocking loopback, link-local (cloud metadata), RFC1918 private IPs,
 *   obfuscated IPs (decimal, hex, octal), and private IPv6 / ULA.
 * - Host allowlist support with wildcard matching (*.example.com).
 * - DNS resolution verification before connecting.
 * - Safe redirect inspection (re-validates every redirect target against SSRF rules).
 * - Size and time caps with clean response truncation.
 * - Tainted content marker metadata (Rule R12 / Phase 5 taint tracking).
 */

import dns from 'node:dns/promises';
import { z } from 'zod';
import { AirError } from '../../errors/index.js';
import type { Clock } from '../../util/index.js';
import { SystemClock } from '../../util/index.js';
import type { AnyTool, ToolCapability, ToolDefinition } from '../contract.js';
import { defineTool, toAnyTool } from '../contract.js';
import type { ToolRegistry } from '../registry.js';

// ============================================================================
// Schemas
// ============================================================================

export const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const HttpFetchInputSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  method: HttpMethodSchema.default('GET'),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  maxResponseBytes: z.number().int().positive().max(10 * 1024 * 1024).optional(),
  followRedirects: z.boolean().default(true),
  maxRedirects: z.number().int().min(0).max(20).default(5),
});

export type HttpFetchInput = z.infer<typeof HttpFetchInputSchema>;

export const HttpFetchOutputSchema = z.object({
  status: z.number().int(),
  statusText: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
  truncated: z.boolean(),
  bytesReceived: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  tainted: z.literal(true),
  finalUrl: z.string(),
});

export type HttpFetchOutput = z.infer<typeof HttpFetchOutputSchema>;

// ============================================================================
// SSRF & IP Guard Utilities
// ============================================================================

/**
 * Parses an IPv4 candidate string (supporting decimal, octal, hex, and shorthand notation)
 * into a 32-bit unsigned integer, or null if not a valid IPv4 representation.
 */
export function parseIpv4ToUint32(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // Single number notation (dword, e.g. 2130706433 or 0x7f000001)
  if (/^(?:0x[0-9a-fA-F]+|\d+)$/.test(trimmed)) {
    const val = trimmed.startsWith('0x') || trimmed.startsWith('0X')
      ? parseInt(trimmed, 16)
      : parseInt(trimmed, 10);
    if (!Number.isFinite(val) || val < 0 || val > 0xffffffff) return null;
    return val >>> 0;
  }

  const parts = trimmed.split('.');
  if (parts.length < 1 || parts.length > 4) return null;

  const parsedParts: number[] = [];
  for (const part of parts) {
    if (part.length === 0) return null;
    let n: number;
    if (part.startsWith('0x') || part.startsWith('0X')) {
      n = parseInt(part, 16);
    } else if (part.startsWith('0') && part.length > 1) {
      // Octal or invalid
      if (/[^0-7]/.test(part)) return null;
      n = parseInt(part, 8);
    } else {
      if (/[^0-9]/.test(part)) return null;
      n = parseInt(part, 10);
    }

    if (!Number.isFinite(n) || n < 0) return null;
    parsedParts.push(n);
  }

  // POSIX inet_aton semantics for parts length
  let val = 0;
  if (parsedParts.length === 1) {
    const p0 = parsedParts[0];
    if (p0 === undefined || p0 > 0xffffffff) return null;
    val = p0;
  } else if (parsedParts.length === 2) {
    const p0 = parsedParts[0];
    const p1 = parsedParts[1];
    if (p0 === undefined || p1 === undefined) return null;
    if (p0 > 0xff || p1 > 0xffffff) return null;
    val = (p0 << 24) | p1;
  } else if (parsedParts.length === 3) {
    const p0 = parsedParts[0];
    const p1 = parsedParts[1];
    const p2 = parsedParts[2];
    if (p0 === undefined || p1 === undefined || p2 === undefined) return null;
    if (p0 > 0xff || p1 > 0xff || p2 > 0xffff) return null;
    val = (p0 << 24) | (p1 << 16) | p2;
  } else if (parsedParts.length === 4) {
    const p0 = parsedParts[0];
    const p1 = parsedParts[1];
    const p2 = parsedParts[2];
    const p3 = parsedParts[3];
    if (p0 === undefined || p1 === undefined || p2 === undefined || p3 === undefined) return null;
    if (p0 > 0xff || p1 > 0xff || p2 > 0xff || p3 > 0xff) return null;
    val = (p0 << 24) | (p1 << 16) | (p2 << 8) | p3;
  }

  return val >>> 0;
}

/**
 * Checks whether an IPv4 uint32 falls inside private, loopback, or link-local ranges.
 */
export function isPrivateOrReservedIpv4(ipUint: number): boolean {
  const b0 = (ipUint >>> 24) & 0xff;
  const b1 = (ipUint >>> 16) & 0xff;

  // 0.0.0.0/8 (Broadcast/source)
  if (b0 === 0) return true;

  // 10.0.0.0/8 (Private RFC1918)
  if (b0 === 10) return true;

  // 100.64.0.0/10 (Carrier-grade NAT: 100.64.0.0 to 100.127.255.255)
  if (b0 === 100 && (b1 & 0xc0) === 64) return true;

  // 127.0.0.0/8 (Loopback)
  if (b0 === 127) return true;

  // 169.254.0.0/16 (Link-local / Cloud metadata: 169.254.169.254)
  if (b0 === 169 && b1 === 254) return true;

  // 172.16.0.0/12 (Private RFC1918: 172.16.0.0 to 172.31.255.255)
  if (b0 === 172 && (b1 & 0xf0) === 16) return true;

  // 192.0.0.0/24 (IETF assignments)
  if (b0 === 192 && b1 === 0) return true;

  // 192.0.2.0/24 (TEST-NET-1)
  if (b0 === 192 && b1 === 0) return true;

  // 192.168.0.0/16 (Private RFC1918)
  if (b0 === 192 && b1 === 168) return true;

  // 198.18.0.0/15 (Benchmarking)
  if (b0 === 198 && (b1 & 0xfe) === 18) return true;

  // 198.51.100.0/24 (TEST-NET-2)
  if (b0 === 198 && b1 === 51) return true;

  // 203.0.113.0/24 (TEST-NET-3)
  if (b0 === 203 && b1 === 0) return true;

  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved/Broadcast)
  if (b0 >= 224) return true;

  return false;
}

/**
 * Checks whether an IPv6 address is private, loopback, link-local, or documentation.
 */
export function isPrivateOrReservedIpv6(ipv6: string): boolean {
  const norm = ipv6.toLowerCase().trim();

  // Strip brackets if present: [::1] -> ::1
  const clean = norm.startsWith('[') && norm.endsWith(']') ? norm.slice(1, -1) : norm;

  // Loopback and unspecified
  if (clean === '::1' || clean === '::' || clean === '0000:0000:0000:0000:0000:0000:0000:0001' || clean === '0:0:0:0:0:0:0:1') {
    return true;
  }

  // IPv4-mapped IPv6: ::ffff:127.0.0.1 or ::ffff:7f00:1
  if (clean.startsWith('::ffff:')) {
    const embedded = clean.slice(7);
    const parsed = parseIpv4ToUint32(embedded);
    if (parsed !== null) {
      return isPrivateOrReservedIpv4(parsed);
    }
    return true; // Malformed or reserved mapped
  }

  // ULA (Unique Local Address: fc00::/7 -> fc.. or fd..)
  if (clean.startsWith('fc') || clean.startsWith('fd')) return true;

  // Link-local unicast (fe80::/10 -> fe8, fe9, fea, feb)
  if (/^fe[89ab]/i.test(clean)) return true;

  // Multicast (ff00::/8)
  if (clean.startsWith('ff')) return true;

  // Documentation (2001:db8::/32)
  if (clean.startsWith('2001:db8') || clean.startsWith('2001:0db8')) return true;

  // Discard prefix (100::/64)
  if (clean.startsWith('100:')) return true;

  return false;
}

/**
 * Matches host against allowlist entries (exact or wildcard *.domain.com).
 */
export function matchesHostAllowlist(hostname: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  const target = hostname.toLowerCase();

  for (const pattern of allowlist) {
    const p = pattern.toLowerCase().trim();
    if (p === target) return true;
    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // e.g. .example.com
      if (target.endsWith(suffix) && target.length > suffix.length) {
        return true;
      }
    }
  }

  return false;
}

export interface SsrfValidationResult {
  readonly valid: boolean;
  readonly reason?: string | undefined;
  readonly resolvedIps?: readonly string[] | undefined;
}

export type DnsLookupFn = (hostname: string) => Promise<string[]>;

export const defaultDnsLookup: DnsLookupFn = async (hostname: string) => {
  try {
    const records = await dns.lookup(hostname, { all: true });
    return records.map((r) => r.address);
  } catch (err) {
    throw new AirError('TOOL_EXECUTION_FAILED', `DNS lookup failed for "${hostname}": ${(err as Error).message}`, {
      cause: err instanceof Error ? err : undefined,
      context: { hostname },
    });
  }
};

/**
 * Validates a parsed URL against SSRF rules, host allowlists, and resolved IPs.
 */
export async function validateUrlForSsrf(
  targetUrl: URL,
  options?: {
    readonly allowlist?: readonly string[] | undefined;
    readonly allowPrivateNetworks?: boolean | undefined;
    readonly lookupFn?: DnsLookupFn | undefined;
  },
): Promise<SsrfValidationResult> {
  const protocol = targetUrl.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return {
      valid: false,
      reason: `Protocol "${protocol}" is forbidden (only http: and https: are allowed)`,
    };
  }

  const hostname = targetUrl.hostname.toLowerCase();

  // Block localhost and standard local domains
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan') ||
    hostname.endsWith('.home') ||
    hostname.endsWith('.corp')
  ) {
    if (!options?.allowPrivateNetworks) {
      return {
        valid: false,
        reason: `Access to local/private domain "${hostname}" is blocked by SSRF guard`,
      };
    }
  }

  // Check host allowlist
  if (options?.allowlist && options.allowlist.length > 0) {
    if (!matchesHostAllowlist(hostname, options.allowlist)) {
      return {
        valid: false,
        reason: `Host "${hostname}" is not in the configured allowlist`,
      };
    }
  }

  // Check if hostname is an IPv4 or obfuscated IPv4 representation
  const ipv4Uint = parseIpv4ToUint32(hostname);
  if (ipv4Uint !== null) {
    if (!options?.allowPrivateNetworks && isPrivateOrReservedIpv4(ipv4Uint)) {
      return {
        valid: false,
        reason: `Access to private or reserved IPv4 address "${hostname}" is blocked by SSRF guard`,
      };
    }
    return { valid: true, resolvedIps: [hostname] };
  }

  // Check if hostname is an IPv6 address
  if (hostname.includes(':') || isPrivateOrReservedIpv6(hostname)) {
    if (!options?.allowPrivateNetworks && isPrivateOrReservedIpv6(hostname)) {
      return {
        valid: false,
        reason: `Access to private or reserved IPv6 address "${hostname}" is blocked by SSRF guard`,
      };
    }
    return { valid: true, resolvedIps: [hostname] };
  }

  // Hostname requires DNS resolution to verify target IP
  const lookup = options?.lookupFn ?? defaultDnsLookup;
  const ips = await lookup(hostname);
  if (ips.length === 0) {
    return {
      valid: false,
      reason: `DNS lookup returned no IP addresses for "${hostname}"`,
    };
  }

  if (!options?.allowPrivateNetworks) {
    for (const ip of ips) {
      const parsed4 = parseIpv4ToUint32(ip);
      if (parsed4 !== null && isPrivateOrReservedIpv4(parsed4)) {
        return {
          valid: false,
          reason: `Host "${hostname}" resolved to private/reserved IPv4 address "${ip}"`,
          resolvedIps: ips,
        };
      }
      if (ip.includes(':') && isPrivateOrReservedIpv6(ip)) {
        return {
          valid: false,
          reason: `Host "${hostname}" resolved to private/reserved IPv6 address "${ip}"`,
          resolvedIps: ips,
        };
      }
    }
  }

  return { valid: true, resolvedIps: ips };
}

// ============================================================================
// Tool Implementation
// ============================================================================

export interface HttpToolOptions {
  readonly fetchFn?: typeof fetch | undefined;
  readonly lookupFn?: DnsLookupFn | undefined;
  readonly clock?: Clock | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly defaultMaxResponseBytes?: number | undefined;
  readonly allowlist?: readonly string[] | undefined;
  readonly allowPrivateNetworks?: boolean | undefined;
}

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB

export function createHttpFetchTool(
  options?: HttpToolOptions,
): ToolDefinition<HttpFetchInput, HttpFetchOutput> {
  const clock = options?.clock ?? new SystemClock();
  const fetchFn = options?.fetchFn ?? globalThis.fetch;
  const defaultTimeoutMs = options?.defaultTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const defaultMaxResponseBytes = options?.defaultMaxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const allowlist = options?.allowlist;
  const allowPrivateNetworks = options?.allowPrivateNetworks ?? false;
  const lookupFn = options?.lookupFn;

  return defineTool({
    name: 'http.fetch',
    description:
      'Performs an HTTP request with SSRF guard protection, host allowlisting, automatic redirect checks, timeout bounding, response size truncation, and tainted content tagging.',
    risk: 'medium',
    idempotent: false,
    defaultTimeoutMs,
    maxOutputBytes: defaultMaxResponseBytes * 2, // Allow output metadata JSON overhead
    inputSchema: HttpFetchInputSchema,
    outputSchema: HttpFetchOutputSchema,

    capabilities: (args): readonly ToolCapability[] => {
      try {
        const u = new URL(args.url);
        const hostCap = u.port ? `net.host:${u.hostname}:${u.port}` : `net.host:${u.hostname}`;
        return [
          {
            type: 'net',
            action: 'http',
            resource: hostCap,
            meta: {
              url: args.url,
              method: args.method,
              hostname: u.hostname,
            },
          },
        ];
      } catch {
        return [
          {
            type: 'net',
            action: 'http',
            resource: args.url,
          },
        ];
      }
    },

    execute: async (input, context) => {
      let currentUrlStr = input.url;
      let currentMethod = input.method;
      let currentBody = input.body;
      const followRedirects = input.followRedirects;
      const maxRedirects = input.maxRedirects;
      const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
      const maxResponseBytes = input.maxResponseBytes ?? defaultMaxResponseBytes;

      let redirectCount = 0;
      const startMono = clock.monotonicMs();

      while (true) {
        let currentUrl: URL;
        try {
          currentUrl = new URL(currentUrlStr);
        } catch (err) {
          throw new AirError('INVALID_ARGUMENT', `Malformed URL: "${currentUrlStr}"`, {
            cause: err instanceof Error ? err : undefined,
          });
        }

        // SSRF guard check on every URL (initial + redirect targets)
        const ssrfCheck = await validateUrlForSsrf(currentUrl, {
          allowlist,
          allowPrivateNetworks,
          lookupFn,
        });

        if (!ssrfCheck.valid) {
          throw new AirError('PERMISSION_DENIED', `SSRF guard blocked request: ${ssrfCheck.reason}`, {
            context: {
              url: currentUrlStr,
              reason: ssrfCheck.reason,
              resolvedIps: ssrfCheck.resolvedIps ? [...ssrfCheck.resolvedIps] : undefined,
            },
          });
        }

        // Setup abort controller linking context signal and timeout
        const abortController = new AbortController();
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

        if (timeoutMs > 0) {
          timeoutHandle = setTimeout(() => {
            abortController.abort(new AirError('TOOL_TIMEOUT', `HTTP request timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }

        const parentSignal = context.signal;
        const onParentAbort = (): void => {
          if (parentSignal) {
            abortController.abort(parentSignal.reason);
          }
        };

        if (parentSignal) {
          if (parentSignal.aborted) {
            abortController.abort(parentSignal.reason);
          } else {
            parentSignal.addEventListener('abort', onParentAbort, { once: true });
          }
        }

        if (abortController.signal.aborted) {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
          if (parentSignal?.aborted) {
            throw new AirError('CANCELLED', 'HTTP request was cancelled');
          }
          throw new AirError('TOOL_TIMEOUT', `HTTP request timed out after ${timeoutMs}ms`);
        }

        const requestInit: RequestInit = {
          method: currentMethod,
          redirect: 'manual',
          signal: abortController.signal,
        };
        if (input.headers !== undefined) {
          requestInit.headers = input.headers;
        }
        if (currentMethod !== 'GET' && currentMethod !== 'HEAD' && currentBody !== undefined) {
          requestInit.body = currentBody;
        }

        let response: Response;
        try {
          response = await fetchFn(currentUrlStr, requestInit);
        } catch (err: unknown) {
          if (abortController.signal.aborted) {
            if (parentSignal?.aborted) {
              throw new AirError('CANCELLED', 'HTTP request was cancelled');
            }
            throw new AirError('TOOL_TIMEOUT', `HTTP request timed out after ${timeoutMs}ms`);
          }
          throw new AirError('TOOL_EXECUTION_FAILED', `HTTP request to "${currentUrlStr}" failed: ${(err as Error).message}`, {
            cause: err instanceof Error ? err : undefined,
            context: { url: currentUrlStr, method: currentMethod },
          });
        } finally {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
          }
          if (parentSignal) {
            parentSignal.removeEventListener('abort', onParentAbort);
          }
        }

        // Check if redirect
        const status = response.status;
        const isRedirect = [301, 302, 303, 307, 308].includes(status);

        if (isRedirect && followRedirects) {
          redirectCount += 1;
          if (redirectCount > maxRedirects) {
            throw new AirError('TOOL_EXECUTION_FAILED', `Exceeded maximum redirect limit of ${maxRedirects}`, {
              context: { initialUrl: input.url, currentUrl: currentUrlStr, redirectCount },
            });
          }

          const location = response.headers.get('location');
          if (!location) {
            throw new AirError('TOOL_EXECUTION_FAILED', `Redirect response (${status}) missing Location header`, {
              context: { url: currentUrlStr, status },
            });
          }

          // Resolve relative redirect against current URL
          const nextUrl = new URL(location, currentUrl).href;
          currentUrlStr = nextUrl;

          // For 303 (See Other) or 301/302 from POST, change method to GET
          if (status === 303 || ((status === 301 || status === 302) && currentMethod === 'POST')) {
            currentMethod = 'GET';
            currentBody = undefined;
          }

          continue;
        }

        // Extract response headers
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });

        // Read response body with size capping
        let body = '';
        let bytesReceived = 0;
        let truncated = false;

        if (response.body && currentMethod !== 'HEAD') {
          const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
          const decoder = new TextDecoder('utf-8');

          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done || !chunk.value) break;

              const chunkBytes = chunk.value;
              bytesReceived += chunkBytes.byteLength;
              if (body.length < maxResponseBytes) {
                const remainingBytes = maxResponseBytes - body.length;
                if (chunkBytes.byteLength > remainingBytes) {
                  body += decoder.decode(chunkBytes.subarray(0, remainingBytes), { stream: false });
                  truncated = true;
                  body += '\n\n[TRUNCATED: maxResponseBytes exceeded]';
                  // Cancel the rest of the stream to save bandwidth
                  await reader.cancel();
                  break;
                } else {
                  body += decoder.decode(chunkBytes, { stream: true });
                }
              } else {
                truncated = true;
                await reader.cancel();
                break;
              }
            }
          } catch (err: unknown) {
            if (abortController.signal.aborted) {
              throw new AirError('TOOL_TIMEOUT', `HTTP body streaming timed out`);
            }
            throw new AirError('TOOL_EXECUTION_FAILED', `Error reading response stream: ${(err as Error).message}`, {
              cause: err instanceof Error ? err : undefined,
            });
          }
        }

        const durationMs = clock.monotonicMs() - startMono;

        return {
          status: response.status,
          statusText: response.statusText,
          headers,
          body,
          truncated,
          bytesReceived,
          durationMs,
          tainted: true,
          finalUrl: currentUrlStr,
        };
      }
    },
  });
}

/**
 * Standard default singleton http.fetch tool instance.
 */
export const httpFetchTool = createHttpFetchTool();

export const BUILTIN_HTTP_TOOLS: readonly AnyTool[] = [
  toAnyTool(httpFetchTool),
];

/**
 * Registers all built-in HTTP tools with the provided ToolRegistry.
 */
export function registerBuiltinHttpTools(
  registry: ToolRegistry,
  options?: HttpToolOptions,
): void {
  const tool = options ? createHttpFetchTool(options) : httpFetchTool;
  registry.register(tool);
}
