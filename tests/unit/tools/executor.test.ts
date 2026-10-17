/**
 * Unit tests for ToolExecutor (Phase 4 - P4-T03).
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AirError } from '../../../src/errors/index.js';
import { type EventEnvelope, EventBus } from '../../../src/journal/index.js';
import { defineTool, toAnyTool, type ToolExecutionContext } from '../../../src/tools/contract.js';
import { ToolExecutor, type ToolPolicyHook, truncateOutput } from '../../../src/tools/executor.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { FakeClock, FakeIdGenerator } from '../../../src/util/index.js';

describe('truncateOutput utility', () => {
  it('truncates string exceeding maxBytes and appends marker', () => {
    const longString = 'A'.repeat(500);
    const result = truncateOutput(longString, 100);

    expect(result.truncated).toBe(true);
    expect(typeof result.output).toBe('string');
    const str = result.output as string;
    expect(str.endsWith('\n\n[TRUNCATED: maxOutputBytes exceeded]')).toBe(true);
    expect(Buffer.byteLength(str, 'utf8')).toBeLessThanOrEqual(100);
  });

  it('leaves string within limit unmodified', () => {
    const shortString = 'Short output';
    const result = truncateOutput(shortString, 100);

    expect(result.truncated).toBe(false);
    expect(result.output).toBe(shortString);
  });

  it('truncates Buffer exceeding maxBytes', () => {
    const buf = Buffer.alloc(200, 0x42);
    const result = truncateOutput(buf, 50);

    expect(result.truncated).toBe(true);
    expect((result.output as Buffer).byteLength).toBe(50);
  });

  it('truncates JSON object exceeding maxBytes', () => {
    const largeObj = { data: 'X'.repeat(500) };
    const result = truncateOutput(largeObj, 120);

    expect(result.truncated).toBe(true);
    expect(typeof result.output).toBe('string');
    expect((result.output as string).includes('[TRUNCATED: maxOutputBytes exceeded]')).toBe(true);
  });

  it('handles zero or negative maxBytes gracefully', () => {
    const res = truncateOutput('hello', 0);
    expect(res.truncated).toBe(false);
    expect(res.output).toBe('hello');
  });
});

describe('ToolExecutor (Lifecycle & Success)', () => {
  it('executes a tool successfully with input and output validation', async () => {
    const clock = new FakeClock();
    const idGenerator = new FakeIdGenerator();
    const registry = new ToolRegistry();

    const echoTool = defineTool({
      name: 'test.echo',
      description: 'Echoes message',
      risk: 'low',
      idempotent: true,
      inputSchema: z.object({ msg: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
      capabilities: (args) => [{ type: 'test', action: 'echo', resource: args.msg }],
      execute: async (args: { msg: string }, ctx: ToolExecutionContext) => {
        expect(ctx.callId).toBeDefined();
        expect(ctx.runId).toBe('run-000001');
        expect(ctx.clock).toBe(clock);
        await Promise.resolve();
        return { echoed: args.msg.toUpperCase() };
      },
    });

    registry.register(echoTool);
    const executor = new ToolExecutor({ registry, clock, idGenerator });

    const result = await executor.execute<{ echoed: string }>({
      toolName: 'test.echo',
      runId: 'run-000001',
      input: { msg: 'hello' },
    });

    expect(result.toolName).toBe('test.echo');
    expect(result.output).toEqual({ echoed: 'HELLO' });
    expect(result.truncated).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.capabilities).toEqual([{ type: 'test', action: 'echo', resource: 'hello' }]);
  });

  it('executes tool provided directly in request without registry', async () => {
    const clock = new FakeClock();
    const executor = new ToolExecutor({ clock });

    const tool = defineTool({
      name: 'direct.tool',
      description: 'Direct tool',
      risk: 'low',
      idempotent: true,
      inputSchema: z.object({ count: z.number() }),
      execute: async (args: { count: number }) => {
        await Promise.resolve();
        return args.count * 2;
      },
    });

    const result = await executor.execute({
      tool,
      runId: 'run-000001',
      input: { count: 21 },
    });

    expect(result.output).toBe(42);
  });

  it('preserves caller-specified callId and contextMeta', async () => {
    const executor = new ToolExecutor();
    const tool = defineTool({
      name: 'simple.tool',
      description: 'Simple tool',
      risk: 'low',
      idempotent: true,
      inputSchema: z.object({}),
      execute: async () => {
        await Promise.resolve();
        return 'done';
      },
    });

    const customCallId = '01JABCDEFGHJKMNPQRSTVWXYZ0';
    const result = await executor.execute({
      tool,
      callId: customCallId,
      runId: 'run-000001',
      input: {},
      contextMeta: { tag: 'meta-check' },
    });

    expect(result.callId).toBe(customCallId);
    expect(result.meta).toEqual({ tag: 'meta-check' });
  });
});

describe('ToolExecutor (Validation Errors)', () => {
  it('throws NOT_FOUND when toolName is not registered', async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor({ registry });

    await expect(
      executor.execute({ toolName: 'nonexistent', runId: 'run-000001', input: {} }),
    ).rejects.toThrowError(AirError);

    try {
      await executor.execute({ toolName: 'nonexistent', runId: 'run-000001', input: {} });
    } catch (err) {
      expect((err as AirError).code).toBe('NOT_FOUND');
    }
  });

  it('throws NOT_FOUND when resolving by toolName with no registry configured', async () => {
    const executor = new ToolExecutor();

    await expect(
      executor.execute({ toolName: 'fs.read', runId: 'run-000001', input: {} }),
    ).rejects.toThrowError(AirError);

    try {
      await executor.execute({ toolName: 'fs.read', runId: 'run-000001', input: {} });
    } catch (err) {
      expect((err as AirError).code).toBe('NOT_FOUND');
    }
  });

  it('throws INVALID_ARGUMENT when neither tool nor toolName is specified', async () => {
    const executor = new ToolExecutor();
    await expect(
      executor.execute({ runId: 'run-000001', input: {} }),
    ).rejects.toThrowError(AirError);
  });

  it('throws INVALID_ARGUMENT when input arguments violate inputSchema', async () => {
    const tool = defineTool({
      name: 'strict.input',
      description: 'Strict input tool',
      risk: 'low',
      idempotent: true,
      inputSchema: z.object({ path: z.string(), depth: z.number().int().positive() }),
      execute: async () => {
        await Promise.resolve();
      },
    });

    const executor = new ToolExecutor();

    await expect(
      executor.execute({ tool, runId: 'run-000001', input: { path: 123 } }),
    ).rejects.toThrowError(AirError);

    try {
      await executor.execute({ tool, runId: 'run-000001', input: { path: 123 } });
    } catch (err) {
      expect((err as AirError).code).toBe('INVALID_ARGUMENT');
    }
  });

  it('throws INTERNAL when tool output violates outputSchema', async () => {
    const tool = toAnyTool(
      defineTool({
        name: 'faulty.output',
        description: 'Tool that returns bad output',
        risk: 'low',
        idempotent: true,
        inputSchema: z.object({}),
        outputSchema: z.object({ expectedField: z.string() }),
        execute: async () => {
          await Promise.resolve();
          return { wrongField: 999 } as unknown as { expectedField: string };
        },
      }),
    );

    const executor = new ToolExecutor();

    await expect(
      executor.execute({ tool, runId: 'run-000001', input: {} }),
    ).rejects.toThrowError(AirError);

    try {
      await executor.execute({ tool, runId: 'run-000001', input: {} });
    } catch (err) {
      expect((err as AirError).code).toBe('INTERNAL');
    }
  });
});

describe('ToolExecutor (Policy Governance)', () => {
  it('allows execution when policy hook returns allowed: true', async () => {
    const tool = defineTool({
      name: 'policy.allowed',
      description: 'Tool allowed by policy',
      risk: 'low',
      idempotent: true,
      inputSchema: z.object({}),
      execute: async () => {
        await Promise.resolve();
        return 'allowed-result';
      },
    });

    const policyHook: ToolPolicyHook = {
      evaluate: async () => {
        await Promise.resolve();
        return { allowed: true, decisionId: 'dec-001' };
      },
    };

    const executor = new ToolExecutor({ policyHook });
    const result = await executor.execute({ tool, runId: 'run-000001', input: {} });

    expect(result.output).toBe('allowed-result');
  });

  it('throws PERMISSION_DENIED when policy hook returns allowed: false', async () => {
    const executed = false;
    const tool = defineTool({
      name: 'policy.denied',
      description: 'Tool denied by policy',
      risk: 'high',
      idempotent: false,
      inputSchema: z.object({ cmd: z.string() }),
      execute: async () => {
        await Promise.resolve();
        return 'should-not-run';
      },
    });

    const policyHook: ToolPolicyHook = {
      evaluate: async () => {
        await Promise.resolve();
        return { allowed: false, decisionId: 'dec-999', reason: 'High risk command blocked' };
      },
    };

    const executor = new ToolExecutor({ policyHook });

    await expect(
      executor.execute({ tool, runId: 'run-000001', input: { cmd: 'rm -rf /' } }),
    ).rejects.toThrowError(AirError);

    expect(executed).toBe(false);

    try {
      await executor.execute({ tool, runId: 'run-000001', input: { cmd: 'rm -rf /' } });
    } catch (err) {
      expect((err as AirError).code).toBe('PERMISSION_DENIED');
      expect((err as AirError).message).toContain('High risk command blocked');
    }
  });
});

describe('ToolExecutor (Timeouts & Cancellation)', () => {
  it('aborts tool execution when execution exceeds timeoutMs', async () => {
    const tool = defineTool({
      name: 'slow.tool',
      description: 'Slow hanging tool',
      risk: 'low',
      idempotent: true,
      inputSchema: z.object({}),
      execute: async (_args, ctx) => {
        return new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => resolve('completed'), 1000);
          ctx.signal?.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(new Error('Operation aborted'));
          });
        });
      },
    });

    const executor = new ToolExecutor();

    await expect(
      executor.execute({
        tool,
        runId: 'run-000001',
        input: {},
        timeoutMs: 30, // 30ms timeout
      }),
    ).rejects.toThrowError(AirError);

    try {
      await executor.execute({
        tool,
        runId: 'run-000001',
        input: {},
        timeoutMs: 30,
      });
    } catch (err) {
      expect((err as AirError).code).toBe('TOOL_TIMEOUT');
    }
  });

  it('rejects immediately with CANCELLED if caller signal is pre-aborted', async () => {
    const tool = defineTool({
      name: 'pre.cancelled',
      description: 'Cancelled tool',
      risk: 'low',
      idempotent: true,
      inputSchema: z.object({}),
      execute: async () => {
        await Promise.resolve();
        return 'never';
      },
    });

    const executor = new ToolExecutor();
    const abortCtrl = new AbortController();
    abortCtrl.abort();

    await expect(
      executor.execute({ tool, runId: 'run-000001', input: {}, signal: abortCtrl.signal }),
    ).rejects.toThrowError(AirError);

    try {
      await executor.execute({ tool, runId: 'run-000001', input: {}, signal: abortCtrl.signal });
    } catch (err) {
      expect((err as AirError).code).toBe('CANCELLED');
    }
  });

  it('cancels mid-execution when caller abort signal fires', async () => {
    const tool = defineTool({
      name: 'mid.cancelled',
      description: 'Mid execution cancel',
      risk: 'low',
      idempotent: true,
      inputSchema: z.object({}),
      execute: async (_args, ctx) => {
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => resolve('done'), 500);
          ctx.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Caller cancelled'));
          });
        });
      },
    });

    const executor = new ToolExecutor();
    const abortCtrl = new AbortController();

    const executionPromise = executor.execute({
      tool,
      runId: 'run-000001',
      input: {},
      signal: abortCtrl.signal,
    });

    setTimeout(() => abortCtrl.abort(), 20);

    await expect(executionPromise).rejects.toThrowError(AirError);
    try {
      await executionPromise;
    } catch (err) {
      expect((err as AirError).code).toBe('CANCELLED');
    }
  });
});

describe('ToolExecutor (Observability & Journal Events)', () => {
  it('emits lifecycle events on EventBus and notifies observer on success', async () => {
    const eventBus = new EventBus();
    const publishedEvents: EventEnvelope[] = [];
    eventBus.subscribe({ streamPrefix: 'run:' }, (evt) => {
      publishedEvents.push(evt);
    });

    let observerStarted = false;
    let observerSuccess = false;

    const executor = new ToolExecutor({
      eventBus,
      observer: {
        onToolStart: () => {
          observerStarted = true;
        },
        onToolSuccess: () => {
          observerSuccess = true;
        },
      },
    });

    const tool = defineTool({
      name: 'observed.tool',
      description: 'Observed tool',
      risk: 'medium',
      idempotent: false,
      inputSchema: z.object({ text: z.string() }),
      execute: async (args: { text: string }) => {
        await Promise.resolve();
        return `Hello ${args.text}`;
      },
    });

    const result = await executor.execute({
      tool,
      runId: 'run-000001',
      input: { text: 'World' },
    });

    expect(result.output).toBe('Hello World');
    expect(observerStarted).toBe(true);
    expect(observerSuccess).toBe(true);

    await eventBus.drain();
    expect(publishedEvents.length).toBe(2);
    expect(publishedEvents[0]?.type).toBe('tool.started');
    expect(publishedEvents[1]?.type).toBe('tool.completed');
  });

  it('emits tool.failed event and notifies observer on failure', async () => {
    const eventBus = new EventBus();
    const publishedEvents: EventEnvelope[] = [];
    eventBus.subscribe({ streamPrefix: 'run:' }, (evt) => {
      publishedEvents.push(evt);
    });

    let observerError = false;

    const executor = new ToolExecutor({
      eventBus,
      observer: {
        onToolError: () => {
          observerError = true;
        },
      },
    });

    const failingTool = defineTool({
      name: 'fail.tool',
      description: 'Failing tool',
      risk: 'low',
      idempotent: true,
      inputSchema: z.object({}),
      execute: async () => {
        await Promise.resolve();
        throw new Error('Database connection broke');
      },
    });

    await expect(
      executor.execute({ tool: failingTool, runId: 'run-000001', input: {} }),
    ).rejects.toThrowError(AirError);

    expect(observerError).toBe(true);

    await eventBus.drain();
    expect(publishedEvents.length).toBe(2);
    expect(publishedEvents[0]?.type).toBe('tool.started');
    expect(publishedEvents[1]?.type).toBe('tool.failed');
  });

  it('emits tool.timed_out event on eventBus when tool times out', async () => {
    const eventBus = new EventBus();
    const publishedEvents: EventEnvelope[] = [];
    eventBus.subscribe({ streamPrefix: 'run:' }, (evt) => {
      publishedEvents.push(evt);
    });

    const tool = defineTool({
      name: 'timeout.event.tool',
      description: 'Hanging tool',
      risk: 'low',
      idempotent: true,
      inputSchema: z.object({}),
      execute: async (_args, ctx) => {
        return new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => resolve('done'), 1000);
          ctx.signal?.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(new Error('Operation aborted'));
          });
        });
      },
    });

    const executor = new ToolExecutor({ eventBus });

    await expect(
      executor.execute({
        tool,
        runId: 'run-000001',
        sessionId: 'sess-000001',
        agentId: 'agent-000001',
        input: {},
        timeoutMs: 25,
      }),
    ).rejects.toThrowError(AirError);

    await eventBus.drain();
    expect(publishedEvents.length).toBe(2);
    expect(publishedEvents[0]?.type).toBe('tool.started');
    expect(publishedEvents[1]?.type).toBe('tool.timed_out');
  });

  it('emits tool.cancelled event on eventBus when execution is cancelled', async () => {
    const eventBus = new EventBus();
    const publishedEvents: EventEnvelope[] = [];
    eventBus.subscribe({ streamPrefix: 'run:' }, (evt) => {
      publishedEvents.push(evt);
    });

    const tool = defineTool({
      name: 'cancel.event.tool',
      description: 'Cancellable tool',
      risk: 'low',
      idempotent: true,
      inputSchema: z.object({}),
      execute: async (_args, ctx) => {
        return new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => resolve('done'), 1000);
          ctx.signal?.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(new Error('Caller cancelled'));
          });
        });
      },
    });

    const executor = new ToolExecutor({ eventBus });
    const abortCtrl = new AbortController();

    const promise = executor.execute({
      tool,
      runId: 'run-000001',
      sessionId: 'sess-000001',
      agentId: 'agent-000001',
      input: {},
      signal: abortCtrl.signal,
    });

    setTimeout(() => abortCtrl.abort(), 20);

    await expect(promise).rejects.toThrowError(AirError);

    await eventBus.drain();
    expect(publishedEvents.length).toBe(2);
    expect(publishedEvents[0]?.type).toBe('tool.started');
    expect(publishedEvents[1]?.type).toBe('tool.cancelled');
  });

  it('wraps capabilities derivation errors in AirError INTERNAL', async () => {
    const tool = defineTool({
      name: 'broken.caps',
      description: 'Tool with throwing capabilities',
      risk: 'low',
      idempotent: true,
      inputSchema: z.object({}),
      capabilities: () => {
        throw new Error('Capabilities failed');
      },
      execute: async () => {
        await Promise.resolve();
        return 'done';
      },
    });

    const executor = new ToolExecutor();

    await expect(
      executor.execute({ tool, runId: 'run-000001', input: {} }),
    ).rejects.toThrowError(AirError);

    try {
      await executor.execute({ tool, runId: 'run-000001', input: {} });
    } catch (err) {
      expect((err as AirError).code).toBe('INTERNAL');
      expect((err as AirError).message).toContain('Failed to derive capabilities');
    }
  });

  it('tolerates observer errors without interrupting execution', async () => {
    const executor = new ToolExecutor({
      observer: {
        onToolStart: () => {
          throw new Error('Observer start broke');
        },
        onToolSuccess: () => {
          throw new Error('Observer success broke');
        },
      },
    });

    const tool = defineTool({
      name: 'resilient.observer.tool',
      description: 'Runs despite observer errors',
      risk: 'low',
      idempotent: true,
      inputSchema: z.object({}),
      execute: async () => {
        await Promise.resolve();
        return 'success';
      },
    });

    const result = await executor.execute({ tool, runId: 'run-000001', input: {} });
    expect(result.output).toBe('success');
  });
});

describe('ToolExecutor Policy Choke Point Assertions (P5-T08 / Rule R3 / Threat T6)', () => {
  const dummyTool = defineTool({
    name: 'security.check.tool',
    description: 'Security testing tool',
    risk: 'high',
    idempotent: false,
    inputSchema: z.object({ value: z.string() }),
    execute: async (args) => {
      await Promise.resolve();
      return `executed: ${args.value}`;
    },
  });

  it('throws SECURITY_VIOLATION if requirePolicyDecision is true and no policyHook is configured', async () => {
    const executor = new ToolExecutor({
      requirePolicyDecision: true,
    });

    await expect(
      executor.execute({
        tool: dummyTool,
        runId: 'run-001',
        input: { value: 'test' },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AirError);
      const airErr = err as AirError;
      expect(airErr.code).toBe('SECURITY_VIOLATION');
      expect(airErr.message).toContain('without a policy engine');
      return true;
    });
  });

  it('throws SECURITY_VIOLATION if policyHook returns decision without a valid decisionId', async () => {
    const malformedPolicyHook: ToolPolicyHook = {
      evaluate: () =>
        Promise.resolve({
          allowed: true,
          // Missing decisionId
        }),
    };

    const executor = new ToolExecutor({
      policyHook: malformedPolicyHook,
    });

    await expect(
      executor.execute({
        tool: dummyTool,
        runId: 'run-001',
        input: { value: 'test' },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AirError);
      const airErr = err as AirError;
      expect(airErr.code).toBe('SECURITY_VIOLATION');
      expect(airErr.message).toContain('valid policy decision ID');
      return true;
    });
  });

  it('throws SECURITY_VIOLATION if policyHook returns an empty string decisionId', async () => {
    const emptyIdPolicyHook: ToolPolicyHook = {
      evaluate: () =>
        Promise.resolve({
          allowed: true,
          decisionId: '   ',
        }),
    };

    const executor = new ToolExecutor({
      policyHook: emptyIdPolicyHook,
    });

    await expect(
      executor.execute({
        tool: dummyTool,
        runId: 'run-001',
        input: { value: 'test' },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AirError);
      const airErr = err as AirError;
      expect(airErr.code).toBe('SECURITY_VIOLATION');
      return true;
    });
  });

  it('records decisionId in result and passes valid execution through', async () => {
    const validPolicyHook: ToolPolicyHook = {
      evaluate: () =>
        Promise.resolve({
          allowed: true,
          decisionId: 'dec-valid-12345',
        }),
    };

    const executor = new ToolExecutor({
      policyHook: validPolicyHook,
    });

    const result = await executor.execute({
      tool: dummyTool,
      runId: 'run-001',
      input: { value: 'allowed-call' },
    });

    expect(result.output).toBe('executed: allowed-call');
    expect(result.decisionId).toBe('dec-valid-12345');
  });
});

