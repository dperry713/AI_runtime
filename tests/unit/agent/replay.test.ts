import { describe, expect, it } from 'vitest';
import { AgentRunner } from '../../../src/agent/runner.js';
import { AgentReplayEngine, replayRun } from '../../../src/agent/replay.js';
import { PolicyEngine, type PolicyDocument } from '../../../src/policy/index.js';
import { MockProvider } from '../../../src/providers/index.js';
import {
  defineTool,
  ToolRegistry,
} from '../../../src/tools/index.js';
import { createEnvelope, EventBus, type EventEnvelope } from '../../../src/journal/index.js';
import { FakeClock } from '../../../src/util/index.js';
import type { AgentManifest } from '../../../src/agent/manifest.js';
import { z } from 'zod';

describe('Deterministic Replay Engine (P6-T08)', () => {
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

  const permissivePolicy: PolicyDocument = {
    version: 1,
    name: 'permissive-policy',
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

  it('asserts identical decisions and transitions for live run events', async () => {
    const eventBus = new EventBus();
    const recordedEvents: EventEnvelope[] = [];
    eventBus.subscribe({}, (ev) => {
      recordedEvents.push(ev);
    });

    const provider = new MockProvider({ clock });
    provider.enqueue({
      response: [
        { type: 'tool_call', id: 'c1', name: 'test.echo', arguments: { msg: 'replay test' } },
      ],
      stopReason: 'tool_calls',
    });
    provider.enqueue({
      response: 'Replay completed successfully',
      stopReason: 'stop',
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

    const policyEngine = new PolicyEngine(permissivePolicy);

    const runner = new AgentRunner({
      manifest: baseManifest,
      runId: 'run-replay-001',
      provider,
      toolRegistry,
      policyEngine,
      eventBus,
      clock,
    });

    const outcome = await runner.run({ initialGoal: 'Run echo' });
    expect(outcome.status).toBe('completed');
    expect(recordedEvents.length).toBeGreaterThan(0);

    // Replay the recorded events
    const replayResult = await replayRun('run-replay-001', {
      events: recordedEvents,
      manifest: baseManifest,
      policyEngine,
      clock,
    });

    expect(replayResult.passed).toBe(true);
    expect(replayResult.divergences).toHaveLength(0);
    expect(replayResult.stateTransitionsChecked).toBeGreaterThan(0);
    expect(replayResult.policyDecisionsChecked).toBe(1);
    expect(replayResult.toolCallsChecked).toBe(1);
  });

  it('detects policy drift when policy changes after the run', async () => {
    const eventBus = new EventBus();
    const recordedEvents: EventEnvelope[] = [];
    eventBus.subscribe({}, (ev) => {
      recordedEvents.push(ev);
    });

    const provider = new MockProvider({ clock });
    provider.enqueue({
      response: [
        { type: 'tool_call', id: 'c1', name: 'test.echo', arguments: { msg: 'test' } },
      ],
      stopReason: 'tool_calls',
    });
    provider.enqueue({
      response: 'Done',
      stopReason: 'stop',
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

    const originalPolicy = new PolicyEngine(permissivePolicy);
    const runner = new AgentRunner({
      manifest: baseManifest,
      runId: 'run-drift-001',
      provider,
      toolRegistry,
      policyEngine: originalPolicy,
      eventBus,
      clock,
    });

    await runner.run({ initialGoal: 'Run drift test' });

    // New strict policy that denies test.echo
    const strictPolicy = new PolicyEngine({
      version: 1,
      name: 'strict-policy',
      defaultEffect: 'deny',
      rules: [],
    });

    const engine = new AgentReplayEngine({
      runId: 'run-drift-001',
      events: recordedEvents,
      manifest: baseManifest,
      policyEngine: strictPolicy,
      clock,
    });

    const result = await engine.replay();

    expect(result.passed).toBe(false);
    expect(result.divergences.length).toBeGreaterThan(0);
    const policyDiv = result.divergences.find((d) => d.category === 'policy');
    expect(policyDiv).toBeDefined();
    expect(policyDiv?.message).toContain('Policy drift detected for tool "test.echo"');
  });

  it('detects sequence order violation in event stream', async () => {
    const invalidEvents: EventEnvelope[] = [
      createEnvelope({
        stream: 'run:run-seq-001',
        seq: 2, // Non-monotonic: starts with 2
        type: 'run.starting',
        payload: { timestamp: clock.iso() },
        clock,
      }),
      createEnvelope({
        stream: 'run:run-seq-001',
        seq: 1, // Decreases: 2 -> 1
        type: 'run.running',
        payload: { turnIndex: 0 },
        clock,
      }),
    ];

    const engine = new AgentReplayEngine({
      runId: 'run-seq-001',
      events: invalidEvents,
      verifySequenceOrdering: true,
      clock,
    });

    const result = await engine.replay();

    expect(result.passed).toBe(false);
    const orderDiv = result.divergences.find((d) => d.category === 'event_order');
    expect(orderDiv).toBeDefined();
    expect(orderDiv?.message).toContain('Non-monotonic event sequence number');
  });

  it('replays failed, cancelled, and budget_exceeded terminal runs correctly', async () => {
    const events: EventEnvelope[] = [
      createEnvelope({
        stream: 'run:run-term-001',
        seq: 1,
        type: 'run.starting',
        payload: {},
        clock,
      }),
      createEnvelope({
        stream: 'run:run-term-001',
        seq: 2,
        type: 'run.running',
        payload: { turnIndex: 0 },
        clock,
      }),
      createEnvelope({
        stream: 'run:run-term-001',
        seq: 3,
        type: 'run.failed',
        payload: { error: { code: 'CRASH', message: 'Model crashed' } },
        clock,
      }),
    ];

    const res = await replayRun('run-term-001', {
      events,
      clock,
    });

    expect(res.passed).toBe(true);
    expect(res.finalState).toBe('failed');
    expect(res.divergences).toHaveLength(0);
  });

  it('detects illegal state transition in event stream during replay', async () => {
    // Attempting to complete directly from created state (without starting/running)
    const illegalEvents: EventEnvelope[] = [
      createEnvelope({
        stream: 'run:run-illegal-001',
        seq: 1,
        type: 'run.completed',
        payload: { summary: 'Skipped to end' },
        clock,
      }),
    ];

    const engine = new AgentReplayEngine({
      runId: 'run-illegal-001',
      events: illegalEvents,
      clock,
    });

    const res = await engine.replay();
    expect(res.passed).toBe(false);
    expect(res.divergences.some((d) => d.category === 'state')).toBe(true);
  });

  it('handles run.cancelled and run.budget_exceeded in replay', async () => {
    const cancelledEvents: EventEnvelope[] = [
      createEnvelope({ stream: 'run:run-c-1', seq: 1, type: 'run.starting', payload: {}, clock }),
      createEnvelope({ stream: 'run:run-c-1', seq: 2, type: 'run.running', payload: { turnIndex: 0 }, clock }),
      createEnvelope({ stream: 'run:run-c-1', seq: 3, type: 'run.cancelled', payload: { reason: 'User abort' }, clock }),
    ];
    const cRes = await replayRun('run-c-1', { events: cancelledEvents, clock });
    expect(cRes.passed).toBe(true);
    expect(cRes.finalState).toBe('cancelled');

    const budgetEvents: EventEnvelope[] = [
      createEnvelope({ stream: 'run:run-b-1', seq: 1, type: 'run.starting', payload: {}, clock }),
      createEnvelope({ stream: 'run:run-b-1', seq: 2, type: 'run.running', payload: { turnIndex: 0 }, clock }),
      createEnvelope({
        stream: 'run:run-b-1',
        seq: 3,
        type: 'run.budget_exceeded',
        payload: { dimension: 'steps', limit: 5, actual: 6 },
        clock,
      }),
    ];
    const bRes = await replayRun('run-b-1', { events: budgetEvents, clock });
    expect(bRes.passed).toBe(true);
    expect(bRes.finalState).toBe('budget_exceeded');
  });
});
