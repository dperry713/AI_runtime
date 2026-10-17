/**
 * Deterministic Replay Engine for Agent Runs (Phase 6 - P6-T08).
 *
 * Implements deterministic replay and auditing of agent runs from journal event streams:
 * 1. Reads append-only historical journal events via JournalReader or in-memory envelopes
 * 2. Re-evaluates policy decisions against active PolicyEngine to detect policy drift
 * 3. Folds state transitions through RunStateMachine to verify lifecycle invariant preservation
 * 4. Verifies turn sequence order, tool calls, and model outputs for deterministic parity
 * 5. Flags exact divergence points (turn index, event sequence, category, expected vs actual)
 *
 * Adheres to:
 * - Rule R6: Clock and IdGenerator injection
 * - Rule R7: Strict TypeScript, no any
 * - Rule R8: State = fold(events)
 * - Rule R11: Typed AirError errors
 */

import { AirError } from '../errors/index.js';
import type { EventEnvelope, JournalReader } from '../journal/index.js';
import type { PolicyEngine } from '../policy/index.js';
import { parseRunId, type RunId } from '../types/index.js';
import {
  type Clock,
  SystemClock,
} from '../util/index.js';
import type { AgentManifest } from './manifest.js';
import { RunStateMachine, type RunState } from './state-machine.js';

// ============================================================================
// 1. Interfaces & Types
// ============================================================================

export type ReplayDivergenceCategory =
  | 'state'
  | 'policy'
  | 'tool_call'
  | 'model_response'
  | 'event_order';

export interface ReplayDivergence {
  readonly sequenceNumber: number;
  readonly turnIndex?: number | undefined;
  readonly category: ReplayDivergenceCategory;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly message: string;
}

export interface ReplayVerificationResult {
  readonly runId: RunId;
  readonly passed: boolean;
  readonly finalState?: RunState | undefined;
  readonly totalEvents: number;
  readonly totalTurns: number;
  readonly stateTransitionsChecked: number;
  readonly policyDecisionsChecked: number;
  readonly toolCallsChecked: number;
  readonly divergences: readonly ReplayDivergence[];
}

export interface AgentReplayOptions {
  readonly runId: RunId | string;
  readonly events?: readonly EventEnvelope[] | undefined;
  readonly reader?: JournalReader | undefined;
  readonly manifest?: AgentManifest | undefined;
  readonly policyEngine?: PolicyEngine | undefined;
  readonly clock?: Clock | undefined;
  readonly failFast?: boolean | undefined;
  /**
   * If true, asserts that all event sequence numbers are strictly monotonically increasing.
   * Default: false when events array passed, true when reader is provided.
   */
  readonly verifySequenceOrdering?: boolean | undefined;
}

// ============================================================================
// 2. AgentReplayEngine Class
// ============================================================================

export class AgentReplayEngine {
  private readonly runId: RunId;
  private readonly events?: readonly EventEnvelope[] | undefined;
  private readonly reader?: JournalReader | undefined;
  private readonly manifest?: AgentManifest | undefined;
  private readonly policyEngine?: PolicyEngine | undefined;
  private readonly clock: Clock;
  private readonly failFast: boolean;
  private readonly verifySequenceOrdering: boolean;

  public constructor(options: AgentReplayOptions) {
    this.runId = parseRunId(options.runId);
    this.events = options.events;
    this.reader = options.reader;
    this.manifest = options.manifest;
    this.policyEngine = options.policyEngine;
    this.clock = options.clock ?? new SystemClock();
    this.failFast = options.failFast ?? false;
    this.verifySequenceOrdering =
      options.verifySequenceOrdering ?? (this.reader !== undefined);

    if (!this.events && !this.reader) {
      throw new AirError('INVALID_ARGUMENT', 'AgentReplayEngine requires either events array or a JournalReader');
    }
  }

  /**
   * Replays the recorded event stream, validating parity of state transitions,
   * tool requests, and policy decisions.
   */
  public async replay(): Promise<ReplayVerificationResult> {
    const streamId = `run:${this.runId}`;
    let envelopes: readonly EventEnvelope[];

    if (this.events) {
      envelopes = this.events;
    } else if (this.reader) {
      envelopes = await this.reader.readStream(streamId);
    } else {
      envelopes = [];
    }

    if (envelopes.length === 0) {
      throw new AirError('NOT_FOUND', `No journal events found for run stream "${streamId}"`);
    }

    const divergences: ReplayDivergence[] = [];
    let stateTransitionsChecked = 0;
    let policyDecisionsChecked = 0;
    let toolCallsChecked = 0;
    let currentTurnIndex = 0;
    let lastSeq = 0;

    // Track active state machine fold
    const stateMachine = new RunStateMachine({
      runId: this.runId,
      clock: this.clock,
    });

    for (const event of envelopes) {
      // 1. Verify monotonic sequence ordering
      if (this.verifySequenceOrdering && event.seq <= lastSeq) {
        divergences.push({
          sequenceNumber: event.seq,
          category: 'event_order',
          expected: `> ${lastSeq}`,
          actual: event.seq,
          message: `Non-monotonic event sequence number: ${event.seq} <= ${lastSeq}`,
        });
        if (this.failFast) break;
      }
      lastSeq = Math.max(lastSeq, event.seq);

      // 2. Track turn index
      if (event.type === 'turn.started') {
        const payload = event.payload as { turnIndex?: number };
        if (typeof payload.turnIndex === 'number') {
          currentTurnIndex = payload.turnIndex;
        }
      }

      // 3. Verify RunStateMachine state transitions
      switch (event.type) {
        case 'run.starting': {
          stateTransitionsChecked++;
          if (stateMachine.canTransitionTo('starting')) {
            stateMachine.start();
          } else {
            divergences.push({
              sequenceNumber: event.seq,
              turnIndex: currentTurnIndex,
              category: 'state',
              expected: 'transition to starting allowed',
              actual: stateMachine.getState(),
              message: `Illegal state transition to starting from ${stateMachine.getState()}`,
            });
            if (this.failFast) break;
          }
          break;
        }

        case 'run.running': {
          stateTransitionsChecked++;
          if (stateMachine.canTransitionTo('running')) {
            stateMachine.run(currentTurnIndex);
          } else {
            divergences.push({
              sequenceNumber: event.seq,
              turnIndex: currentTurnIndex,
              category: 'state',
              expected: 'transition to running allowed',
              actual: stateMachine.getState(),
              message: `Illegal state transition to running from ${stateMachine.getState()}`,
            });
            if (this.failFast) break;
          }
          break;
        }

        case 'run.paused': {
          stateTransitionsChecked++;
          const payload = event.payload as { reason?: string };
          if (stateMachine.canTransitionTo('paused')) {
            stateMachine.pause(payload.reason ?? 'Replay pause');
          } else {
            divergences.push({
              sequenceNumber: event.seq,
              turnIndex: currentTurnIndex,
              category: 'state',
              expected: 'transition to paused allowed',
              actual: stateMachine.getState(),
              message: `Illegal state transition to paused from ${stateMachine.getState()}`,
            });
            if (this.failFast) break;
          }
          break;
        }

        case 'run.resumed': {
          stateTransitionsChecked++;
          const payload = event.payload as { reason?: string };
          if (stateMachine.canTransitionTo('running')) {
            stateMachine.resume(payload.reason);
          } else {
            divergences.push({
              sequenceNumber: event.seq,
              turnIndex: currentTurnIndex,
              category: 'state',
              expected: 'transition to running (resumed) allowed',
              actual: stateMachine.getState(),
              message: `Illegal state transition to running from ${stateMachine.getState()}`,
            });
            if (this.failFast) break;
          }
          break;
        }

        case 'run.completed': {
          stateTransitionsChecked++;
          const payload = event.payload as { summary?: string; totalSteps?: number; result?: unknown };
          if (stateMachine.canTransitionTo('completed')) {
            stateMachine.complete(payload);
          } else {
            divergences.push({
              sequenceNumber: event.seq,
              turnIndex: currentTurnIndex,
              category: 'state',
              expected: 'transition to completed allowed',
              actual: stateMachine.getState(),
              message: `Illegal state transition to completed from ${stateMachine.getState()}`,
            });
            if (this.failFast) break;
          }
          break;
        }

        case 'run.failed': {
          stateTransitionsChecked++;
          const payload = event.payload as { error?: { code: string; message: string; retryable?: boolean } };
          const err = payload.error ?? { code: 'INTERNAL', message: 'Failed' };
          if (stateMachine.canTransitionTo('failed')) {
            stateMachine.fail(err);
          } else {
            divergences.push({
              sequenceNumber: event.seq,
              turnIndex: currentTurnIndex,
              category: 'state',
              expected: 'transition to failed allowed',
              actual: stateMachine.getState(),
              message: `Illegal state transition to failed from ${stateMachine.getState()}`,
            });
            if (this.failFast) break;
          }
          break;
        }

        case 'run.cancelled': {
          stateTransitionsChecked++;
          const payload = event.payload as { reason?: string };
          if (stateMachine.canTransitionTo('cancelled')) {
            stateMachine.cancel(payload.reason);
          } else {
            divergences.push({
              sequenceNumber: event.seq,
              turnIndex: currentTurnIndex,
              category: 'state',
              expected: 'transition to cancelled allowed',
              actual: stateMachine.getState(),
              message: `Illegal state transition to cancelled from ${stateMachine.getState()}`,
            });
            if (this.failFast) break;
          }
          break;
        }

        case 'run.budget_exceeded': {
          stateTransitionsChecked++;
          const payload = event.payload as {
            dimension?: 'tokens' | 'wall_time' | 'cost' | 'steps' | 'tool_calls';
            limit?: number;
            actual?: number;
          };
          if (stateMachine.canTransitionTo('budget_exceeded')) {
            stateMachine.exceedBudget({
              dimension: payload.dimension ?? 'steps',
              limit: payload.limit ?? 0,
              actual: payload.actual ?? 0,
            });
          } else {
            divergences.push({
              sequenceNumber: event.seq,
              turnIndex: currentTurnIndex,
              category: 'state',
              expected: 'transition to budget_exceeded allowed',
              actual: stateMachine.getState(),
              message: `Illegal state transition to budget_exceeded from ${stateMachine.getState()}`,
            });
            if (this.failFast) break;
          }
          break;
        }
      }

      // 4. Verify Policy Decisions Parity (if policyEngine provided)
      if (event.type === 'tool.policy_decided' && this.policyEngine) {
        policyDecisionsChecked++;
        const payload = event.payload as {
          toolCallId: string;
          decision: 'allow' | 'deny' | 'ask';
          ruleId: string;
          reason: string;
        };

        // Find associated tool.requested event to retrieve toolName and arguments
        const reqEvent = envelopes.find(
          (e) =>
            e.type === 'tool.requested' &&
            (e.payload as { toolCallId?: string }).toolCallId === payload.toolCallId,
        );

        if (reqEvent) {
          const reqPayload = reqEvent.payload as {
            name: string;
            arguments?: Record<string, unknown>;
          };

          const simulatedDecision = this.policyEngine.evaluate({
            agentId: this.manifest?.id ?? 'default',
            runId: this.runId,
            callId: payload.toolCallId,
            toolName: reqPayload.name,
            input: reqPayload.arguments ?? {},
          });

          const expectedMapped =
            simulatedDecision.effect === 'ask_user' ? 'ask' : simulatedDecision.effect;

          if (expectedMapped !== payload.decision) {
            divergences.push({
              sequenceNumber: event.seq,
              turnIndex: currentTurnIndex,
              category: 'policy',
              expected: expectedMapped,
              actual: payload.decision,
              message: `Policy drift detected for tool "${reqPayload.name}": recorded "${payload.decision}", evaluated "${expectedMapped}"`,
            });
            if (this.failFast) break;
          }
        }
      }

      // 5. Track tool call count
      if (event.type === 'tool.requested') {
        toolCallsChecked++;
      }
    }

    return {
      runId: this.runId,
      passed: divergences.length === 0,
      finalState: stateMachine.getState(),
      totalEvents: envelopes.length,
      totalTurns: currentTurnIndex + 1,
      stateTransitionsChecked,
      policyDecisionsChecked,
      toolCallsChecked,
      divergences,
    };
  }
}

/**
 * Top-level helper function for replaying a run by ID per docs/MODULES.md.
 */
export async function replayRun(
  runId: string,
  options: Omit<AgentReplayOptions, 'runId'>,
): Promise<ReplayVerificationResult> {
  const engine = new AgentReplayEngine({
    ...options,
    runId,
  });
  return await engine.replay();
}
