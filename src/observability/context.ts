import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  AgentId,
  EventId,
  RunId,
  SessionId,
  ToolCallId,
  TurnId,
} from '../types/index.js';

export interface LogContext {
  sessionId?: SessionId | undefined;
  runId?: RunId | undefined;
  agentId?: AgentId | undefined;
  turnId?: TurnId | undefined;
  toolCallId?: ToolCallId | undefined;
  eventId?: EventId | undefined;
  traceId?: string | undefined;
  spanId?: string | undefined;
  [key: string]: unknown;
}

const asyncLocalStorage = new AsyncLocalStorage<LogContext>();

/**
 * Executes a function within the provided correlation context.
 * Existing context keys are preserved and merged with the new context.
 */
export function withContext<T>(ctx: LogContext, fn: () => T): T {
  const parent = asyncLocalStorage.getStore();
  const merged: LogContext = { ...parent, ...ctx };
  return asyncLocalStorage.run(merged, fn);
}

/**
 * Returns the currently active correlation context, if any.
 */
export function currentContext(): LogContext | undefined {
  return asyncLocalStorage.getStore();
}
