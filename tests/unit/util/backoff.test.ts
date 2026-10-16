import { describe, expect, it } from 'vitest';
import { calculateBackoff } from '../../../src/util/backoff.js';
import type { Random } from '../../../src/util/random.js';
import { SeededRandom } from '../../../src/util/random.js';

class MockRandom implements Random {
  constructor(private readonly fixedFloat: number) {}

  nextFloat(): number {
    return this.fixedFloat;
  }

  nextInt(min: number, max: number): number {
    return min + Math.floor(this.fixedFloat * (max - min + 1));
  }

  choice<T>(items: ReadonlyArray<T>): T | undefined {
    return items[0];
  }

  shuffle<T>(items: ReadonlyArray<T>): T[] {
    return [...items];
  }
}

describe('calculateBackoff (Full Jitter)', () => {
  it('calculates deterministic backoff with injected fixed Random', () => {
    // With nextFloat = 1.0 (max ceiling)
    const maxRandom = new MockRandom(1.0);
    expect(calculateBackoff(0, { baseMs: 100, factor: 2, random: maxRandom })).toBe(100);
    expect(calculateBackoff(1, { baseMs: 100, factor: 2, random: maxRandom })).toBe(200);
    expect(calculateBackoff(2, { baseMs: 100, factor: 2, random: maxRandom })).toBe(400);

    // With nextFloat = 0.5 (half ceiling)
    const halfRandom = new MockRandom(0.5);
    expect(calculateBackoff(0, { baseMs: 100, factor: 2, random: halfRandom })).toBe(50);
    expect(calculateBackoff(1, { baseMs: 100, factor: 2, random: halfRandom })).toBe(100);
  });

  it('caps at maxMs', () => {
    const maxRandom = new MockRandom(1.0);
    const delay = calculateBackoff(10, {
      baseMs: 100,
      maxMs: 1000,
      factor: 2,
      random: maxRandom,
    });
    expect(delay).toBe(1000);
  });

  it('produces deterministic series with SeededRandom', () => {
    const r1 = new SeededRandom('backoff-seed');
    const r2 = new SeededRandom('backoff-seed');

    const delays1 = [0, 1, 2, 3].map((attempt) => calculateBackoff(attempt, { baseMs: 200, random: r1 }));
    const delays2 = [0, 1, 2, 3].map((attempt) => calculateBackoff(attempt, { baseMs: 200, random: r2 }));

    expect(delays1).toEqual(delays2);
  });

  it('throws on invalid configuration', () => {
    expect(() => calculateBackoff(-1)).toThrow(RangeError);
    expect(() => calculateBackoff(0, { baseMs: 0 })).toThrow(RangeError);
    expect(() => calculateBackoff(0, { baseMs: 1000, maxMs: 500 })).toThrow(RangeError);
    expect(() => calculateBackoff(0, { factor: 0.5 })).toThrow(RangeError);
  });
});
