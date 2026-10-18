/**
 * Unit tests for Network Egress Control (P7-T04).
 */

import http from 'node:http';
import net from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import {
  parseHostAndPort,
  matchesHostPattern,
  evaluateEgressPolicy,
  EgressProxy,
  NetworkEgressController,
  WindowsFirewallManager,
} from '../../../src/sandbox/network.js';
import type { EgressLogEvent } from '../../../src/sandbox/network.js';

describe('Network Egress Control (P7-T04)', () => {
  const disposables: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (disposables.length > 0) {
      const dispose = disposables.pop();
      if (dispose) {
        try {
          await dispose();
        } catch {
          // ignore cleanup errors
        }
      }
    }
  });

  describe('Host Parsing & Pattern Matching', () => {
    it('parses standard hosts and ports correctly', () => {
      expect(parseHostAndPort('example.com')).toEqual({ host: 'example.com', port: 80 });
      expect(parseHostAndPort('example.com:8080')).toEqual({ host: 'example.com', port: 8080 });
      expect(parseHostAndPort('EXAMPLE.COM:443')).toEqual({ host: 'example.com', port: 443 });
      expect(parseHostAndPort('[::1]:9000')).toEqual({ host: '::1', port: 9000 });
      expect(parseHostAndPort('[2001:db8::1]')).toEqual({ host: '2001:db8::1', port: 80 });
    });

    it('matches exact hostnames case-insensitively', () => {
      expect(matchesHostPattern('api.github.com', 443, 'api.github.com')).toBe(true);
      expect(matchesHostPattern('API.GITHUB.COM', 443, 'api.github.com')).toBe(true);
      expect(matchesHostPattern('api.gitlab.com', 443, 'api.github.com')).toBe(false);
    });

    it('matches wildcard subdomains (*.example.com)', () => {
      expect(matchesHostPattern('api.github.com', 443, '*.github.com')).toBe(true);
      expect(matchesHostPattern('raw.github.com', 443, '*.github.com')).toBe(true);
      expect(matchesHostPattern('deep.sub.github.com', 443, '*.github.com')).toBe(true);
      expect(matchesHostPattern('github.com', 443, '*.github.com')).toBe(false);
      expect(matchesHostPattern('evilgithub.com', 443, '*.github.com')).toBe(false);
    });

    it('matches leading dot patterns (.example.com)', () => {
      expect(matchesHostPattern('github.com', 443, '.github.com')).toBe(true);
      expect(matchesHostPattern('api.github.com', 443, '.github.com')).toBe(true);
      expect(matchesHostPattern('other.com', 443, '.github.com')).toBe(false);
    });

    it('respects port restrictions in patterns', () => {
      expect(matchesHostPattern('api.github.com', 443, 'api.github.com:443')).toBe(true);
      expect(matchesHostPattern('api.github.com', 80, 'api.github.com:443')).toBe(false);
      expect(matchesHostPattern('api.github.com', 8080, '*:8080')).toBe(true);
      expect(matchesHostPattern('api.github.com', 80, '*:8080')).toBe(false);
    });

    it('matches universal wildcard pattern', () => {
      expect(matchesHostPattern('anything.io', 443, '*')).toBe(true);
      expect(matchesHostPattern('something.else.org', 80, '')).toBe(true);
    });
  });

  describe('Policy Evaluation & SSRF Protection', () => {
    it('denies by default when no allowed hosts are configured', async () => {
      const decision = await evaluateEgressPolicy('api.github.com', 443, { allowedHosts: [] });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('DENIED_DEFAULT');
    });

    it('denies hosts that do not match the allowlist', async () => {
      const decision = await evaluateEgressPolicy('evil.com', 443, {
        allowedHosts: ['*.github.com'],
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('DENIED_ALLOWLIST');
    });

    it('allows matching hosts in allowlist', async () => {
      // Use raw IP to bypass external DNS resolution in offline test
      const decision = await evaluateEgressPolicy('8.8.8.8', 53, {
        allowedHosts: ['8.8.8.8'],
      });
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toContain('ALLOWED');
    });

    it('blocks loopback addresses (127.0.0.1, localhost, ::1) under SSRF policy', async () => {
      const d1 = await evaluateEgressPolicy('127.0.0.1', 8080, { allowedHosts: ['*'] });
      expect(d1.allowed).toBe(false);
      expect(d1.reason).toContain('DENIED_LOOPBACK');

      const d2 = await evaluateEgressPolicy('localhost', 3000, { allowedHosts: ['*'] });
      expect(d2.allowed).toBe(false);
      expect(d2.reason).toContain('DENIED_LOOPBACK');

      const d3 = await evaluateEgressPolicy('::1', 80, { allowedHosts: ['*'] });
      expect(d3.allowed).toBe(false);
      expect(d3.reason).toContain('DENIED_LOOPBACK');
    });

    it('blocks cloud metadata endpoint (169.254.169.254) under SSRF policy', async () => {
      const decision = await evaluateEgressPolicy('169.254.169.254', 80, { allowedHosts: ['*'] });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('DENIED_METADATA_OR_LINK_LOCAL');
    });

    it('blocks RFC1918 private IP subnets under SSRF policy', async () => {
      const d10 = await evaluateEgressPolicy('10.0.0.1', 80, { allowedHosts: ['*'] });
      expect(d10.allowed).toBe(false);
      expect(d10.reason).toContain('DENIED_PRIVATE_IP');

      const d192 = await evaluateEgressPolicy('192.168.1.1', 443, { allowedHosts: ['*'] });
      expect(d192.allowed).toBe(false);
      expect(d192.reason).toContain('DENIED_PRIVATE_IP');

      const d172 = await evaluateEgressPolicy('172.16.0.50', 8080, { allowedHosts: ['*'] });
      expect(d172.allowed).toBe(false);
      expect(d172.reason).toContain('DENIED_PRIVATE_IP');
    });

    it('blocks carrier-grade NAT (100.64.0.0/10) under SSRF policy', async () => {
      const decision = await evaluateEgressPolicy('100.64.0.1', 80, { allowedHosts: ['*'] });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('DENIED_PRIVATE_IP');
    });
  });

  describe('EgressProxy Server (HTTP & HTTPS CONNECT)', () => {
    it('starts on loopback and provides a valid proxy URL', async () => {
      const proxy = new EgressProxy({ allowedHosts: ['example.com'] });
      const port = await proxy.start();
      disposables.push(() => proxy.stop());

      expect(port).toBeGreaterThan(0);
      expect(proxy.getPort()).toBe(port);
      expect(proxy.getProxyUrl()).toBe(`http://127.0.0.1:${port}`);
    });

    it('blocks HTTP requests to non-allowlisted targets with 403 Forbidden', async () => {
      const events: EgressLogEvent[] = [];
      const proxy = new EgressProxy({
        allowedHosts: ['api.github.com'],
        onEvent: (e) => events.push(e),
      });
      const proxyPort = await proxy.start();
      disposables.push(() => proxy.stop());

      // Send request via proxy to blocked host
      const response = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }>(
        (resolve, reject) => {
          const req = http.request(
            {
              host: '127.0.0.1',
              port: proxyPort,
              method: 'GET',
              path: 'http://evil.com/data',
              headers: { host: 'evil.com' },
            },
            (res) => {
              let body = '';
              res.on('data', (c) => (body += c));
              res.on('end', () =>
                resolve({
                  statusCode: res.statusCode ?? 0,
                  headers: res.headers,
                  body,
                }),
              );
            },
          );
          req.on('error', reject);
          req.end();
        },
      );

      expect(response.statusCode).toBe(403);
      expect(response.headers['x-air-egress-denied']).toBe('true');
      expect(response.body).toContain('EGRESS_DENIED');
      expect(events.length).toBe(1);
      expect(events[0]?.allowed).toBe(false);
      expect(events[0]?.host).toBe('evil.com');
    });

    it('forwards allowed HTTP requests to local origin server', async () => {
      // 1. Create a dummy origin server
      const originServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`Hello from origin: ${req.url}`);
      });

      const originPort = await new Promise<number>((resolve) => {
        originServer.listen(0, '127.0.0.1', () => {
          const addr = originServer.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });
      disposables.push(
        () =>
          new Promise((resolve) => {
            originServer.close(() => resolve());
          }),
      );

      // 2. Start proxy configured to allow this origin port (with allowLoopback: true for test)
      const events: EgressLogEvent[] = [];
      const proxy = new EgressProxy({
        allowedHosts: [`127.0.0.1:${originPort}`],
        allowLoopback: true,
        onEvent: (e) => events.push(e),
      });
      const proxyPort = await proxy.start();
      disposables.push(() => proxy.stop());

      // 3. Send request through proxy
      const response = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            method: 'GET',
            path: `http://127.0.0.1:${originPort}/test-endpoint`,
            headers: { host: `127.0.0.1:${originPort}` },
          },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          },
        );
        req.on('error', reject);
        req.end();
      });

      expect(response).toBe('Hello from origin: /test-endpoint');
      expect(events.length).toBe(1);
      expect(events[0]?.allowed).toBe(true);
      expect(events[0]?.port).toBe(originPort);
    });

    it('handles HTTPS CONNECT requests: blocks disallowed targets', async () => {
      const events: EgressLogEvent[] = [];
      const proxy = new EgressProxy({
        allowedHosts: ['api.github.com'],
        onEvent: (e) => events.push(e),
      });
      const proxyPort = await proxy.start();
      disposables.push(() => proxy.stop());

      const client = net.connect(proxyPort, '127.0.0.1');
      disposables.push(() => {
        client.destroy();
        return Promise.resolve();
      });

      const rawResponse = await new Promise<string>((resolve, reject) => {
        client.on('error', reject);
        client.write('CONNECT evil.com:443 HTTP/1.1\r\nHost: evil.com:443\r\n\r\n');
        client.on('data', (data) => {
          resolve(data.toString());
        });
      });

      expect(rawResponse).toContain('403 Forbidden');
      expect(events.length).toBe(1);
      expect(events[0]?.method).toBe('CONNECT');
      expect(events[0]?.allowed).toBe(false);
      expect(events[0]?.host).toBe('evil.com');
    });

    it('handles HTTPS CONNECT requests: allows authorized targets and pipes data', async () => {
      // 1. Create a mock TCP target server
      const targetServer = net.createServer((socket) => {
        socket.on('data', (data) => {
          socket.write(`ECHO:${data.toString()}`);
        });
      });

      const targetPort = await new Promise<number>((resolve) => {
        targetServer.listen(0, '127.0.0.1', () => {
          const addr = targetServer.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });
      disposables.push(
        () =>
          new Promise((resolve) => {
            targetServer.close(() => resolve());
          }),
      );

      // 2. Start proxy allowing this port
      const proxy = new EgressProxy({
        allowedHosts: [`127.0.0.1:${targetPort}`],
        allowLoopback: true,
      });
      const proxyPort = await proxy.start();
      disposables.push(() => proxy.stop());

      // 3. Connect to proxy and request tunnel
      const client = net.connect(proxyPort, '127.0.0.1');
      disposables.push(() => {
        client.destroy();
        return Promise.resolve();
      });

      await new Promise<void>((resolve, reject) => {
        client.on('error', reject);
        client.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
        client.once('data', (data) => {
          const str = data.toString();
          if (str.includes('200 Connection Established')) {
            resolve();
          } else {
            reject(new Error(`Unexpected response: ${str}`));
          }
        });
      });

      // 4. Send tunnel payload and verify bidirectional piping
      const echoResponse = await new Promise<string>((resolve) => {
        client.once('data', (data) => {
          resolve(data.toString());
        });
        client.write('hello-tunnel');
      });

      expect(echoResponse).toBe('ECHO:hello-tunnel');
    });

    it('manages proxy lifecycle methods cleanly (getPort, getProxyUrl, idempotent start/stop)', async () => {
      const proxy = new EgressProxy({ allowedHosts: ['api.github.com'] });
      expect(proxy.getPort()).toBe(0);
      expect(() => proxy.getProxyUrl()).toThrow('Egress proxy is not running');

      const port1 = await proxy.start();
      expect(port1).toBeGreaterThan(0);
      expect(proxy.getPort()).toBe(port1);
      expect(proxy.getProxyUrl()).toBe(`http://127.0.0.1:${port1}`);

      // Second start call returns existing port
      const port2 = await proxy.start();
      expect(port2).toBe(port1);

      await proxy.stop();
      expect(proxy.getPort()).toBe(0);

      // Idempotent stop
      await proxy.stop();
    });

    it('returns 502 Bad Gateway when forwarding HTTP request to offline destination', async () => {
      // Find an unused local port
      const dummyPort = 59876;
      const proxy = new EgressProxy({
        allowedHosts: [`127.0.0.1:${dummyPort}`],
        allowLoopback: true,
      });
      const proxyPort = await proxy.start();
      disposables.push(() => proxy.stop());

      const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            method: 'GET',
            path: `http://127.0.0.1:${dummyPort}/`,
            headers: { host: `127.0.0.1:${dummyPort}` },
          },
          (response) => {
            let body = '';
            response.on('data', (c) => (body += c));
            response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.end();
      });

      expect(res.statusCode).toBe(502);
      expect(res.body).toContain('Bad Gateway');
    });

    it('returns 502 Bad Gateway on CONNECT when destination cannot be reached', async () => {
      const dummyPort = 59877;
      const proxy = new EgressProxy({
        allowedHosts: [`127.0.0.1:${dummyPort}`],
        allowLoopback: true,
      });
      const proxyPort = await proxy.start();
      disposables.push(() => proxy.stop());

      const client = net.connect(proxyPort, '127.0.0.1');
      disposables.push(() => {
        client.destroy();
        return Promise.resolve();
      });

      const response = await new Promise<string>((resolve, reject) => {
        client.on('error', reject);
        client.write(`CONNECT 127.0.0.1:${dummyPort} HTTP/1.1\r\nHost: 127.0.0.1:${dummyPort}\r\n\r\n`);
        client.on('data', (data) => {
          resolve(data.toString());
        });
      });

      expect(response).toContain('502 Bad Gateway');
    });

    it('denies domain that fails DNS resolution under evaluateEgressPolicy', async () => {
      const decision = await evaluateEgressPolicy('this-domain-definitely-does-not-exist-air-sandbox.invalid', 443, {
        allowedHosts: ['*.invalid'],
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('DENIED_DNS_LOOKUP_FAILED');
    });
  });

  describe('NetworkEgressController Environment Configuration', () => {
    it('strips all proxy variables when network is denied (default deny)', () => {
      const controller = new NetworkEgressController({
        allowedHosts: ['api.github.com'],
      });

      const dirtyEnv: Record<string, string> = {
        PATH: 'C:\\Windows',
        HTTP_PROXY: 'http://rogue-proxy.com:8080',
        HTTPS_PROXY: 'http://rogue-proxy.com:8080',
        ALL_PROXY: 'socks5://rogue.com',
        NO_PROXY: '*',
      };

      const cleanEnv = controller.configureEnvironment(dirtyEnv, false);
      expect(cleanEnv.PATH).toBe('C:\\Windows');
      expect(cleanEnv.HTTP_PROXY).toBeUndefined();
      expect(cleanEnv.HTTPS_PROXY).toBeUndefined();
      expect(cleanEnv.ALL_PROXY).toBeUndefined();
      expect(cleanEnv.NO_PROXY).toBeUndefined();
    });

    it('injects loopback proxy variables when network is enabled and proxy is started', async () => {
      const controller = new NetworkEgressController({
        allowedHosts: ['api.github.com'],
      });
      const proxyUrl = await controller.start();
      disposables.push(() => controller.stop());

      expect(proxyUrl).toBeDefined();

      const baseEnv: Record<string, string> = {
        PATH: 'C:\\Windows',
      };

      const configuredEnv = controller.configureEnvironment(baseEnv, true);
      expect(configuredEnv.HTTP_PROXY).toBe(proxyUrl);
      expect(configuredEnv.HTTPS_PROXY).toBe(proxyUrl);
      expect(configuredEnv.ALL_PROXY).toBe(proxyUrl);
      expect(configuredEnv.http_proxy).toBe(proxyUrl);
      expect(configuredEnv.https_proxy).toBe(proxyUrl);
      expect(configuredEnv.NO_PROXY).toBe('localhost,127.0.0.1');
    });
  });

  describe('WindowsFirewallManager', () => {
    it('checks elevation status safely without throwing', async () => {
      const elevated = await WindowsFirewallManager.isElevated();
      expect(typeof elevated).toBe('boolean');
    });

    it('gracefully reports elevation requirement when adding rules without admin rights', async () => {
      const elevated = await WindowsFirewallManager.isElevated();
      if (!elevated) {
        const res = await WindowsFirewallManager.addOutboundBlockRule('AIR-Test-Rule', 'C:\\dummy.exe');
        expect(res.success).toBe(false);
        expect(res.message).toContain('Elevation required');
      }
    });

    it('safely attempts rule removal without throwing', async () => {
      const res = await WindowsFirewallManager.removeRule('AIR-NonExistent-Rule');
      // Should return a result object and not crash the process
      expect(typeof res.success).toBe('boolean');
      expect(typeof res.message).toBe('string');
    });
  });
});
