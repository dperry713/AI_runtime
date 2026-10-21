/**
 * E2E integration tests for IPC over Windows named pipe (P9-T01).
 *
 * Spawns a real IpcServer and IpcClient on a unique named pipe and verifies
 * the full request/response and notification round-trip.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { IpcServer } from '../../../src/ipc/server.js';
import { IpcClient } from '../../../src/ipc/client.js';
import { MethodRegistry } from '../../../src/ipc/registry.js';
import { FakeClock, UlidIdGenerator } from '../../../src/util/index.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTestPipeBase(): string {
  const suffix = Date.now().toString(36);
  return `air-e2e-${suffix}`;
}

async function waitForClientCount(server: IpcServer, expected: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (server.clientCount !== expected) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for clientCount=${expected}, got ${server.clientCount}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ============================================================================
// E2E Round-Trip
// ============================================================================

describe('IPC E2E round-trip', () => {
  let server: IpcServer | null = null;
  let client: IpcClient | null = null;

  afterEach(async () => {
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // Ignore disconnect errors during cleanup
      }
      client = null;
    }
    if (server) {
      try {
        await server.stop();
      } catch {
        // Ignore stop errors during cleanup
      }
      server = null;
    }
  });

  it('connects, sends daemon.health request, and receives response', async () => {
    const pipeBase = makeTestPipeBase();
    const registry = new MethodRegistry();
    const fakeClock = new FakeClock('2026-10-19T00:00:00.000Z');

    server = new IpcServer({
      config: { pipeName: pipeBase },
      registry,
      clock: fakeClock,
    });
    await server.start();

    client = new IpcClient({
      pipeName: server.pipeName,
      requestTimeoutMs: 5000,
      reconnectDelayMs: 100,
      maxReconnectAttempts: 3,
      clock: fakeClock,
    });
    await client.connect();

    expect(client.isConnected).toBe(true);
    expect(server.isRunning).toBe(true);
    await waitForClientCount(server, 1);

    const health = await client.request<unknown, { protocolVersion: number; status: string }>('daemon.health');
    expect(health.protocolVersion).toBe(1);
    expect(health.status).toBe('healthy');
  });

  it('handles custom method requests and responses', async () => {
    const pipeBase = makeTestPipeBase();
    const registry = new MethodRegistry();
    registry.register('echo', (params) => Promise.resolve({ echoed: params }));

    server = new IpcServer({
      config: { pipeName: pipeBase },
      registry,
    });
    await server.start();

    client = new IpcClient({
      pipeName: server.pipeName,
      requestTimeoutMs: 5000,
      reconnectDelayMs: 100,
      maxReconnectAttempts: 3,
    });
    await client.connect();
    await waitForClientCount(server, 1);

    const result = await client.request<{ msg: string }, { echoed: { msg: string } }>('echo', { msg: 'hello world' });
    expect(result.echoed).toEqual({ msg: 'hello world' });
  });

  it('returns error response for unknown method', async () => {
    const pipeBase = makeTestPipeBase();
    const registry = new MethodRegistry();

    server = new IpcServer({
      config: { pipeName: pipeBase },
      registry,
    });
    await server.start();

    client = new IpcClient({
      pipeName: server.pipeName,
      requestTimeoutMs: 5000,
      reconnectDelayMs: 100,
      maxReconnectAttempts: 3,
    });
    await client.connect();
    await waitForClientCount(server, 1);

    await expect(client.request('nonexistent.method')).rejects.toMatchObject({
      code: 'IPC_PROTOCOL_ERROR',
    });
  });

  it('sends and receives notifications', async () => {
    const pipeBase = makeTestPipeBase();
    const registry = new MethodRegistry();
    let receivedNotification: unknown = null;

    registry.registerNotification('custom.notify', (params) => {
      receivedNotification = params;
      return Promise.resolve();
    });

    server = new IpcServer({
      config: { pipeName: pipeBase },
      registry,
    });
    await server.start();

    client = new IpcClient({
      pipeName: server.pipeName,
      requestTimeoutMs: 5000,
      reconnectDelayMs: 100,
      maxReconnectAttempts: 3,
    });
    await client.connect();
    await waitForClientCount(server, 1);

    client.notify('custom.notify', { data: 'test notification' });

    // Give the server time to process the notification
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receivedNotification).toEqual({ data: 'test notification' });
  });

  it('server broadcasts event notifications to subscribed clients', async () => {
    const pipeBase = makeTestPipeBase();
    const registry = new MethodRegistry();
    const { EventBus } = await import('../../../src/journal/index.js');
    const fakeClock = new FakeClock('2026-10-19T00:00:00.000Z');
    const idGenerator = new UlidIdGenerator(fakeClock);

    const eventBus = new EventBus({ clock: fakeClock, idGenerator });

    server = new IpcServer({
      config: { pipeName: pipeBase },
      registry,
      eventBus,
      clock: fakeClock,
    });
    await server.start();

    client = new IpcClient({
      pipeName: server.pipeName,
      requestTimeoutMs: 5000,
      reconnectDelayMs: 100,
      maxReconnectAttempts: 3,
      clock: fakeClock,
    });
    await client.connect();
    await waitForClientCount(server, 1);

    // Subscribe to events
    let receivedEvent: unknown = null;
    client.onEvent((event) => {
      receivedEvent = event;
    });

    // Publish an event on the bus
    const { createEnvelope } = await import('../../../src/journal/index.js');
    const envelope = createEnvelope({
      stream: 'run:test',
      seq: 1,
      type: 'run.started',
      payload: { runId: 'test-run' },
      clock: fakeClock,
      idGenerator,
    });
    eventBus.publish(envelope);

    // Give the server time to broadcast
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receivedEvent).not.toBeNull();
    expect((receivedEvent as { type?: string }).type).toBe('run.started');
  });

  it('disconnects cleanly', async () => {
    const pipeBase = makeTestPipeBase();
    const registry = new MethodRegistry();

    server = new IpcServer({
      config: { pipeName: pipeBase },
      registry,
    });
    await server.start();

    client = new IpcClient({
      pipeName: server.pipeName,
      requestTimeoutMs: 5000,
      reconnectDelayMs: 100,
      maxReconnectAttempts: 3,
    });
    await client.connect();
    await waitForClientCount(server, 1);

    expect(client.isConnected).toBe(true);
    expect(server.clientCount).toBe(1);

    await client.disconnect();
    expect(client.isConnected).toBe(false);
  });
});
