/**
 * Run State Machine (Phase 6 - P6-T02).
 *
 * Implements the lifecycle state machine for AIR agent runs:
 * - Strictly guarded state transitions (created -> starting -> running ⇄ paused / waiting)
 * - Terminal states: completed, failed, cancelled, budget_exceeded
 * - Illegal transition guards throwing AirError('RUN_ILLEGAL_TRANSITION')
 * - Event sourcing fold: reconstructs run state from journal events (Rule R8)
 * - Journal event emission via EventBus on every state transition
 * - Deterministic replay with injected Clock and IdGenerator (Rule R6)
 *
 * Adheres to:
 * - Rule R6: Clock/IdGenerator injection
 * - Rule R7: Strict TypeScript, no any
 * - Rule R8: State = fold(events)
 * - Rule R11: Typed AirError errors
 */

import { z } from 'zod';
import { AirError } from '../errors/index.js';
import {
  createEnvelope,
  type EventBus,
  type EventEnvelope,
} from '../journal/index.js';
import {
  parseRunId,
  type RunId,
  type ToolCallId,
} from '../types/index.js';
import {
  type Clock,
  type IdGenerator,
  SystemClock,
  UlidIdGenerator,
} from '../util/index.js';

// ============================================================================
// 1. States & Schemas
// ============================================================================

export const RunStateSchema = z.enum([
  'created',
  'starting',
  'running',
  'paused',
  'waiting_approval',
  'waiting_user',
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
]);

/**
 * Checks whether a given state is terminal.
 */
export function isTerminalState(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Formal State Transition Matrix (docs/ARCHITECTURE.md §5.1).
 */
export const VALID_TRANSITIONS: ReadonlyMap<RunState, ReadonlySet<RunState>> = new Map([
  ['created', new Set(['starting', 'failed', 'cancelled'])],
  ['starting', new Set(['running', 'failed', 'cancelled'])],
  ['running', new Set([
    'paused',
    'waiting_approval',
    'waiting_user',
    'completed',
    'failed',
    'cancelled',
    'budget_exceeded',
  ])],
  ['paused', new Set(['running', 'cancelled', 'failed'])],
  ['waiting_approval', new Set([
    'running',
    'paused',
    'cancelled',
    'failed',
    'budget_exceeded',
  ])],
  ['waiting_user', new Set([
    'running',
    'paused',
    'cancelled',
    'failed',
    'budget_exceeded',
  ])],
  ['completed', new Set()],
  ['failed', new Set()],
  ['cancelled', new Set()],
  ['budget_exceeded', new Set()],
]);

export interface StateTransitionRecord {
  readonly from: RunState;
  readonly to: RunState;
  readonly timestamp: string;
  readonly reason?: string | undefined;
  readonly payload?: unknown;
}

export interface RunStateMachineOptions {
  readonly runId: RunId | string;
  readonly initialState?: RunState | undefined;
  readonly clock?: Clock | undefined;
  readonly idGenerator?: IdGenerator | undefined;
  readonly eventBus?: EventBus | undefined;
  readonly streamSeq?: number | undefined;
}

// ============================================================================
// 2. RunStateMachine Class
// ============================================================================

export class RunStateMachine {
  private readonly runId: RunId;
  private state: RunState;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private eventBus?: EventBus | undefined;
  private seq: number;
  private readonly transitionHistory: StateTransitionRecord[] = [];

  public constructor(options: RunStateMachineOptions) {
    this.runId = parseRunId(options.runId);
    this.state = options.initialState ?? 'created';
    this.clock = options.clock ?? new SystemClock();
    this.idGenerator = options.idGenerator ?? new UlidIdGenerator(this.clock);
    this.eventBus = options.eventBus;
    this.seq = options.streamSeq ?? 1;

    // Record initial state entry
    this.transitionHistory.push({
      from: this.state,
      to: this.state,
      timestamp: this.clock.now().toISOString(),
      reason: 'Initial state',
    });
  }

  /**
   * Retrieves the current run state.
   */
  public getState(): RunState {
    return this.state;
  }

  /**
   * Retrieves the run ID.
   */
  public getRunId(): RunId {
    return this.runId;
  }

  /**
   * Returns true if the run is in a terminal state.
   */
  public isTerminal(): boolean {
    return isTerminalState(this.state);
  }

  /**
   * Retrieves chronological audit history of all state transitions.
   */
  public getHistory(): readonly StateTransitionRecord[] {
    return [...this.transitionHistory];
  }

  /**
   * Updates or attaches the event bus for publishing future lifecycle events.
   */
  public setEventBus(bus?: EventBus): void {
    this.eventBus = bus;
  }

  /**
   * Tests whether a transition from current state to target state is legally permissible.
   */
  public canTransitionTo(target: RunState): boolean {
    const allowed = VALID_TRANSITIONS.get(this.state);
    return allowed !== undefined && allowed.has(target);
  }

  // ==========================================================================
  // State Transition Actions
  // ==========================================================================

  /**
   * created -> starting
   */
  public start(): StateTransitionRecord {
    return this.executeTransition('starting', {
      eventType: 'run.starting',
      payload: { timestamp: this.clock.now().toISOString() },
    });
  }

  /**
   * starting / paused / waiting -> running
   */
  public run(turnIndex = 0): StateTransitionRecord {
    return this.executeTransition('running', {
      eventType: 'run.running',
      payload: { turnIndex },
    });
  }

  /**
   * running / waiting -> paused
   */
  public pause(reason: string): StateTransitionRecord {
    if (!reason || reason.trim().length === 0) {
      throw new AirError('INVALID_ARGUMENT', 'Pause requires a non-empty reason');
    }
    return this.executeTransition('paused', {
      reason,
      eventType: 'run.paused',
      payload: { reason },
    });
  }

  /**
   * paused -> running
   */
  public resume(reason?: string): StateTransitionRecord {
    return this.executeTransition('running', {
      reason,
      eventType: 'run.resumed',
      payload: { reason },
    });
  }

  /**
   * running -> waiting_approval
   */
  public waitApproval(details: {
    toolCallId: ToolCallId | string;
    toolName: string;
    riskLevel: string;
    reason: string;
  }): StateTransitionRecord {
    return this.executeTransition('waiting_approval', {
      reason: details.reason,
      eventType: 'run.waiting_approval',
      payload: details,
    });
  }

  /**
   * running -> waiting_user
   */
  public waitUser(prompt: string): StateTransitionRecord {
    if (!prompt || prompt.trim().length === 0) {
      throw new AirError('INVALID_ARGUMENT', 'waitUser requires a non-empty prompt');
    }
    return this.executeTransition('waiting_user', {
      reason: prompt,
      eventType: 'run.waiting_user',
      payload: { prompt },
    });
  }

  /**
   * running -> completed (terminal)
   */
  public complete(details?: {
    result?: unknown;
    summary?: string;
    totalSteps?: number;
  }): StateTransitionRecord {
    return this.executeTransition('completed', {
      reason: details?.summary ?? 'Run completed successfully',
      eventType: 'run.completed',
      payload: {
        result: details?.result,
        summary: details?.summary,
        totalSteps: details?.totalSteps,
      },
    });
  }

  /**
   * any active -> failed (terminal)
   */
  public fail(error: {
    code: string;
    message: string;
    retryable?: boolean;
  }): StateTransitionRecord {
    return this.executeTransition('failed', {
      reason: error.message,
      eventType: 'run.failed',
      payload: {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable ?? false,
        },
      },
    });
  }

  /**
   * any active -> cancelled (terminal)
   */
  public cancel(reason = 'Run cancelled by operator'): StateTransitionRecord {
    return this.executeTransition('cancelled', {
      reason,
      eventType: 'run.cancelled',
      payload: { reason },
    });
  }

  /**
   * running / waiting -> budget_exceeded (terminal)
   */
  public exceedBudget(details: {
    dimension: 'tokens' | 'wall_time' | 'cost' | 'steps' | 'tool_calls';
    limit: number;
    actual: number;
  }): StateTransitionRecord {
    return this.executeTransition('budget_exceeded', {
      reason: `Budget exceeded on ${details.dimension}: ${details.actual} > ${details.limit}`,
      eventType: 'run.budget_exceeded',
      payload: details,
    });
  }

  // ==========================================================================
  // Internal Transition Engine
  // ==========================================================================

  private executeTransition(
    targetState: RunState,
    meta?: {
      reason?: string | undefined;
      eventType?: string | undefined;
      payload?: unknown;
    },
  ): StateTransitionRecord {
    const fromState = this.state;

    if (!this.canTransitionTo(targetState)) {
      throw new AirError(
        'RUN_ILLEGAL_TRANSITION',
        `Illegal run state transition: cannot transition run "${this.runId}" from "${fromState}" to "${targetState}"`,
        {
          context: {
            runId: this.runId,
            from: fromState,
            to: targetState,
            historyLength: this.transitionHistory.length,
          },
        },
      );
    }

    const timestamp = this.clock.now().toISOString();
    this.state = targetState;

    const record: StateTransitionRecord = {
      from: fromState,
      to: targetState,
      timestamp,
      reason: meta?.reason,
      payload: meta?.payload,
    };

    this.transitionHistory.push(record);

    // Rule R8: Emit corresponding journal event via EventBus if configured
    if (this.eventBus && meta?.eventType) {
      try {
        const payloadObj = (typeof meta.payload === 'object' && meta.payload !== null)
          ? (meta.payload as Record<string, unknown>)
          : {};

        this.eventBus.publish(
          createEnvelope({
            stream: `run:${this.runId}`,
            seq: this.seq++,
            type: meta.eventType,
            payload: payloadObj,
            meta: {
              runId: this.runId,
            },
            clock: this.clock,
            idGenerator: this.idGenerator,
          }),
        );
      } catch {
        // Event bus publishing errors should not prevent state transition
      }
    }

    return record;
  }

  // ==========================================================================
  // Event-Sourcing Reconstruction (State = fold(events))
  // ==========================================================================

  /**
   * Reconstitutes a RunStateMachine by folding over historical journal events.
   */
  public static fromEvents(
    events: readonly EventEnvelope[],
    options?: {
      clock?: Clock | undefined;
      idGenerator?: IdGenerator | undefined;
      eventBus?: EventBus | undefined;
    },
  ): RunStateMachine {
    if (events.length === 0) {
      throw new AirError('INVALID_ARGUMENT', 'Cannot rebuild RunStateMachine from empty event stream');
    }

    const firstEvent = events[0];
    if (!firstEvent) {
      throw new AirError('INVALID_ARGUMENT', 'Missing initial event in stream');
    }

    const runId = firstEvent.meta?.runId ?? (firstEvent.payload as { runId?: string }).runId ?? 'run-reconstituted';
    const machine = new RunStateMachine({
      runId,
      initialState: 'created',
      clock: options?.clock,
      idGenerator: options?.idGenerator,
      streamSeq: events.length + 1,
    });

    for (const ev of events) {
      const type = ev.type;
      switch (type) {
        case 'run.created':
          // Machine begins at created
          break;
        case 'run.starting':
          machine.start();
          break;
        case 'run.running':
        case 'run.started': {
          const payload = ev.payload as { turnIndex?: number };
          machine.run(payload?.turnIndex ?? 0);
          break;
        }
        case 'run.paused': {
          const payload = ev.payload as { reason?: string };
          machine.pause(payload?.reason ?? 'Paused in journal');
          break;
        }
        case 'run.resumed': {
          const payload = ev.payload as { reason?: string };
          machine.resume(payload?.reason);
          break;
        }
        case 'run.waiting_approval': {
          const payload = ev.payload as {
            toolCallId: ToolCallId | string;
            toolName: string;
            riskLevel: string;
            reason: string;
          };
          machine.waitApproval(payload);
          break;
        }
        case 'run.waiting_user': {
          const payload = ev.payload as { prompt?: string };
          machine.waitUser(payload?.prompt ?? 'Input requested');
          break;
        }
        case 'run.completed': {
          const payload = ev.payload as {
            result?: unknown;
            summary?: string;
            totalSteps?: number;
          };
          machine.complete(payload);
          break;
        }
        case 'run.failed': {
          const payload = ev.payload as {
            error?: { code?: string; message?: string; retryable?: boolean };
          };
          machine.fail({
            code: payload?.error?.code ?? 'INTERNAL',
            message: payload?.error?.message ?? 'Run failed in journal',
            retryable: payload?.error?.retryable ?? false,
          });
          break;
        }
        case 'run.cancelled': {
          const payload = ev.payload as { reason?: string };
          machine.cancel(payload?.reason ?? 'Cancelled in journal');
          break;
        }
        case 'run.budget_exceeded': {
          const payload = ev.payload as {
            dimension: 'tokens' | 'wall_time' | 'cost' | 'steps' | 'tool_calls';
            limit: number;
            actual: number;
          };
          machine.exceedBudget(payload);
          break;
        }
        default:
          // Ignore non-run lifecycle events (turns, tools, models, memories)
          break;
      }
    }

    machine.setEventBus(options?.eventBus);
    return machine;
  }
}
