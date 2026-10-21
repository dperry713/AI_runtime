/**
 * Unit tests for IPC Server (P9-T01).
 *
 * Covers: built-in daemon.health and daemon.shutdown methods, custom method
 * registration, line handling, error responses, and client session management.
 */

import { describe, expect, it } from 'vitest';
import type { Socket as NetSocket } from 'node:net';
import { IpcServer } from '../../../src/ipc/server.js';
import { MethodRegistry } from '../../../src/ipc/registry.js';
import { FakeClock } from '../../../src/util/index.js';
import { DEFAULT_MAX_FRAME_SIZE, FrameReader, FrameWriter } from '../../../src/ipc/framing.js';

// ============================================================================
// Helpers
// ============================================================================

function makeRegistry(): MethodRegistry {
  return new MethodRegistry();
}

function makeServer(options: {
  registry: MethodRegistry;
  clock?: FakeClock;
}): IpcServer {
  return new IpcServer({
    config: { pipeName: 'test-pipe' },
    registry: options.registry,
    ...(options.clock ? { clock: options.clock } : {}),
  });
}

function makeMockClientSession(server: IpcServer, clientId: string): {
  socket: NetSocket;
  written: string[];
} {
  const written: string[] = [];
  const socket = {
    writable: true,
    write: (data: string) => {
      written.push(data);
    },
    destroy: () => {},
    once: () => {},
    on: () => {},
  } as unknown as NetSocket;

  const writer = new FrameWriter({
    write: (data) => {
      if (socket.writable) {
        socket.write(data);
      }
    },
  });

  const reader = new FrameReader({
    maxFrameSize: DEFAULT_MAX_FRAME_SIZE,
    onLine: () => {},
  });

  const serverAsAny = server as unknown as {
    clients: Map<string, { clientId: string; socket: NetSocket; writer: FrameWriter; reader: FrameReader; subscribed: boolean }>;
  };
  serverAsAny.clients.set(clientId, {
    clientId,
    socket,
    writer,
    reader,
    subscribed: true,
  });

  return { socket, written };
}

// ============================================================================
// pipeName
// ============================================================================

describe('IpcServer pipeName', () => {
  it('returns the pipe name from config', () => {
    const registry = makeRegistry();
    const server = makeServer({ registry });
    expect(server.pipeName).toContain('\\\\.\\pipe\\test-pipe-');
  });
});

// ============================================================================
// isRunning / clientCount
// ============================================================================

describe('IpcServer state', () => {
  it('starts not running', () => {
    const registry = makeRegistry();
    const server = makeServer({ registry });
    expect(server.isRunning).toBe(false);
    expect(server.clientCount).toBe(0);
  });
});

// ============================================================================
// daemon.health
// ============================================================================

describe('daemon.health', () => {
  it('returns protocol version, status, and uptime', async () => {
    const registry = makeRegistry();
    const server = makeServer({ registry });
    const fakeClock = new FakeClock('2026-10-19T00:00:00.000Z');
    const result = await server['handleDaemonHealth'](undefined, {
      correlationId: 'c1',
      clientId: 'c1',
      pipeName: '\\\\.\\pipe\\test',
      clock: fakeClock,
    });
    expect(result.protocolVersion).toBe(1);
    expect(result.status).toBe('healthy');
    expect(result.version).toBe('0.0.0');
    expect(typeof result.uptimeMs).toBe('number');
    expect(typeof result.activeRuns).toBe('number');
  });
});

// ============================================================================
// daemon.shutdown
// ============================================================================

describe('daemon.shutdown', () => {
  it('returns ok true', async () => {
    const registry = makeRegistry();
    const server = makeServer({ registry });
    const fakeClock = new FakeClock('2026-10-19T00:00:00.000Z');
    const result = await server['handleDaemonShutdown'](undefined, {
      correlationId: 'c1',
      clientId: 'c1',
      pipeName: '\\\\.\\pipe\\test',
      clock: fakeClock,
    });
    expect(result).toEqual({ ok: true });
  });
});

// ============================================================================
// Custom method registration
// ============================================================================

describe('custom method registration', () => {
  it('registers and invokes a custom method via handleLine', async () => {
    const registry = makeRegistry();
    let receivedParams: unknown = null;
    registry.register('custom.echo', (params) => {
      receivedParams = params;
      return Promise.resolve({ echoed: params });
    });
    const server = makeServer({ registry });

    const { socket, written } = makeMockClientSession(server, 'client1');
    await server['handleLine']('client1', socket, JSON.stringify({
      jsonrpc: '2.0',
      method: 'custom.echo',
      params: { msg: 'hello' },
      id: '1',
    }));

    expect(receivedParams).toEqual({ msg: 'hello' });
    expect(written).toHaveLength(1);
    const first = written[0];
    expect(first).toBeDefined();
    if (first) {
      const response = JSON.parse(first) as { jsonrpc: string; id: string; result: { echoed: { msg: string } } };
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('1');
      expect(response.result).toEqual({ echoed: { msg: 'hello' } });
    }
  });

  it('returns error response for unknown method via handleLine', async () => {
    const registry = makeRegistry();
    const server = makeServer({ registry });

    const { socket, written } = makeMockClientSession(server, 'client1');
    await server['handleLine']('client1', socket, JSON.stringify({
      jsonrpc: '2.0',
      method: 'nonexistent.method',
      id: '1',
    }));

    expect(written).toHaveLength(1);
    const first = written[0];
    expect(first).toBeDefined();
    if (first) {
      const response = JSON.parse(first) as { jsonrpc: string; id: string; error: { code: number; message: string } };
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('1');
      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toContain('not found');
    }
  });

  it('returns parse error for invalid JSON via handleLine', async () => {
    const registry = makeRegistry();
    const server = makeServer({ registry });

    const { socket, written } = makeMockClientSession(server, 'client1');
    await server['handleLine']('client1', socket, 'not json');

    expect(written).toHaveLength(1);
    const first = written[0];
    expect(first).toBeDefined();
    if (first) {
      const response = JSON.parse(first) as { error: { code: number } };
      expect(response.error.code).toBe(-32700);
    }
  });
});

// ============================================================================
// Determinism with FakeClock
// ============================================================================

describe('determinism with FakeClock', () => {
  it('uses injected clock for uptime calculation', async () => {
    const fakeClock = new FakeClock('2026-10-19T00:00:00.000Z');
    const registry = makeRegistry();
    const server = makeServer({ registry, clock: fakeClock });

    fakeClock.advance(10_000);

    const result = await server['handleDaemonHealth'](undefined, {
      correlationId: 'c1',
      clientId: 'c1',
      pipeName: '\\\\.\\pipe\\test',
      clock: fakeClock,
    });
    expect(result.uptimeMs).toBe(10000);
  });
});
