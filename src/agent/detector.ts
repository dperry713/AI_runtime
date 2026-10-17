/**
 * Stall & Loop Detector (Phase 6 - P6-T07).
 *
 * Implements heuristics to prevent autonomous agents from falling into infinite loops:
 * - Repeated identical tool calls (same tool + same arguments)
 * - Oscillating / ping-pong cycles (e.g. tool A -> tool B -> tool A -> tool B)
 * - Repeated identical errors without progress
 * - Max steps guard
 *
 * Adheres to:
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 */

import { AirError } from '../errors/index.js';

export interface ToolCallSnapshot {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly output?: unknown;
  readonly error?: { readonly code: string; readonly message: string } | undefined;
}

export interface StallDetectorConfig {
  /** Maximum consecutive identical calls permitted before flagging stall. Default: 3. */
  readonly maxIdenticalCalls?: number | undefined;
  /** Maximum cycle repetitions permitted (e.g. A->B->A->B). Default: 2. */
  readonly maxCycleRepetitions?: number | undefined;
  /** Maximum repeated identical tool errors before flagging stall. Default: 3. */
  readonly maxRepeatedErrors?: number | undefined;
  /** Hard upper bound on total turns. Default: 100. */
  readonly maxTurns?: number | undefined;
}

export type StallType =
  | 'identical_calls'
  | 'cycle_detected'
  | 'repeated_failure'
  | 'max_turns_exceeded';

export interface StallDetectionResult {
  readonly isStalled: boolean;
  readonly type?: StallType | undefined;
  readonly reason?: string | undefined;
  readonly details?: Record<string, unknown> | undefined;
}

/**
 * Computes a deterministic canonical string representation of an object.
 */
function canonicalize(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map(canonicalize).join(',')}]`;
  }
  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Computes a signature for a tool call based on name and canonicalized arguments.
 */
export function computeToolCallSignature(name: string, args: Record<string, unknown>): string {
  return `${name}:${canonicalize(args)}`;
}

export class StallDetector {
  private readonly maxIdenticalCalls: number;
  private readonly maxCycleRepetitions: number;
  private readonly maxRepeatedErrors: number;
  private readonly maxTurns: number;

  private turnCount = 0;
  private readonly callHistory: Array<{
    turnIndex: number;
    signature: string;
    hasError: boolean;
    errorCode?: string | undefined;
  }> = [];

  public constructor(config?: StallDetectorConfig) {
    this.maxIdenticalCalls = config?.maxIdenticalCalls ?? 3;
    this.maxCycleRepetitions = config?.maxCycleRepetitions ?? 2;
    this.maxRepeatedErrors = config?.maxRepeatedErrors ?? 3;
    this.maxTurns = config?.maxTurns ?? 100;
  }

  /**
   * Records a turn's tool executions and immediately evaluates stall heuristics.
   */
  public recordTurn(
    turnIndex: number,
    toolCalls: readonly ToolCallSnapshot[],
  ): StallDetectionResult {
    this.turnCount++;

    if (this.turnCount > this.maxTurns) {
      return {
        isStalled: true,
        type: 'max_turns_exceeded',
        reason: `Run exceeded maximum allowed turns limit of ${this.maxTurns}`,
        details: { turnCount: this.turnCount, maxTurns: this.maxTurns },
      };
    }

    if (toolCalls.length === 0) {
      return { isStalled: false };
    }

    for (const call of toolCalls) {
      const sig = computeToolCallSignature(call.name, call.arguments);
      this.callHistory.push({
        turnIndex,
        signature: sig,
        hasError: Boolean(call.error),
        errorCode: call.error?.code,
      });
    }

    return this.evaluate();
  }

  /**
   * Asserts whether a stall is detected and throws an AirError if so.
   */
  public assertNotStalled(
    turnIndex: number,
    toolCalls: readonly ToolCallSnapshot[],
  ): void {
    const result = this.recordTurn(turnIndex, toolCalls);
    if (result.isStalled) {
      throw new AirError('AGENT_STALL_DETECTED', result.reason ?? 'Agent loop/stall detected', {
        context: {
          stallType: result.type,
          details: result.details,
        },
      });
    }
  }

  /**
   * Evaluates the current call history against stall detection rules.
   */
  public evaluate(): StallDetectionResult {
    const historyLen = this.callHistory.length;
    if (historyLen < 2) {
      return { isStalled: false };
    }

    // 1. Repeated identical errors check (more specific than generic identical calls)
    if (historyLen >= this.maxRepeatedErrors) {
      const recent = this.callHistory.slice(-this.maxRepeatedErrors);
      const allFailed = recent.every((item) => item.hasError);
      if (allFailed) {
        const firstCode = recent[0]?.errorCode;
        const firstSig = recent[0]?.signature;
        if (recent.every((item) => item.errorCode === firstCode && item.signature === firstSig)) {
          return {
            isStalled: true,
            type: 'repeated_failure',
            reason: `Agent failed with the same error "${firstCode}" on "${firstSig}" ${this.maxRepeatedErrors} times consecutively`,
            details: { signature: firstSig, errorCode: firstCode, count: this.maxRepeatedErrors },
          };
        }
      }
    }

    // 2. Repeated identical calls check
    if (historyLen >= this.maxIdenticalCalls) {
      const recent = this.callHistory.slice(-this.maxIdenticalCalls);
      const firstSig = recent[0]?.signature;
      if (firstSig && recent.every((item) => item.signature === firstSig)) {
        return {
          isStalled: true,
          type: 'identical_calls',
          reason: `Agent executed identical tool call ${this.maxIdenticalCalls} consecutive times without changes: "${firstSig}"`,
          details: { signature: firstSig, count: this.maxIdenticalCalls },
        };
      }
    }

    // 3. Cycle / Ping-Pong detection (e.g., period 2: A, B, A, B; period 3: A, B, C, A, B, C)
    const signatures = this.callHistory.map((h) => h.signature);
    for (let period = 2; period <= 4; period++) {
      const neededLength = period * (this.maxCycleRepetitions + 1);
      if (signatures.length >= neededLength) {
        const slice = signatures.slice(-neededLength);
        let isCycle = true;
        for (let i = 0; i < neededLength; i++) {
          if (slice[i] !== slice[i % period]) {
            isCycle = false;
            break;
          }
        }
        if (isCycle) {
          const pattern = slice.slice(0, period);
          return {
            isStalled: true,
            type: 'cycle_detected',
            reason: `Agent caught in repeating cycle of length ${period} repeated ${this.maxCycleRepetitions + 1} times: [${pattern.join(' -> ')}]`,
            details: { period, pattern },
          };
        }
      }
    }

    return { isStalled: false };
  }

  public reset(): void {
    this.turnCount = 0;
    this.callHistory.length = 0;
  }
}
