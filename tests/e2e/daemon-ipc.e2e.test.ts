/**
 * E2E test suite for AIR Daemon and IPC over Windows named pipe (Phase 9 - R-008).
 *
 * Spawns real Daemon and AirClient on a unique named pipe and verifies:
 * - Boot sequence, health check, session creation
 * - Concurrent client connections
 * - Malformed JSON rejection
 * - Client disconnect / resilience
 * - Graceful shutdown
 */

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AirClient } from '../../src/client/index.js';
import { Daemon } from '../../src/service/index.js';

function makeTestPipe(): string {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return `air-e2e-${suffix}`;
}

describe('E2E: Daemon & IPC over Named Pipe', () => {
  let daemon: Daemon | null = null;
  let client1: AirClient | null = null;
  let client2: AirClient | null = null;

  afterEach(async () => {
    if (client1) {
      try {
        await client1.disconnect();
      } catch {
        // ignore
      }
      client1 = null;
    }
    if (client2) {
      try {
        await client2.disconnect();
      } catch {
        // ignore
      }
      client2 = null;
    }
    if (daemon) {
      try {
        await daemon.stop();
      } catch {
        // ignore
      }
      daemon = null;
    }
  });

  it('boots real daemon on temp pipe, serves health, and shuts down', async () => {
    const home = path.join(os.tmpdir(), `air-e2e-home-${Date.now()}`);
    const pipeName = makeTestPipe();

    daemon = new Daemon({
      home,
      pipeName,
      skipPidfile: true,
    });
    await daemon.boot();

    const fullPipe = daemon.pipeNameValue ?? '';
    expect(daemon.stateValue).toBe('running');

    client1 = new AirClient({
      pipeName: fullPipe,
      requestTimeoutMs: 5000,
    });
    await client1.connect();

    const health = await client1.health();
    expect(health.status).toBe('healthy');
    expect(health.protocolVersion).toBe(1);

    const session = await client1.createSession({ agentId: 'auditor' });
    expect(session.sessionId).toBeDefined();

    const sessions = await client1.listSessions();
    expect(sessions.sessions.some((s) => s.sessionId === session.sessionId)).toBe(true);

    await client1.disconnect();
    client1 = null;

    await daemon.stop();
    expect(daemon.stateValue).toBe('stopped');
    daemon = null;
  });

  it('handles multiple concurrent client connections', async () => {
    const home = path.join(os.tmpdir(), `air-e2e-home-${Date.now()}`);
    const pipeName = makeTestPipe();

    daemon = new Daemon({
      home,
      pipeName,
      skipPidfile: true,
    });
    await daemon.boot();

    const fullPipe = daemon.pipeNameValue ?? '';

    client1 = new AirClient({ pipeName: fullPipe, requestTimeoutMs: 5000 });
    client2 = new AirClient({ pipeName: fullPipe, requestTimeoutMs: 5000 });

    await Promise.all([client1.connect(), client2.connect()]);

    const [h1, h2] = await Promise.all([client1.health(), client2.health()]);
    expect(h1.status).toBe('healthy');
    expect(h2.status).toBe('healthy');
  });

  it('handles client crash / abrupt disconnect without crashing daemon', async () => {
    const home = path.join(os.tmpdir(), `air-e2e-home-${Date.now()}`);
    const pipeName = makeTestPipe();

    daemon = new Daemon({
      home,
      pipeName,
      skipPidfile: true,
    });
    await daemon.boot();

    const fullPipe = daemon.pipeNameValue ?? '';

    const socket = net.connect(fullPipe);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    // Abruptly destroy the socket
    socket.destroy();

    // Verify daemon is still healthy and accepts new clients
    client1 = new AirClient({ pipeName: fullPipe, requestTimeoutMs: 5000 });
    await client1.connect();
    const health = await client1.health();
    expect(health.status).toBe('healthy');
  });

  it('rejects malformed non-JSON frame with JSON-RPC parse error', async () => {
    const home = path.join(os.tmpdir(), `air-e2e-home-${Date.now()}`);
    const pipeName = makeTestPipe();

    daemon = new Daemon({
      home,
      pipeName,
      skipPidfile: true,
    });
    await daemon.boot();

    const fullPipe = daemon.pipeNameValue ?? '';

    const socket = net.connect(fullPipe);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    const responsePromise = new Promise<string>((resolve) => {
      socket.once('data', (data) => resolve(data.toString('utf-8')));
    });

    socket.write('THIS_IS_NOT_VALID_JSON\n');
    const response = await responsePromise;
    socket.end();

    const parsed = JSON.parse(response) as { error?: { code: number } };
    expect(parsed.error?.code).toBe(-32700); // Parse error
  });
});
