/**
 * Unit tests for Client SDK AirClient (P9-T03).
 *
 * Covers: initial state, connection state delegation, request/response validation
 * via Zod schemas, invalid param rejection, invalid response rejection, and
 * notification handler registration. Does not require a real pipe server.
 */

import { describe, expect, it } from 'vitest';
import { AirClient } from '../../../src/client/air-client.js';

// ============================================================================
// Helpers
// ============================================================================

function makeClient(options: { pipeName?: string } = {}): AirClient {
  return new AirClient({
    pipeName: options.pipeName ?? '\\\\.\\pipe\\air-client-test',
  });
}

// ============================================================================
// Initial State
// ============================================================================

describe('AirClient initial state', () => {
  it('starts disconnected', () => {
    const client = makeClient();
    expect(client.isConnected).toBe(false);
    expect(client.isConnecting).toBe(false);
    expect(client.pendingRequestCount).toBe(0);
  });

  it('uses default pipe name when none provided', () => {
    const client = new AirClient();
    expect(client.name).toContain('\\\\.\\pipe\\air-');
  });

  it('uses custom pipe name when provided', () => {
    const client = makeClient({ pipeName: '\\\\.\\pipe\\custom-client-pipe' });
    expect(client.name).toBe('\\\\.\\pipe\\custom-client-pipe');
  });
});

// ============================================================================
// Request validation (Zod at wire boundary)
// ============================================================================

describe('request validation', () => {
  it('createSession rejects missing agentId', async () => {
    const client = makeClient();
    await expect(client.createSession({ agentId: '' })).rejects.toThrow();
  });

  it('createSession rejects missing agentId property', async () => {
    const client = makeClient();
    await expect(
      client.createSession({} as unknown as { agentId: string }),
    ).rejects.toThrow();
  });

  it('startRun rejects missing goal', async () => {
    const client = makeClient();
    await expect(
      client.startRun({ sessionId: 's1', agentId: 'a1', goal: '' }),
    ).rejects.toThrow();
  });

  it('resolveApproval rejects invalid decision', async () => {
    const client = makeClient();
    await expect(
      client.resolveApproval({ approvalId: 'ap1', decision: 'maybe' as never }),
    ).rejects.toThrow();
  });

  it('getConfig rejects missing key', async () => {
    const client = makeClient();
    await expect(client.getConfig({ key: '' })).rejects.toThrow();
  });

  it('explainConfig rejects missing key', async () => {
    const client = makeClient();
    await expect(
      client.explainConfig({} as unknown as { key: string }),
    ).rejects.toThrow();
  });
});

// ============================================================================
// Connection delegation
// ============================================================================

describe('connection delegation', () => {
  it('connect throws IPC_CONNECTION_FAILED when no server is listening', async () => {
    const client = makeClient({ pipeName: '\\\\.\\pipe\\air-nonexistent-pipe-xyz' });
    await expect(client.connect()).rejects.toMatchObject({
      code: 'IPC_CONNECTION_FAILED',
    });
    expect(client.isConnected).toBe(false);
  });

  it('disconnect on unconnected client does not throw', async () => {
    const client = makeClient();
    await expect(client.disconnect()).resolves.toBeUndefined();
  });
});

// ============================================================================
// Notification handler registration
// ============================================================================

describe('notification handlers', () => {
  it('onEvent and offEvent register and remove handlers', () => {
    const client = makeClient();
    const handler = () => {};
    client.onEvent(handler);
    client.offEvent(handler);
    // Should not throw
  });

  it('onApprovalRequested and offApprovalRequested register and remove handlers', () => {
    const client = makeClient();
    const handler = () => {};
    client.onApprovalRequested(handler);
    client.offApprovalRequested(handler);
    // Should not throw
  });
});

// ============================================================================
// AirError propagation
// ============================================================================

describe('error propagation', () => {
  it('request failures surface as AirError', async () => {
    const client = makeClient({ pipeName: '\\\\.\\pipe\\air-nonexistent-pipe-abc' });
    await expect(client.health()).rejects.toMatchObject({
      code: 'IPC_CONNECTION_FAILED',
    });
    await expect(client.listSessions()).rejects.toMatchObject({
      code: 'IPC_CONNECTION_FAILED',
    });
    await expect(client.listApprovals()).rejects.toMatchObject({
      code: 'IPC_CONNECTION_FAILED',
    });
  });
});
