import { ulid } from 'ulid';

export type Brand<K extends string> = { readonly __brand: K };

export type Branded<T, K extends string> = T & Brand<K>;

export type RunId = Branded<string, 'RunId'>;
export type AgentId = Branded<string, 'AgentId'>;
export type SessionId = Branded<string, 'SessionId'>;
export type TurnId = Branded<string, 'TurnId'>;
export type ToolCallId = Branded<string, 'ToolCallId'>;
export type EventId = Branded<string, 'EventId'>;

function createId<K extends string>(): Branded<string, K> {
  return ulid() as Branded<string, K>;
}

export function createRunId(): RunId {
  return createId<'RunId'>();
}

export function createAgentId(): AgentId {
  return createId<'AgentId'>();
}

export function createSessionId(): SessionId {
  return createId<'SessionId'>();
}

export function createTurnId(): TurnId {
  return createId<'TurnId'>();
}

export function createToolCallId(): ToolCallId {
  return createId<'ToolCallId'>();
}

export function createEventId(): EventId {
  return createId<'EventId'>();
}

export function parseRunId(value: string): RunId {
  return value as RunId;
}

export function parseAgentId(value: string): AgentId {
  return value as AgentId;
}

export function parseSessionId(value: string): SessionId {
  return value as SessionId;
}

export function parseTurnId(value: string): TurnId {
  return value as TurnId;
}

export function parseToolCallId(value: string): ToolCallId {
  return value as ToolCallId;
}

export function parseEventId(value: string): EventId {
  return value as EventId;
}

export const ID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isValidId(value: string): boolean {
  return ID_REGEX.test(value);
}

export function assertValidId(value: string, typeName: string): void {
  if (!isValidId(value)) {
    throw new Error(`Invalid ${typeName}: ${value}`);
  }
}