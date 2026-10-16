/**
 * Event envelope schemas and constructor factory for the AIR Journal (P2-T01).
 * Adheres to Rule R6 (Injected determinism: Clock and IdGenerator) and Rule R8 (Event sourcing).
 */

import { z } from 'zod';
import { AirError } from '../errors/index.js';
import {
  AgentIdSchema,
  type EventId,
  EventIdSchema,
  RunIdSchema,
  SessionIdSchema,
  ToolCallIdSchema,
  TurnIdSchema,
} from '../types/index.js';
import {
  type Clock,
  type IdGenerator,
  SystemClock,
  UlidIdGenerator,
} from '../util/index.js';

export const EventMetaSchema = z.object({
  sessionId: SessionIdSchema.optional(),
  runId: RunIdSchema.optional(),
  agentId: AgentIdSchema.optional(),
  turnId: TurnIdSchema.optional(),
  toolCallId: ToolCallIdSchema.optional(),
  traceId: z.string().min(1).optional(),
  spanId: z.string().min(1).optional(),
  causationId: EventIdSchema.optional(),
  correlationId: z.string().min(1).optional(),
});

export type EventMeta = z.infer<typeof EventMetaSchema>;

/**
 * Creates a validated Zod envelope schema for a specific payload type.
 */
export function createEventEnvelopeSchema<T extends z.ZodTypeAny>(payloadSchema: T) {
  return z.object({
    id: EventIdSchema,
    stream: z.string().min(1),
    seq: z.number().int().positive(),
    ts: z.string().datetime({ offset: true }),
    type: z.string().min(1),
    payload: payloadSchema,
    meta: EventMetaSchema.optional(),
  });
}

export const GenericEventEnvelopeSchema = createEventEnvelopeSchema(z.unknown());

export interface EventEnvelope<T = unknown> {
  readonly id: EventId;
  readonly stream: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly payload: T;
  readonly meta?: EventMeta | undefined;
}

export interface CreateEnvelopeOptions<T> {
  stream: string;
  seq: number;
  type: string;
  payload: T;
  meta?: EventMeta | undefined;
  clock?: Clock | undefined;
  idGenerator?: IdGenerator | undefined;
}

/**
 * Constructs an immutable, validated EventEnvelope with injected determinism.
 */
export function createEnvelope<T>(options: CreateEnvelopeOptions<T>): EventEnvelope<T> {
  if (!options.stream || options.stream.trim().length === 0) {
    throw new AirError('INVALID_ARGUMENT', 'Event stream identifier cannot be empty');
  }
  if (!Number.isInteger(options.seq) || options.seq <= 0) {
    throw new AirError('INVALID_ARGUMENT', `Event sequence number must be a positive integer, got: ${options.seq}`);
  }
  if (!options.type || options.type.trim().length === 0) {
    throw new AirError('INVALID_ARGUMENT', 'Event type cannot be empty');
  }

  const clock = options.clock ?? new SystemClock();
  const idGenerator = options.idGenerator ?? new UlidIdGenerator(clock);

  const id = idGenerator.nextEventId();
  const ts = clock.iso();

  const envelope: EventEnvelope<T> = {
    id,
    stream: options.stream,
    seq: options.seq,
    ts,
    type: options.type,
    payload: options.payload,
  };

  if (options.meta && Object.keys(options.meta).length > 0) {
    (envelope as { meta?: EventMeta }).meta = options.meta;
  }

  return Object.freeze(envelope);
}
