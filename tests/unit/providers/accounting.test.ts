/**
 * Unit tests for Token & Cost Accounting Engine (P3-T07).
 */

import { describe, expect, it } from 'vitest';
import type { BudgetsConfig } from '../../../src/config/index.js';
import { AirError } from '../../../src/errors/index.js';
import {
  calculateCost,
  DEFAULT_MODEL_PRICING,
  estimateCost,
  estimateTokens,
  PricingRegistry,
  RunUsageTracker,
} from '../../../src/providers/accounting.js';
import type { NormalizedRequest, TokenUsage } from '../../../src/providers/types.js';
import { parseRunId } from '../../../src/types/index.js';
import { FakeClock } from '../../../src/util/clock.js';

describe('PricingRegistry', () => {
  it('returns reference prices for default frontier models', () => {
    const registry = new PricingRegistry();

    const sonnet = registry.getPricing('claude-3-5-sonnet');
    expect(sonnet.inputPerMillion).toBe(3.0);
    expect(sonnet.outputPerMillion).toBe(15.0);
    expect(sonnet.cacheReadPerMillion).toBe(0.3);
    expect(sonnet.cacheWritePerMillion).toBe(3.75);

    const gpt4o = registry.getPricing('gpt-4o');
    expect(gpt4o.inputPerMillion).toBe(2.5);
    expect(gpt4o.outputPerMillion).toBe(10.0);
    expect(gpt4o.cacheReadPerMillion).toBe(1.25);
  });

  it('matches versioned models by prefix or substring', () => {
    const registry = new PricingRegistry();

    const versionedSonnet = registry.getPricing('claude-3-5-sonnet-20241022');
    expect(versionedSonnet.inputPerMillion).toBe(3.0);
    expect(versionedSonnet.outputPerMillion).toBe(15.0);

    const versionedGpt4o = registry.getPricing('gpt-4o-2024-08-06');
    expect(versionedGpt4o.inputPerMillion).toBe(2.5);
  });

  it('defaults local and mock models to zero cost', () => {
    const registry = new PricingRegistry();

    expect(registry.getPricing('ollama/llama3:8b')).toEqual({
      inputPerMillion: 0,
      outputPerMillion: 0,
    });
    expect(registry.getPricing('mock-model')).toEqual({
      inputPerMillion: 0,
      outputPerMillion: 0,
    });
    expect(registry.getPricing('local-mistral')).toEqual({
      inputPerMillion: 0,
      outputPerMillion: 0,
    });
  });

  it('supports custom price registration and overrides', () => {
    const registry = new PricingRegistry({
      'custom-model': {
        inputPerMillion: 1.0,
        outputPerMillion: 2.0,
      },
    });

    expect(registry.getPricing('custom-model')).toEqual({
      inputPerMillion: 1.0,
      outputPerMillion: 2.0,
    });

    registry.setPricing('custom-model-2', {
      inputPerMillion: 5.0,
      outputPerMillion: 20.0,
    });
    expect(registry.getPricing('custom-model-2')).toEqual({
      inputPerMillion: 5.0,
      outputPerMillion: 20.0,
    });
  });

  it('provides all registered pricing entries', () => {
    const registry = new PricingRegistry();
    const all = registry.getAllPricing();
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(Object.keys(DEFAULT_MODEL_PRICING).length);
    expect(all['claude-3-5-sonnet']).toBeDefined();
  });
});

describe('calculateCost', () => {
  it('calculates prompt and completion costs accurately', () => {
    const pricing = {
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
    };
    const usage: TokenUsage = {
      promptTokens: 100_000,
      completionTokens: 20_000,
      totalTokens: 120_000,
    };

    const cost = calculateCost(usage, pricing);
    // 100k / 1M * 3 = $0.30
    expect(cost.inputCostUsd).toBe(0.3);
    // 20k / 1M * 15 = $0.30
    expect(cost.outputCostUsd).toBe(0.3);
    expect(cost.cacheReadCostUsd).toBe(0);
    expect(cost.cacheWriteCostUsd).toBe(0);
    expect(cost.totalCostUsd).toBe(0.6);
  });

  it('accounts for prompt cache reads and writes with uncached deduction', () => {
    const pricing = {
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    };
    const usage: TokenUsage = {
      promptTokens: 100_000, // 80k cached read + 20k uncached
      completionTokens: 10_000,
      totalTokens: 110_000,
      cacheReadTokens: 80_000,
      cacheWriteTokens: 10_000,
    };

    const cost = calculateCost(usage, pricing);
    // Uncached: (100k - 80k) = 20k -> 20k / 1M * 3 = $0.06
    expect(cost.inputCostUsd).toBe(0.06);
    // Output: 10k / 1M * 15 = $0.15
    expect(cost.outputCostUsd).toBe(0.15);
    // Cache read: 80k / 1M * 0.3 = $0.024
    expect(cost.cacheReadCostUsd).toBe(0.024);
    // Cache write: 10k / 1M * 3.75 = $0.0375
    expect(cost.cacheWriteCostUsd).toBe(0.0375);
    // Total: 0.06 + 0.15 + 0.024 + 0.0375 = $0.2715
    expect(cost.totalCostUsd).toBe(0.2715);
  });

  it('returns zero costs for free models', () => {
    const pricing = { inputPerMillion: 0, outputPerMillion: 0 };
    const usage: TokenUsage = {
      promptTokens: 50_000,
      completionTokens: 10_000,
      totalTokens: 60_000,
    };

    const cost = calculateCost(usage, pricing);
    expect(cost.totalCostUsd).toBe(0);
    expect(cost.inputCostUsd).toBe(0);
    expect(cost.outputCostUsd).toBe(0);
  });
});

describe('estimateTokens and estimateCost', () => {
  it('estimates token counts for simple text messages', () => {
    const request: NormalizedRequest = {
      model: 'claude-3-5-sonnet',
      system: 'You are a helpful assistant.',
      messages: [
        {
          role: 'user',
          content: 'Hello, world! Can you explain the theory of relativity in simple terms?',
        },
      ],
    };

    const tokens = estimateTokens(request);
    expect(tokens).toBeGreaterThan(15);
    expect(tokens).toBeLessThan(100);
  });

  it('estimates token counts with tools, thinking, and images', () => {
    const request: NormalizedRequest = {
      model: 'claude-3-5-sonnet',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think about how to solve this math problem...' },
            {
              type: 'tool_call',
              id: 'call_1',
              name: 'calculator',
              arguments: { expr: '42 * 10' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'call_1',
              content: '420',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'image',
              mediaType: 'image/png',
              data: 'data',
            },
            { type: 'text', text: 'Analyze this image.' },
          ],
        },
      ],
      tools: [
        {
          name: 'calculator',
          description: 'Evaluates arithmetic expressions',
          parameters: {
            type: 'object',
            properties: { expr: { type: 'string' } },
            required: ['expr'],
          },
        },
      ],
    };

    const tokens = estimateTokens(request);
    // Image alone adds ~1000 tokens equivalent
    expect(tokens).toBeGreaterThan(1000);
  });

  it('estimates upper-bound cost based on maxTokens parameter', () => {
    const request: NormalizedRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Write a quick poem.' }],
      maxTokens: 500,
    };
    const pricing = { inputPerMillion: 2.5, outputPerMillion: 10.0 };

    const estimate = estimateCost(request, pricing);
    expect(estimate.estimatedInputTokens).toBeGreaterThan(0);
    expect(estimate.estimatedMaxOutputTokens).toBe(500);
    expect(estimate.estimatedMaxOutputCostUsd).toBe(roundUsd((500 / 1_000_000) * 10.0));
    expect(estimate.estimatedMaxTotalCostUsd).toBe(
      roundUsd(estimate.estimatedInputCostUsd + estimate.estimatedMaxOutputCostUsd),
    );
  });
});

describe('RunUsageTracker', () => {
  const testRunId = parseRunId('run_01j7ac841800007mv5d0000001');

  it('initializes with zero usage and cost', () => {
    const tracker = new RunUsageTracker(testRunId);
    const summary = tracker.getSummary();

    expect(summary.runId).toBe(testRunId);
    expect(summary.callCount).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.totalUsage.totalTokens).toBe(0);
    expect(tracker.getRecords().length).toBe(0);
  });

  it('accumulates usage and costs across multiple calls and models', () => {
    const clock = new FakeClock('2026-10-17T03:00:00.000Z');
    const tracker = new RunUsageTracker(testRunId, { clock });

    // Call 1: Claude 3.5 Sonnet
    clock.advance(1000);
    const rec1 = tracker.recordCall('claude-3-5-sonnet', {
      promptTokens: 10_000,
      completionTokens: 2_000,
      totalTokens: 12_000,
    });
    expect(rec1.callIndex).toBe(0);
    expect(rec1.cost.inputCostUsd).toBe(0.03); // 10k / 1M * 3
    expect(rec1.cost.outputCostUsd).toBe(0.03); // 2k / 1M * 15
    expect(rec1.cost.totalCostUsd).toBe(0.06);

    // Call 2: GPT-4o-mini
    clock.advance(2000);
    const rec2 = tracker.recordCall('gpt-4o-mini', {
      promptTokens: 20_000,
      completionTokens: 5_000,
      totalTokens: 25_000,
    });
    expect(rec2.callIndex).toBe(1);
    expect(rec2.cost.inputCostUsd).toBe(0.003); // 20k / 1M * 0.15
    expect(rec2.cost.outputCostUsd).toBe(0.003); // 5k / 1M * 0.6
    expect(rec2.cost.totalCostUsd).toBe(0.006);

    const summary = tracker.getSummary();
    expect(summary.callCount).toBe(2);
    expect(summary.totalUsage.promptTokens).toBe(30_000);
    expect(summary.totalUsage.completionTokens).toBe(7_000);
    expect(summary.totalUsage.totalTokens).toBe(37_000);
    expect(summary.totalCostUsd).toBe(0.066);

    const records = tracker.getRecords();
    expect(records.length).toBe(2);
    expect(records[0]?.timestamp).toBe('2026-10-17T03:00:01.000Z');
    expect(records[1]?.timestamp).toBe('2026-10-17T03:00:03.000Z');
  });

  it('enforces budget limits and detects violations', () => {
    const tracker = new RunUsageTracker(testRunId);
    const budget: BudgetsConfig = {
      maxUsdPerRun: 1.0,
      maxTokensPerRun: 100_000,
      maxStepsPerRun: 5,
      maxWallClockMinutes: 60,
    };

    expect(tracker.isBudgetExceeded(budget)).toBe(false);
    expect(() => tracker.checkBudget(budget)).not.toThrow();

    // Add usage that stays within budget
    tracker.recordCall('claude-3-5-sonnet', {
      promptTokens: 50_000,
      completionTokens: 10_000,
      totalTokens: 60_000,
    });
    expect(tracker.isBudgetExceeded(budget)).toBe(false);

    // Add another call that breaches token budget (60k + 50k = 110k > 100k)
    tracker.recordCall('claude-3-5-sonnet', {
      promptTokens: 40_000,
      completionTokens: 10_000,
      totalTokens: 50_000,
    });

    expect(tracker.isBudgetExceeded(budget)).toBe(true);
    let caughtError: unknown;
    try {
      tracker.checkBudget(budget);
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(AirError);
    expect((caughtError as AirError).code).toBe('RUN_BUDGET_EXCEEDED');
    expect((caughtError as AirError).message).toContain('tokens 110000 >= max 100000');
  });

  it('throws RUN_BUDGET_EXCEEDED when USD cost limit is breached', () => {
    const tracker = new RunUsageTracker(testRunId);
    const budget: BudgetsConfig = {
      maxUsdPerRun: 0.1,
      maxTokensPerRun: 1_000_000,
      maxStepsPerRun: 100,
      maxWallClockMinutes: 60,
    };

    tracker.recordCall('claude-3-opus', {
      promptTokens: 10_000, // 10k / 1M * 15 = $0.15
      completionTokens: 1_000,
      totalTokens: 11_000,
    });

    expect(tracker.isBudgetExceeded(budget)).toBe(true);
    expect(() => tracker.checkBudget(budget)).toThrowError(
      /Run budget exceeded: cost \$0\.2250 >= max \$0\.10/,
    );
  });

  it('throws RUN_BUDGET_EXCEEDED when step limit is breached', () => {
    const tracker = new RunUsageTracker(testRunId);
    const budget: BudgetsConfig = {
      maxUsdPerRun: 100.0,
      maxTokensPerRun: 1_000_000,
      maxStepsPerRun: 2,
      maxWallClockMinutes: 60,
    };

    tracker.recordCall('mock', { promptTokens: 10, completionTokens: 10, totalTokens: 20 });
    tracker.recordCall('mock', { promptTokens: 10, completionTokens: 10, totalTokens: 20 });

    expect(tracker.isBudgetExceeded(budget)).toBe(true);
    expect(() => tracker.checkBudget(budget)).toThrowError(
      /Run budget exceeded: steps 2 >= max 2/,
    );
  });

  it('clears state on reset()', () => {
    const tracker = new RunUsageTracker(testRunId);
    tracker.recordCall('gpt-4o', { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    expect(tracker.getSummary().callCount).toBe(1);

    tracker.reset();
    const cleanSummary = tracker.getSummary();
    expect(cleanSummary.callCount).toBe(0);
    expect(cleanSummary.totalCostUsd).toBe(0);
    expect(cleanSummary.totalUsage.totalTokens).toBe(0);
  });
});

function roundUsd(val: number): number {
  return Math.round(val * 1_000_000) / 1_000_000;
}
