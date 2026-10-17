/**
 * Capability Model (Phase 5 - P5-T01).
 *
 * Defines typed capability atoms, patterns, and pattern matchers:
 * - Domain-specific capability atoms: 'fs', 'net', 'exec', 'system', 'interaction'
 * - Windows-aware path pattern matching with recursive globs (**), single segment (*), and traversal resistance
 * - Host pattern matching with exact domains, subdomains (*.example.com), ports, and CIDR subnets
 * - Command pattern matching with executable normalization (.exe strip), subcommand trees, and argument wildcards
 * - Canonical capability string format: `<type>:<action>:<resource>`
 * - Universal capability matching (`matchCapability`) and subsumption analysis (`isCapabilitySubsumed`)
 * - Specificity calculation (`calculateCapabilitySpecificity`) for monotonic decision engine rule ordering
 *
 * Adheres to:
 * - Rule R5: Strict Windows path normalization via src/util/paths
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 * - Rule R12: Zod schema validation
 */

import { z } from 'zod';
import { AirError } from '../errors/index.js';
import { normalizeSeparators } from '../util/index.js';

// ============================================================================
// 1. Capability Atoms & Schemas
// ============================================================================

export const CapabilityDomainSchema = z.enum([
  'fs',
  'net',
  'exec',
  'user',
  'plan',
  'run',
  'system',
  'custom',
]);
export type CapabilityDomain = z.infer<typeof CapabilityDomainSchema> | (string & {});

export const FsActionSchema = z.enum(['read', 'write', 'delete', 'list', 'stat', '*']);
export type FsAction = z.infer<typeof FsActionSchema>;

export const NetActionSchema = z.enum(['fetch', 'connect', 'listen', '*']);
export type NetAction = z.infer<typeof NetActionSchema>;

export const ExecActionSchema = z.enum(['run', '*']);
export type ExecAction = z.infer<typeof ExecActionSchema>;

export const CapabilityAtomSchema = z.object({
  /** Capability domain, e.g. 'fs', 'net', 'exec', 'system'. */
  type: z.string().min(1),
  /** Specific action within the domain, e.g. 'read', 'write', 'run', 'fetch'. */
  action: z.string().min(1).optional(),
  /** Specific target resource, e.g. path, host, command. */
  resource: z.string().optional(),
  /** Additional structured metadata for granular policy inspection. */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type CapabilityAtom = z.infer<typeof CapabilityAtomSchema>;

export interface FsCapability extends CapabilityAtom {
  readonly type: 'fs';
  readonly action: FsAction;
  readonly resource: string; // File or directory path
}

export interface NetCapability extends CapabilityAtom {
  readonly type: 'net';
  readonly action: NetAction;
  readonly resource: string; // Host or URL
  readonly meta?: {
    readonly port?: number | undefined;
    readonly protocol?: string | undefined;
    readonly [key: string]: unknown;
  } | undefined;
}

export interface ExecCapability extends CapabilityAtom {
  readonly type: 'exec';
  readonly action: ExecAction;
  readonly resource: string; // Command or executable
  readonly meta?: {
    readonly args?: readonly string[] | undefined;
    readonly shell?: string | undefined;
    readonly [key: string]: unknown;
  } | undefined;
}

// ============================================================================
// 2. Capability Constructors
// ============================================================================

export function createFsCapability(
  action: FsAction,
  path: string,
  meta?: Record<string, unknown>,
): FsCapability {
  if (!path || path.trim().length === 0) {
    throw new AirError('INVALID_ARGUMENT', 'Filesystem capability requires non-empty path');
  }
  return {
    type: 'fs',
    action,
    resource: normalizeSeparators(path),
    ...(meta ? { meta } : {}),
  };
}

export function createNetCapability(
  action: NetAction,
  hostOrUrl: string,
  options?: {
    readonly port?: number | undefined;
    readonly protocol?: string | undefined;
    readonly meta?: Record<string, unknown> | undefined;
  },
): NetCapability {
  if (!hostOrUrl || hostOrUrl.trim().length === 0) {
    throw new AirError('INVALID_ARGUMENT', 'Network capability requires non-empty host or URL');
  }
  return {
    type: 'net',
    action,
    resource: hostOrUrl,
    meta: {
      ...options?.meta,
      ...(options?.port !== undefined ? { port: options.port } : {}),
      ...(options?.protocol !== undefined ? { protocol: options.protocol } : {}),
    },
  };
}

export function createExecCapability(
  action: ExecAction,
  command: string,
  options?: {
    readonly args?: readonly string[] | undefined;
    readonly shell?: string | undefined;
    readonly meta?: Record<string, unknown> | undefined;
  },
): ExecCapability {
  if (!command || command.trim().length === 0) {
    throw new AirError('INVALID_ARGUMENT', 'Execution capability requires non-empty command');
  }
  return {
    type: 'exec',
    action,
    resource: command,
    meta: {
      ...options?.meta,
      ...(options?.args !== undefined ? { args: options.args } : {}),
      ...(options?.shell !== undefined ? { shell: options.shell } : {}),
    },
  };
}

export function createCapability(
  type: string,
  action?: string,
  resource?: string,
  meta?: Record<string, unknown>,
): CapabilityAtom {
  if (!type || type.trim().length === 0) {
    throw new AirError('INVALID_ARGUMENT', 'Capability type must be non-empty');
  }
  return {
    type,
    ...(action !== undefined ? { action } : {}),
    ...(resource !== undefined ? { resource } : {}),
    ...(meta !== undefined ? { meta } : {}),
  };
}

// ============================================================================
// 3. Capability Patterns & Parsing
// ============================================================================

export const CapabilityPatternSchema = z.object({
  type: z.string().min(1),
  action: z.union([z.string(), z.array(z.string())]).optional(),
  resource: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type CapabilityPattern = z.infer<typeof CapabilityPatternSchema>;

/**
 * Formats a capability or pattern into the canonical string notation:
 * `<type>:<action>:<resource>`
 */
export function formatCapability(cap: CapabilityAtom | CapabilityPattern): string {
  const type = cap.type || '*';
  let action = '*';
  if (Array.isArray(cap.action)) {
    action = cap.action.join('|');
  } else if (cap.action) {
    action = cap.action;
  }
  const resource = cap.resource ?? '*';
  return `${type}:${action}:${resource}`;
}

/**
 * Parses a canonical capability string into a structured CapabilityPattern.
 * Supports formats:
 * - `<type>:<action>:<resource>` (e.g. `fs:read:C:\repo\**`)
 * - `<type>:<action>` (e.g. `exec:run` -> resource: `*`)
 * - `<type>` (e.g. `fs` -> action: `*`, resource: `*`)
 */
export function parseCapabilityPattern(pattern: string | CapabilityPattern): CapabilityPattern {
  if (typeof pattern === 'object' && pattern !== null) {
    return CapabilityPatternSchema.parse(pattern);
  }

  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    throw new AirError('INVALID_ARGUMENT', 'Capability pattern must be a non-empty string or object');
  }

  const trimmed = pattern.trim();

  // Find colons, being careful with Windows drive letters like C:\ in the resource segment
  // Formats: type[:action[:resource]]
  const firstColon = trimmed.indexOf(':');
  if (firstColon === -1) {
    return {
      type: trimmed,
      action: '*',
      resource: '*',
    };
  }

  const type = trimmed.slice(0, firstColon).trim();
  const rest = trimmed.slice(firstColon + 1);

  const secondColon = rest.indexOf(':');
  if (secondColon === -1) {
    const action = rest.trim() || '*';
    return {
      type,
      action: action.includes('|') ? action.split('|').map((a) => a.trim()) : action,
      resource: '*',
    };
  }

  const rawAction = rest.slice(0, secondColon).trim();
  const resource = rest.slice(secondColon + 1).trim() || '*';
  const action = rawAction.includes('|') ? rawAction.split('|').map((a) => a.trim()) : (rawAction || '*');

  return {
    type,
    action,
    resource,
  };
}

// ============================================================================
// 4. Windows-Aware Path Pattern Matching
// ============================================================================

/**
 * Cleans and collapses dot segments (. and ..) in a relative or absolute path.
 */
function collapseDotSegments(p: string): string {
  const parts = p.split('\\');
  const result: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (result.length > 0 && result[result.length - 1] !== '..') {
        result.pop();
      } else {
        result.push('..');
      }
    } else {
      result.push(part);
    }
  }
  return (p.startsWith('\\') ? '\\' : '') + result.join('\\');
}

/**
 * Matches a target filesystem path against a glob pattern.
 * - Handles Windows backslashes and forward slashes interchangeably
 * - Case-insensitive on Windows
 * - `*` matches within a single path segment
 * - `**` matches zero or more path segments
 * - `?` matches a single character
 */
export function matchPathPattern(pattern: string, targetPath: string): boolean {
  if (!pattern || !targetPath) return false;
  if (pattern === '*' || pattern === '**') return true;

  const normTarget = normalizeSeparators(targetPath).trim();
  const normPattern = normalizeSeparators(pattern).trim();

  const collapsedTarget = collapseDotSegments(normTarget).toLowerCase();
  const collapsedPattern = collapseDotSegments(normPattern).toLowerCase();

  // If pattern is exact match (or target equals pattern)
  if (collapsedTarget === collapsedPattern) {
    return true;
  }

  // If pattern ends with `\**` (e.g. `C:\repo\**`), match the root folder itself or any child
  if (normPattern.endsWith('\\**')) {
    const base = collapsedPattern.slice(0, -3); // Strip `\**`
    if (collapsedTarget === base) {
      return true;
    }
    const prefix = base.endsWith('\\') ? base : `${base}\\`;
    if (collapsedTarget.startsWith(prefix)) {
      return true;
    }
  }

  // Convert glob pattern to regular expression
  // Segment separator is backslash `\`
  let regexStr = '^';
  let i = 0;
  while (i < collapsedPattern.length) {
    const char = collapsedPattern[i];
    if (char === '*' && collapsedPattern[i + 1] === '*') {
      // Check for `\**\` or leading `**\` or trailing `\**`
      const hasLeadingSlash = i > 0 && collapsedPattern[i - 1] === '\\';
      const hasTrailingSlash = i + 2 < collapsedPattern.length && collapsedPattern[i + 2] === '\\';

      if (hasLeadingSlash && hasTrailingSlash) {
        // Leading backslash was already added to regexStr. Match zero or more directories ending in `\`
        regexStr += '(?:.*\\\\)?';
        i += 3;
        continue;
      } else if (hasTrailingSlash) {
        // `**\` at start
        regexStr += '(?:.*\\\\)?';
        i += 3;
        continue;
      } else if (hasLeadingSlash) {
        // `\**` at end
        regexStr += '(?:\\\\.*)?';
        i += 2;
        continue;
      } else {
        // `**` alone
        regexStr += '.*';
        i += 2;
        continue;
      }
    } else if (char === '*') {
      // Single `*` does not cross path separator `\`
      regexStr += '[^\\\\]*';
      i += 1;
    } else if (char === '?') {
      regexStr += '[^\\\\]';
      i += 1;
    } else if (char === '\\') {
      regexStr += '\\\\';
      i += 1;
    } else if (['.', '+', '(', ')', '[', ']', '{', '}', '^', '$', '|'].includes(char ?? '')) {
      regexStr += `\\${char}`;
      i += 1;
    } else {
      regexStr += char;
      i += 1;
    }
  }
  regexStr += '$';

  try {
    const regex = new RegExp(regexStr, 'i');
    return regex.test(collapsedTarget);
  } catch {
    return false;
  }
}

// ============================================================================
// 5. Host & Network Pattern Matching
// ============================================================================

/**
 * Parses an IPv4 string into a 32-bit unsigned integer.
 */
function parseIpv4(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (let i = 0; i < 4; i++) {
    const segment = parts[i]?.trim();
    if (!segment || !/^\d+$/.test(segment)) return null;
    const n = Number.parseInt(segment, 10);
    if (n < 0 || n > 255) return null;
    acc = (acc << 8) | n;
  }
  return acc >>> 0;
}

/**
 * Checks if target IPv4 falls within a CIDR subnet (e.g. 192.168.0.0/16).
 */
function matchIpv4Cidr(cidr: string, targetIp: string): boolean {
  const slashIdx = cidr.indexOf('/');
  if (slashIdx === -1) return false;

  const baseIpStr = cidr.slice(0, slashIdx).trim();
  const prefixLenStr = cidr.slice(slashIdx + 1).trim();

  const prefixLen = Number.parseInt(prefixLenStr, 10);
  if (Number.isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) return false;

  const baseIp = parseIpv4(baseIpStr);
  const target = parseIpv4(targetIp);
  if (baseIp === null || target === null) return false;

  if (prefixLen === 0) return true;
  const mask = ((0xffffffff << (32 - prefixLen)) >>> 0);
  return (baseIp & mask) === (target & mask);
}

/**
 * Extracts host and optional port from a URL, host string, or host:port string.
 */
function parseHostAndPort(raw: string): { host: string; port?: number | undefined } {
  const trimmed = raw.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const url = new URL(trimmed);
      const port = url.port ? Number.parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
      return { host: url.hostname.toLowerCase(), port };
    } catch {
      // Fallback if URL parsing fails
    }
  }

  // Check for host:port format (avoid IPv6 colons if bracketed)
  if (trimmed.startsWith('[')) {
    const closing = trimmed.indexOf(']');
    if (closing !== -1) {
      const host = trimmed.slice(1, closing).toLowerCase();
      const after = trimmed.slice(closing + 1);
      if (after.startsWith(':')) {
        const port = Number.parseInt(after.slice(1), 10);
        return { host, port: Number.isNaN(port) ? undefined : port };
      }
      return { host };
    }
  }

  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon !== -1 && !trimmed.includes('::')) {
    const portStr = trimmed.slice(lastColon + 1);
    if (/^\d+$/.test(portStr)) {
      const port = Number.parseInt(portStr, 10);
      const host = trimmed.slice(0, lastColon).toLowerCase();
      return { host, port };
    }
  }

  return { host: trimmed.toLowerCase() };
}

/**
 * Matches a host or URL against a network pattern.
 * Supports:
 * - `*` (matches all hosts)
 * - Exact host: `api.github.com`
 * - Wildcard domain: `*.example.com` (matches `api.example.com`, `foo.bar.example.com`, and `example.com`)
 * - Port constraints: `api.github.com:443`, `*:8080`
 * - IPv4 and IPv4 CIDR blocks: `192.168.0.0/16`, `127.0.0.1`
 */
export function matchHostPattern(pattern: string, targetHostOrUrl: string): boolean {
  if (!pattern || !targetHostOrUrl) return false;
  if (pattern === '*' || pattern === '*:*') return true;

  const targetParsed = parseHostAndPort(targetHostOrUrl);
  const patternParsed = parseHostAndPort(pattern);

  // If pattern specified a port and it differs from target, reject
  if (patternParsed.port !== undefined && targetParsed.port !== undefined) {
    if (patternParsed.port !== targetParsed.port) {
      return false;
    }
  }

  const patternHost = patternParsed.host;
  const targetHost = targetParsed.host;

  if (patternHost === '*' || patternHost === '') {
    return true;
  }

  // Check CIDR block match (e.g. 192.168.0.0/16)
  if (patternHost.includes('/')) {
    return matchIpv4Cidr(patternHost, targetHost);
  }

  // Exact host match
  if (patternHost === targetHost) {
    return true;
  }

  // Wildcard domain match (e.g. `*.example.com`)
  if (patternHost.startsWith('*.')) {
    const rootDomain = patternHost.slice(2); // `example.com`
    if (targetHost === rootDomain) {
      return true;
    }
    if (targetHost.endsWith(`.${rootDomain}`)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// 6. Command Pattern Matching
// ============================================================================

/**
 * Tokenizes a command line string into an array of arguments,
 * respecting single and double quotes.
 */
export function tokenizeCommandLine(cmd: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (/\s/.test(char ?? '') && !inDouble && !inSingle) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Normalizes an executable name for Windows comparison.
 * Strips path, strips trailing `.exe`, and converts to lowercase.
 */
function normalizeExecutable(exe: string): string {
  const norm = normalizeSeparators(exe).toLowerCase();
  const base = norm.split('\\').pop() ?? norm;
  return base.endsWith('.exe') ? base.slice(0, -4) : base;
}

/**
 * Matches a command execution against a command pattern.
 * Supports:
 * - `*` (matches any command)
 * - Exact command: `git status`
 * - Prefix command: `npm test` matches `npm test -- --coverage`
 * - Argument wildcards: `git checkout *`, `python -m *`
 * - Recursive wildcards: `cargo **`
 * - Windows executable equivalence: `git` matches `git.exe` and `C:\Program Files\Git\bin\git.exe`
 */
export function matchCommandPattern(
  pattern: string,
  command: string,
  args?: readonly string[],
): boolean {
  if (!pattern || !command) return false;
  if (pattern === '*' || pattern === '**') return true;

  // Build target tokens
  let targetTokens: string[];
  if (args !== undefined) {
    targetTokens = [command, ...args];
  } else if (
    (command.toLowerCase().endsWith('.exe') ||
      command.toLowerCase().endsWith('.cmd') ||
      command.toLowerCase().endsWith('.bat')) &&
    (command.includes('\\') || command.includes('/')) &&
    !command.includes(' -')
  ) {
    targetTokens = [command];
  } else {
    targetTokens = tokenizeCommandLine(command);
  }
  if (targetTokens.length === 0) return false;

  const patternTokens = tokenizeCommandLine(pattern);
  if (patternTokens.length === 0) return false;

  const patternExe = patternTokens[0] ?? '';
  const targetExe = targetTokens[0] ?? '';

  // Match executable
  if (patternExe !== '*' && patternExe !== '**') {
    if (normalizeExecutable(patternExe) !== normalizeExecutable(targetExe)) {
      return false;
    }
  }

  // Match arguments
  const pArgs = patternTokens.slice(1);
  const tArgs = targetTokens.slice(1);

  if (pArgs.length === 0) {
    // Pattern was just executable (e.g. `git`). If no args in pattern, matches any args!
    return true;
  }

  let pIdx = 0;
  let tIdx = 0;

  while (pIdx < pArgs.length) {
    const pToken = pArgs[pIdx] ?? '';

    if (pToken === '**') {
      // Recursive wildcard matches all remaining arguments
      return true;
    }

    if (tIdx >= tArgs.length) {
      // Pattern expects more arguments than provided
      return false;
    }

    const tToken = tArgs[tIdx] ?? '';

    if (pToken === '*') {
      // Single wildcard matches one argument
      pIdx++;
      tIdx++;
      continue;
    }

    // Exact argument match (case-insensitive on Windows)
    if (pToken.toLowerCase() !== tToken.toLowerCase()) {
      return false;
    }

    pIdx++;
    tIdx++;
  }

  // If pattern arguments fully matched, target arguments must not have trailing un-matched tokens
  // unless pattern ended with `**` or `*`
  return tIdx === tArgs.length;
}

// ============================================================================
// 7. Universal Capability Matcher
// ============================================================================

/**
 * Evaluates whether a requested capability matches a grant or pattern.
 */
export function matchCapability(
  pattern: CapabilityPattern | string,
  requested: CapabilityAtom,
): boolean {
  const p = parseCapabilityPattern(pattern);

  // 1. Match domain / type
  if (p.type !== '*' && p.type.toLowerCase() !== requested.type.toLowerCase()) {
    return false;
  }

  // 2. Match action
  if (p.action && p.action !== '*') {
    const reqAction = (requested.action ?? '').toLowerCase();
    if (Array.isArray(p.action)) {
      const allowedActions = p.action.map((a) => a.toLowerCase());
      if (!allowedActions.includes('*') && !allowedActions.includes(reqAction)) {
        return false;
      }
    } else {
      const allowedAction = p.action.toLowerCase();
      if (allowedAction !== '*' && allowedAction !== reqAction) {
        return false;
      }
    }
  }

  // 3. Match resource
  if (p.resource && p.resource !== '*') {
    const reqResource = requested.resource ?? '';

    if (p.type.toLowerCase() === 'fs') {
      if (!matchPathPattern(p.resource, reqResource)) {
        return false;
      }
    } else if (p.type.toLowerCase() === 'net') {
      if (!matchHostPattern(p.resource, reqResource)) {
        return false;
      }
    } else if (p.type.toLowerCase() === 'exec') {
      const execArgs = Array.isArray(requested.meta?.['args'])
        ? (requested.meta['args'] as string[])
        : undefined;
      if (!matchCommandPattern(p.resource, reqResource, execArgs)) {
        return false;
      }
    } else {
      // Generic string matching with wildcard support
      if (p.resource !== reqResource && p.resource !== '*') {
        return false;
      }
    }
  }

  // 4. Match metadata constraints if declared in pattern
  if (p.meta) {
    if (!requested.meta) return false;
    for (const [key, value] of Object.entries(p.meta)) {
      if (requested.meta[key] !== value) {
        return false;
      }
    }
  }

  return true;
}

// ============================================================================
// 8. Specificity Calculation & Subsumption
// ============================================================================

/**
 * Calculates a numerical specificity score for a capability pattern.
 * Higher score = more specific.
 * Used by the decision engine to sort rules from most specific to least specific.
 */
export function calculateCapabilitySpecificity(pattern: CapabilityPattern | string): number {
  const p = parseCapabilityPattern(pattern);
  let score = 0;

  // Domain score
  if (p.type !== '*') {
    score += 100;
  }

  // Action score
  if (p.action && p.action !== '*') {
    if (Array.isArray(p.action)) {
      score += 40;
    } else {
      score += 50;
    }
  }

  // Resource score
  const res = p.resource ?? '*';
  if (res === '*' || res === '**') {
    score += 0;
  } else if (res.includes('**')) {
    score += 60;
  } else if (res.includes('*')) {
    score += 100;
  } else {
    // Exact resource
    score += 200;
  }

  // Length and segment depth bonus (longer paths/domains are more specific)
  if (res !== '*' && res !== '**') {
    const segments = res.split(/[/\\.:]/).filter(Boolean);
    score += segments.length * 5;
  }

  // Meta constraints add specificity
  if (p.meta && Object.keys(p.meta).length > 0) {
    score += Object.keys(p.meta).length * 25;
  }

  return score;
}

/**
 * Determines if a child capability pattern is strictly subsumed by a parent pattern.
 * If child is subsumed by parent, any request granted by child is also granted by parent.
 */
export function isCapabilitySubsumed(
  child: CapabilityPattern | string,
  parent: CapabilityPattern | string,
): boolean {
  const c = parseCapabilityPattern(child);
  const p = parseCapabilityPattern(parent);

  // Type subsumption
  if (p.type !== '*' && p.type.toLowerCase() !== c.type.toLowerCase()) {
    return false;
  }

  // Action subsumption
  if (p.action && p.action !== '*') {
    const pActions = Array.isArray(p.action) ? p.action.map((a) => a.toLowerCase()) : [p.action.toLowerCase()];
    const cActions = Array.isArray(c.action)
      ? c.action.map((a) => a.toLowerCase())
      : c.action ? [c.action.toLowerCase()] : ['*'];

    if (cActions.includes('*') && !pActions.includes('*')) {
      return false;
    }
    for (const ca of cActions) {
      if (!pActions.includes(ca) && !pActions.includes('*')) {
        return false;
      }
    }
  }

  // Resource subsumption
  const pRes = p.resource ?? '*';
  const cRes = c.resource ?? '*';

  if (pRes === '*' || pRes === '**') {
    return true;
  }
  if (cRes === '*' && pRes !== '*') {
    return false;
  }

  // Domain-specific resource subsumption
  const type = (c.type !== '*' ? c.type : p.type).toLowerCase();
  if (type === 'fs') {
    return matchPathPattern(pRes, cRes);
  }
  if (type === 'net') {
    return matchHostPattern(pRes, cRes);
  }
  if (type === 'exec') {
    return matchCommandPattern(pRes, cRes);
  }

  return pRes === cRes;
}
