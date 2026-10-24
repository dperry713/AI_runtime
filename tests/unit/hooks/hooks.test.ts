/**
 * Unit tests for Hooks System (Phase 10 - P10-T03).
 */

import { describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  HookRegistry,
  HookRunner,
  createHookRunner,
  type HookDefinition,
  type PreToolHookContext,
  type PostToolHookContext,
  type OnEventHookContext,
  type PreModelHookContext,
  type PostModelHookContext,
  type SessionHookContext,
  type RunHookContext,
} from '../../../src/hooks/index.js';
import { createEnvelope } from '../../../src/journal/index.js';
import { createRunId, createToolCallId } from '../../../src/types/index.js';
import { FakeClock, UlidIdGenerator } from '../../../src/util/index.js';

describe('HookRegistry', () => {
  it('registers and retrieves hooks', () => {
    const registry = new HookRegistry();
    const hook: HookDefinition = {
      id: 'h1',
      name: 'Hook 1',
      kind: 'pre-tool',
      handler: () => {},
    };
    registry.register(hook);
    expect(registry.get('h1')).toBe(hook);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list('pre-tool')).toHaveLength(1);
    expect(registry.list('post-tool')).toHaveLength(0);
  });

  it('rejects invalid hook registration', () => {
    const registry = new HookRegistry();
    expect(() =>
      registry.register({ id: '', name: 'Test', kind: 'pre-tool', handler: () => {} }),
    ).toThrow(AirError);
    expect(() =>
      registry.register({ id: 'h1', name: '', kind: 'pre-tool', handler: () => {} }),
    ).toThrow(AirError);
    expect(() =>
      // @ts-expect-error Testing invalid handler
      registry.register({ id: 'h1', name: 'Test', kind: 'pre-tool', handler: null }),
    ).toThrow(AirError);
  });

  it('rejects duplicate hook id', () => {
    const registry = new HookRegistry();
    registry.register({ id: 'dup', name: 'Dup', kind: 'pre-tool', handler: () => {} });
    expect(() =>
      registry.register({ id: 'dup', name: 'Dup 2', kind: 'pre-tool', handler: () => {} }),
    ).toThrow(AirError);
  });

  it('unregisters and clears hooks', () => {
    const registry = new HookRegistry();
    registry.register({ id: 'h1', name: 'H1', kind: 'pre-tool', handler: () => {} });
    expect(registry.unregister('h1')).toBe(true);
    expect(registry.unregister('h1')).toBe(false);
    expect(registry.get('h1')).toBeUndefined();

    registry.register({ id: 'h2', name: 'H2', kind: 'pre-tool', handler: () => {} });
    registry.clear();
    expect(registry.list()).toHaveLength(0);
  });

  it('sorts matching hooks by priority (descending)', () => {
    const registry = new HookRegistry();
    registry.register({ id: 'low', name: 'Low', kind: 'pre-tool', priority: 10, handler: () => {} });
    registry.register({ id: 'high', name: 'High', kind: 'pre-tool', priority: 200, handler: () => {} });
    registry.register({ id: 'default', name: 'Default', kind: 'pre-tool', handler: () => {} }); // priority 100

    const matching = registry.getMatchingHooks('pre-tool');
    expect(matching.map((h) => h.id)).toEqual(['high', 'default', 'low']);
  });

  it('filters by tool name exact, wildcard, and prefix', () => {
    const registry = new HookRegistry();
    registry.register({
      id: 'exact-fs',
      name: 'Exact',
      kind: 'pre-tool',
      filter: { tools: ['fs.read'] },
      handler: () => {},
    });
    registry.register({
      id: 'prefix-fs',
      name: 'Prefix',
      kind: 'pre-tool',
      filter: { tools: ['fs.*'] },
      handler: () => {},
    });
    registry.register({
      id: 'wildcard-all',
      name: 'All',
      kind: 'pre-tool',
      filter: { tools: ['*'] },
      handler: () => {},
    });
    registry.register({
      id: 'other',
      name: 'Other',
      kind: 'pre-tool',
      filter: { tools: ['net.http'] },
      handler: () => {},
    });

    const forFsRead = registry.getMatchingHooks('pre-tool', { toolName: 'fs.read' });
    expect(forFsRead.map((h) => h.id)).toContain('exact-fs');
    expect(forFsRead.map((h) => h.id)).toContain('prefix-fs');
    expect(forFsRead.map((h) => h.id)).toContain('wildcard-all');
    expect(forFsRead.map((h) => h.id)).not.toContain('other');

    const forFsWrite = registry.getMatchingHooks('pre-tool', { toolName: 'fs.write' });
    expect(forFsWrite.map((h) => h.id)).not.toContain('exact-fs');
    expect(forFsWrite.map((h) => h.id)).toContain('prefix-fs');
  });

  it('filters by event type and agent id', () => {
    const registry = new HookRegistry();
    registry.register({
      id: 'event-tool',
      name: 'Event',
      kind: 'on-event',
      filter: { eventTypes: ['tool.*'], agents: ['special-agent'] },
      handler: () => {},
    });

    expect(
      registry.getMatchingHooks('on-event', { eventType: 'tool.completed', agentId: 'special-agent' }),
    ).toHaveLength(1);
    expect(
      registry.getMatchingHooks('on-event', { eventType: 'tool.completed', agentId: 'other-agent' }),
    ).toHaveLength(0);
    expect(
      registry.getMatchingHooks('on-event', { eventType: 'run.started', agentId: 'special-agent' }),
    ).toHaveLength(0);
  });
});

describe('HookRunner', () => {
  const clock = new FakeClock();

  describe('Policy Invariant: Cannot Weaken Policy', () => {
    it('throws SECURITY_VIOLATION if hook attempts to allow a policy denial', () => {
      const registry = new HookRegistry();
      const runner = new HookRunner(registry, { clock });

      expect(() => {
        runner.assertCannotWeakenPolicy(false, { allowed: true });
      }).toThrow(AirError);
      expect(() => {
        runner.assertCannotWeakenPolicy(true, { allowed: true });
      }).not.toThrow();
      expect(() => {
        runner.assertCannotWeakenPolicy(false, { allowed: false });
      }).not.toThrow();
    });
  });

  describe('pre-tool hooks', () => {
    const baseContext: PreToolHookContext = {
      callId: createToolCallId(),
      runId: 'run-1',
      toolName: 'fs.read',
      input: { path: 'foo.txt' },
      capabilities: [],
      timestamp: '2026-10-24T00:00:00Z',
    };

    it('executes pre-tool hooks and modifies input sequentially', async () => {
      const registry = new HookRegistry();
      registry.register({
        id: 'h1',
        name: 'H1',
        kind: 'pre-tool',
        priority: 200,
        handler: (ctx: PreToolHookContext) => {
          const input = ctx.input as { path: string };
          return { modifiedInput: { path: input.path.toUpperCase() } };
        },
      });
      registry.register({
        id: 'h2',
        name: 'H2',
        kind: 'pre-tool',
        priority: 100,
        handler: (ctx: PreToolHookContext) => {
          const input = ctx.input as { path: string };
          return { modifiedInput: { path: `${input.path}.bak` } };
        },
      });

      const runner = new HookRunner(registry, { clock });
      const result = await runner.executePreTool(baseContext);

      expect(result.input).toEqual({ path: 'FOO.TXT.bak' });
      expect(result.records).toHaveLength(2);
      expect(result.records[0]?.status).toBe('success');
    });

    it('throws HOOK_DENIED when pre-tool hook vetos', async () => {
      const registry = new HookRegistry();
      registry.register({
        id: 'veto-hook',
        name: 'Veto',
        kind: 'pre-tool',
        handler: () => ({ allowed: false, reason: 'Read of foo.txt is forbidden' }),
      });

      const runner = new HookRunner(registry, { clock });
      await expect(runner.executePreTool(baseContext)).rejects.toThrow(AirError);
      await expect(runner.executePreTool(baseContext)).rejects.toThrow(/Read of foo\.txt is forbidden/);
    });
  });

  describe('post-tool hooks', () => {
    it('executes post-tool hooks for both success and error outputs', async () => {
      const registry = new HookRegistry();
      let loggedSuccess: unknown = null;
      let loggedError: unknown = null;

      registry.register({
        id: 'post-success',
        name: 'Post Success',
        kind: 'post-tool',
        handler: (ctx) => {
          loggedSuccess = (ctx as PostToolHookContext).output;
        },
      });

      registry.register({
        id: 'post-error',
        name: 'Post Error',
        kind: 'post-tool',
        handler: (ctx) => {
          loggedError = (ctx as PostToolHookContext).error;
        },
      });

      const runner = new HookRunner(registry, { clock });
      const successCtx: PostToolHookContext = {
        callId: createToolCallId(),
        runId: 'run-1',
        toolName: 'fs.read',
        input: {},
        output: 'file contents',
        durationMs: 10,
        truncated: false,
        timestamp: '2026-10-24T00:00:00Z',
      };
      await runner.executePostTool(successCtx);
      expect(loggedSuccess).toBe('file contents');

      const errorCtx: PostToolHookContext = {
        callId: createToolCallId(),
        runId: 'run-1',
        toolName: 'fs.read',
        input: {},
        error: new AirError('INTERNAL', 'disk failed'),
        durationMs: 12,
        truncated: false,
        timestamp: '2026-10-24T00:00:00Z',
      };
      await runner.executePostTool(errorCtx);
      expect(loggedError).toBeInstanceOf(AirError);
    });
  });

  describe('model hooks (pre-model and post-model)', () => {
    it('executes pre-model hooks with message modification', async () => {
      const registry = new HookRegistry();
      registry.register({
        id: 'prompt-injection-guard',
        name: 'Prompt Guard',
        kind: 'pre-model',
        handler: (ctx) => {
          const preCtx = ctx as PreModelHookContext;
          return { modifiedInput: [...preCtx.messages, { role: 'system', content: 'Injected' }] };
        },
      });

      const runner = new HookRunner(registry, { clock });
      const result = await runner.executePreModel({
        runId: 'r1',
        turnId: 't1',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        timestamp: '2026-10-24T00:00:00Z',
      });

      expect(result.messages).toHaveLength(2);
    });

    it('vetos pre-model hook', async () => {
      const registry = new HookRegistry();
      registry.register({
        id: 'model-veto',
        name: 'Model Veto',
        kind: 'pre-model',
        handler: () => ({ allowed: false, reason: 'Budget exhausted' }),
      });

      const runner = new HookRunner(registry, { clock });
      await expect(
        runner.executePreModel({
          runId: 'r1',
          turnId: 't1',
          model: 'gpt-4o',
          messages: [],
          timestamp: '2026-10-24T00:00:00Z',
        }),
      ).rejects.toThrow(/Budget exhausted/);
    });

    it('executes post-model hooks', async () => {
      const registry = new HookRegistry();
      let capturedResponse: unknown = null;
      registry.register({
        id: 'post-model-hook',
        name: 'Post Model',
        kind: 'post-model',
        handler: (ctx) => {
          capturedResponse = (ctx as PostModelHookContext).response;
        },
      });

      const runner = new HookRunner(registry, { clock });
      await runner.executePostModel({
        runId: 'r1',
        turnId: 't1',
        model: 'claude-3-5',
        response: { text: 'hello' },
        durationMs: 400,
        timestamp: '2026-10-24T00:00:00Z',
      });

      expect(capturedResponse).toEqual({ text: 'hello' });
    });
  });

  describe('on-event, session, and run hooks', () => {
    it('executes on-event hooks matching event criteria', async () => {
      const registry = new HookRegistry();
      let eventCount = 0;
      registry.register({
        id: 'event-counter',
        name: 'Counter',
        kind: 'on-event',
        handler: () => {
          eventCount++;
        },
      });

      const runner = new HookRunner(registry, { clock });
      const idGen = new UlidIdGenerator(clock);
      const envelope = createEnvelope({
        type: 'run.started',
        payload: { runId: createRunId() },
        stream: 'run-1',
        seq: 1,
        clock,
        idGenerator: idGen,
      });
      const ctx: OnEventHookContext = {
        event: envelope,
        timestamp: '2026-10-24T00:00:00Z',
      };
      await runner.executeOnEvent(ctx);
      expect(eventCount).toBe(1);
    });

    it('executes session-start and session-end hooks', async () => {
      const registry = new HookRegistry();
      const events: string[] = [];
      registry.register({
        id: 'sess-start',
        name: 'Start',
        kind: 'session-start',
        handler: (ctx) => {
          events.push(`start:${(ctx as SessionHookContext).sessionId}`);
        },
      });
      registry.register({
        id: 'sess-end',
        name: 'End',
        kind: 'session-end',
        handler: (ctx) => {
          events.push(`end:${(ctx as SessionHookContext).sessionId}`);
        },
      });

      const runner = new HookRunner(registry, { clock });
      await runner.executeSession({ sessionId: 's1', agentId: 'a1', timestamp: '2026-10-24T00:00:00Z' }, 'session-start');
      await runner.executeSession({ sessionId: 's1', agentId: 'a1', timestamp: '2026-10-24T00:00:00Z' }, 'session-end');

      expect(events).toEqual(['start:s1', 'end:s1']);
    });

    it('executes run-start and run-end hooks', async () => {
      const registry = new HookRegistry();
      const events: string[] = [];
      registry.register({
        id: 'run-start-hook',
        name: 'Start',
        kind: 'run-start',
        handler: (ctx) => {
          events.push(`run-start:${(ctx as RunHookContext).runId}`);
        },
      });
      registry.register({
        id: 'run-end-hook',
        name: 'End',
        kind: 'run-end',
        handler: (ctx) => {
          events.push(`run-end:${(ctx as RunHookContext).runId}`);
        },
      });

      const runner = new HookRunner(registry, { clock });
      await runner.executeRun({ runId: 'r1', timestamp: '2026-10-24T00:00:00Z' }, 'run-start');
      await runner.executeRun({ runId: 'r1', timestamp: '2026-10-24T00:00:00Z' }, 'run-end');

      expect(events).toEqual(['run-start:r1', 'run-end:r1']);
    });
  });

  describe('sandboxing, timeouts & failure modes', () => {
    it('times out in fail-closed mode and throws HOOK_TIMED_OUT', async () => {
      const registry = new HookRegistry();
      registry.register({
        id: 'slow-hook',
        name: 'Slow',
        kind: 'pre-tool',
        timeoutMs: 50,
        failureMode: 'fail-closed',
        handler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
        },
      });

      const runner = new HookRunner(registry, { clock });
      await expect(
        runner.executePreTool({
          callId: createToolCallId(),
          runId: 'r1',
          toolName: 'fs.read',
          input: {},
          capabilities: [],
          timestamp: '2026-10-24T00:00:00Z',
        }),
      ).rejects.toThrow(AirError);
    });

    it('times out in fail-open mode and proceeds with warning record', async () => {
      const registry = new HookRegistry();
      registry.register({
        id: 'slow-fail-open',
        name: 'Slow Fail Open',
        kind: 'pre-tool',
        timeoutMs: 50,
        failureMode: 'fail-open',
        handler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
        },
      });

      const runner = new HookRunner(registry, { clock });
      const result = await runner.executePreTool({
        callId: createToolCallId(),
        runId: 'r1',
        toolName: 'fs.read',
        input: { a: 1 },
        capabilities: [],
        timestamp: '2026-10-24T00:00:00Z',
      });

      expect(result.input).toEqual({ a: 1 });
      expect(result.records).toHaveLength(1);
      expect(result.records[0]?.status).toBe('timed_out');
    });

    it('handles throwing hook in fail-closed mode', async () => {
      const registry = new HookRegistry();
      registry.register({
        id: 'throwing-hook',
        name: 'Throwing',
        kind: 'pre-tool',
        failureMode: 'fail-closed',
        handler: () => {
          throw new Error('boom');
        },
      });

      const runner = new HookRunner(registry, { clock });
      await expect(
        runner.executePreTool({
          callId: createToolCallId(),
          runId: 'r1',
          toolName: 'fs.read',
          input: {},
          capabilities: [],
          timestamp: '2026-10-24T00:00:00Z',
        }),
      ).rejects.toThrow(/Hook "throwing-hook" failed: boom/);
    });

    it('handles throwing hook in fail-open mode', async () => {
      const registry = new HookRegistry();
      registry.register({
        id: 'throwing-fail-open',
        name: 'Throwing Fail Open',
        kind: 'pre-tool',
        failureMode: 'fail-open',
        handler: () => {
          throw new Error('silent boom');
        },
      });

      const runner = new HookRunner(registry, { clock });
      const result = await runner.executePreTool({
        callId: createToolCallId(),
        runId: 'r1',
        toolName: 'fs.read',
        input: { ok: true },
        capabilities: [],
        timestamp: '2026-10-24T00:00:00Z',
      });

      expect(result.input).toEqual({ ok: true });
      expect(result.records[0]?.status).toBe('failed');
    });
  });

  describe('observer adapter and factory helper', () => {
    it('creates ToolExecutionObserver adapter', async () => {
      const { runner } = createHookRunner();
      const observer = runner.toToolExecutionObserver();
      expect(typeof observer.onToolStart).toBe('function');
      expect(typeof observer.onToolSuccess).toBe('function');
      expect(typeof observer.onToolError).toBe('function');

      // Call methods to verify non-throwing dispatch
      await observer.onToolStart?.({
        callId: createToolCallId(),
        runId: 'r1',
        toolName: 'test',
        input: {},
        capabilities: [],
        timestamp: '2026-10-24T00:00:00Z',
      });
      await observer.onToolSuccess?.({
        callId: createToolCallId(),
        runId: 'r1',
        toolName: 'test',
        output: {},
        truncated: false,
        durationMs: 5,
        timestamp: '2026-10-24T00:00:00Z',
      });
      await observer.onToolError?.({
        callId: createToolCallId(),
        runId: 'r1',
        toolName: 'test',
        error: new AirError('INTERNAL', 'err'),
        durationMs: 5,
        timestamp: '2026-10-24T00:00:00Z',
      });
    });
  });
});
