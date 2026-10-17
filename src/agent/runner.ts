/**
 * Agent Runner (Phase 6 - P6-T06).
 *
 * Coordinates multi-turn agent execution loops:
 * 1. Lifecycle orchestration with RunStateMachine (P6-T02)
 * 2. Turn execution loop via TurnEngine (P6-T03)
 * 3. Cooperative cancellation via AbortSignal propagation
 * 4. Safe pause points at turn boundaries without state corruption
 * 5. Clean resumption from paused / waiting_user states
 * 6. Resumption from journal event streams (Rule R8: State = fold(events))
 * 7. Comprehensive event emission (run.created, run.starting, run.running, run.completed, etc.)
 *
 * Adheres to:
 * - Rule R6: Clock and IdGenerator injection
 * - Rule R7: Strict TypeScript, no any
 * - Rule R8: Journal event sourcing
 * - Rule R11: Typed AirError errors
 */

import { AirError } from '../errors/index.js';
import {
  createEnvelope,
  type EventBus,
  type EventEnvelope,
} from '../journal/index.js';
import type { ComponentLogger } from '../observability/index.js';
import type {
  ApprovalBroker,
  BudgetTracker,
  PolicyEngine,
  TaintTracker,
} from '../policy/index.js';
import type { Provider } from '../providers/index.js';
import type { ToolRegistry } from '../tools/index.js';
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
import type { ContextManager } from './context.js';
import type { StallDetector } from './detector.js';
import type { AgentManifest } from './manifest.js';
import {
  RunStateMachine,
  type RunState,
} from './state-machine.js';
import {
  TurnEngine,
  type TurnExecutionResult,
} from './turn-engine.js';

// ============================================================================
// 1. Interfaces & Types
// ============================================================================

export type RunOutcomeStatus =
  | 'completed'
  | 'paused'
  | 'cancelled'
  | 'waiting_approval'
  | 'waiting_user'
  | 'budget_exceeded'
  | 'stalled'
  | 'failed';

export interface RunOutcome {
  readonly runId: RunId;
  readonly status: RunOutcomeStatus;
  readonly totalTurns: number;
  readonly text?: string | undefined;
  readonly reason?: string | undefined;
  readonly error?: AirError | undefined;
  readonly lastTurnResult?: TurnExecutionResult | undefined;
}

export interface AgentRunnerOptions {
  readonly manifest: AgentManifest;
  readonly runId: RunId | string;
  readonly provider: Provider;
  readonly toolRegistry: ToolRegistry;
  readonly policyEngine: PolicyEngine;
  readonly approvalBroker?: ApprovalBroker | undefined;
  readonly budgetTracker?: BudgetTracker | undefined;
  readonly taintTracker?: TaintTracker | undefined;
  readonly stallDetector?: StallDetector | undefined;
  readonly contextManager?: ContextManager | undefined;
  readonly stateMachine?: RunStateMachine | undefined;
  readonly eventBus?: EventBus | undefined;
  readonly logger?: ComponentLogger | undefined;
  readonly clock?: Clock | undefined;
  readonly idGenerator?: IdGenerator | undefined;
  readonly maxTurns?: number | undefined;
  readonly headless?: boolean | undefined;
  readonly workspaceRoot?: string | undefined;
}

export interface RunExecutionOptions {
  readonly signal?: AbortSignal | undefined;
  readonly initialGoal?: string | undefined;
}

export interface ResumeExecutionOptions {
  readonly signal?: AbortSignal | undefined;
  readonly userMessage?: string | undefined;
  readonly reason?: string | undefined;
}

// ============================================================================
// 2. AgentRunner Class
// ============================================================================

export class AgentRunner {
  private readonly manifest: AgentManifest;
  private readonly runId: RunId;
  private readonly turnEngine: TurnEngine;
  private readonly stateMachine: RunStateMachine;
  private readonly contextManager: ContextManager;
  private readonly budgetTracker: BudgetTracker;
  private readonly eventBus?: EventBus | undefined;
  private readonly logger?: ComponentLogger | undefined;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly maxTurns: number;

  private currentTurnIndex = 0;
  private abortController: AbortController = new AbortController();
  private pauseRequested = false;
  private pauseReason: string | undefined;
  private isExecuting = false;
  private seq = 1;

  public constructor(options: AgentRunnerOptions) {
    this.manifest = options.manifest;
    this.runId = parseRunId(options.runId);
    this.clock = options.clock ?? new SystemClock();
    this.idGenerator = options.idGenerator ?? new UlidIdGenerator(this.clock);
    this.eventBus = options.eventBus;
    this.logger = options.logger;

    this.maxTurns =
      options.maxTurns ??
      this.manifest.budgets?.maxSteps ??
      50;

    this.stateMachine =
      options.stateMachine ??
      new RunStateMachine({
        runId: this.runId,
        clock: this.clock,
        idGenerator: this.idGenerator,
        eventBus: this.eventBus,
      });

    this.turnEngine = new TurnEngine({
      manifest: this.manifest,
      runId: this.runId,
      provider: options.provider,
      toolRegistry: options.toolRegistry,
      policyEngine: options.policyEngine,
      approvalBroker: options.approvalBroker,
      budgetTracker: options.budgetTracker,
      taintTracker: options.taintTracker,
      stallDetector: options.stallDetector,
      contextManager: options.contextManager,
      eventBus: this.eventBus,
      logger: this.logger,
      clock: this.clock,
      idGenerator: this.idGenerator,
      headless: options.headless,
      workspaceRoot: options.workspaceRoot,
    });

    this.contextManager = this.turnEngine.getContextManager();
    this.budgetTracker = this.turnEngine.getBudgetTracker();
  }

  public getRunId(): RunId {
    return this.runId;
  }

  public getState(): RunState {
    return this.stateMachine.getState();
  }

  public getStateMachine(): RunStateMachine {
    return this.stateMachine;
  }

  public getTurnEngine(): TurnEngine {
    return this.turnEngine;
  }

  public getContextManager(): ContextManager {
    return this.contextManager;
  }

  public getBudgetTracker(): BudgetTracker {
    return this.budgetTracker;
  }

  public getCurrentTurnIndex(): number {
    return this.currentTurnIndex;
  }

  /**
   * Initiates and runs the agent loop from start to completion, pause, or failure.
   */
  public async run(options?: RunExecutionOptions): Promise<RunOutcome> {
    if (this.isExecuting) {
      throw new AirError('INVALID_STATE', `Runner for run "${this.runId}" is already active`);
    }

    this.isExecuting = true;
    this.abortController = new AbortController();

    // Link caller signal if provided
    if (options?.signal) {
      if (options.signal.aborted) {
        this.abortController.abort(options.signal.reason);
      } else {
        options.signal.addEventListener(
          'abort',
          () => this.abortController.abort(options.signal?.reason),
          { once: true },
        );
      }
    }

    try {
      // 1. Initial creation transition if in created state
      if (this.stateMachine.getState() === 'created') {
        const goal = options?.initialGoal ?? 'Execute agent goal';
        this.emitRunCreatedEvent(goal);

        this.stateMachine.start();
        if (options?.initialGoal) {
          this.contextManager.addMessage({
            role: 'user',
            content: options.initialGoal,
          });
        }
      }

      // Check immediate cancellation before starting loop
      if (this.abortController.signal.aborted) {
        return this.handleCancellation(String(this.abortController.signal.reason));
      }

      return await this.executeLoop();
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Resumes a paused or waiting run.
   */
  public async resume(options?: ResumeExecutionOptions): Promise<RunOutcome> {
    if (this.isExecuting) {
      throw new AirError('INVALID_STATE', `Runner for run "${this.runId}" is already active`);
    }

    const currentState = this.stateMachine.getState();
    if (
      currentState !== 'paused' &&
      currentState !== 'waiting_user' &&
      currentState !== 'waiting_approval'
    ) {
      throw new AirError(
        'RUN_ILLEGAL_TRANSITION',
        `Cannot resume run "${this.runId}" from state "${currentState}". Only paused or waiting states can be resumed.`,
      );
    }

    this.isExecuting = true;
    this.abortController = new AbortController();
    this.pauseRequested = false;
    this.pauseReason = undefined;

    if (options?.signal) {
      if (options.signal.aborted) {
        this.abortController.abort(options.signal.reason);
      } else {
        options.signal.addEventListener(
          'abort',
          () => this.abortController.abort(options.signal?.reason),
          { once: true },
        );
      }
    }

    try {
      if (options?.userMessage) {
        this.contextManager.addMessage({
          role: 'user',
          content: options.userMessage,
        });
      }

      const reason = options?.reason ?? 'Run resumed by operator';
      this.stateMachine.resume(reason);

      return await this.executeLoop();
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Requests a safe pause at the next turn boundary.
   */
  public requestPause(reason = 'Pause requested by operator'): void {
    if (this.stateMachine.isTerminal()) {
      return;
    }
    this.pauseRequested = true;
    this.pauseReason = reason;
  }

  /**
   * Cancels the active run immediately or at cooperative cancellation point.
   */
  public cancel(reason = 'Run cancelled by operator'): void {
    if (this.stateMachine.isTerminal()) {
      return;
    }
    this.abortController.abort(reason);

    // If not executing turn right now, transition immediately
    if (!this.isExecuting && this.stateMachine.canTransitionTo('cancelled')) {
      this.stateMachine.cancel(reason);
    }
  }

  // ==========================================================================
  // Core Execution Loop
  // ==========================================================================

  private async executeLoop(): Promise<RunOutcome> {
    let lastTurnResult: TurnExecutionResult | undefined;

    while (this.currentTurnIndex < this.maxTurns) {
      // 1. Check cooperative cancellation before turn
      if (this.abortController.signal.aborted) {
        return this.handleCancellation(String(this.abortController.signal.reason));
      }

      // 2. Check safe pause request before turn (between turns, not before the initial turn)
      if (this.pauseRequested && this.currentTurnIndex > 0) {
        return this.handlePause(this.pauseReason ?? 'Pause requested');
      }

      // 3. Transition to running state if not already running
      if (this.stateMachine.getState() !== 'running') {
        if (this.stateMachine.canTransitionTo('running')) {
          this.stateMachine.run(this.currentTurnIndex);
        } else {
          throw new AirError(
            'RUN_ILLEGAL_TRANSITION',
            `Cannot transition to running from current state "${this.stateMachine.getState()}"`,
          );
        }
      }

      // 4. Execute turn
      const turnResult = await this.turnEngine.executeTurn(
        this.currentTurnIndex,
        this.abortController.signal,
      );
      lastTurnResult = turnResult;

      // 5. Evaluate turn result
      switch (turnResult.status) {
        case 'complete': {
          this.currentTurnIndex++;
          const completeDetails: { summary?: string; totalSteps?: number; result?: unknown } = {
            totalSteps: this.currentTurnIndex,
          };
          if (turnResult.text !== undefined) {
            completeDetails.summary = turnResult.text;
            completeDetails.result = turnResult.text;
          }
          this.stateMachine.complete(completeDetails);

          return {
            runId: this.runId,
            status: 'completed',
            totalTurns: this.currentTurnIndex,
            text: turnResult.text,
            lastTurnResult,
          };
        }

        case 'continue': {
          this.currentTurnIndex++;

          // Check if pause was requested during the turn
          if (this.pauseRequested) {
            return this.handlePause(this.pauseReason ?? 'Pause requested');
          }

          // Check if cancelled during the turn
          if (this.abortController.signal.aborted) {
            return this.handleCancellation(String(this.abortController.signal.reason));
          }

          break;
        }

        case 'waiting_user': {
          const prompt =
            typeof turnResult.reason === 'string' && turnResult.reason.length > 0
              ? turnResult.reason
              : 'User interaction required';

          this.stateMachine.waitUser(prompt);

          return {
            runId: this.runId,
            status: 'waiting_user',
            totalTurns: this.currentTurnIndex + 1,
            reason: prompt,
            lastTurnResult,
          };
        }

        case 'waiting_approval': {
          const toolRes = turnResult.toolResults?.[0];
          const toolCallId = (toolRes?.toolCallId ?? 'unknown') as ToolCallId;
          const toolName = toolRes?.name ?? 'unknown';

          this.stateMachine.waitApproval({
            toolCallId,
            toolName,
            riskLevel: 'high',
            reason: turnResult.reason ?? 'Approval required',
          });

          return {
            runId: this.runId,
            status: 'waiting_approval',
            totalTurns: this.currentTurnIndex + 1,
            reason: turnResult.reason,
            lastTurnResult,
          };
        }

        case 'budget_exceeded': {
          this.stateMachine.exceedBudget({
            dimension: 'steps',
            limit: this.maxTurns,
            actual: this.currentTurnIndex + 1,
          });

          return {
            runId: this.runId,
            status: 'budget_exceeded',
            totalTurns: this.currentTurnIndex + 1,
            reason: turnResult.reason ?? 'Budget limit exceeded',
            lastTurnResult,
          };
        }

        case 'stalled': {
          this.stateMachine.fail({
            code: 'AGENT_STALL_DETECTED',
            message: turnResult.reason ?? 'Agent stalled or entered infinite loop',
            retryable: false,
          });

          return {
            runId: this.runId,
            status: 'stalled',
            totalTurns: this.currentTurnIndex + 1,
            reason: turnResult.reason,
            lastTurnResult,
          };
        }

        case 'error': {
          const err = turnResult.error ?? new AirError('INTERNAL', turnResult.reason ?? 'Turn failed');
          this.stateMachine.fail({
            code: err.code,
            message: err.message,
            retryable: err.retryable,
          });

          return {
            runId: this.runId,
            status: 'failed',
            totalTurns: this.currentTurnIndex + 1,
            error: err,
            reason: turnResult.reason,
            lastTurnResult,
          };
        }
      }
    }

    // Exceeded maxTurns without completion
    this.stateMachine.exceedBudget({
      dimension: 'steps',
      limit: this.maxTurns,
      actual: this.currentTurnIndex,
    });

    return {
      runId: this.runId,
      status: 'budget_exceeded',
      totalTurns: this.currentTurnIndex,
      reason: `Exceeded maximum configured turns limit (${this.maxTurns})`,
      lastTurnResult,
    };
  }

  private handleCancellation(reason: string): RunOutcome {
    if (this.stateMachine.canTransitionTo('cancelled')) {
      this.stateMachine.cancel(reason);
    }
    return {
      runId: this.runId,
      status: 'cancelled',
      totalTurns: this.currentTurnIndex,
      reason,
    };
  }

  private handlePause(reason: string): RunOutcome {
    this.pauseRequested = false;
    this.pauseReason = undefined;
    if (this.stateMachine.canTransitionTo('paused')) {
      this.stateMachine.pause(reason);
    }
    return {
      runId: this.runId,
      status: 'paused',
      totalTurns: this.currentTurnIndex,
      reason,
    };
  }

  private emitRunCreatedEvent(goal: string): void {
    if (!this.eventBus) return;
    try {
      this.eventBus.publish(
        createEnvelope({
          stream: `run:${this.runId}`,
          seq: this.seq++,
          type: 'run.created',
          payload: {
            goal,
            agentId: this.manifest.id,
            config: {
              model: this.manifest.model.model,
              version: this.manifest.version,
            },
          },
          meta: { runId: this.runId, agentId: this.manifest.id },
          clock: this.clock,
          idGenerator: this.idGenerator,
        }),
      );
    } catch {
      // Non-fatal
    }
  }

  // ==========================================================================
  // Static Reconstitution from Event Streams (Rule R8)
  // ==========================================================================

  /**
   * Reconstitutes an AgentRunner from an append-only stream of historical journal events.
   */
  public static fromEvents(
    events: readonly EventEnvelope[],
    options: Omit<AgentRunnerOptions, 'stateMachine' | 'runId'> & { runId?: string | RunId },
  ): AgentRunner {
    const streamRunId = events[0]?.meta?.runId ?? events[0]?.stream.replace(/^run:/, '');
    const resolvedRunId = options.runId ?? streamRunId;
    if (!resolvedRunId) {
      throw new AirError('INVALID_ARGUMENT', 'AgentRunner.fromEvents requires a runId or at least one event with runId metadata');
    }

    if (events.length === 0) {
      return new AgentRunner({ ...options, runId: resolvedRunId });
    }

    const stateMachine = RunStateMachine.fromEvents(events, {
      clock: options.clock,
      idGenerator: options.idGenerator,
      eventBus: options.eventBus,
    });

    const runner = new AgentRunner({
      ...options,
      runId: resolvedRunId,
      stateMachine,
    });

    // Reconstruct turn index from events
    let maxTurnIndex = 0;
    for (const ev of events) {
      if (ev.type === 'turn.completed' || ev.type === 'turn.started') {
        const payload = ev.payload as { turnIndex?: number };
        if (typeof payload.turnIndex === 'number' && payload.turnIndex >= maxTurnIndex) {
          maxTurnIndex = payload.turnIndex + (ev.type === 'turn.completed' ? 1 : 0);
        }
      }
    }

    runner.currentTurnIndex = maxTurnIndex;
    return runner;
  }
}
