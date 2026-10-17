/**
 * Schema registry and discriminated unions for all AIR journal events (P2-T01).
 * Adheres to additive-versioning rules in docs/specs/events.md.
 */

import { z } from 'zod';
import { AirError } from '../errors/index.js';
import {
  AgentIdSchema,
  EventIdSchema,
  RunIdSchema,
  ToolCallIdSchema,
} from '../types/index.js';
import { EventMetaSchema } from './envelope.js';

// ---------------------------------------------------------------------------
// 1. Run Lifecycle Payloads
// ---------------------------------------------------------------------------

export const RunCreatedPayloadSchema = z.object({
  goal: z.string().min(1),
  agentId: AgentIdSchema,
  parentRunId: RunIdSchema.optional(),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const RunStartingPayloadSchema = z.object({
  timestamp: z.string().optional(),
});

export const RunRunningPayloadSchema = z.object({
  turnIndex: z.number().int().nonnegative().default(0),
});

export const RunPausedPayloadSchema = z.object({
  reason: z.string().min(1),
});

export const RunResumedPayloadSchema = z.object({
  reason: z.string().optional(),
});

export const RunWaitingApprovalPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  toolName: z.string().min(1),
  riskLevel: z.string().min(1),
  reason: z.string().min(1),
});

export const RunWaitingUserPayloadSchema = z.object({
  prompt: z.string().min(1),
});

export const RunCompletedPayloadSchema = z.object({
  result: z.unknown().optional(),
  summary: z.string().optional(),
  totalSteps: z.number().int().nonnegative().optional(),
});

export const RunFailedPayloadSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean().optional(),
  }),
});

export const RunCancelledPayloadSchema = z.object({
  reason: z.string().optional(),
});

export const RunBudgetExceededPayloadSchema = z.object({
  dimension: z.enum(['tokens', 'wall_time', 'cost', 'steps', 'tool_calls']),
  limit: z.number().nonnegative(),
  actual: z.number().nonnegative(),
});

// ---------------------------------------------------------------------------
// 2. Turn Lifecycle Payloads
// ---------------------------------------------------------------------------

export const TurnStartedPayloadSchema = z.object({
  turnIndex: z.number().int().nonnegative(),
});

export const TurnCompletedPayloadSchema = z.object({
  turnIndex: z.number().int().nonnegative(),
  toolCallsCount: z.number().int().nonnegative().default(0),
});

export const TurnFailedPayloadSchema = z.object({
  turnIndex: z.number().int().nonnegative(),
  error: z.string().min(1),
});

// ---------------------------------------------------------------------------
// 3. Model / Provider Lifecycle Payloads
// ---------------------------------------------------------------------------

export const ModelRequestedPayloadSchema = z.object({
  model: z.string().min(1),
  promptTokens: z.number().int().nonnegative().optional(),
  temperature: z.number().optional(),
});

export const ModelRespondedPayloadSchema = z.object({
  model: z.string().min(1),
  completionTokens: z.number().int().nonnegative().optional(),
  stopReason: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
});

export const ModelFailedPayloadSchema = z.object({
  model: z.string().min(1),
  error: z.string().min(1),
  retryable: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// 4. Tool Lifecycle Payloads
// ---------------------------------------------------------------------------

export const ToolRequestedPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().optional(),
});

export const ToolPolicyDecidedPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  decision: z.enum(['allow', 'deny', 'ask']),
  ruleId: z.string().min(1),
  reason: z.string().min(1),
});

export const ToolApprovalRequestedPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  riskLevel: z.string().min(1),
  prompt: z.string().min(1),
});

export const ToolApprovedPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  operator: z.string().optional(),
});

export const ToolDeniedPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  reason: z.string().min(1),
});

export const ToolStartedPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  name: z.string().min(1),
  idempotent: z.boolean().default(false),
});

export const ToolOutputPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  channel: z.enum(['stdout', 'stderr', 'result']),
  chunk: z.string(),
});

export const ToolCompletedPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  exitCode: z.number().int().optional(),
  output: z.unknown().optional(),
  durationMs: z.number().nonnegative().optional(),
});

export const ToolFailedPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean().optional(),
  }),
});

export const ToolCancelledPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  reason: z.string().optional(),
});

export const ToolTimedOutPayloadSchema = z.object({
  toolCallId: ToolCallIdSchema,
  timeoutMs: z.number().positive(),
});

// ---------------------------------------------------------------------------
// 5. Memory Lifecycle Payloads
// ---------------------------------------------------------------------------

export const MemoryWrittenPayloadSchema = z.object({
  key: z.string().min(1),
  category: z.string().min(1),
  contentHash: z.string().optional(),
});

export const MemorySearchedPayloadSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive(),
  matchCount: z.number().int().nonnegative(),
});

export const MemoryForgottenPayloadSchema = z.object({
  key: z.string().min(1),
  reason: z.string().optional(),
});

// ---------------------------------------------------------------------------
// 5.1 Context Lifecycle Payloads
// ---------------------------------------------------------------------------

export const ContextCompactedPayloadSchema = z.object({
  previousTokens: z.number().int().nonnegative(),
  compactedTokens: z.number().int().nonnegative(),
  removedMessageCount: z.number().int().nonnegative(),
  summary: z.string().optional(),
});

// ---------------------------------------------------------------------------
// 6. System Lifecycle Payloads
// ---------------------------------------------------------------------------

export const SystemStartedPayloadSchema = z.object({
  version: z.string().min(1),
  pid: z.number().int(),
  airHome: z.string().min(1),
});

export const SystemShutdownPayloadSchema = z.object({
  reason: z.string().min(1),
  signal: z.string().optional(),
});

export const SystemRecoveredPayloadSchema = z.object({
  stream: z.string().min(1),
  truncatedBytes: z.number().int().nonnegative(),
  lastValidSeq: z.number().int().nonnegative(),
});

export const SystemQuarantinePayloadSchema = z.object({
  segmentPath: z.string().min(1),
  reason: z.string().min(1),
  quarantinePath: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Discriminated Event Envelope Schemas
// ---------------------------------------------------------------------------

function defineEnvelope<TType extends string, TSchema extends z.ZodTypeAny>(
  type: TType,
  payloadSchema: TSchema,
) {
  return z.object({
    id: EventIdSchema,
    stream: z.string().min(1),
    seq: z.number().int().positive(),
    ts: z.string().datetime({ offset: true }),
    type: z.literal(type),
    payload: payloadSchema,
    meta: EventMetaSchema.optional(),
  });
}

export const EVENT_SCHEMAS = {
  // Run
  'run.created': defineEnvelope('run.created', RunCreatedPayloadSchema),
  'run.starting': defineEnvelope('run.starting', RunStartingPayloadSchema),
  'run.running': defineEnvelope('run.running', RunRunningPayloadSchema),
  'run.paused': defineEnvelope('run.paused', RunPausedPayloadSchema),
  'run.resumed': defineEnvelope('run.resumed', RunResumedPayloadSchema),
  'run.waiting_approval': defineEnvelope('run.waiting_approval', RunWaitingApprovalPayloadSchema),
  'run.waiting_user': defineEnvelope('run.waiting_user', RunWaitingUserPayloadSchema),
  'run.completed': defineEnvelope('run.completed', RunCompletedPayloadSchema),
  'run.failed': defineEnvelope('run.failed', RunFailedPayloadSchema),
  'run.cancelled': defineEnvelope('run.cancelled', RunCancelledPayloadSchema),
  'run.budget_exceeded': defineEnvelope('run.budget_exceeded', RunBudgetExceededPayloadSchema),

  // Turn
  'turn.started': defineEnvelope('turn.started', TurnStartedPayloadSchema),
  'turn.completed': defineEnvelope('turn.completed', TurnCompletedPayloadSchema),
  'turn.failed': defineEnvelope('turn.failed', TurnFailedPayloadSchema),

  // Model
  'model.requested': defineEnvelope('model.requested', ModelRequestedPayloadSchema),
  'model.responded': defineEnvelope('model.responded', ModelRespondedPayloadSchema),
  'model.failed': defineEnvelope('model.failed', ModelFailedPayloadSchema),

  // Tool
  'tool.requested': defineEnvelope('tool.requested', ToolRequestedPayloadSchema),
  'tool.policy_decided': defineEnvelope('tool.policy_decided', ToolPolicyDecidedPayloadSchema),
  'tool.approval_requested': defineEnvelope('tool.approval_requested', ToolApprovalRequestedPayloadSchema),
  'tool.approved': defineEnvelope('tool.approved', ToolApprovedPayloadSchema),
  'tool.denied': defineEnvelope('tool.denied', ToolDeniedPayloadSchema),
  'tool.started': defineEnvelope('tool.started', ToolStartedPayloadSchema),
  'tool.output': defineEnvelope('tool.output', ToolOutputPayloadSchema),
  'tool.completed': defineEnvelope('tool.completed', ToolCompletedPayloadSchema),
  'tool.failed': defineEnvelope('tool.failed', ToolFailedPayloadSchema),
  'tool.cancelled': defineEnvelope('tool.cancelled', ToolCancelledPayloadSchema),
  'tool.timed_out': defineEnvelope('tool.timed_out', ToolTimedOutPayloadSchema),

  // Memory
  'memory.written': defineEnvelope('memory.written', MemoryWrittenPayloadSchema),
  'memory.searched': defineEnvelope('memory.searched', MemorySearchedPayloadSchema),
  'memory.forgotten': defineEnvelope('memory.forgotten', MemoryForgottenPayloadSchema),

  // Context
  'context.compacted': defineEnvelope('context.compacted', ContextCompactedPayloadSchema),

  // System
  'system.started': defineEnvelope('system.started', SystemStartedPayloadSchema),
  'system.shutdown': defineEnvelope('system.shutdown', SystemShutdownPayloadSchema),
  'system.recovered': defineEnvelope('system.recovered', SystemRecoveredPayloadSchema),
  'system.quarantine': defineEnvelope('system.quarantine', SystemQuarantinePayloadSchema),
} as const;

export type EventType = keyof typeof EVENT_SCHEMAS;

export const KNOWN_EVENT_TYPES = Object.keys(EVENT_SCHEMAS) as EventType[];

export const AirEventEnvelopeSchema = z.discriminatedUnion('type', [
  EVENT_SCHEMAS['run.created'],
  EVENT_SCHEMAS['run.starting'],
  EVENT_SCHEMAS['run.running'],
  EVENT_SCHEMAS['run.paused'],
  EVENT_SCHEMAS['run.resumed'],
  EVENT_SCHEMAS['run.waiting_approval'],
  EVENT_SCHEMAS['run.waiting_user'],
  EVENT_SCHEMAS['run.completed'],
  EVENT_SCHEMAS['run.failed'],
  EVENT_SCHEMAS['run.cancelled'],
  EVENT_SCHEMAS['run.budget_exceeded'],
  EVENT_SCHEMAS['turn.started'],
  EVENT_SCHEMAS['turn.completed'],
  EVENT_SCHEMAS['turn.failed'],
  EVENT_SCHEMAS['model.requested'],
  EVENT_SCHEMAS['model.responded'],
  EVENT_SCHEMAS['model.failed'],
  EVENT_SCHEMAS['tool.requested'],
  EVENT_SCHEMAS['tool.policy_decided'],
  EVENT_SCHEMAS['tool.approval_requested'],
  EVENT_SCHEMAS['tool.approved'],
  EVENT_SCHEMAS['tool.denied'],
  EVENT_SCHEMAS['tool.started'],
  EVENT_SCHEMAS['tool.output'],
  EVENT_SCHEMAS['tool.completed'],
  EVENT_SCHEMAS['tool.failed'],
  EVENT_SCHEMAS['tool.cancelled'],
  EVENT_SCHEMAS['tool.timed_out'],
  EVENT_SCHEMAS['memory.written'],
  EVENT_SCHEMAS['memory.searched'],
  EVENT_SCHEMAS['memory.forgotten'],
  EVENT_SCHEMAS['context.compacted'],
  EVENT_SCHEMAS['system.started'],
  EVENT_SCHEMAS['system.shutdown'],
  EVENT_SCHEMAS['system.recovered'],
  EVENT_SCHEMAS['system.quarantine'],
]);

export type AnyAirEventEnvelope = z.infer<typeof AirEventEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Validation & Parsing Helpers
// ---------------------------------------------------------------------------

export function isKnownEventType(type: string): type is EventType {
  return Object.prototype.hasOwnProperty.call(EVENT_SCHEMAS, type);
}

export function parseEventEnvelope(raw: unknown): AnyAirEventEnvelope {
  const result = AirEventEnvelopeSchema.safeParse(raw);
  if (!result.success) {
    throw new AirError('VALIDATION_FAILED', `Invalid event envelope: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`, {
      context: { issues: result.error.issues },
    });
  }
  return result.data;
}

export function safeParseEventEnvelope(raw: unknown) {
  return AirEventEnvelopeSchema.safeParse(raw);
}

// Type guard helpers
export function isRunEvent(envelope: { type: string }): boolean {
  return envelope.type.startsWith('run.');
}

export function isTurnEvent(envelope: { type: string }): boolean {
  return envelope.type.startsWith('turn.');
}

export function isModelEvent(envelope: { type: string }): boolean {
  return envelope.type.startsWith('model.');
}

export function isToolEvent(envelope: { type: string }): boolean {
  return envelope.type.startsWith('tool.');
}

export function isMemoryEvent(envelope: { type: string }): boolean {
  return envelope.type.startsWith('memory.');
}

export function isSystemEvent(envelope: { type: string }): boolean {
  return envelope.type.startsWith('system.');
}
