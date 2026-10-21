/**
 * Unit tests for shell commands (P9-T04/P9-T05).
 *
 * Commands are tested with a mock AirClient that returns predefined results,
 * verifying that each command correctly delegates to the client and formats
 * results.
 */

import { describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  CommandRegistry,
  registerBuiltinCommands,
  type CommandContext,
} from '../../../src/shell/commands.js';

// ============================================================================
// Mock AirClient
// ============================================================================

class MockAirClient {
  get name(): string {
    return '\\\\.\\pipe\\air-mock';
  }
  get isConnected(): boolean {
    return true;
  }
  get isConnecting(): boolean {
    return false;
  }
  get pendingRequestCount(): number {
    return 0;
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  health(): Promise<{
    protocolVersion: number;
    status: string;
    uptimeMs: number;
    activeRuns: number;
    version: string;
  }> {
    return Promise.resolve({
      protocolVersion: 1,
      status: 'healthy',
      uptimeMs: 0,
      activeRuns: 0,
      version: '0.0.0',
    });
  }
  shutdown(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }
  createSession(): Promise<{ sessionId: string }> {
    return Promise.resolve({ sessionId: 'sess-123' });
  }
  listSessions(): Promise<{
    sessions: Array<{ sessionId: string; agentId: string; createdAt: string }>;
  }> {
    return Promise.resolve({
      sessions: [{ sessionId: 'sess-123', agentId: 'agent-1', createdAt: '2026-10-20T00:00:00Z' }],
    });
  }
  startRun(): Promise<{ runId: string }> {
    return Promise.resolve({ runId: 'run-123' });
  }
  cancelRun(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }
  pauseRun(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }
  resumeRun(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }
  listRuns(): Promise<{
    runs: Array<{ runId: string; status: string; createdAt: string }>;
  }> {
    return Promise.resolve({
      runs: [{ runId: 'run-123', status: 'running', createdAt: '2026-10-20T00:00:00Z' }],
    });
  }
  getRun(): Promise<{ run: unknown }> {
    return Promise.resolve({ run: { runId: 'run-123' } });
  }
  replayRun(): Promise<{ runId: string; events: unknown[] }> {
    return Promise.resolve({ runId: 'run-123', events: [] });
  }
  listApprovals(): Promise<{ approvals: unknown[] }> {
    return Promise.resolve({ approvals: [] });
  }
  resolveApproval(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }
  tailLogs(): Promise<{ records: unknown[] }> {
    return Promise.resolve({ records: [] });
  }
  getConfig(): Promise<{ value: unknown; source: string }> {
    return Promise.resolve({ value: 'info', source: 'defaults' });
  }
  explainConfig(): Promise<{
    key: string;
    value: unknown;
    provenance: unknown[];
  }> {
    return Promise.resolve({ key: 'logging.level', value: 'info', provenance: [] });
  }
  onEvent(): void {
    // no-op
  }
  offEvent(): void {
    // no-op
  }
  onApprovalRequested(): void {
    // no-op
  }
  offApprovalRequested(): void {
    // no-op
  }
  onNotification(): void {
    // no-op
  }
  offNotification(): void {
    // no-op
  }
  request<R = unknown>(): Promise<R> {
    return Promise.resolve() as Promise<R>;
  }
  notify(): void {
    // no-op
  }
}

function makeContext(client: MockAirClient, json = false): CommandContext {
  return { client, json } as unknown as CommandContext;
}

function requireCommand(
  registry: CommandRegistry,
  name: string,
): { handler: (ctx: CommandContext, args: string[]) => Promise<{ kind: string; data: unknown }> } {
  const def = registry.get(name);
  if (!def) {
    throw new Error(`Command "${name}" not found`);
  }
  return { handler: def.handler };
}

// ============================================================================
// Tests
// ============================================================================

describe('CommandRegistry', () => {
  it('registers and lists built-in commands', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const names = registry.list().map((c) => c.name);
    expect(names).toContain('health');
    expect(names).toContain('session.create');
    expect(names).toContain('session.list');
    expect(names).toContain('run.start');
    expect(names).toContain('run.list');
    expect(names).toContain('run.get');
    expect(names).toContain('run.cancel');
    expect(names).toContain('run.pause');
    expect(names).toContain('run.resume');
    expect(names).toContain('run.replay');
    expect(names).toContain('approval.list');
    expect(names).toContain('approval.resolve');
    expect(names).toContain('logs.tail');
    expect(names).toContain('config.get');
    expect(names).toContain('config.explain');
    expect(names).toContain('chat');
    expect(names).toContain('doctor');
    expect(names).toContain('agents');
    expect(names).toContain('policy');
    expect(names).toContain('audit.verify');
  });

  it('resolves aliases to commands', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    expect(registry.get('ps')).toBeDefined();
    expect(registry.get('kill')).toBeDefined();
    expect(registry.get('pause')).toBeDefined();
    expect(registry.get('resume')).toBeDefined();
    expect(registry.get('logs')).toBeDefined();
  });
});

describe('health command', () => {
  it('returns daemon health', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const client = new MockAirClient();
    const { handler } = requireCommand(registry, 'health');
    const result = await handler(makeContext(client), []);
    expect(result.data).toEqual({
      protocolVersion: 1,
      status: 'healthy',
      uptimeMs: 0,
      activeRuns: 0,
      version: '0.0.0',
    });
  });
});

describe('session.create command', () => {
  it('creates a session with agentId', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const client = new MockAirClient();
    const { handler } = requireCommand(registry, 'session.create');
    const result = await handler(makeContext(client), ['agent-1']);
    expect(result.data).toEqual({ sessionId: 'sess-123' });
  });

  it('throws when agentId is missing', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const client = new MockAirClient();
    const { handler } = requireCommand(registry, 'session.create');
    await expect(handler(makeContext(client), [])).rejects.toThrow(AirError);
  });
});

describe('run.start command', () => {
  it('starts a run with sessionId, agentId, and goal', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const client = new MockAirClient();
    const { handler } = requireCommand(registry, 'run.start');
    const result = await handler(makeContext(client), ['sess-1', 'agent-1', 'Say hello']);
    expect(result.data).toEqual({ runId: 'run-123' });
  });

  it('throws when arguments are missing', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const client = new MockAirClient();
    const { handler } = requireCommand(registry, 'run.start');
    await expect(handler(makeContext(client), ['sess-1'])).rejects.toThrow(AirError);
  });
});

describe('run.cancel command', () => {
  it('cancels a run', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const client = new MockAirClient();
    const { handler } = requireCommand(registry, 'run.cancel');
    const result = await handler(makeContext(client), ['run-123']);
    expect(result.data).toEqual({ ok: true });
  });
});

describe('approval.resolve command', () => {
  it('resolves an approval with approve decision', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const client = new MockAirClient();
    const { handler } = requireCommand(registry, 'approval.resolve');
    const result = await handler(makeContext(client), ['ap-1', 'approve', 'looks good']);
    expect(result.data).toEqual({ ok: true });
  });

  it('rejects invalid decision', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const client = new MockAirClient();
    const { handler } = requireCommand(registry, 'approval.resolve');
    await expect(handler(makeContext(client), ['ap-1', 'maybe'])).rejects.toThrow(AirError);
  });
});

describe('chat command', () => {
  it('starts a chat run with a goal', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const client = new MockAirClient();
    const { handler } = requireCommand(registry, 'chat');
    const result = await handler(makeContext(client), ['Say hello world']);
    expect(result.data).toBeDefined();
    expect((result.data as { goal: string }).goal).toBe('Say hello world');
  });
});

describe('doctor command', () => {
  it('returns environment diagnostics', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const client = new MockAirClient();
    const { handler } = requireCommand(registry, 'doctor');
    const result = await handler(makeContext(client), []);
    expect(result.data).toBeDefined();
    expect((result.data as { daemon: unknown }).daemon).toBeDefined();
  });
});

describe('unknown command', () => {
  it('returns undefined from registry', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    expect(registry.get('nonexistent.command')).toBeUndefined();
  });
});
