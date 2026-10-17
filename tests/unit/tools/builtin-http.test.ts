import { describe, expect, it } from 'vitest';
import {
  createHttpFetchTool,
  httpFetchTool,
  isPrivateOrReservedIpv4,
  isPrivateOrReservedIpv6,
  matchesHostAllowlist,
  parseIpv4ToUint32,
  registerBuiltinHttpTools,
  validateUrlForSsrf,
} from '../../../src/tools/builtin/http.js';
import { ToolExecutor } from '../../../src/tools/executor.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { FakeClock } from '../../../src/util/index.js';

describe('Built-in HTTP Tool: http.fetch (P4-T06)', () => {
  describe('SSRF Guard: IP Parsing & Identification', () => {
    it('parses standard dotted decimal IPv4 to uint32 accurately', () => {
      expect(parseIpv4ToUint32('127.0.0.1')).toBe(0x7f000001);
      expect(parseIpv4ToUint32('10.0.0.1')).toBe(0x0a000001);
      expect(parseIpv4ToUint32('192.168.1.100')).toBe(0xc0a80164);
      expect(parseIpv4ToUint32('0.0.0.0')).toBe(0);
      expect(parseIpv4ToUint32('255.255.255.255')).toBe(0xffffffff);
    });

    it('parses dword / integer and hex representations of IPv4', () => {
      // 2130706433 is 127.0.0.1
      expect(parseIpv4ToUint32('2130706433')).toBe(0x7f000001);
      expect(parseIpv4ToUint32('0x7f000001')).toBe(0x7f000001);
      expect(parseIpv4ToUint32('0x7f.0.0.1')).toBe(0x7f000001);
    });

    it('parses octal and mixed notation IPv4', () => {
      // 0177 is octal 127
      expect(parseIpv4ToUint32('0177.0.0.1')).toBe(0x7f000001);
      // 127.1 in inet_aton is 127.0.0.1
      expect(parseIpv4ToUint32('127.1')).toBe(0x7f000001);
    });

    it('returns null for invalid IPv4 strings', () => {
      expect(parseIpv4ToUint32('')).toBeNull();
      expect(parseIpv4ToUint32('not-an-ip')).toBeNull();
      expect(parseIpv4ToUint32('1.2.3.4.5')).toBeNull();
      expect(parseIpv4ToUint32('256.0.0.1')).toBeNull();
      expect(parseIpv4ToUint32('088.0.0.1')).toBeNull(); // 088 invalid octal
    });

    it('identifies private, loopback, and reserved IPv4 blocks', () => {
      const getIpv4 = (ipStr: string): number => {
        const val = parseIpv4ToUint32(ipStr);
        expect(val).not.toBeNull();
        return val ?? 0;
      };

      // Loopback
      expect(isPrivateOrReservedIpv4(getIpv4('127.0.0.1'))).toBe(true);
      expect(isPrivateOrReservedIpv4(getIpv4('127.255.255.254'))).toBe(true);

      // RFC1918 Private
      expect(isPrivateOrReservedIpv4(getIpv4('10.0.0.1'))).toBe(true);
      expect(isPrivateOrReservedIpv4(getIpv4('10.255.255.255'))).toBe(true);
      expect(isPrivateOrReservedIpv4(getIpv4('172.16.0.1'))).toBe(true);
      expect(isPrivateOrReservedIpv4(getIpv4('172.31.255.255'))).toBe(true);
      expect(isPrivateOrReservedIpv4(getIpv4('192.168.1.1'))).toBe(true);

      // Carrier-grade NAT (100.64.0.0/10)
      expect(isPrivateOrReservedIpv4(getIpv4('100.64.0.1'))).toBe(true);
      expect(isPrivateOrReservedIpv4(getIpv4('100.127.255.254'))).toBe(true);

      // Link-local / Cloud metadata (169.254.0.0/16)
      expect(isPrivateOrReservedIpv4(getIpv4('169.254.169.254'))).toBe(true);
      expect(isPrivateOrReservedIpv4(getIpv4('169.254.1.1'))).toBe(true);

      // Broadcast and multicast
      expect(isPrivateOrReservedIpv4(getIpv4('0.0.0.0'))).toBe(true);
      expect(isPrivateOrReservedIpv4(getIpv4('224.0.0.1'))).toBe(true);
      expect(isPrivateOrReservedIpv4(getIpv4('255.255.255.255'))).toBe(true);

      // Public IPs should not be reserved
      expect(isPrivateOrReservedIpv4(getIpv4('8.8.8.8'))).toBe(false);
      expect(isPrivateOrReservedIpv4(getIpv4('1.1.1.1'))).toBe(false);
      expect(isPrivateOrReservedIpv4(getIpv4('93.184.216.34'))).toBe(false);
    });

    it('identifies private, loopback, and reserved IPv6 blocks', () => {
      // Loopback
      expect(isPrivateOrReservedIpv6('::1')).toBe(true);
      expect(isPrivateOrReservedIpv6('[::1]')).toBe(true);
      expect(isPrivateOrReservedIpv6('::')).toBe(true);

      // ULA (fc00::/7)
      expect(isPrivateOrReservedIpv6('fc00::1')).toBe(true);
      expect(isPrivateOrReservedIpv6('fd12:3456:789a::1')).toBe(true);

      // Link-local (fe80::/10)
      expect(isPrivateOrReservedIpv6('fe80::1')).toBe(true);
      expect(isPrivateOrReservedIpv6('fe80::200:5aee:feaa:20a2')).toBe(true);

      // Multicast
      expect(isPrivateOrReservedIpv6('ff02::1')).toBe(true);

      // IPv4-mapped IPv6 pointing to private addresses
      expect(isPrivateOrReservedIpv6('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateOrReservedIpv6('::ffff:169.254.169.254')).toBe(true);
      expect(isPrivateOrReservedIpv6('::ffff:10.0.0.1')).toBe(true);

      // IPv4-mapped IPv6 pointing to public address
      expect(isPrivateOrReservedIpv6('::ffff:8.8.8.8')).toBe(false);

      // Public global unicast IPv6
      expect(isPrivateOrReservedIpv6('2607:f8b0:4005:805::200e')).toBe(false);
    });
  });

  describe('SSRF Guard: URL & Hostname Validation', () => {
    it('blocks non-http/https protocols', async () => {
      const fileUrl = new URL('file:///C:/Windows/System32/drivers/etc/hosts');
      const res = await validateUrlForSsrf(fileUrl);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('forbidden');
    });

    it('blocks localhost and internal domain names', async () => {
      for (const host of [
        'http://localhost:8080',
        'http://sub.localhost',
        'http://service.local',
        'http://db.internal',
        'http://router.lan',
        'http://metadata.google.internal',
      ]) {
        const res = await validateUrlForSsrf(new URL(host));
        expect(res.valid).toBe(false);
        expect(res.reason).toContain('blocked by SSRF guard');
      }
    });

    it('blocks direct access to private IPv4 and IPv6 URLs', async () => {
      for (const url of [
        'http://127.0.0.1:8080/api',
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.5/',
        'http://192.168.1.1/admin',
        'http://2130706433/', // decimal 127.0.0.1
        'http://0x7f000001/', // hex 127.0.0.1
        'http://[::1]:8080',
        'http://[fd00::1]/',
      ]) {
        const res = await validateUrlForSsrf(new URL(url));
        expect(res.valid).toBe(false);
        expect(res.reason).toContain('blocked by SSRF guard');
      }
    });

    it('blocks hosts that resolve to private IPs via DNS lookup', async () => {
      const mockLookup = (hostname: string) => {
        if (hostname === 'attacker-rebind.com') {
          return Promise.resolve(['169.254.169.254']);
        }
        return Promise.resolve(['93.184.216.34']);
      };

      const evilRes = await validateUrlForSsrf(new URL('http://attacker-rebind.com/api'), {
        lookupFn: mockLookup,
      });
      expect(evilRes.valid).toBe(false);
      expect(evilRes.reason).toContain('resolved to private/reserved');

      const goodRes = await validateUrlForSsrf(new URL('https://example.com/api'), {
        lookupFn: mockLookup,
      });
      expect(goodRes.valid).toBe(true);
      expect(goodRes.resolvedIps).toEqual(['93.184.216.34']);
    });

    it('enforces host allowlist with exact and wildcard rules', async () => {
      const allowlist = ['api.github.com', '*.example.com'];

      expect(matchesHostAllowlist('api.github.com', allowlist)).toBe(true);
      expect(matchesHostAllowlist('sub.example.com', allowlist)).toBe(true);
      expect(matchesHostAllowlist('deep.nested.example.com', allowlist)).toBe(true);
      expect(matchesHostAllowlist('evil.com', allowlist)).toBe(false);
      expect(matchesHostAllowlist('github.com', allowlist)).toBe(false);

      const mockLookup = () => Promise.resolve(['93.184.216.34']);

      const blockedRes = await validateUrlForSsrf(new URL('https://evil.com/data'), {
        allowlist,
        lookupFn: mockLookup,
      });
      expect(blockedRes.valid).toBe(false);
      expect(blockedRes.reason).toContain('not in the configured allowlist');

      const allowedRes = await validateUrlForSsrf(new URL('https://api.github.com/zen'), {
        allowlist,
        lookupFn: mockLookup,
      });
      expect(allowedRes.valid).toBe(true);
    });
  });

  describe('Contract and Metadata', () => {
    it('declares risk: medium and non-idempotent semantics', () => {
      expect(httpFetchTool.name).toBe('http.fetch');
      expect(httpFetchTool.risk).toBe('medium');
      expect(httpFetchTool.idempotent).toBe(false);
    });

    it('derives capabilities dynamically from URL', () => {
      const getCaps = httpFetchTool.capabilities;
      expect(getCaps).toBeDefined();
      if (!getCaps) return;

      const caps1 = getCaps({
        url: 'https://api.example.com/data',
        method: 'GET',
        followRedirects: true,
        maxRedirects: 5,
      });
      expect(caps1[0]?.type).toBe('net');
      expect(caps1[0]?.action).toBe('http');
      expect(caps1[0]?.resource).toBe('net.host:api.example.com');

      const caps2 = getCaps({
        url: 'http://example.org:8080/path',
        method: 'POST',
        followRedirects: true,
        maxRedirects: 5,
      });
      expect(caps2[0]?.type).toBe('net');
      expect(caps2[0]?.action).toBe('http');
      expect(caps2[0]?.resource).toBe('net.host:example.org:8080');
    });
  });

  describe('Execution via Injected Fetch', () => {
    const publicLookup = () => Promise.resolve(['93.184.216.34']);

    it('executes a GET request and returns headers, body, and tainted marker', async () => {
      const mockFetch: typeof fetch = () => {
        return Promise.resolve(
          new Response(JSON.stringify({ greeting: 'hello' }), {
            status: 200,
            statusText: 'OK',
            headers: {
              'content-type': 'application/json',
              'x-custom-header': 'air-test',
            },
          }),
        );
      };

      const tool = createHttpFetchTool({
        fetchFn: mockFetch,
        lookupFn: publicLookup,
      });

      const executor = new ToolExecutor();
      const result = await executor.execute({
        tool,
        runId: 'run-000001',
        input: {
          url: 'https://api.example.com/hello',
          method: 'GET',
        },
      });

      const output = result.output;
      expect(output.status).toBe(200);
      expect(output.statusText).toBe('OK');
      expect(output.body).toBe('{"greeting":"hello"}');
      expect(output.headers['content-type']).toBe('application/json');
      expect(output.headers['x-custom-header']).toBe('air-test');
      expect(output.truncated).toBe(false);
      expect(output.tainted).toBe(true);
      expect(output.finalUrl).toBe('https://api.example.com/hello');
    });

    it('handles POST requests with body', async () => {
      let receivedMethod = '';
      let receivedBody = '';

      const mockFetch: typeof fetch = (_url, init) => {
        receivedMethod = init?.method ?? '';
        receivedBody = typeof init?.body === 'string' ? init.body : '';
        return Promise.resolve(new Response('created', { status: 201, statusText: 'Created' }));
      };

      const tool = createHttpFetchTool({
        fetchFn: mockFetch,
        lookupFn: publicLookup,
      });

      const executor = new ToolExecutor();
      const result = await executor.execute({
        tool,
        runId: 'run-000001',
        input: {
          url: 'https://api.example.com/items',
          method: 'POST',
          body: JSON.stringify({ item: 'widget' }),
        },
      });

      expect(receivedMethod).toBe('POST');
      expect(receivedBody).toBe('{"item":"widget"}');
      expect(result.output.status).toBe(201);
      expect(result.output.body).toBe('created');
    });

    it('follows valid redirects and updates finalUrl', async () => {
      let fetchCount = 0;
      const mockFetch: typeof fetch = (url) => {
        fetchCount += 1;
        if (url === 'https://api.example.com/old-path') {
          return Promise.resolve(
            new Response(null, {
              status: 301,
              headers: { location: 'https://api.example.com/new-path' },
            }),
          );
        }
        return Promise.resolve(new Response('landed successfully', { status: 200 }));
      };

      const tool = createHttpFetchTool({
        fetchFn: mockFetch,
        lookupFn: publicLookup,
      });

      const executor = new ToolExecutor();
      const result = await executor.execute({
        tool,
        runId: 'run-000001',
        input: {
          url: 'https://api.example.com/old-path',
        },
      });

      expect(fetchCount).toBe(2);
      expect(result.output.status).toBe(200);
      expect(result.output.finalUrl).toBe('https://api.example.com/new-path');
      expect(result.output.body).toBe('landed successfully');
    });

    it('blocks redirects to private IPs (SSRF redirect defense)', async () => {
      const mockFetch: typeof fetch = (url) => {
        if (url === 'https://api.example.com/redirect-to-metadata') {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: 'http://169.254.169.254/latest/meta-data/' },
            }),
          );
        }
        return Promise.resolve(new Response('metadata'));
      };

      const tool = createHttpFetchTool({
        fetchFn: mockFetch,
        lookupFn: publicLookup,
      });

      const executor = new ToolExecutor();
      await expect(
        executor.execute({
          tool,
          runId: 'run-000001',
          input: {
            url: 'https://api.example.com/redirect-to-metadata',
          },
        }),
      ).rejects.toThrow(/SSRF guard blocked request/);
    });

    it('throws when exceeding maxRedirects', async () => {
      const mockFetch: typeof fetch = () => {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://api.example.com/loop' },
          }),
        );
      };

      const tool = createHttpFetchTool({
        fetchFn: mockFetch,
        lookupFn: publicLookup,
      });

      const executor = new ToolExecutor();
      await expect(
        executor.execute({
          tool,
          runId: 'run-000001',
          input: {
            url: 'https://api.example.com/loop',
            maxRedirects: 3,
          },
        }),
      ).rejects.toThrow(/Exceeded maximum redirect limit/);
    });

    it('truncates oversized response bodies and sets truncated: true', async () => {
      const hugeString = 'X'.repeat(5000);
      const mockFetch: typeof fetch = () => {
        return Promise.resolve(new Response(hugeString, { status: 200 }));
      };

      const tool = createHttpFetchTool({
        fetchFn: mockFetch,
        lookupFn: publicLookup,
      });

      const executor = new ToolExecutor();
      const result = await executor.execute({
        tool,
        runId: 'run-000001',
        input: {
          url: 'https://api.example.com/huge',
          maxResponseBytes: 1000,
        },
      });

      expect(result.output.truncated).toBe(true);
      expect(result.output.body).toContain('[TRUNCATED: maxResponseBytes exceeded]');
      expect(result.output.body.length).toBeLessThan(1200);
    });

    it('handles request timeout and cancellation', async () => {
      const clock = new FakeClock();
      const hangingFetch: typeof fetch = (_url, init) => {
        return new Promise((_, reject) => {
          if (init?.signal?.aborted) {
            return reject(new Error('fetch aborted'));
          }
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('fetch aborted'));
          });
        });
      };

      const tool = createHttpFetchTool({
        fetchFn: hangingFetch,
        lookupFn: publicLookup,
        clock,
      });

      const executor = new ToolExecutor();

      // Test explicit timeout
      await expect(
        executor.execute({
          tool,
          runId: 'run-000001',
          input: {
            url: 'https://api.example.com/hang',
            timeoutMs: 10,
          },
        }),
      ).rejects.toThrow();

      // Test cancellation via signal
      const abortCtrl = new AbortController();
      const promise = executor.execute({
        tool,
        runId: 'run-000001',
        signal: abortCtrl.signal,
        input: {
          url: 'https://api.example.com/hang',
          timeoutMs: 10_000,
        },
      });
      abortCtrl.abort();
      await expect(promise).rejects.toThrow();
    });
  });

  describe('Registry Integration', () => {
    it('registers http.fetch into ToolRegistry and dispatches through executor', async () => {
      const registry = new ToolRegistry();
      const mockFetch: typeof fetch = () => Promise.resolve(new Response('ok', { status: 200 }));

      registerBuiltinHttpTools(registry, {
        fetchFn: mockFetch,
        lookupFn: () => Promise.resolve(['93.184.216.34']),
      });

      expect(registry.has('http.fetch')).toBe(true);
      const tool = registry.get('http.fetch');
      expect(tool).toBeDefined();

      const executor = new ToolExecutor({ registry });
      const result = await executor.execute({
        toolName: 'http.fetch',
        runId: 'run-000001',
        input: {
          url: 'https://example.com/ping',
        },
      });

      const output = result.output as { status: number; body: string };
      expect(output.status).toBe(200);
      expect(output.body).toBe('ok');
    });
  });
});
