/**
 * Token & Cost Accounting Engine for AIR (Phase 3 - P3-T07).
 *
 * Implements:
 * - Per-model pricing tables (USD per million tokens for prompt, completion, cache read/write, thinking).
 * - High-precision cost calculation from normalized token usage.
 * - Pre-call token and cost estimation for prompt budgeting.
 * - Run-level running totals, usage accumulation, and budget enforcement (`RUN_BUDGET_EXCEEDED`).
 * - Pattern-based model pricing registry with default frontier model tables.
 */

import type { BudgetsConfig } from '../config/index.js';
import { AirError } from '../errors/index.js';
import type { RunId } from '../types/index.js';
import { type Clock, SystemClock } from '../util/index.js';
import {
  type NormalizedMessage,
  type NormalizedRequest,
  type TokenUsage,
} from './types.js';

// ============================================================================
// 1. Pricing Definitions
// ============================================================================

export interface ModelPricing {
  /** Cost in USD per 1,000,000 prompt / input tokens. */
  readonly inputPerMillion: number;
  /** Cost in USD per 1,000,000 completion / output tokens. */
  readonly outputPerMillion: number;
  /** Cost in USD per 1,000,000 prompt cache read tokens (hit). */
  readonly cacheReadPerMillion?: number | undefined;
  /** Cost in USD per 1,000,000 prompt cache write tokens (creation). */
  readonly cacheWritePerMillion?: number | undefined;
  /** Cost in USD per 1,000,000 extended thinking tokens (defaults to outputPerMillion if omitted). */
  readonly thinkingPerMillion?: number | undefined;
}

/**
 * Standard reference pricing table for popular models (USD per 1M tokens).
 */
export const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic Claude 3.5 & 3 series
  'claude-3-5-sonnet': {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  'claude-3-5-haiku': {
    inputPerMillion: 0.8,
    outputPerMillion: 4.0,
    cacheReadPerMillion: 0.08,
    cacheWritePerMillion: 1.0,
  },
  'claude-3-opus': {
    inputPerMillion: 15.0,
    outputPerMillion: 75.0,
    cacheReadPerMillion: 1.5,
    cacheWritePerMillion: 18.75,
  },

  // OpenAI GPT-4o & reasoning series
  'gpt-4o': {
    inputPerMillion: 2.5,
    outputPerMillion: 10.0,
    cacheReadPerMillion: 1.25,
  },
  'gpt-4o-mini': {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
    cacheReadPerMillion: 0.075,
  },
  'o1': {
    inputPerMillion: 15.0,
    outputPerMillion: 60.0,
    cacheReadPerMillion: 7.5,
  },
  'o1-mini': {
    inputPerMillion: 3.0,
    outputPerMillion: 12.0,
    cacheReadPerMillion: 1.5,
  },
  'o3-mini': {
    inputPerMillion: 1.1,
    outputPerMillion: 4.4,
    cacheReadPerMillion: 0.55,
  },

  // DeepSeek frontier series
  'deepseek-chat': {
    inputPerMillion: 0.14,
    outputPerMillion: 0.28,
    cacheReadPerMillion: 0.014,
  },
  'deepseek-reasoner': {
    inputPerMillion: 0.55,
    outputPerMillion: 2.19,
    cacheReadPerMillion: 0.14,
  },

  // Local & mock models (zero cost)
  'mock': {
    inputPerMillion: 0,
    outputPerMillion: 0,
  },
  'ollama': {
    inputPerMillion: 0,
    outputPerMillion: 0,
  },
};

// ============================================================================
// 2. Pricing Registry
// ============================================================================

export class PricingRegistry {
  private readonly prices = new Map<string, ModelPricing>();

  constructor(customPrices?: Record<string, ModelPricing>) {
    // Load defaults
    for (const [model, pricing] of Object.entries(DEFAULT_MODEL_PRICING)) {
      this.prices.set(model.toLowerCase(), pricing);
    }

    // Overlay custom pricing
    if (customPrices) {
      for (const [model, pricing] of Object.entries(customPrices)) {
        this.prices.set(model.toLowerCase(), pricing);
      }
    }
  }

  setPricing(modelPattern: string, pricing: ModelPricing): void {
    this.prices.set(modelPattern.toLowerCase(), pricing);
  }

  getPricing(modelName: string): ModelPricing {
    const normalized = modelName.trim().toLowerCase();

    // 1. Exact match
    const exact = this.prices.get(normalized);
    if (exact) {
      return exact;
    }

    // 2. Prefix or substring match (e.g. 'claude-3-5-sonnet-20241022' matches 'claude-3-5-sonnet')
    for (const [pattern, pricing] of this.prices) {
      if (normalized.startsWith(pattern) || normalized.includes(pattern)) {
        return pricing;
      }
    }

    // 3. If local model (e.g. llama3, qwen, mistral in Ollama), default to zero cost
    if (
      normalized.includes('ollama') ||
      normalized.includes('local') ||
      normalized.includes('lmstudio') ||
      normalized.includes('mock')
    ) {
      return { inputPerMillion: 0, outputPerMillion: 0 };
    }

    // 4. Default fallback: conservative zero pricing to prevent unverified inflated numbers
    return { inputPerMillion: 0, outputPerMillion: 0 };
  }

  getAllPricing(): Readonly<Record<string, ModelPricing>> {
    const result: Record<string, ModelPricing> = {};
    for (const [k, v] of this.prices) {
      result[k] = v;
    }
    return result;
  }
}

// ============================================================================
// 3. Cost Calculation
// ============================================================================

export interface CostBreakdown {
  readonly inputCostUsd: number;
  readonly outputCostUsd: number;
  readonly cacheReadCostUsd: number;
  readonly cacheWriteCostUsd: number;
  readonly totalCostUsd: number;
}

export function calculateCost(usage: TokenUsage, pricing: ModelPricing): CostBreakdown {
  const promptTokens = usage.promptTokens;
  const completionTokens = usage.completionTokens;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;

  // Uncached prompt tokens = total prompt tokens - cacheReadTokens
  const uncachedPromptTokens = Math.max(0, promptTokens - cacheReadTokens);

  const inputCostUsd = (uncachedPromptTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCostUsd = (completionTokens / 1_000_000) * pricing.outputPerMillion;

  const cacheReadCostUsd =
    pricing.cacheReadPerMillion !== undefined
      ? (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion
      : 0;

  const cacheWriteCostUsd =
    pricing.cacheWritePerMillion !== undefined
      ? (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMillion
      : 0;

  const totalCostUsd = inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheWriteCostUsd;

  return {
    inputCostUsd: roundUsd(inputCostUsd),
    outputCostUsd: roundUsd(outputCostUsd),
    cacheReadCostUsd: roundUsd(cacheReadCostUsd),
    cacheWriteCostUsd: roundUsd(cacheWriteCostUsd),
    totalCostUsd: roundUsd(totalCostUsd),
  };
}

function roundUsd(value: number): number {
  // Precision to 6 decimal places ($0.000001) for accurate micro-cent accounting
  return Math.round(value * 1_000_000) / 1_000_000;
}

// ============================================================================
// 4. Pre-Call Estimation
// ============================================================================

export interface CostEstimate {
  readonly estimatedInputTokens: number;
  readonly estimatedInputCostUsd: number;
  readonly estimatedMaxOutputTokens: number;
  readonly estimatedMaxOutputCostUsd: number;
  readonly estimatedMaxTotalCostUsd: number;
}

/**
 * Heuristic token estimation for normalized messages and tool definitions (~3.8 chars per token).
 */
export function estimateTokens(request: NormalizedRequest): number {
  let charCount = 0;

  if (request.system) {
    if (typeof request.system === 'string') {
      charCount += request.system.length;
    } else {
      for (const s of request.system) {
        charCount += s.length;
      }
    }
  }

  for (const msg of request.messages) {
    charCount += estimateMessageCharacters(msg);
  }

  if (request.tools) {
    for (const tool of request.tools) {
      charCount += tool.name.length;
      charCount += tool.description.length;
      charCount += JSON.stringify(tool.parameters).length;
    }
  }

  // Baseline ~3.8 characters per token for English text and code, + 4 tokens overhead per message
  const textTokens = Math.ceil(charCount / 3.8);
  const messageOverhead = request.messages.length * 4;

  return textTokens + messageOverhead;
}

function estimateMessageCharacters(message: NormalizedMessage): number {
  if (typeof message.content === 'string') {
    return message.content.length;
  }

  let chars = 0;
  for (const part of message.content) {
    if (part.type === 'text') {
      chars += part.text.length;
    } else if (part.type === 'thinking') {
      chars += part.thinking.length;
    } else if (part.type === 'tool_call') {
      chars += part.name.length;
      chars += typeof part.arguments === 'string' ? part.arguments.length : JSON.stringify(part.arguments).length;
    } else if (part.type === 'tool_result') {
      chars += typeof part.content === 'string' ? part.content.length : JSON.stringify(part.content).length;
    } else if (part.type === 'image') {
      // Approximate 1,000 tokens equivalent in characters (~3,800 chars) for an image
      chars += 3800;
    }
  }
  return chars;
}

/**
 * Calculates pre-call upper bound cost estimates for budgeting decisions.
 */
export function estimateCost(
  request: NormalizedRequest,
  pricing: ModelPricing,
  defaultMaxOutputTokens = 4096,
): CostEstimate {
  const estimatedInputTokens = estimateTokens(request);
  const estimatedMaxOutputTokens = request.maxTokens ?? defaultMaxOutputTokens;

  const estimatedInputCostUsd = roundUsd((estimatedInputTokens / 1_000_000) * pricing.inputPerMillion);
  const estimatedMaxOutputCostUsd = roundUsd((estimatedMaxOutputTokens / 1_000_000) * pricing.outputPerMillion);
  const estimatedMaxTotalCostUsd = roundUsd(estimatedInputCostUsd + estimatedMaxOutputCostUsd);

  return {
    estimatedInputTokens,
    estimatedInputCostUsd,
    estimatedMaxOutputTokens,
    estimatedMaxOutputCostUsd,
    estimatedMaxTotalCostUsd,
  };
}

// ============================================================================
// 5. Run-level Accounting & Budget Tracker
// ============================================================================

export interface RunUsageRecord {
  readonly callIndex: number;
  readonly timestamp: string;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly cost: CostBreakdown;
}

export interface RunUsageSummary {
  readonly runId: RunId;
  readonly callCount: number;
  readonly totalUsage: TokenUsage;
  readonly totalCostUsd: number;
  readonly costBreakdown: CostBreakdown;
}

export class RunUsageTracker {
  readonly runId: RunId;
  private readonly registry: PricingRegistry;
  private readonly clock: Clock;

  private readonly records: RunUsageRecord[] = [];
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private totalCacheReadTokens = 0;
  private totalCacheWriteTokens = 0;
  private totalThinkingTokens = 0;

  private totalInputCostUsd = 0;
  private totalOutputCostUsd = 0;
  private totalCacheReadCostUsd = 0;
  private totalCacheWriteCostUsd = 0;

  constructor(
    runId: RunId,
    options?: {
      readonly registry?: PricingRegistry | undefined;
      readonly clock?: Clock | undefined;
    },
  ) {
    this.runId = runId;
    this.registry = options?.registry ?? new PricingRegistry();
    this.clock = options?.clock ?? new SystemClock();
  }

  recordCall(model: string, usage: TokenUsage): RunUsageRecord {
    const pricing = this.registry.getPricing(model);
    const cost = calculateCost(usage, pricing);

    this.totalPromptTokens += usage.promptTokens;
    this.totalCompletionTokens += usage.completionTokens;
    this.totalCacheReadTokens += usage.cacheReadTokens ?? 0;
    this.totalCacheWriteTokens += usage.cacheWriteTokens ?? 0;
    this.totalThinkingTokens += usage.thinkingTokens ?? 0;

    this.totalInputCostUsd += cost.inputCostUsd;
    this.totalOutputCostUsd += cost.outputCostUsd;
    this.totalCacheReadCostUsd += cost.cacheReadCostUsd;
    this.totalCacheWriteCostUsd += cost.cacheWriteCostUsd;

    const record: RunUsageRecord = {
      callIndex: this.records.length,
      timestamp: this.clock.iso(),
      model,
      usage,
      cost,
    };
    this.records.push(record);

    return record;
  }

  getSummary(): RunUsageSummary {
    const totalTokens = this.totalPromptTokens + this.totalCompletionTokens;
    const totalCostUsd = roundUsd(
      this.totalInputCostUsd +
        this.totalOutputCostUsd +
        this.totalCacheReadCostUsd +
        this.totalCacheWriteCostUsd,
    );

    return {
      runId: this.runId,
      callCount: this.records.length,
      totalUsage: {
        promptTokens: this.totalPromptTokens,
        completionTokens: this.totalCompletionTokens,
        totalTokens,
        cacheReadTokens: this.totalCacheReadTokens,
        cacheWriteTokens: this.totalCacheWriteTokens,
        thinkingTokens: this.totalThinkingTokens,
      },
      totalCostUsd,
      costBreakdown: {
        inputCostUsd: roundUsd(this.totalInputCostUsd),
        outputCostUsd: roundUsd(this.totalOutputCostUsd),
        cacheReadCostUsd: roundUsd(this.totalCacheReadCostUsd),
        cacheWriteCostUsd: roundUsd(this.totalCacheWriteCostUsd),
        totalCostUsd,
      },
    };
  }

  getRecords(): readonly RunUsageRecord[] {
    return [...this.records];
  }

  isBudgetExceeded(budget: BudgetsConfig): boolean {
    const summary = this.getSummary();

    if (summary.totalCostUsd >= budget.maxUsdPerRun) {
      return true;
    }
    if (summary.totalUsage.totalTokens >= budget.maxTokensPerRun) {
      return true;
    }
    if (summary.callCount >= budget.maxStepsPerRun) {
      return true;
    }
    return false;
  }

  checkBudget(budget: BudgetsConfig): void {
    const summary = this.getSummary();

    if (summary.totalCostUsd >= budget.maxUsdPerRun) {
      throw new AirError(
        'RUN_BUDGET_EXCEEDED',
        `Run budget exceeded: cost $${summary.totalCostUsd.toFixed(4)} >= max $${budget.maxUsdPerRun.toFixed(2)}`,
        {
          context: {
            runId: this.runId,
            currentCostUsd: summary.totalCostUsd,
            maxUsdPerRun: budget.maxUsdPerRun,
            reason: 'usd_budget_exceeded',
          },
        },
      );
    }

    if (summary.totalUsage.totalTokens >= budget.maxTokensPerRun) {
      throw new AirError(
        'RUN_BUDGET_EXCEEDED',
        `Run budget exceeded: tokens ${summary.totalUsage.totalTokens} >= max ${budget.maxTokensPerRun}`,
        {
          context: {
            runId: this.runId,
            currentTokens: summary.totalUsage.totalTokens,
            maxTokensPerRun: budget.maxTokensPerRun,
            reason: 'token_budget_exceeded',
          },
        },
      );
    }

    if (summary.callCount >= budget.maxStepsPerRun) {
      throw new AirError(
        'RUN_BUDGET_EXCEEDED',
        `Run budget exceeded: steps ${summary.callCount} >= max ${budget.maxStepsPerRun}`,
        {
          context: {
            runId: this.runId,
            currentSteps: summary.callCount,
            maxStepsPerRun: budget.maxStepsPerRun,
            reason: 'step_budget_exceeded',
          },
        },
      );
    }
  }

  reset(): void {
    this.records.length = 0;
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheWriteTokens = 0;
    this.totalThinkingTokens = 0;
    this.totalInputCostUsd = 0;
    this.totalOutputCostUsd = 0;
    this.totalCacheReadCostUsd = 0;
    this.totalCacheWriteCostUsd = 0;
  }
}
