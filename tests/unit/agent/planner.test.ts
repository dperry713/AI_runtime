import { describe, expect, it } from 'vitest';
import {
  FailureClass,
  InMemoryEventSink,
  InMemoryExecutor,
  normalizeStepProposal,
  type PlannerModelClient,
  PlannerOrchestrator,
  Planner,
  type Scope,
  ScopeValidator,
  StepAction,
  StepStatus,
  type ToolCall,
  toolCallSchema,
  plannerConfigSchema,
} from '../../../src/agent/planner.js';
import { createRunId } from '../../../src/types/index.js';

class MockModelClient implements PlannerModelClient {
  private responses: Array<{ content: string; thinking?: string }>;
  public readonly calls: Array<{ model: string; messages: ReadonlyArray<{ role: string; content: string }> }> = [];

  constructor(responses: Array<{ content: string; thinking?: string }>) {
    this.responses = [...responses];
  }

  async chat(request: {
    model: string;
    messages: ReadonlyArray<{ role: string; content: string }>;
  }): Promise<{ content: string; thinking?: string }> {
    this.calls.push(request);
    const next = this.responses.shift();
    if (!next) {
      throw new Error('No more mocked responses');
    }
    return Promise.resolve(next);
  }
}

describe('Planner Domain Schemas & Normalization', () => {
  it('validates a correct ToolCall', () => {
    const valid = toolCallSchema.parse({
      name: 'echo',
      arguments: { msg: 'hi' },
      idempotencyKey: 'key-123',
    });
    expect(valid.name).toBe('echo');
    expect(valid.idempotencyKey).toBe('key-123');
  });

  it('normalizes snake_case LLM output into typed StepProposal', () => {
    const raw = {
      thought_summary: 'Deciding to run echo',
      action: 'next',
      tool_call: {
        name: 'echo',
        arguments: { text: 'hello' },
        idempotency_key: 'call-1',
      },
      reasoning: 'I should echo first',
      assumptions: ['Tool exists'],
      confidence: 0.95,
    };

    const proposal = normalizeStepProposal(raw);
    expect(proposal.thoughtSummary).toBe('Deciding to run echo');
    expect(proposal.action).toBe('next');
    expect(proposal.toolCall?.name).toBe('echo');
    expect(proposal.toolCall?.idempotencyKey).toBe('call-1');
    expect(proposal.confidence).toBe(0.95);
  });

  it('normalizes camelCase StepProposal', () => {
    const raw = {
      thoughtSummary: 'Finishing run',
      action: 'finish',
      reasoning: 'Goal is satisfied',
      confidence: 1.0,
    };

    const proposal = normalizeStepProposal(raw);
    expect(proposal.thoughtSummary).toBe('Finishing run');
    expect(proposal.action).toBe('finish');
    expect(proposal.toolCall).toBeNull();
  });

  it('rejects invalid action in proposal', () => {
    const raw = {
      thought_summary: 'Bad action',
      action: 'destroy_database',
    };
    expect(() => normalizeStepProposal(raw)).toThrow();
  });

  it('validates plannerConfigSchema defaults', () => {
    const config = plannerConfigSchema.parse({});
    expect(config.model).toBe('qwen3.5:9b');
    expect(config.maxPlannerSteps).toBe(25);
    expect(config.temperature).toBe(0.6);
  });
});

describe('ScopeValidator', () => {
  const scope: Scope = {
    allowedTools: ['echo', 'read_file'],
    maxSteps: 2,
    maxCostUnits: 100,
    forbiddenSideEffects: ['delete'],
    requireHumanOn: ['ask_human'],
  };

  it('accepts valid tool inside scope', () => {
    const validator = new ScopeValidator(scope);
    const res = validator.validate({
      thought_summary: 'Run echo',
      action: 'next',
      tool_call: { name: 'echo', idempotency_key: 'id-1' },
    });
    expect(res.accepted).toBe(true);
    expect(res.proposal?.toolCall?.name).toBe('echo');
  });

  it('rejects disallowed tool', () => {
    const validator = new ScopeValidator(scope);
    const res = validator.validate({
      thought_summary: 'Run bash',
      action: 'next',
      tool_call: { name: 'bash', idempotency_key: 'id-2' },
    });
    expect(res.accepted).toBe(false);
    expect(res.reason).toContain('tool_not_allowed: bash');
  });

  it('enforces maximum steps constraint', () => {
    const validator = new ScopeValidator(scope);
    const step = {
      thought_summary: 'Step',
      action: 'next',
      tool_call: { name: 'echo', idempotency_key: 'step' },
    };

    expect(validator.validate(step).accepted).toBe(true);
    expect(validator.validate(step).accepted).toBe(true);

    const overLimit = validator.validate(step);
    expect(overLimit.accepted).toBe(false);
    expect(overLimit.reason).toBe('max_steps_exceeded');
  });
});

describe('InMemoryExecutor and Idempotency', () => {
  it('executes tool successfully and caches idempotency key', () => {
    const executor = new InMemoryExecutor();
    const toolCall: ToolCall = {
      name: 'echo',
      arguments: { val: 42 },
      idempotencyKey: 'idem-42',
    };

    const res1 = executor.execute(toolCall);
    expect(res1.success).toBe(true);
    expect(res1.output).toEqual({ echoed: { val: 42 } });
    expect(res1.idempotencyKey).toBe('idem-42');

    const res2 = executor.execute(toolCall);
    expect(res2).toBe(res1);
  });

  it('classifies transient and fatal failures', () => {
    const executor = new InMemoryExecutor();

    const resTransient = executor.execute({
      name: 'fail_transient',
      arguments: {},
      idempotencyKey: 'trans-1',
    });
    expect(resTransient.success).toBe(false);
    expect(resTransient.failureClass).toBe(FailureClass.TRANSIENT);

    const resFatal = executor.execute({
      name: 'fail_fatal',
      arguments: {},
      idempotencyKey: 'fatal-1',
    });
    expect(resFatal.success).toBe(false);
    expect(resFatal.failureClass).toBe(FailureClass.FATAL);
  });
});

describe('Planner Propose & Thinking Extraction', () => {
  const config = plannerConfigSchema.parse({});
  const scope: Scope = {
    allowedTools: ['echo'],
    maxSteps: 5,
    maxCostUnits: 100,
    forbiddenSideEffects: [],
    requireHumanOn: ['ask_human'],
  };

  it('parses markdown-fenced JSON and preserves thinking', async () => {
    const runId = createRunId();
    const sink = new InMemoryEventSink(runId);
    const jsonStr = JSON.stringify({
      thought_summary: 'Execute echo',
      action: 'next',
      tool_call: { name: 'echo', arguments: { a: 1 }, idempotency_key: 'k1' },
      assumptions: ['none'],
      confidence: 0.9,
    });
    const markdownContent = `\`\`\`json\n${jsonStr}\n\`\`\``;

    const mockClient = new MockModelClient([
      { content: markdownContent, thinking: 'Thought tokens from Qwen3.5' },
    ]);

    const planner = new Planner(config, sink, mockClient);
    const { proposal, thinking } = await planner.propose('goal', scope, [], 'step-0000');

    expect(proposal).not.toBeNull();
    expect(proposal?.thoughtSummary).toBe('Execute echo');
    expect(proposal?.reasoning).toBe('Thought tokens from Qwen3.5');
    expect(thinking).toBe('Thought tokens from Qwen3.5');

    const events = sink.getEvents();
    expect(events.length).toBe(2);
    expect(events[0]?.eventType).toBe('planner_request');
    expect(events[1]?.eventType).toBe('planner_response');
  });

  it('handles unparseable model response gracefully', async () => {
    const runId = createRunId();
    const sink = new InMemoryEventSink(runId);
    const mockClient = new MockModelClient([
      { content: 'Sorry, I cannot produce JSON right now.', thinking: 'Refused' },
    ]);

    const planner = new Planner(config, sink, mockClient);
    const { proposal, thinking } = await planner.propose('goal', scope, [], 'step-0000');

    expect(proposal).toBeNull();
    expect(thinking).toBe('Refused');

    const events = sink.getEvents();
    expect(events.some((e) => e.eventType === 'planner_parse_error')).toBe(true);
  });
});

describe('PlannerOrchestrator End-to-End Loop', () => {
  const config = plannerConfigSchema.parse({ maxPlannerSteps: 5 });
  const scope: Scope = {
    allowedTools: ['echo'],
    maxSteps: 5,
    maxCostUnits: 100,
    forbiddenSideEffects: [],
    requireHumanOn: ['ask_human'],
  };

  it('runs complete flow: propose -> execute -> finish', async () => {
    const step1 = JSON.stringify({
      thought_summary: 'Call echo',
      action: 'next',
      tool_call: { name: 'echo', arguments: { text: 'air planner' }, idempotency_key: 's1' },
    });
    const step2 = JSON.stringify({
      thought_summary: 'Work complete',
      action: 'finish',
    });

    const mockClient = new MockModelClient([
      { content: step1, thinking: 'Step 1 thinking' },
      { content: step2, thinking: 'Step 2 thinking' },
    ]);

    const executor = new InMemoryExecutor();
    const orch = new PlannerOrchestrator(config, scope, executor, { modelClient: mockClient });

    const result = await orch.run('Echo message and complete');

    expect(result.finalStatus).toBe(StepStatus.SUCCEEDED);
    expect(result.stepsTaken).toBe(2);
    expect(result.history.length).toBe(2);
    expect(result.history[0]?.['status']).toBe(StepStatus.SUCCEEDED);
    expect(result.history[1]?.['action']).toBe('finish');
    expect(result.events.length).toBeGreaterThan(4);
  });

  it('halts with SKIPPED when ask_human is requested', async () => {
    const askHumanJson = JSON.stringify({
      thought_summary: 'Need human approval',
      action: 'ask_human',
    });

    const mockClient = new MockModelClient([
      { content: askHumanJson, thinking: 'Seeking escalation' },
    ]);

    const executor = new InMemoryExecutor();
    const orch = new PlannerOrchestrator(config, scope, executor, { modelClient: mockClient });

    const result = await orch.run('Test escalation');
    expect(result.finalStatus).toBe(StepStatus.SKIPPED);
    expect(result.history.length).toBe(1);
    expect(result.history[0]?.['action']).toBe(StepAction.ASK_HUMAN);
  });

  it('stops when fatal failure occurs during tool execution', async () => {
    const fatalScope: Scope = { ...scope, allowedTools: ['fail_fatal'] };
    const fatalStep = JSON.stringify({
      thought_summary: 'Trigger fatal failure',
      action: 'next',
      tool_call: { name: 'fail_fatal', idempotency_key: 'fatal-key' },
    });

    const mockClient = new MockModelClient([
      { content: fatalStep, thinking: 'Triggering fatal' },
    ]);

    const executor = new InMemoryExecutor();
    const orch = new PlannerOrchestrator(config, fatalScope, executor, { modelClient: mockClient });

    const result = await orch.run('Test fatal error');
    expect(result.finalStatus).toBe(StepStatus.FAILED);
    expect(result.history.length).toBe(1);
    expect(result.history[0]?.['status']).toBe(StepStatus.FAILED);
  });

  it('exhausts retries and terminates with FAILED on repeated unparseable proposals', async () => {
    const mockClient = new MockModelClient([
      { content: 'bad 1' },
      { content: 'bad 2' },
      { content: 'bad 3' },
    ]);

    const executor = new InMemoryExecutor();
    const orch = new PlannerOrchestrator(config, scope, executor, { modelClient: mockClient });

    const result = await orch.run('Test rejection exhaustion');
    expect(result.finalStatus).toBe(StepStatus.FAILED);
    expect(result.history.length).toBe(3);
    expect(result.history.every((h) => h['status'] === StepStatus.REJECTED)).toBe(true);
  });
});
