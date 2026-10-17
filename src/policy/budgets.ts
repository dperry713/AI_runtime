/**
 * Budgets & Quotas Management Engine (Phase 5 - P5-T05).
 *
 * Implements:
 * - Multi-dimensional budget tracking: tokens, USD cost, steps, tool-calls, wall-clock time.
 * - Per-tool quotas (e.g., maximum calls for destructive or expensive tools).
 * - Pre-check enforcement before costly actions (model inference, tool execution, steps).
 * - In-flight / post-execution quota recording and accumulation.
 * - Single-shot journal event emission (`run.budget_exceeded`) via EventBus (Rule R8).
 * - Strict typed error dispatch (`AirError('RUN_BUDGET_EXCEEDED')`).
 * - Deterministic replay and testing via injected `Clock` and `IdGenerator` (Rule R6).
 */

import { z } from 'zod';
import { type BudgetsConfig } from '../config/index.js';
import { AirError } from '../errors/index.js';
import type { EventBus } from '../journal/index.js';
import { createEnvelope } from '../journal/index.js';
import type { ComponentLogger } from '../observability/index.js';
import { getLogger } from '../observability/index.js';
import { parseRunId, type RunId } from '../types/index.js';
import {
  type Clock,
  type IdGenerator,
  SystemClock,
  UlidIdGenerator,
} from '../util/index.js';

// ============================================================================
// 1. Zod Schemas & Types
// ============================================================================

export const BudgetDimensionSchema = z.enum([
  'tokens',
  'wall_time',
  'cost',
  'steps',
  'tool_calls',
]);
export type BudgetDimension = z.infer<typeof BudgetDimensionSchema>;

export const RunBudgetLimitsSchema = z.object({
  /** Maximum cumulative tokens allowed for the run (prompt + completion + cache). */
  maxTokens: z.number().int().nonnegative().optional(),
  /** Maximum cumulative USD spend allowed for the run. */
  maxUsd: z.number().nonnegative().optional(),
  /** Maximum agent turn/step count allowed. */
  maxSteps: z.number().int().nonnegative().optional(),
  /** Maximum total tool invocations allowed. */
  maxToolCalls: z.number().int().nonnegative().optional(),
  /** Maximum elapsed wall-clock time in milliseconds. */
  maxWallClockMs: z.number().positive().optional(),
  /** Per-tool specific invocation limits (toolName -> limit). */
  perToolLimits: z.record(z.string(), z.number().int().nonnegative()).optional(),
});
export type RunBudgetLimits = z.infer<typeof RunBudgetLimitsSchema>;

export const BudgetUsageSchema = z.object({
  tokens: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
  steps: z.number().int().nonnegative().default(0),
  toolCalls: z.number().int().nonnegative().default(0),
  toolCallsByName: z.record(z.string(), z.number().int().nonnegative()).default({}),
  startedAt: z.string().datetime({ offset: true }),
  lastActiveAt: z.string().datetime({ offset: true }),
  wallClockElapsedMs: z.number().nonnegative().default(0),
});
export type BudgetUsage = z.infer<typeof BudgetUsageSchema>;

export type BudgetStatus = 'active' | 'exceeded';

export interface BudgetExceededDetails {
  readonly dimension: BudgetDimension;
  readonly limit: number;
  readonly actual: number;
  readonly message: string;
  readonly toolName?: string | undefined;
}

export interface BudgetSnapshot {
  readonly runId: string;
  readonly sessionId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly limits: RunBudgetLimits;
  readonly usage: BudgetUsage;
  readonly status: BudgetStatus;
  readonly exceeded?: BudgetExceededDetails | undefined;
  readonly utilization: {
    readonly tokensPct: number;
    readonly usdPct: number;
    readonly stepsPct: number;
    readonly toolCallsPct: number;
    readonly wallClockPct: number;
  };
}

export interface BudgetPreCheckResult {
  readonly allowed: boolean;
  readonly exceeded?: BudgetExceededDetails | undefined;
}

export interface RecordTokensOptions {
  readonly input?: number | undefined;
  readonly output?: number | undefined;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
  readonly total?: number | undefined;
  readonly costUsd?: number | undefined;
}

export interface BudgetTrackerOptions {
  readonly clock?: Clock | undefined;
  readonly idGenerator?: IdGenerator | undefined;
  readonly eventBus?: EventBus | undefined;
  readonly defaultLimits?: RunBudgetLimits | undefined;
  readonly throwOnExceeded?: boolean | undefined;
}

export interface CreateRunBudgetOptions {
  readonly limits?: RunBudgetLimits | undefined;
  readonly sessionId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly startedAt?: Date | undefined;
}

interface InternalRunBudget {
  readonly runId: RunId;
  readonly sessionId?: string | undefined;
  readonly agentId?: string | undefined;
  limits: RunBudgetLimits;
  usage: BudgetUsage;
  status: BudgetStatus;
  exceededDetails?: BudgetExceededDetails | undefined;
  hasEmittedExceededEvent: boolean;
}

// ============================================================================
// 2. BudgetTracker Implementation
// ============================================================================

export class BudgetTracker {
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly eventBus?: EventBus | undefined;
  private readonly defaultLimits: RunBudgetLimits;
  private readonly throwOnExceeded: boolean;
  private readonly logger: ComponentLogger;
  private readonly budgets = new Map<string, InternalRunBudget>();

  public constructor(options?: BudgetTrackerOptions) {
    this.clock = options?.clock ?? new SystemClock();
    this.idGenerator = options?.idGenerator ?? new UlidIdGenerator();
    this.eventBus = options?.eventBus;
    this.defaultLimits = options?.defaultLimits ?? {};
    this.throwOnExceeded = options?.throwOnExceeded ?? true;
    this.logger = getLogger('policy.budgets');
  }

  /**
   * Converts a configuration object into standard RunBudgetLimits.
   */
  public static fromConfig(config: BudgetsConfig): RunBudgetLimits {
    return {
      maxUsd: config.maxUsdPerRun,
      maxTokens: config.maxTokensPerRun,
      maxSteps: config.maxStepsPerRun,
      maxWallClockMs: config.maxWallClockMinutes * 60 * 1000,
    };
  }

  /**
   * Initializes or updates a budget for a specific run.
   */
  public createBudget(runIdStr: string, options?: CreateRunBudgetOptions): BudgetSnapshot {
    const runId = parseRunId(runIdStr);
    const now = (options?.startedAt ?? this.clock.now()).toISOString();

    const limits: RunBudgetLimits = {
      ...this.defaultLimits,
      ...(options?.limits ?? {}),
    };

    const budget: InternalRunBudget = {
      runId,
      sessionId: options?.sessionId,
      agentId: options?.agentId,
      limits,
      usage: {
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        steps: 0,
        toolCalls: 0,
        toolCallsByName: {},
        startedAt: now,
        lastActiveAt: now,
        wallClockElapsedMs: 0,
      },
      status: 'active',
      hasEmittedExceededEvent: false,
    };

    this.budgets.set(runId, budget);
    return this.buildSnapshot(budget);
  }

  /**
   * Returns true if a budget is registered for the run.
   */
  public hasBudget(runIdStr: string): boolean {
    return this.budgets.has(runIdStr);
  }

  /**
   * Returns a snapshot of the current budget utilization.
   */
  public getSnapshot(runIdStr: string): BudgetSnapshot {
    const budget = this.requireBudget(runIdStr);
    this.refreshWallClock(budget);
    return this.buildSnapshot(budget);
  }

  /**
   * Pre-check before executing an agent step/turn.
   * Verifies step quota and wall-clock timeout.
   */
  public preCheckStep(runIdStr: string): BudgetPreCheckResult {
    const budget = this.requireBudget(runIdStr);
    this.refreshWallClock(budget);

    // 1. If already exceeded
    if (budget.status === 'exceeded' && budget.exceededDetails) {
      return this.handleViolation(budget, budget.exceededDetails);
    }

    // 2. Check wall clock
    const wallViolation = this.checkWallClockLimit(budget);
    if (wallViolation) {
      return this.handleViolation(budget, wallViolation);
    }

    // 3. Check step quota
    if (budget.limits.maxSteps !== undefined && budget.usage.steps >= budget.limits.maxSteps) {
      const details: BudgetExceededDetails = {
        dimension: 'steps',
        limit: budget.limits.maxSteps,
        actual: budget.usage.steps + 1,
        message: `Step budget exceeded: limit is ${budget.limits.maxSteps} steps, currently at ${budget.usage.steps}`,
      };
      return this.handleViolation(budget, details);
    }

    return { allowed: true };
  }

  /**
   * Pre-check before requesting model inference.
   * Verifies estimated token count, estimated cost, and wall-clock timeout.
   */
  public preCheckModelCall(
    runIdStr: string,
    estimate?: { tokens?: number; costUsd?: number },
  ): BudgetPreCheckResult {
    const budget = this.requireBudget(runIdStr);
    this.refreshWallClock(budget);

    if (budget.status === 'exceeded' && budget.exceededDetails) {
      return this.handleViolation(budget, budget.exceededDetails);
    }

    const wallViolation = this.checkWallClockLimit(budget);
    if (wallViolation) {
      return this.handleViolation(budget, wallViolation);
    }

    // Check estimated tokens
    if (estimate?.tokens !== undefined && budget.limits.maxTokens !== undefined) {
      const projected = budget.usage.tokens + estimate.tokens;
      if (projected > budget.limits.maxTokens) {
        const details: BudgetExceededDetails = {
          dimension: 'tokens',
          limit: budget.limits.maxTokens,
          actual: projected,
          message: `Projected token budget exceeded: limit is ${budget.limits.maxTokens}, estimated total is ${projected}`,
        };
        return this.handleViolation(budget, details, { permanent: false });
      }
    }

    // Check estimated USD cost
    if (estimate?.costUsd !== undefined && budget.limits.maxUsd !== undefined) {
      const projected = budget.usage.costUsd + estimate.costUsd;
      if (projected > budget.limits.maxUsd) {
        const details: BudgetExceededDetails = {
          dimension: 'cost',
          limit: budget.limits.maxUsd,
          actual: projected,
          message: `Projected cost budget exceeded: limit is $${budget.limits.maxUsd.toFixed(4)}, estimated total is $${projected.toFixed(4)}`,
        };
        return this.handleViolation(budget, details, { permanent: false });
      }
    }

    return { allowed: true };
  }

  /**
   * Pre-check before invoking a tool.
   * Verifies total tool invocations, per-tool quotas, and wall-clock timeout.
   */
  public preCheckToolCall(runIdStr: string, toolName: string): BudgetPreCheckResult {
    const budget = this.requireBudget(runIdStr);
    this.refreshWallClock(budget);

    if (budget.status === 'exceeded' && budget.exceededDetails) {
      return this.handleViolation(budget, budget.exceededDetails);
    }

    const wallViolation = this.checkWallClockLimit(budget);
    if (wallViolation) {
      return this.handleViolation(budget, wallViolation);
    }

    // 1. Check total tool calls limit
    if (budget.limits.maxToolCalls !== undefined && budget.usage.toolCalls >= budget.limits.maxToolCalls) {
      const details: BudgetExceededDetails = {
        dimension: 'tool_calls',
        limit: budget.limits.maxToolCalls,
        actual: budget.usage.toolCalls + 1,
        message: `Tool call budget exceeded: limit is ${budget.limits.maxToolCalls} calls, currently at ${budget.usage.toolCalls}`,
      };
      return this.handleViolation(budget, details);
    }

    // 2. Check per-tool limit
    if (budget.limits.perToolLimits) {
      const toolLimit = budget.limits.perToolLimits[toolName];
      const toolCurrent = budget.usage.toolCallsByName[toolName] ?? 0;
      if (toolLimit !== undefined && toolCurrent >= toolLimit) {
        const details: BudgetExceededDetails = {
          dimension: 'tool_calls',
          limit: toolLimit,
          actual: toolCurrent + 1,
          message: `Tool quota exceeded for '${toolName}': limit is ${toolLimit} calls, currently at ${toolCurrent}`,
          toolName,
        };
        return this.handleViolation(budget, details, { permanent: false, isToolSpecific: true });
      }
    }

    return { allowed: true };
  }

  /**
   * Records completed agent step/turn.
   */
  public recordStep(runIdStr: string, count = 1): BudgetSnapshot {
    const budget = this.requireBudget(runIdStr);
    this.refreshWallClock(budget);

    budget.usage.steps += count;
    budget.usage.lastActiveAt = this.clock.now().toISOString();

    if (budget.limits.maxSteps !== undefined && budget.usage.steps > budget.limits.maxSteps) {
      const details: BudgetExceededDetails = {
        dimension: 'steps',
        limit: budget.limits.maxSteps,
        actual: budget.usage.steps,
        message: `Step budget exceeded: limit was ${budget.limits.maxSteps}, now at ${budget.usage.steps}`,
      };
      this.handleViolation(budget, details);
    }

    return this.buildSnapshot(budget);
  }

  /**
   * Records token consumption and cumulative USD cost from model inference.
   */
  public recordTokens(runIdStr: string, options: RecordTokensOptions): BudgetSnapshot {
    const budget = this.requireBudget(runIdStr);
    this.refreshWallClock(budget);

    const input = options.input ?? 0;
    const output = options.output ?? 0;
    const cacheRead = options.cacheRead ?? 0;
    const cacheWrite = options.cacheWrite ?? 0;
    const total = options.total ?? (input + output + cacheRead + cacheWrite);
    const costUsd = options.costUsd ?? 0;

    budget.usage.tokens += total;
    budget.usage.inputTokens += input;
    budget.usage.outputTokens += output;
    budget.usage.cacheReadTokens += cacheRead;
    budget.usage.cacheWriteTokens += cacheWrite;
    budget.usage.costUsd = Math.round((budget.usage.costUsd + costUsd) * 1e6) / 1e6;
    budget.usage.lastActiveAt = this.clock.now().toISOString();

    // 1. Check token limit
    if (budget.limits.maxTokens !== undefined && budget.usage.tokens > budget.limits.maxTokens) {
      const details: BudgetExceededDetails = {
        dimension: 'tokens',
        limit: budget.limits.maxTokens,
        actual: budget.usage.tokens,
        message: `Token budget exceeded: limit was ${budget.limits.maxTokens}, now at ${budget.usage.tokens}`,
      };
      this.handleViolation(budget, details);
    }

    // 2. Check cost limit
    if (budget.limits.maxUsd !== undefined && budget.usage.costUsd > budget.limits.maxUsd) {
      const details: BudgetExceededDetails = {
        dimension: 'cost',
        limit: budget.limits.maxUsd,
        actual: budget.usage.costUsd,
        message: `Cost budget exceeded: limit was $${budget.limits.maxUsd.toFixed(4)}, now at $${budget.usage.costUsd.toFixed(4)}`,
      };
      this.handleViolation(budget, details);
    }

    return this.buildSnapshot(budget);
  }

  /**
   * Records tool invocation completion.
   */
  public recordToolCall(runIdStr: string, toolName: string): BudgetSnapshot {
    const budget = this.requireBudget(runIdStr);
    this.refreshWallClock(budget);

    budget.usage.toolCalls += 1;
    budget.usage.toolCallsByName[toolName] = (budget.usage.toolCallsByName[toolName] ?? 0) + 1;
    budget.usage.lastActiveAt = this.clock.now().toISOString();

    // 1. Check overall tool call limit
    if (budget.limits.maxToolCalls !== undefined && budget.usage.toolCalls > budget.limits.maxToolCalls) {
      const details: BudgetExceededDetails = {
        dimension: 'tool_calls',
        limit: budget.limits.maxToolCalls,
        actual: budget.usage.toolCalls,
        message: `Tool call budget exceeded: limit was ${budget.limits.maxToolCalls}, now at ${budget.usage.toolCalls}`,
      };
      this.handleViolation(budget, details);
    }

    // 2. Check per-tool limit
    if (budget.limits.perToolLimits) {
      const toolLimit = budget.limits.perToolLimits[toolName];
      const toolActual = budget.usage.toolCallsByName[toolName] ?? 0;
      if (toolLimit !== undefined && toolActual > toolLimit) {
        const details: BudgetExceededDetails = {
          dimension: 'tool_calls',
          limit: toolLimit,
          actual: toolActual,
          message: `Tool quota exceeded for '${toolName}': limit was ${toolLimit}, now at ${toolActual}`,
          toolName,
        };
        this.handleViolation(budget, details, { permanent: false, isToolSpecific: true });
      }
    }

    return this.buildSnapshot(budget);
  }

  /**
   * Explicitly evaluates wall clock duration.
   */
  public checkWallClock(runIdStr: string): BudgetPreCheckResult {
    const budget = this.requireBudget(runIdStr);
    this.refreshWallClock(budget);

    const violation = this.checkWallClockLimit(budget);
    if (violation) {
      return this.handleViolation(budget, violation);
    }

    return { allowed: true };
  }

  /**
   * Resets usage counters for a run while maintaining limits.
   */
  public reset(runIdStr: string): BudgetSnapshot {
    const budget = this.requireBudget(runIdStr);
    const now = this.clock.now().toISOString();

    budget.usage = {
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      steps: 0,
      toolCalls: 0,
      toolCallsByName: {},
      startedAt: now,
      lastActiveAt: now,
      wallClockElapsedMs: 0,
    };
    budget.status = 'active';
    budget.exceededDetails = undefined;
    budget.hasEmittedExceededEvent = false;

    return this.buildSnapshot(budget);
  }

  /**
   * Deletes a budget entry.
   */
  public deleteBudget(runIdStr: string): boolean {
    return this.budgets.delete(runIdStr);
  }

  /**
   * Returns list of currently active run IDs.
   */
  public listActiveRuns(): string[] {
    return Array.from(this.budgets.keys());
  }

  // ==========================================================================
  // Internal Helpers
  // ==========================================================================

  private requireBudget(runIdStr: string): InternalRunBudget {
    let budget = this.budgets.get(runIdStr);
    if (!budget) {
      // Auto-create with default limits if not explicitly initialized
      this.createBudget(runIdStr);
      budget = this.budgets.get(runIdStr);
    }
    if (!budget) {
      throw new AirError('INTERNAL', `Failed to initialize budget for run '${runIdStr}'`);
    }
    return budget;
  }

  private refreshWallClock(budget: InternalRunBudget): void {
    const started = new Date(budget.usage.startedAt).getTime();
    const now = this.clock.now().getTime();
    budget.usage.wallClockElapsedMs = Math.max(0, now - started);
  }

  private checkWallClockLimit(budget: InternalRunBudget): BudgetExceededDetails | undefined {
    if (budget.limits.maxWallClockMs === undefined) return undefined;

    if (budget.usage.wallClockElapsedMs > budget.limits.maxWallClockMs) {
      return {
        dimension: 'wall_time',
        limit: budget.limits.maxWallClockMs,
        actual: budget.usage.wallClockElapsedMs,
        message: `Wall-clock budget exceeded: limit was ${budget.limits.maxWallClockMs}ms, elapsed is ${budget.usage.wallClockElapsedMs}ms`,
      };
    }
    return undefined;
  }

  private handleViolation(
    budget: InternalRunBudget,
    details: BudgetExceededDetails,
    options?: { permanent?: boolean; isToolSpecific?: boolean },
  ): BudgetPreCheckResult {
    const permanent = options?.permanent ?? true;
    const isToolSpecific = options?.isToolSpecific ?? false;

    if (permanent && !isToolSpecific) {
      budget.status = 'exceeded';
      budget.exceededDetails = details;

      // Rule R8: Emit run.budget_exceeded journal event once per run
      if (!budget.hasEmittedExceededEvent) {
        budget.hasEmittedExceededEvent = true;
        this.publishExceededEvent(budget, details);
      }
    }

    if (this.throwOnExceeded) {
      throw new AirError(
        'RUN_BUDGET_EXCEEDED',
        details.message,
        {
          retryable: false,
          context: {
            dimension: details.dimension,
            limit: details.limit,
            actual: details.actual,
            runId: budget.runId,
            toolName: details.toolName,
          },
        },
      );
    }

    return { allowed: false, exceeded: details };
  }

  private publishExceededEvent(budget: InternalRunBudget, details: BudgetExceededDetails): void {
    if (!this.eventBus) return;

    try {
      this.eventBus.publish(
        createEnvelope({
          stream: `run:${budget.runId}`,
          seq: 1,
          type: 'run.budget_exceeded',
          payload: {
            dimension: details.dimension,
            limit: details.limit,
            actual: details.actual,
          },
          meta: {
            runId: budget.runId,
            sessionId: budget.sessionId,
            agentId: budget.agentId,
          },
          clock: this.clock,
          idGenerator: this.idGenerator,
        }),
      );
    } catch (err) {
      this.logger.warn(
        {
          event: 'budget.publish_failed',
          runId: budget.runId,
          err: err instanceof Error ? err : new Error(String(err)),
        },
        'Failed to emit run.budget_exceeded event to EventBus',
      );
    }
  }

  private buildSnapshot(budget: InternalRunBudget): BudgetSnapshot {
    const calcPct = (actual: number, limit?: number): number => {
      if (!limit || limit <= 0) return 0;
      return Math.min(100, Math.round((actual / limit) * 1000) / 10);
    };

    return {
      runId: budget.runId,
      sessionId: budget.sessionId,
      agentId: budget.agentId,
      limits: { ...budget.limits },
      usage: {
        ...budget.usage,
        toolCallsByName: { ...budget.usage.toolCallsByName },
      },
      status: budget.status,
      exceeded: budget.exceededDetails,
      utilization: {
        tokensPct: calcPct(budget.usage.tokens, budget.limits.maxTokens),
        usdPct: calcPct(budget.usage.costUsd, budget.limits.maxUsd),
        stepsPct: calcPct(budget.usage.steps, budget.limits.maxSteps),
        toolCallsPct: calcPct(budget.usage.toolCalls, budget.limits.maxToolCalls),
        wallClockPct: calcPct(budget.usage.wallClockElapsedMs, budget.limits.maxWallClockMs),
      },
    };
  }
}
