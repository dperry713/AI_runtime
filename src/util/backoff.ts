/**
 * Full-jitter exponential backoff for AIR (Rule R6: Injected Random).
 */

import type { Random } from './random.js';
import { SystemRandom } from './random.js';

export interface BackoffOptions {
  /** Initial backoff duration in milliseconds (default: 500ms). */
  baseMs?: number | undefined;
  /** Maximum backoff duration in milliseconds (default: 30,000ms / 30s). */
  maxMs?: number | undefined;
  /** Exponential multiplier per attempt (default: 2). */
  factor?: number | undefined;
  /** Injected Random instance (default: SystemRandom). */
  random?: Random | undefined;
}

/**
 * Calculates a backoff duration using the Full Jitter algorithm:
 * ceiling = min(maxMs, baseMs * (factor ^ attempt))
 * sleep = random.nextFloat() * ceiling
 *
 * @param attempt - 0-based retry attempt number (0, 1, 2, ...).
 * @param options - Configuration options for backoff limits and jitter.
 * @returns Duration in milliseconds to wait before the next attempt.
 */
export function calculateBackoff(attempt: number, options: BackoffOptions = {}): number {
  if (attempt < 0) {
    throw new RangeError(`attempt must be >= 0, got ${attempt}`);
  }

  const baseMs = options.baseMs ?? 500;
  const maxMs = options.maxMs ?? 30_000;
  const factor = options.factor ?? 2;
  const random = options.random ?? new SystemRandom();

  if (baseMs <= 0) {
    throw new RangeError(`baseMs must be > 0, got ${baseMs}`);
  }
  if (maxMs < baseMs) {
    throw new RangeError(`maxMs (${maxMs}) must be >= baseMs (${baseMs})`);
  }
  if (factor < 1) {
    throw new RangeError(`factor must be >= 1, got ${factor}`);
  }

  // Prevent numeric overflow on large attempt numbers
  const exponentialMultiplier = Math.pow(factor, Math.min(attempt, 30));
  const ceiling = Math.min(maxMs, baseMs * exponentialMultiplier);

  return Math.round(random.nextFloat() * ceiling);
}

export const backoff = calculateBackoff;
