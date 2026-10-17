import { describe, expect, it } from 'vitest';
import { TurnEngine } from '../../../src/agent/turn-engine.js';
import {
  getPolicyProfile,
  PolicyEngine,
  type PolicyDocument,
} from '../../../src/policy/index.js';
import {
  isToolResultPart,
  MockProvider,
  type MessagePart,
} from '../../../src/providers/index.js';
import {
  defineTool,
  ToolRegistry,
} from '../../../src/tools/index.js';
import { EventBus } from '../../../src/journal/index.js';
import { FakeClock } from '../../../src/util/index.js';
import type { AgentManifest } from '../../../src/agent/manifest.js';
import { z } from 'zod';

describe('TurnEngine (P6-T03)', () => {
  const clock = new FakeClock('2026-10-17T12:00:00.000Z');

  const baseManifest: AgentManifest = {
    schemaVersion: 1,
    id: 'developer',
    name: 'Developer Agent',
    description: 'Dev agent',
    version: '1.0.0',
    model: {
      model: 'mock-model',
      temperature: 0.0,
      maxTokens: 1024,
    },
    systemPrompt: 'You are an engineer.',
    tools: ['*'],
    policyProfile: 'project-write',
    maxContextTokens: 100_000,
    maxParallelTools: 4,
  };

  function setupEngine(options?: {
    scriptSteps?: Parameters<MockProvider['enqueue']>[0][];
    policyDoc?: PolicyDocument;
    budgets?: AgentManifest['budgets'];
  }) {
    const eventBus = new EventBus();
    const provider = new MockProvider({ clock });

    if (options?.scriptSteps) {
      for (const step of options.scriptSteps) {
        provider.enqueue(step);
      }
    }

    const toolRegistry = new ToolRegistry();
    // Register test tool: test.echo
    toolRegistry.register(
      defineTool({
        name: 'test.echo',
        description: 'Echo message',
        inputSchema: z.object({ msg: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
        risk: 'low',
        idempotent: true,
        execute: (args) => Promise.resolve({ echoed: args.msg }),
      }),
    );

    // Register high risk tool: test.deploy
    toolRegistry.register(
      defineTool({
        name: 'test.deploy',
        description: 'Deploy code',
        inputSchema: z.object({ env: z.string() }),
        outputSchema: z.object({ deployed: z.boolean() }),
        risk: 'high',
        idempotent: false,
        execute: () => Promise.resolve({ deployed: true }),
      }),
    );

    const defaultTestPolicy: PolicyDocument = {
      version: 1,
      name: 'test-policy',
      defaultEffect: 'deny',
      rules: [
        {
          id: 'allow-test-echo',
          effect: 'allow',
          match: {
            tools: ['test.echo'],
          },
          reason: 'Allow test.echo for unit tests',
        },
      ],
    };

    const policyDoc = options?.policyDoc ?? defaultTestPolicy;
    const policyEngine = new PolicyEngine(policyDoc);

    const manifest: AgentManifest = {
      ...baseManifest,
      budgets: options?.budgets,
    };

    const engine = new TurnEngine({
      manifest,
      runId: 'run-turn-001',
      provider,
      toolRegistry,
      policyEngine,
      eventBus,
      clock,
    });

    return { engine, provider, eventBus, toolRegistry };
  }

  it('executes simple answer turn with no tool calls', async () => {
    const { engine, eventBus } = setupEngine({
      scriptSteps: [
        {
          response: 'Hello! I am ready to write code.',
          stopReason: 'stop',
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
        },
      ],
    });

    const events: string[] = [];
    const sub = eventBus.subscribe({}, (ev) => {
      events.push(ev.type);
    });

    engine.getContextManager().addMessage({ role: 'user', content: 'What is your status?' });

    const result = await engine.executeTurn(0);
    await sub.drain();

    expect(result.status).toBe('complete');
    expect(result.text).toBe('Hello! I am ready to write code.');
    expect(result.toolCallsExecuted).toBe(0);

    expect(events).toContain('turn.started');
    expect(events).toContain('model.requested');
    expect(events).toContain('model.responded');
    expect(events).toContain('turn.completed');
  });

  it('executes tool call, fences output, and appends to context', async () => {
    const { engine, eventBus } = setupEngine({
      scriptSteps: [
        {
          response: [
            { type: 'text', text: 'Calling echo tool' },
            {
              type: 'tool_call',
              id: 'call-echo-1',
              name: 'test.echo',
              arguments: { msg: 'AIR runtime active' },
            },
          ],
          stopReason: 'tool_calls',
        },
      ],
    });

    const events: string[] = [];
    const sub = eventBus.subscribe({}, (ev) => {
      events.push(ev.type);
    });

    engine.getContextManager().addMessage({ role: 'user', content: 'Echo runtime' });

    const result = await engine.executeTurn(0);
    await sub.drain();

    expect(result.status).toBe('continue');
    expect(result.toolCallsExecuted).toBe(1);
    expect(result.toolResults?.[0]?.success).toBe(true);

    expect(events).toContain('tool.requested');
    expect(events).toContain('tool.policy_decided');
    expect(events).toContain('tool.started');
    expect(events).toContain('tool.completed');

    // Verify tool result was added to context and fenced with untrusted_content
    const messages = engine.getContextManager().getMessages();
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg?.role).toBe('tool');
    expect(Array.isArray(lastMsg?.content)).toBe(true);

    const parts = (lastMsg?.content ?? []) as readonly MessagePart[];
    const firstPart = parts[0];
    expect(firstPart && isToolResultPart(firstPart)).toBe(true);
    if (firstPart && isToolResultPart(firstPart)) {
      expect(firstPart.content).toContain('<untrusted_content');
      expect(firstPart.content).toContain('AIR runtime active');
      expect(firstPart.content).toContain('</untrusted_content>');
    }
  });

  it('handles policy denial and returns error tool result without executing tool', async () => {
    const lockedPolicy = getPolicyProfile('locked-down'); // denies test.echo
    const { engine } = setupEngine({
      policyDoc: lockedPolicy,
      scriptSteps: [
        {
          response: [
            {
              type: 'tool_call',
              id: 'call-denied-1',
              name: 'test.echo',
              arguments: { msg: 'forbidden' },
            },
          ],
          stopReason: 'tool_calls',
        },
      ],
    });

    engine.getContextManager().addMessage({ role: 'user', content: 'Echo' });

    const result = await engine.executeTurn(0);
    expect(result.status).toBe('continue');
    expect(result.toolCallsExecuted).toBe(1);

    const toolRes = result.toolResults?.[0];
    expect(toolRes?.success).toBe(false);
    expect(toolRes?.error?.code).toBe('POLICY_DENIED');
  });

  it('enforces step budget pre-check', async () => {
    const { engine } = setupEngine({
      budgets: {
        maxSteps: 1, // Only turn 0 permitted
      },
      scriptSteps: [{ response: 'Turn 0' }, { response: 'Turn 1' }],
    });

    engine.getContextManager().addMessage({ role: 'user', content: 'Hi' });

    const turn0 = await engine.executeTurn(0);
    expect(turn0.status).toBe('complete');

    // Turn 1 should be rejected because maxSteps is 1
    const turn1 = await engine.executeTurn(1);
    expect(turn1.status).toBe('budget_exceeded');
    expect(turn1.reason).toContain('Step count limit');
  });

  it('detects stalls when provider repeats identical tool calls', async () => {
    const { engine } = setupEngine({
      scriptSteps: [
        {
          response: [
            { type: 'tool_call', id: 'c1', name: 'test.echo', arguments: { msg: 'loop' } },
          ],
        },
        {
          response: [
            { type: 'tool_call', id: 'c2', name: 'test.echo', arguments: { msg: 'loop' } },
          ],
        },
        {
          response: [
            { type: 'tool_call', id: 'c3', name: 'test.echo', arguments: { msg: 'loop' } },
          ],
        },
      ],
    });

    engine.getContextManager().addMessage({ role: 'user', content: 'Start' });

    await engine.executeTurn(0);
    await engine.executeTurn(1);
    const turn2 = await engine.executeTurn(2);

    expect(turn2.status).toBe('stalled');
    expect(turn2.reason).toContain('identical tool call');
  });

  it('handles unregistered tools gracefully with error tool result', async () => {
    const { engine } = setupEngine({
      scriptSteps: [
        {
          response: [
            { type: 'tool_call', id: 'c_unknown', name: 'nonexistent.tool', arguments: {} },
          ],
        },
      ],
    });

    engine.getContextManager().addMessage({ role: 'user', content: 'Call mystery tool' });
    const turn = await engine.executeTurn(0);
    expect(turn.status).toBe('continue');
    expect(turn.toolCallsExecuted).toBe(1);
    expect(turn.toolResults?.[0]?.success).toBe(false);
    expect(turn.toolResults?.[0]?.error?.code).toBe('TOOL_NOT_FOUND');
  });

  it('parses JSON string arguments in tool calls and handles invalid JSON', async () => {
    const { engine } = setupEngine({
      scriptSteps: [
        {
          response: [
            {
              type: 'tool_call',
              id: 'c_json_valid',
              name: 'test.echo',
              arguments: JSON.stringify({ msg: 'from json string' }),
            },
          ],
        },
      ],
    });

    engine.getContextManager().addMessage({ role: 'user', content: 'Test json string args' });
    const turn = await engine.executeTurn(0);
    expect(turn.status).toBe('continue');
    expect(turn.toolCallsExecuted).toBe(1);
    expect(turn.toolResults?.[0]?.success).toBe(true);
    expect(turn.toolResults?.[0]?.output).toEqual({ echoed: 'from json string' });
  });
});
