/**
 * Hook System Types & Contracts (Phase 10 - P10-T03).
 *
 * Defines the lifecycle hooks for tool executions, model calls, journal events,
 * and session/run boundaries.
 *
 * Non-negotiable invariants:
 * - Hooks cannot weaken policy: if policy denies, a hook can never overturn it.
 * - Hooks are sandboxed and timeout-bounded (default 5000ms).
 * - Hook failures respect configurable failureMode: 'fail-closed' (default) throws AirError,
 *   'fail-open' logs warnings and continues.
 */

import { z } from 'zod';
import type { AirError } from '../errors/index.js';
import type { EventEnvelope } from '../journal/index.js';
import type { ToolCapability } from '../tools/index.js';
import type { ToolCallId } from '../types/index.js';

export type HookKind =
  | 'pre-tool'
  | 'post-tool'
  | 'on-event'
  | 'pre-model'
  | 'post-model'
  | 'session-start'
  | 'session-end'
  | 'run-start'
  | 'run-end';

export type HookFailureMode = 'fail-closed' | 'fail-open';

export interface HookFilter {
  readonly tools?: readonly string[] | undefined;
  readonly eventTypes?: readonly string[] | undefined;
  readonly agents?: readonly string[] | undefined;
}

export const HookFilterSchema = z
  .object({
    tools: z.array(z.string()).optional(),
    eventTypes: z.array(z.string()).optional(),
    agents: z.array(z.string()).optional(),
  })
  .strict();

export interface PreToolHookContext {
  readonly callId: ToolCallId;
  readonly runId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly capabilities: readonly ToolCapability[];
  readonly agentId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly timestamp: string;
}

export interface PostToolHookContext {
  readonly callId: ToolCallId;
  readonly runId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly error?: AirError | undefined;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly agentId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly timestamp: string;
}

export interface OnEventHookContext {
  readonly event: EventEnvelope;
  readonly agentId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly runId?: string | undefined;
  readonly timestamp: string;
}

export interface PreModelHookContext {
  readonly runId: string;
  readonly turnId: string;
  readonly model: string;
  readonly messages: readonly unknown[];
  readonly agentId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly timestamp: string;
}

export interface PostModelHookContext {
  readonly runId: string;
  readonly turnId: string;
  readonly model: string;
  readonly response?: unknown;
  readonly error?: AirError | undefined;
  readonly durationMs: number;
  readonly agentId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly timestamp: string;
}

export interface SessionHookContext {
  readonly sessionId: string;
  readonly agentId: string;
  readonly timestamp: string;
}

export interface RunHookContext {
  readonly runId: string;
  readonly sessionId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly timestamp: string;
}

export type HookContext =
  | PreToolHookContext
  | PostToolHookContext
  | OnEventHookContext
  | PreModelHookContext
  | PostModelHookContext
  | SessionHookContext
  | RunHookContext;

export interface HookDecision {
  /** Whether the hook permits the action to continue (default true). */
  readonly allowed?: boolean | undefined;
  /** Veto or approval reason if specified by the hook. */
  readonly reason?: string | undefined;
  /** Optionally modified input for pre-tool or pre-model hooks. */
  readonly modifiedInput?: unknown;
  /** Custom annotations or metadata attached by the hook. */
  readonly metadata?: Record<string, unknown> | undefined;
}

export type HookHandler<TContext extends HookContext = HookContext> = (
  context: TContext,
  signal: AbortSignal,
) => Promise<HookDecision | void> | HookDecision | void;

export interface HookDefinition<TContext extends HookContext = HookContext> {
  readonly id: string;
  readonly name: string;
  readonly kind: HookKind;
  readonly description?: string | undefined;
  /** Priority determines execution order (higher number executes first). Default 100. */
  readonly priority?: number | undefined;
  /** Maximum execution time before aborting in ms. Default 5000. */
  readonly timeoutMs?: number | undefined;
  /** Failure behavior: fail-closed (throws) or fail-open (logs and continues). Default fail-closed. */
  readonly failureMode?: HookFailureMode | undefined;
  /** Filtering criteria. */
  readonly filter?: HookFilter | undefined;
  /** The execution function. */
  readonly handler: HookHandler<TContext>;
}

export interface HookExecutionRecord {
  readonly hookId: string;
  readonly kind: HookKind;
  readonly status: 'success' | 'failed' | 'timed_out' | 'vetoed';
  readonly durationMs: number;
  readonly error?: string | undefined;
  readonly reason?: string | undefined;
}
