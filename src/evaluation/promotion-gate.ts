/**
 * Deterministic candidate promotion gate for benchmark-driven strategy changes.
 *
 * This module only evaluates evidence supplied by the caller; it does not
 * execute candidates, persist versions, or perform deployment/rollback.
 */

export type PromotionTargetMetric =
  | 'taskSuccessRate'
  | 'attackPreventionRate'
  | 'recoveryRate';

export interface BenchmarkScorecard {
  readonly taskSuccessRate: number;
  readonly attackPreventionRate: number;
  readonly falseDenialRate: number;
  readonly recoveryRate: number;
  readonly p95LatencyMs: number;
}

export interface PromotionEvidence {
  readonly criticalSecurityViolations: number;
  readonly secretLeaks: number;
  readonly unauthorizedSideEffects: number;
  readonly holdoutPassed: boolean;
  readonly evidenceComplete: boolean;
}

export interface PromotionPolicy {
  readonly targetMetric: PromotionTargetMetric;
  /** Required absolute improvement in the target rate, e.g. 0.02 = +2 percentage points. */
  readonly minTargetImprovement: number;
  readonly maxTaskSuccessRegression: number;
  readonly maxAttackPreventionRegression: number;
  readonly maxFalseDenialRegression: number;
  readonly maxRecoveryRegression: number;
  /** Maximum allowed proportional p95 latency increase, e.g. 0.10 = +10%. */
  readonly maxP95LatencyRegressionRatio: number;
}

export interface PromotionGateResult {
  readonly approved: boolean;
  readonly blockers: readonly string[];
  readonly deltas: Readonly<Record<keyof BenchmarkScorecard, number>>;
}

const RATE_METRICS = [
  'taskSuccessRate',
  'attackPreventionRate',
  'falseDenialRate',
  'recoveryRate',
] as const;

function isValidRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isValidNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function evaluatePromotionGate(
  baseline: BenchmarkScorecard,
  candidate: BenchmarkScorecard,
  evidence: PromotionEvidence,
  policy: PromotionPolicy,
): PromotionGateResult {
  const blockers: string[] = [];
  const deltas: Record<keyof BenchmarkScorecard, number> = {
    taskSuccessRate: candidate.taskSuccessRate - baseline.taskSuccessRate,
    attackPreventionRate: candidate.attackPreventionRate - baseline.attackPreventionRate,
    falseDenialRate: candidate.falseDenialRate - baseline.falseDenialRate,
    recoveryRate: candidate.recoveryRate - baseline.recoveryRate,
    p95LatencyMs: candidate.p95LatencyMs - baseline.p95LatencyMs,
  };

  for (const metric of RATE_METRICS) {
    if (!isValidRate(baseline[metric]) || !isValidRate(candidate[metric])) {
      blockers.push(`INVALID_METRIC:${metric}`);
    }
  }
  if (!isValidNonNegative(baseline.p95LatencyMs) || !isValidNonNegative(candidate.p95LatencyMs)) {
    blockers.push('INVALID_METRIC:p95LatencyMs');
  }

  if (!Number.isInteger(evidence.criticalSecurityViolations) || evidence.criticalSecurityViolations < 0) {
    blockers.push('INVALID_EVIDENCE:criticalSecurityViolations');
  } else if (evidence.criticalSecurityViolations > 0) {
    blockers.push('SECURITY:critical_violation');
  }
  if (!Number.isInteger(evidence.secretLeaks) || evidence.secretLeaks < 0) {
    blockers.push('INVALID_EVIDENCE:secretLeaks');
  } else if (evidence.secretLeaks > 0) {
    blockers.push('SECURITY:secret_leak');
  }
  if (!Number.isInteger(evidence.unauthorizedSideEffects) || evidence.unauthorizedSideEffects < 0) {
    blockers.push('INVALID_EVIDENCE:unauthorizedSideEffects');
  } else if (evidence.unauthorizedSideEffects > 0) {
    blockers.push('SECURITY:unauthorized_side_effect');
  }
  if (!evidence.holdoutPassed) blockers.push('HOLDOUT:failed_or_missing');
  if (!evidence.evidenceComplete) blockers.push('EVIDENCE:incomplete');

  if (!isValidNonNegative(policy.minTargetImprovement)) blockers.push('INVALID_POLICY:minTargetImprovement');
  if (!isValidNonNegative(policy.maxTaskSuccessRegression)) blockers.push('INVALID_POLICY:maxTaskSuccessRegression');
  if (!isValidNonNegative(policy.maxAttackPreventionRegression)) blockers.push('INVALID_POLICY:maxAttackPreventionRegression');
  if (!isValidNonNegative(policy.maxFalseDenialRegression)) blockers.push('INVALID_POLICY:maxFalseDenialRegression');
  if (!isValidNonNegative(policy.maxRecoveryRegression)) blockers.push('INVALID_POLICY:maxRecoveryRegression');
  if (!isValidNonNegative(policy.maxP95LatencyRegressionRatio)) blockers.push('INVALID_POLICY:maxP95LatencyRegressionRatio');

  if (blockers.some((blocker) => blocker.startsWith('INVALID_'))) {
    return { approved: false, blockers, deltas };
  }

  if (deltas.taskSuccessRate < -policy.maxTaskSuccessRegression) {
    blockers.push('QUALITY:task_success_regression');
  }
  if (deltas.attackPreventionRate < -policy.maxAttackPreventionRegression) {
    blockers.push('SECURITY:attack_prevention_regression');
  }
  if (deltas.falseDenialRate > policy.maxFalseDenialRegression) {
    blockers.push('QUALITY:false_denial_regression');
  }
  if (deltas.recoveryRate < -policy.maxRecoveryRegression) {
    blockers.push('RESILIENCE:recovery_regression');
  }

  const latencyLimit = baseline.p95LatencyMs * (1 + policy.maxP95LatencyRegressionRatio);
  if (candidate.p95LatencyMs > latencyLimit) {
    blockers.push('PERFORMANCE:p95_latency_regression');
  }

  const targetDelta = deltas[policy.targetMetric];
  if (targetDelta < policy.minTargetImprovement) {
    blockers.push(`TARGET:insufficient_${policy.targetMetric}_improvement`);
  }

  return { approved: blockers.length === 0, blockers, deltas };
}
