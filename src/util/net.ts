/**
 * Network and IP address parsing / SSRF validation utilities.
 *
 * Provides:
 * - IPv4 candidate string parsing (decimal, octal, hex, dword shorthand) to uint32
 * - Reserved and private IP classification (RFC1918, loopback, link-local / metadata, carrier NAT)
 * - Safe host checking
 */

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
 * Checks whether an IPv4 uint32 falls inside private, loopback, link-local or carrier-grade NAT ranges.
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
