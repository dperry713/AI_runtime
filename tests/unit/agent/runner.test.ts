import { describe, expect, it } from 'vitest';
import { AgentRunner } from '../../../src/agent/runner.js';
import { PolicyEngine, type PolicyDocument } from '../../../src/policy/index.js';
import { MockProvider } from '../../../src/providers/index.js';
import {
  defineTool,
  ToolRegistry,
} from '../../../src/tools/index.js';
import { EventBus, type EventEnvelope } from '../../../src/journal/index.js';
import { FakeClock } from '../../../src/util/index.js';
import type { AgentManifest } from '../../../src/agent/manifest.js';
import { z } from 'zod';

describe('AgentRunner (P6-T06)', () => {
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

  const testPolicy: PolicyDocument = {
    version: 1,
    name: 'test-runner-policy',
    defaultEffect: 'deny',
    rules: [
      {
        id: 'allow-echo',
        description: 'Allow test.echo',
        effect: 'allow',
        priority: 10,
        match: { tools: ['test.echo'] },
        reason: 'Allow test.echo',
      },
    ],
  };

  function setupRunner(options?: {
    scriptSteps?: Parameters<MockProvider['enqueue']>[0][];
    maxTurns?: number;
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

    const policyEngine = new PolicyEngine(testPolicy);

    const manifest: AgentManifest = {
      ...baseManifest,
      budgets: options?.budgets,
    };

    const runner = new AgentRunner({
      manifest,
      runId: 'run-test-runner-001',
      provider,
      toolRegistry,
      policyEngine,
      eventBus,
      clock,
      maxTurns: options?.maxTurns,
    });

    return { runner, provider, eventBus, toolRegistry };
  }

  it('runs to completion for a single-turn answer', async () => {
    const { runner, eventBus } = setupRunner({
      scriptSteps: [
        {
          response: 'Goal achieved!',
          stopReason: 'stop',
        },
      ],
    });

    const events: string[] = [];
    const sub = eventBus.subscribe({}, (ev) => {
      events.push(ev.type);
    });

    const outcome = await runner.run({ initialGoal: 'Complete task' });
    await sub.drain();

    expect(outcome.status).toBe('completed');
    expect(outcome.text).toBe('Goal achieved!');
    expect(outcome.totalTurns).toBe(1);
    expect(runner.getState()).toBe('completed');

    expect(events).toContain('run.created');
    expect(events).toContain('run.starting');
    expect(events).toContain('run.running');
    expect(events).toContain('run.completed');
  });

  it('executes multi-turn loop with tool calls and finishes', async () => {
    const { runner } = setupRunner({
      scriptSteps: [
        // Turn 0: LLM requests tool call
        {
          response: [
            {
              type: 'tool_call',
              id: 'c1',
              name: 'test.echo',
              arguments: { msg: 'Step 1' },
            },
          ],
          stopReason: 'tool_calls',
        },
        // Turn 1: LLM sees tool result and answers
        {
          response: 'Echo received: Step 1',
          stopReason: 'stop',
        },
      ],
    });

    const outcome = await runner.run({ initialGoal: 'Echo step' });

    expect(outcome.status).toBe('completed');
    expect(outcome.text).toBe('Echo received: Step 1');
    expect(outcome.totalTurns).toBe(2);
    expect(runner.getState()).toBe('completed');
  });

  it('handles immediate cancellation via AbortSignal', async () => {
    const { runner } = setupRunner({
      scriptSteps: [{ response: 'Never reached' }],
    });

    const controller = new AbortController();
    controller.abort('User stopped early');

    const outcome = await runner.run({
      initialGoal: 'Quick task',
      signal: controller.signal,
    });

    expect(outcome.status).toBe('cancelled');
    expect(outcome.reason).toContain('User stopped early');
    expect(runner.getState()).toBe('cancelled');
  });

  it('safely pauses at turn boundary and resumes cleanly', async () => {
    const { runner } = setupRunner({
      scriptSteps: [
        // Turn 0: tool call
        {
          response: [
            {
              type: 'tool_call',
              id: 'c1',
              name: 'test.echo',
              arguments: { msg: 'Part A' },
            },
          ],
        },
        // Turn 1: final answer after resume
        {
          response: 'Finished after resume!',
          stopReason: 'stop',
        },
      ],
    });

    // Request pause right after starting
    runner.requestPause('Operator inspecting state');

    const pauseOutcome = await runner.run({ initialGoal: 'Two step task' });

    expect(pauseOutcome.status).toBe('paused');
    expect(runner.getState()).toBe('paused');
    expect(runner.getCurrentTurnIndex()).toBe(1);

    // Now resume
    const resumeOutcome = await runner.resume({
      userMessage: 'Proceed with next step',
    });

    expect(resumeOutcome.status).toBe('completed');
    expect(resumeOutcome.text).toBe('Finished after resume!');
    expect(runner.getState()).toBe('completed');
    expect(runner.getCurrentTurnIndex()).toBe(2);
  });

  it('stops and marks budget_exceeded when maxTurns is hit', async () => {
    const { runner } = setupRunner({
      maxTurns: 2,
      scriptSteps: [
        {
          response: [
            { type: 'tool_call', id: 'c1', name: 'test.echo', arguments: { msg: 't0' } },
          ],
        },
        {
          response: [
            { type: 'tool_call', id: 'c2', name: 'test.echo', arguments: { msg: 't1' } },
          ],
        },
        {
          response: 'Never reached turn 2',
        },
      ],
    });

    const outcome = await runner.run({ initialGoal: 'Exceed steps' });

    expect(outcome.status).toBe('budget_exceeded');
    expect(runner.getState()).toBe('budget_exceeded');
  });

  it('detects stalls and transitions to stalled status', async () => {
    const { runner } = setupRunner({
      scriptSteps: [
        { response: [{ type: 'tool_call', id: 'c1', name: 'test.echo', arguments: { msg: 'loop' } }] },
        { response: [{ type: 'tool_call', id: 'c2', name: 'test.echo', arguments: { msg: 'loop' } }] },
        { response: [{ type: 'tool_call', id: 'c3', name: 'test.echo', arguments: { msg: 'loop' } }] },
      ],
    });

    const outcome = await runner.run({ initialGoal: 'Stall test' });

    expect(outcome.status).toBe('stalled');
    expect(outcome.reason).toContain('identical tool call');
    expect(runner.getState()).toBe('failed');
  });

  it('reconstitutes runner from journal event stream (Rule R8)', async () => {
    const eventBus = new EventBus();
    const capturedEvents: EventEnvelope[] = [];
    eventBus.subscribe({}, (ev) => {
      capturedEvents.push(ev);
    });

    const provider = new MockProvider({ clock });
    provider.enqueue({
      response: [
        { type: 'tool_call', id: 'c1', name: 'test.echo', arguments: { msg: 'reconstitute' } },
      ],
    });

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      defineTool({
        name: 'test.echo',
        description: 'Echo',
        inputSchema: z.object({ msg: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
        risk: 'low',
        idempotent: true,
        execute: (args) => Promise.resolve({ echoed: args.msg }),
      }),
    );

    const runner1 = new AgentRunner({
      manifest: baseManifest,
      runId: 'run-reconstitute-001',
      provider,
      toolRegistry,
      policyEngine: new PolicyEngine(testPolicy),
      eventBus,
      clock,
    });

    runner1.requestPause('Pause after turn 0');
    await runner1.run({ initialGoal: 'Start run' });
    expect(runner1.getState()).toBe('paused');

    // Reconstitute runner from captured events
    const runner2 = AgentRunner.fromEvents(capturedEvents, {
      manifest: baseManifest,
      runId: 'run-reconstitute-001',
      provider,
      toolRegistry,
      policyEngine: new PolicyEngine(testPolicy),
      clock,
    });

    expect(runner2.getState()).toBe('paused');
    expect(runner2.getCurrentTurnIndex()).toBe(1);
  });
});
