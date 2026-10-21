/**
 * Integration tests for Daemon host (P9-T02).
 *
 * Spawns a real Daemon with an IPC server on a unique named pipe and verifies
 * the full boot → health → shutdown lifecycle over IPC.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { Daemon } from '../../../src/service/daemon.js';
import { IpcClient } from '../../../src/ipc/client.js';
import { FakeClock } from '../../../src/util/index.js';
import { resetLogging } from '../../../src/observability/index.js';
import os from 'node:os';
import path from 'node:path';

// ============================================================================
// Helpers
// ============================================================================

function makeTestPipeBase(): string {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2);
  return `air-daemon-int-${suffix}`;
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 5000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for condition`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function requireDaemon(d: Daemon | null): Daemon {
  if (!d) {
    throw new Error('Daemon not initialized');
  }
  return d;
}

function requireClient(c: IpcClient | null): IpcClient {
  if (!c) {
    throw new Error('IpcClient not initialized');
  }
  return c;
}

// ============================================================================
// Daemon lifecycle over IPC
// ============================================================================

describe('Daemon integration over IPC', () => {
  let daemon: Daemon | null = null;
  let client: IpcClient | null = null;

  afterEach(async () => {
    // Stop daemon first (closes server-side sockets, triggering client close)
    if (daemon) {
      try {
        await Promise.race([
          daemon.stop(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('daemon.stop timeout')), 5000)),
        ]);
      } catch {
        // Ignore stop errors during cleanup
      }
      daemon = null;
    }
    // Then disconnect client
    if (client) {
      try {
        await Promise.race([
          client.disconnect(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('client.disconnect timeout')), 5000)),
        ]);
      } catch {
        // Ignore disconnect errors during cleanup
      }
      client = null;
    }
    resetLogging();
  });

  it('boots, responds to daemon.health, and shuts down via IPC', async () => {
    const home = path.join(os.tmpdir(), `air-daemon-int-home-${Date.now()}`);
    const pipeBase = makeTestPipeBase();
    const clock = new FakeClock('2026-10-20T00:00:00.000Z');

    daemon = new Daemon({
      home,
      pipeName: pipeBase,
      skipRecovery: true,
      skipPidfile: true,
      clock,
    });

    await daemon.boot();

    const d = requireDaemon(daemon);
    expect(d.isRunning).toBe(true);
    expect(d.pipeNameValue).toContain(`\\\\.\\pipe\\${pipeBase}`);

    client = new IpcClient({
      pipeName: d.pipeNameValue ?? '',
      requestTimeoutMs: 5000,
      reconnectDelayMs: 100,
      maxReconnectAttempts: 3,
      clock,
    });
    await client.connect();

    const c = requireClient(client);
    expect(c.isConnected).toBe(true);

    const health = await c.request<unknown, {
      protocolVersion: number;
      status: string;
      uptimeMs: number;
      activeRuns: number;
      version: string;
    }>('daemon.health');

    expect(health.protocolVersion).toBe(1);
    expect(health.status).toBe('healthy');
    expect(typeof health.activeRuns).toBe('number');
    expect(health.activeRuns).toBeGreaterThanOrEqual(0);
    expect(health.version).toBe('0.0.0');

    // daemon.shutdown acknowledges the request; actual shutdown is via stop()
    const shutdownResult = await c.request<unknown, { ok: boolean }>('daemon.shutdown');
    expect(shutdownResult.ok).toBe(true);

    // Stop the daemon directly (graceful shutdown)
    await Promise.race([
      d.stop(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('daemon.stop timeout')), 5000)),
    ]);

    expect(d.stateValue).toBe('stopped');
    expect(d.isRunning).toBe(false);
  });

  it('rejects unknown methods with method not found', async () => {
    const home = path.join(os.tmpdir(), `air-daemon-int-home-${Date.now()}`);
    const pipeBase = makeTestPipeBase();

    daemon = new Daemon({
      home,
      pipeName: pipeBase,
      skipRecovery: true,
      skipPidfile: true,
    });

    await daemon.boot();

    const d = requireDaemon(daemon);

    client = new IpcClient({
      pipeName: d.pipeNameValue ?? '',
      requestTimeoutMs: 5000,
      reconnectDelayMs: 100,
      maxReconnectAttempts: 3,
    });
    await client.connect();

    const c = requireClient(client);

    await expect(
      c.request('nonexistent.method'),
    ).rejects.toMatchObject({
      code: 'IPC_PROTOCOL_ERROR',
    });
  });

  it('status reflects active runs count from index store', async () => {
    const home = path.join(os.tmpdir(), `air-daemon-int-home-${Date.now()}`);
    const pipeBase = makeTestPipeBase();

    daemon = new Daemon({
      home,
      pipeName: pipeBase,
      skipRecovery: true,
      skipPidfile: true,
    });

    await daemon.boot();

    const d = requireDaemon(daemon);
    expect(d.status.activeRuns).toBe(0);
    expect(d.status.clientCount).toBe(0);

    client = new IpcClient({
      pipeName: d.pipeNameValue ?? '',
      requestTimeoutMs: 5000,
      reconnectDelayMs: 100,
      maxReconnectAttempts: 3,
    });
    await client.connect();

    const c = requireClient(client);

    await waitForCondition(() => d.clientCount === 1, 5000);
    expect(d.status.clientCount).toBe(1);

    await c.disconnect();
    await waitForCondition(() => d.clientCount === 0, 5000);
    expect(d.status.clientCount).toBe(0);
  });
});
