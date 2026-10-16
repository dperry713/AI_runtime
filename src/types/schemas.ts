import { z } from 'zod';
import type { RunId, AgentId, SessionId, TurnId, ToolCallId, EventId } from './ids.js';
import { isValidId } from './ids.js';

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'Invalid ULID format');

export const RunIdSchema = ulidSchema;
export const AgentIdSchema = ulidSchema;
export const SessionIdSchema = ulidSchema;
export const TurnIdSchema = ulidSchema;
export const ToolCallIdSchema = ulidSchema;
export const EventIdSchema = ulidSchema;

export const ID_SCHEMAS = {
  RunId: RunIdSchema,
  AgentId: AgentIdSchema,
  SessionId: SessionIdSchema,
  TurnId: TurnIdSchema,
  ToolCallId: ToolCallIdSchema,
  EventId: EventIdSchema,
} as const;

export type IdSchemaMap = typeof ID_SCHEMAS;

export function safeParseRunId(value: unknown) {
  return RunIdSchema.safeParse(value);
}

export function safeParseAgentId(value: unknown) {
  return AgentIdSchema.safeParse(value);
}

export function safeParseSessionId(value: unknown) {
  return SessionIdSchema.safeParse(value);
}

export function safeParseTurnId(value: unknown) {
  return TurnIdSchema.safeParse(value);
}

export function safeParseToolCallId(value: unknown) {
  return ToolCallIdSchema.safeParse(value);
}

export function safeParseEventId(value: unknown) {
  return EventIdSchema.safeParse(value);
}

export function isValidIdString(value: string): boolean {
  return isValidId(value);
}

export function assertValidRunId(value: string): RunId {
  return RunIdSchema.parse(value) as RunId;
}

export function assertValidAgentId(value: string): AgentId {
  return AgentIdSchema.parse(value) as AgentId;
}

export function assertValidSessionId(value: string): SessionId {
  return SessionIdSchema.parse(value) as SessionId;
}

export function assertValidTurnId(value: string): TurnId {
  return TurnIdSchema.parse(value) as TurnId;
}

export function assertValidToolCallId(value: string): ToolCallId {
  return ToolCallIdSchema.parse(value) as ToolCallId;
}

export function assertValidEventId(value: string): EventId {
  return EventIdSchema.parse(value) as EventId;
}