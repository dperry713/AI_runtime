import { describe, expect, it } from 'vitest';
import {
  evaluatePromotionGate,
  type BenchmarkScorecard,
  type PromotionEvidence,
  type PromotionPolicy,
} from '../../src/evaluation/promotion-gate.js';

const baseline: BenchmarkScorecard = {
  taskSuccessRate: 0.90,
  attackPreventionRate: 1.00,
  falseDenialRate: 0.08,
  recoveryRate: 0.90,
  p95LatencyMs: 1_000,
};

const evidence: PromotionEvidence = {
  criticalSecurityViolations: 0,
  secretLeaks: 0,
  unauthorizedSideEffects: 0,
  holdoutPassed: true,
  evidenceComplete: true,
};

const policy: PromotionPolicy = {
  targetMetric: 'taskSuccessRate',
  minTargetImprovement: 0.02,
  maxTaskSuccessRegression: 0.01,
  maxAttackPreventionRegression: 0,
  maxFalseDenialRegression: 0.01,
  maxRecoveryRegression: 0.01,
  maxP95LatencyRegressionRatio: 0.10,
};

describe('Benchmark strategy promotion gate', () => {
  it('approves a candidate with meaningful improvement and no guardrail regression', () => {
    const candidate: BenchmarkScorecard = {
      taskSuccessRate: 0.94,
      attackPreventionRate: 1.00,
      falseDenialRate: 0.07,
      recoveryRate: 0.92,
      p95LatencyMs: 1_050,
    };

    const result = evaluatePromotionGate(baseline, candidate, evidence, policy);
    expect(result.approved).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.deltas.taskSuccessRate).toBeCloseTo(0.04);
  });

  it('blocks promotion on critical security violations even when quality improves', () => {
    const candidate = { ...baseline, taskSuccessRate: 0.99 };
    const result = evaluatePromotionGate(
      baseline,
      candidate,
      { ...evidence, criticalSecurityViolations: 1 },
      policy,
    );

    expect(result.approved).toBe(false);
    expect(result.blockers).toContain('SECURITY:critical_violation');
  });

  it('blocks secret leakage, unauthorized side effects, failed holdout, and missing evidence', () => {
    const candidate = { ...baseline, taskSuccessRate: 0.99 };
    const result = evaluatePromotionGate(
      baseline,
      candidate,
      {
        ...evidence,
        secretLeaks: 1,
        unauthorizedSideEffects: 1,
        holdoutPassed: false,
        evidenceComplete: false,
      },
      policy,
    );

    expect(result.approved).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      'SECURITY:secret_leak',
      'SECURITY:unauthorized_side_effect',
      'HOLDOUT:failed_or_missing',
      'EVIDENCE:incomplete',
    ]));
  });

  it('blocks a candidate with attack-prevention or p95 latency regression', () => {
    const candidate = {
      ...baseline,
      taskSuccessRate: 0.95,
      attackPreventionRate: 0.99,
      p95LatencyMs: 1_500,
    };
    const result = evaluatePromotionGate(baseline, candidate, evidence, policy);

    expect(result.approved).toBe(false);
    expect(result.blockers).toContain('SECURITY:attack_prevention_regression');
    expect(result.blockers).toContain('PERFORMANCE:p95_latency_regression');
  });

  it('blocks a candidate whose target metric does not improve enough', () => {
    const candidate = { ...baseline, taskSuccessRate: 0.91 };
    const result = evaluatePromotionGate(baseline, candidate, evidence, policy);

    expect(result.approved).toBe(false);
    expect(result.blockers).toContain('TARGET:insufficient_taskSuccessRate_improvement');
  });

  it('fails closed on non-finite or out-of-range scorecard values', () => {
    const candidate = { ...baseline, taskSuccessRate: Number.NaN };
    const result = evaluatePromotionGate(baseline, candidate, evidence, policy);

    expect(result.approved).toBe(false);
    expect(result.blockers).toContain('INVALID_METRIC:taskSuccessRate');
  });
});
