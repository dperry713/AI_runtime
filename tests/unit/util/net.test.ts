/**
 * Unit tests for network and IP parsing utilities (src/util/net.ts).
 */

import { describe, expect, it } from 'vitest';
import { isPrivateOrReservedIpv4, parseIpv4ToUint32 } from '../../../src/util/net.js';

describe('net utilities', () => {
  describe('parseIpv4ToUint32', () => {
    it('returns null on empty or whitespace string', () => {
      expect(parseIpv4ToUint32('')).toBeNull();
      expect(parseIpv4ToUint32('   ')).toBeNull();
    });

    it('parses single number notation (dword)', () => {
      expect(parseIpv4ToUint32('2130706433')).toBe(2130706433); // 127.0.0.1
      expect(parseIpv4ToUint32('0x7f000001')).toBe(2130706433);
      expect(parseIpv4ToUint32('0X7f000001')).toBe(2130706433);
      expect(parseIpv4ToUint32('4294967295')).toBe(0xffffffff);
      expect(parseIpv4ToUint32('4294967296')).toBeNull(); // Overflow
    });

    it('parses 4-part decimal and octal/hex notation', () => {
      expect(parseIpv4ToUint32('127.0.0.1')).toBe(2130706433);
      expect(parseIpv4ToUint32('0177.0.0.01')).toBe(2130706433); // Octal
      expect(parseIpv4ToUint32('0x7f.0.0.1')).toBe(2130706433); // Hex
      expect(parseIpv4ToUint32('10.0.0.1')).toBe(167772161);
      expect(parseIpv4ToUint32('192.168.1.1')).toBe(3232235777);
    });

    it('parses 2-part and 3-part notation', () => {
      // 10.1 (10 << 24 | 1)
      expect(parseIpv4ToUint32('10.1')).toBe(((10 << 24) | 1) >>> 0);
      expect(parseIpv4ToUint32('172.16.1')).toBe(((172 << 24) | (16 << 16) | 1) >>> 0);
    });

    it('returns null for invalid part formats', () => {
      expect(parseIpv4ToUint32('1.2.3.4.5')).toBeNull(); // > 4 parts
      expect(parseIpv4ToUint32('1..3.4')).toBeNull(); // Empty part
      expect(parseIpv4ToUint32('088.1.1.1')).toBeNull(); // Invalid octal digit
      expect(parseIpv4ToUint32('1.abc.1.1')).toBeNull(); // Invalid chars
      expect(parseIpv4ToUint32('256.0.0.1')).toBeNull(); // Part > 255
      expect(parseIpv4ToUint32('10.16777216')).toBeNull(); // 2-part overflow
      expect(parseIpv4ToUint32('10.0.65536')).toBeNull(); // 3-part overflow
    });
  });

  function parseIp(s: string): number {
    const ip = parseIpv4ToUint32(s);
    if (ip === null) {
      throw new Error(`Invalid IP test input: ${s}`);
    }
    return ip;
  }

  describe('isPrivateOrReservedIpv4', () => {
    it('identifies broadcast and 0.0.0.0/8', () => {
      const zero = parseIp('0.0.0.0');
      expect(isPrivateOrReservedIpv4(zero)).toBe(true);
    });

    it('identifies 10.0.0.0/8 private range', () => {
      const ip = parseIp('10.254.1.2');
      expect(isPrivateOrReservedIpv4(ip)).toBe(true);
    });

    it('identifies 100.64.0.0/10 carrier-grade NAT', () => {
      const ip1 = parseIp('100.64.0.1');
      const ip2 = parseIp('100.127.255.254');
      const ip3 = parseIp('100.128.0.1');
      expect(isPrivateOrReservedIpv4(ip1)).toBe(true);
      expect(isPrivateOrReservedIpv4(ip2)).toBe(true);
      expect(isPrivateOrReservedIpv4(ip3)).toBe(false);
    });

    it('identifies 127.0.0.0/8 loopback', () => {
      const loop = parseIp('127.0.0.1');
      expect(isPrivateOrReservedIpv4(loop)).toBe(true);
    });

    it('identifies 169.254.0.0/16 link-local and cloud metadata', () => {
      const meta = parseIp('169.254.169.254');
      expect(isPrivateOrReservedIpv4(meta)).toBe(true);
    });

    it('identifies 172.16.0.0/12 private range', () => {
      const ip1 = parseIp('172.16.0.1');
      const ip2 = parseIp('172.31.255.254');
      const ip3 = parseIp('172.32.0.1');
      expect(isPrivateOrReservedIpv4(ip1)).toBe(true);
      expect(isPrivateOrReservedIpv4(ip2)).toBe(true);
      expect(isPrivateOrReservedIpv4(ip3)).toBe(false);
    });

    it('identifies 192.168.0.0/16 private range', () => {
      const ip = parseIp('192.168.1.100');
      expect(isPrivateOrReservedIpv4(ip)).toBe(true);
    });

    it('identifies 198.18.0.0/15 benchmarking range', () => {
      const ip1 = parseIp('198.18.0.1');
      const ip2 = parseIp('198.19.255.254');
      const ip3 = parseIp('198.20.0.1');
      expect(isPrivateOrReservedIpv4(ip1)).toBe(true);
      expect(isPrivateOrReservedIpv4(ip2)).toBe(true);
      expect(isPrivateOrReservedIpv4(ip3)).toBe(false);
    });

    it('identifies test nets (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24)', () => {
      expect(isPrivateOrReservedIpv4(parseIp('192.0.2.1'))).toBe(true);
      expect(isPrivateOrReservedIpv4(parseIp('198.51.100.1'))).toBe(true);
      expect(isPrivateOrReservedIpv4(parseIp('203.0.113.1'))).toBe(true);
    });

    it('identifies multicast and reserved ranges (224.0.0.0+)', () => {
      const multi = parseIp('224.0.0.1');
      const res = parseIp('240.0.0.1');
      expect(isPrivateOrReservedIpv4(multi)).toBe(true);
      expect(isPrivateOrReservedIpv4(res)).toBe(true);
    });

    it('allows public IP addresses', () => {
      const pub1 = parseIp('8.8.8.8');
      const pub2 = parseIp('1.1.1.1');
      const pub3 = parseIp('140.82.121.4'); // GitHub
      expect(isPrivateOrReservedIpv4(pub1)).toBe(false);
      expect(isPrivateOrReservedIpv4(pub2)).toBe(false);
      expect(isPrivateOrReservedIpv4(pub3)).toBe(false);
    });
  });
});
