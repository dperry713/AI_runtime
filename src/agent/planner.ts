/**
 * Production Planner-Executor Protocol for AIR.
 * Port of planner.py adhering to strict TypeScript, Zod validation, branded IDs, and error taxonomy.
 */

import { z } from 'zod';
import type { EventId, RunId } from '../types/index.js';
import { createEventId, createRunId, createToolCallId } from '../types/index.js';
import { AirError } from '../errors/index.js';
import type { Clock } from '../util/index.js';
import { SystemClock } from '../util/index.js';

// ---------------------------------------------------------------------------
// Enums and Constants
// ---------------------------------------------------------------------------

export const FailureClass = {
  TRANSIENT: 'transient',
  LOGIC: 'logic',
  PERMISSION: 'permission',
  FATAL: 'fatal',
} as const;
export type FailureClass = (typeof FailureClass)[keyof typeof FailureClass];

export const StepStatus = {
  PROPOSED: 'proposed',
  REJECTED: 'rejected',
  EXECUTING: 'executing',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  SKIPPED: 'skipped',
} as const;
export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus];

export const StepAction = {
  NEXT: 'next',
  REPLAN: 'replan',
  FINISH: 'finish',
  ASK_HUMAN: 'ask_human',
} as const;
export type StepAction = (typeof StepAction)[keyof typeof StepAction];

// ---------------------------------------------------------------------------
// Zod Schemas & Domain Models
// ---------------------------------------------------------------------------

export const toolCallSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().min(1),
});
export type ToolCall = z.infer<typeof toolCallSchema>;

export const stepProposalSchema = z.object({
  thoughtSummary: z.string().min(1),
  action: z.enum(['next', 'replan', 'finish', 'ask_human']),
  toolCall: toolCallSchema.nullable().optional(),
  reasoning: z.string().default(''),
  assumptions: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.7),
});
export type StepProposal = z.infer<typeof stepProposalSchema>;

export const executionResultSchema = z.object({
  success: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  failureClass: z.enum(['transient', 'logic', 'permission', 'fatal']).optional(),
  durationMs: z.number().int().nonnegative().default(0),
  idempotencyKey: z.string().min(1),
});
export type ExecutionResult = z.infer<typeof executionResultSchema>;

export const scopeSchema = z.object({
  allowedTools: z.array(z.string()),
  maxSteps: z.number().int().positive().default(25),
  maxCostUnits: z.number().positive().default(100.0),
  forbiddenSideEffects: z.array(z.string()).default([]),
  requireHumanOn: z.array(z.string()).default(['ask_human']),
});
export type Scope = z.infer<typeof scopeSchema>;

export const plannerConfigSchema = z.object({
  model: z.string().default('qwen3.5:9b'),
  ollamaHost: z.string().default('http://localhost:11434'),
  maxPlannerSteps: z.number().int().positive().default(25),
  maxRejectionsPerStep: z.number().int().positive().default(3),
  temperature: z.number().min(0).max(2).default(0.6),
  topP: z.number().min(0).max(1).default(0.95),
  topK: z.number().int().positive().default(20),
  presencePenalty: z.number().default(0.0),
  numPredict: z.number().int().positive().default(8192),
  requestTimeout: z.number().positive().default(180.0),
});
export type PlannerConfig = z.infer<typeof plannerConfigSchema>;

// ---------------------------------------------------------------------------
// Proposal Parsing (Normalizing snake_case LLM outputs)
// ---------------------------------------------------------------------------

export function normalizeStepProposal(raw: unknown): StepProposal {
  if (typeof raw !== 'object' || raw === null) {
    throw new AirError('VALIDATION_FAILED', 'Proposal payload must be an object');
  }

  const r = raw as Record<string, unknown>;

  const thoughtSummary = typeof r['thought_summary'] === 'string'
    ? r['thought_summary']
    : typeof r['thoughtSummary'] === 'string'
      ? r['thoughtSummary']
      : '';

  const action = typeof r['action'] === 'string' ? r['action'] : '';

  let toolCall: ToolCall | null = null;
  const rawTc = r['tool_call'] ?? r['toolCall'];
  if (typeof rawTc === 'object' && rawTc !== null) {
    const tcObj = rawTc as Record<string, unknown>;
    const name = typeof tcObj['name'] === 'string' ? tcObj['name'] : '';
    const args = typeof tcObj['arguments'] === 'object' && tcObj['arguments'] !== null
      ? (tcObj['arguments'] as Record<string, unknown>)
      : {};
    const idempotencyKey = typeof tcObj['idempotency_key'] === 'string'
      ? tcObj['idempotency_key']
      : typeof tcObj['idempotencyKey'] === 'string'
        ? tcObj['idempotencyKey']
        : String(createToolCallId());

    toolCall = {
      name,
      arguments: args,
      idempotencyKey,
    };
  }

  const reasoning = typeof r['reasoning'] === 'string' ? r['reasoning'] : '';
  const assumptions = Array.isArray(r['assumptions'])
    ? r['assumptions'].filter((item): item is string => typeof item === 'string')
    : [];
  const confidence = typeof r['confidence'] === 'number' ? r['confidence'] : 0.7;

  return stepProposalSchema.parse({
    thoughtSummary,
    action,
    toolCall,
    reasoning,
    assumptions,
    confidence,
  });
}

// ---------------------------------------------------------------------------
// Events & Event Sink
// ---------------------------------------------------------------------------

export interface PlannerEvent {
  readonly eventId: EventId;
  readonly runId: RunId;
  readonly stepId?: string | undefined;
  readonly timestamp: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

export interface EventSink {
  emit(eventType: string, payload: Record<string, unknown>, stepId?: string): PlannerEvent;
  getEvents(): readonly PlannerEvent[];
}

export class InMemoryEventSink implements EventSink {
  private readonly events: PlannerEvent[] = [];

  constructor(
    private readonly runId: RunId,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  emit(eventType: string, payload: Record<string, unknown>, stepId?: string): PlannerEvent {
    const event: PlannerEvent = {
      eventId: createEventId(),
      runId: this.runId,
      stepId,
      timestamp: this.clock.iso(),
      eventType,
      payload,
    };
    this.events.push(event);
    return event;
  }

  getEvents(): readonly PlannerEvent[] {
    return [...this.events];
  }
}

// ---------------------------------------------------------------------------
// Validator (Mechanical Scope Enforcement)
// ---------------------------------------------------------------------------

export interface ValidationResult {
  accepted: boolean;
  reason?: string | undefined;
  proposal?: StepProposal | undefined;
}

export class ScopeValidator {
  private stepsTaken = 0;

  constructor(public readonly scope: Scope) {}

  validate(raw: unknown): ValidationResult {
    let proposal: StepProposal;
    try {
      proposal = normalizeStepProposal(raw);
    } catch (err) {
      return {
        accepted: false,
        reason: `schema_violation: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (this.stepsTaken >= this.scope.maxSteps) {
      return {
        accepted: false,
        reason: 'max_steps_exceeded',
      };
    }

    if (proposal.action === StepAction.NEXT && proposal.toolCall) {
      if (!this.scope.allowedTools.includes(proposal.toolCall.name)) {
        return {
          accepted: false,
          reason: `tool_not_allowed: ${proposal.toolCall.name}`,
        };
      }
    }

    this.stepsTaken += 1;
    return {
      accepted: true,
      proposal,
    };
  }

  getStepsTaken(): number {
    return this.stepsTaken;
  }
}

// ---------------------------------------------------------------------------
// Executor Interface & In-Memory Implementation
// ---------------------------------------------------------------------------

export interface Executor {
  execute(toolCall: ToolCall): Promise<ExecutionResult> | ExecutionResult;
}

export class InMemoryExecutor implements Executor {
  private readonly seen = new Map<string, ExecutionResult>();

  execute(toolCall: ToolCall): ExecutionResult {
    const key = toolCall.idempotencyKey;
    const cached = this.seen.get(key);
    if (cached) {
      return cached;
    }

    const start = globalThis.performance.now();
    try {
      let output: unknown;
      if (toolCall.name === 'echo') {
        output = { echoed: toolCall.arguments };
      } else if (toolCall.name === 'fail_transient') {
        throw new AirError('PROVIDER_UNAVAILABLE', 'simulated network blip', { retryable: true });
      } else if (toolCall.name === 'fail_fatal') {
        throw new AirError('INTERNAL', 'simulated fatal failure', { retryable: false });
      } else {
        output = { status: 'ok', tool: toolCall.name, args: toolCall.arguments };
      }

      const durationMs = Math.round(globalThis.performance.now() - start);
      const result: ExecutionResult = {
        success: true,
        output,
        durationMs,
        idempotencyKey: key,
      };
      this.seen.set(key, result);
      return result;
    } catch (error) {
      const durationMs = Math.round(globalThis.performance.now() - start);
      const isTransient = toolCall.name === 'fail_transient' || (error instanceof AirError && error.retryable);
      const isFatal = toolCall.name === 'fail_fatal';
      const failureClass: FailureClass = isFatal
        ? FailureClass.FATAL
        : isTransient
          ? FailureClass.TRANSIENT
          : FailureClass.LOGIC;

      const result: ExecutionResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        failureClass,
        durationMs,
        idempotencyKey: key,
      };
      this.seen.set(key, result);
      return result;
    }
  }
}

// ---------------------------------------------------------------------------
// Planner Model Client Protocol
// ---------------------------------------------------------------------------

export interface ModelChatResponse {
  content: string;
  thinking?: string | undefined;
}

export interface PlannerModelClient {
  chat(request: {
    model: string;
    messages: ReadonlyArray<{ role: string; content: string }>;
    think?: boolean;
    options?: Record<string, unknown>;
  }): Promise<ModelChatResponse>;
}

export class OllamaPlannerClient implements PlannerModelClient {
  constructor(private readonly baseUrl: string = 'http://localhost:11434') {}

  async chat(request: {
    model: string;
    messages: ReadonlyArray<{ role: string; content: string }>;
    think?: boolean;
    options?: Record<string, unknown>;
  }): Promise<ModelChatResponse> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/api/chat`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: false,
        think: request.think ?? true,
        options: request.options,
      }),
    });

    if (!response.ok) {
      throw new AirError('PROVIDER_UNAVAILABLE', `Ollama request failed with HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      message?: { content?: string; thinking?: string };
    };

    return {
      content: data.message?.content ?? '',
      thinking: data.message?.thinking ?? '',
    };
  }
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export const PLANNER_SYSTEM_PROMPT = `You are the Planner in a strict Planner-Executor protocol.

You receive:
- The overall goal
- The current scoped outlook
- Full history of previous steps and their outcomes
- The list of allowed tools

Your job is to decide the single next action.
You may improvise freely inside the given scope.
You must never request a tool that is not in the allowed list.

Respond with a single JSON object that matches this schema exactly:
{
  "thought_summary": "one sentence",
  "action": "next" | "replan" | "finish" | "ask_human",
  "tool_call": {
    "name": "tool_name",
    "arguments": {},
    "idempotency_key": "unique-string"
  } | null,
  "assumptions": ["list of assumptions you are making"],
  "confidence": 0.0-1.0
}

Do not wrap the JSON in markdown. Emit pure JSON only after your internal reasoning.
`;

export class Planner {
  constructor(
    public readonly config: PlannerConfig,
    public readonly eventSink: EventSink,
    public readonly client: PlannerModelClient,
  ) {}

  async propose(
    goal: string,
    scope: Scope,
    history: ReadonlyArray<Record<string, unknown>>,
    stepId: string,
  ): Promise<{ proposal: StepProposal | null; thinking: string }> {
    const messages = [
      { role: 'system', content: PLANNER_SYSTEM_PROMPT },
      { role: 'user', content: this.buildUserMessage(goal, scope, history) },
    ];

    this.eventSink.emit(
      'planner_request',
      { messages, model: this.config.model },
      stepId,
    );

    let response: ModelChatResponse;
    try {
      response = await this.client.chat({
        model: this.config.model,
        messages,
        think: true,
        options: {
          temperature: this.config.temperature,
          top_p: this.config.topP,
          top_k: this.config.topK,
          presence_penalty: this.config.presencePenalty,
          num_predict: this.config.numPredict,
        },
      });
    } catch (err) {
      this.eventSink.emit(
        'planner_error',
        { error: err instanceof Error ? err.message : String(err) },
        stepId,
      );
      throw err;
    }

    const thinking = response.thinking ?? '';
    const content = response.content ?? '';

    this.eventSink.emit(
      'planner_response',
      { thinking, content, model: this.config.model },
      stepId,
    );

    try {
      let cleaned = content.trim();
      if (cleaned.startsWith('```')) {
        const parts = cleaned.split('```');
        if (parts.length >= 2 && parts[1] !== undefined) {
          cleaned = parts[1];
        }
        if (cleaned.startsWith('json')) {
          cleaned = cleaned.slice(4);
        }
      }
      cleaned = cleaned.trim();
      const parsed = JSON.parse(cleaned) as unknown;
      const proposal = normalizeStepProposal(parsed);
      proposal.reasoning = thinking;
      return { proposal, thinking };
    } catch (err) {
      this.eventSink.emit(
        'planner_parse_error',
        { error: err instanceof Error ? err.message : String(err), raw_content: content },
        stepId,
      );
      return { proposal: null, thinking };
    }
  }

  private buildUserMessage(
    goal: string,
    scope: Scope,
    history: ReadonlyArray<Record<string, unknown>>,
  ): string {
    return JSON.stringify(
      {
        goal,
        scope: {
          allowed_tools: scope.allowedTools,
          max_steps: scope.maxSteps,
          forbidden_side_effects: scope.forbiddenSideEffects,
        },
        history: history.slice(-12),
      },
      null,
      2,
    );
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface OrchestratorRunResult {
  runId: RunId;
  goal: string;
  history: ReadonlyArray<Record<string, unknown>>;
  events: readonly PlannerEvent[];
  stepsTaken: number;
  finalStatus: StepStatus;
}

export class PlannerOrchestrator {
  public readonly runId: RunId;
  public readonly eventSink: EventSink;
  public readonly planner: Planner;
  public readonly validator: ScopeValidator;
  private readonly history: Array<Record<string, unknown>> = [];

  constructor(
    public readonly config: PlannerConfig,
    public readonly scope: Scope,
    public readonly executor: Executor,
    options?: {
      runId?: RunId;
      eventSink?: EventSink;
      planner?: Planner;
      modelClient?: PlannerModelClient;
    },
  ) {
    this.runId = options?.runId ?? createRunId();
    this.eventSink = options?.eventSink ?? new InMemoryEventSink(this.runId);
    this.validator = new ScopeValidator(scope);
    const client = options?.modelClient ?? new OllamaPlannerClient(config.ollamaHost);
    this.planner = options?.planner ?? new Planner(config, this.eventSink, client);
  }

  async run(goal: string): Promise<OrchestratorRunResult> {
    this.eventSink.emit('run_started', { goal, scope: this.scope });

    let stepCount = 0;
    let rejections = 0;
    let finalStatus: StepStatus = StepStatus.SUCCEEDED;

    while (stepCount < this.config.maxPlannerSteps) {
      const stepId = `step-${String(stepCount).padStart(4, '0')}`;
      stepCount += 1;

      const { proposal, thinking } = await this.planner.propose(
        goal,
        this.scope,
        this.history,
        stepId,
      );

      if (!proposal) {
        rejections += 1;
        this.history.push({
          stepId,
          status: StepStatus.REJECTED,
          reason: 'unparseable_proposal',
          thinking,
        });
        if (rejections >= this.config.maxRejectionsPerStep) {
          finalStatus = StepStatus.FAILED;
          break;
        }
        continue;
      }

      const validation = this.validator.validate(proposal);
      if (!validation.accepted || !validation.proposal) {
        rejections += 1;
        this.eventSink.emit(
          'proposal_rejected',
          { reason: validation.reason, proposal },
          stepId,
        );
        this.history.push({
          stepId,
          status: StepStatus.REJECTED,
          reason: validation.reason,
          proposal,
          thinking,
        });
        if (rejections >= this.config.maxRejectionsPerStep) {
          finalStatus = StepStatus.FAILED;
          break;
        }
        continue;
      }

      rejections = 0;
      const validProposal = validation.proposal;

      this.eventSink.emit(
        'proposal_accepted',
        { proposal: validProposal },
        stepId,
      );

      // Terminal actions
      if (validProposal.action === StepAction.FINISH) {
        this.history.push({
          stepId,
          status: StepStatus.SUCCEEDED,
          action: 'finish',
          thinking,
        });
        finalStatus = StepStatus.SUCCEEDED;
        break;
      }

      if (validProposal.action === StepAction.ASK_HUMAN) {
        this.history.push({
          stepId,
          status: StepStatus.SKIPPED,
          action: 'ask_human',
          thinking,
          message: 'Human intervention required',
        });
        finalStatus = StepStatus.SKIPPED;
        break;
      }

      if (validProposal.action === StepAction.REPLAN) {
        this.history.push({
          stepId,
          status: StepStatus.SUCCEEDED,
          action: 'replan',
          thinking,
        });
        continue;
      }

      // Execute action === 'next'
      if (!validProposal.toolCall) {
        this.history.push({
          stepId,
          status: StepStatus.FAILED,
          reason: 'missing_tool_call',
          thinking,
        });
        finalStatus = StepStatus.FAILED;
        break;
      }

      this.eventSink.emit(
        'execution_started',
        { toolCall: validProposal.toolCall },
        stepId,
      );

      const result = await this.executor.execute(validProposal.toolCall);

      this.eventSink.emit(
        'execution_finished',
        { result },
        stepId,
      );

      const status = result.success ? StepStatus.SUCCEEDED : StepStatus.FAILED;
      this.history.push({
        stepId,
        status,
        proposal: validProposal,
        result,
        thinking,
      });

      if (!result.success && result.failureClass === FailureClass.FATAL) {
        finalStatus = StepStatus.FAILED;
        break;
      }
    }

    this.eventSink.emit('run_finished', {
      steps: stepCount,
      finalHistoryLength: this.history.length,
      finalStatus,
    });

    return {
      runId: this.runId,
      goal,
      history: [...this.history],
      events: this.eventSink.getEvents(),
      stepsTaken: stepCount,
      finalStatus,
    };
  }
}
