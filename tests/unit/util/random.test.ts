import { describe, expect, it } from 'vitest';
import { SeededRandom, SystemRandom } from '../../../src/util/random.js';

describe('SystemRandom', () => {
  it('generates floats in [0, 1)', () => {
    const random = new SystemRandom();
    for (let i = 0; i < 50; i++) {
      const val = random.nextFloat();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  it('generates integers within specified inclusive range', () => {
    const random = new SystemRandom();
    const min = 5;
    const max = 10;
    const seen = new Set<number>();

    for (let i = 0; i < 100; i++) {
      const val = random.nextInt(min, max);
      expect(val).toBeGreaterThanOrEqual(min);
      expect(val).toBeLessThanOrEqual(max);
      expect(Number.isInteger(val)).toBe(true);
      seen.add(val);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('throws when min > max', () => {
    const random = new SystemRandom();
    expect(() => random.nextInt(10, 5)).toThrow(RangeError);
  });

  it('picks random choices and handles empty arrays', () => {
    const random = new SystemRandom();
    expect(random.choice([])).toBeUndefined();

    const items = ['apple', 'banana', 'cherry'];
    const chosen = random.choice(items);
    expect(items).toContain(chosen);
  });

  it('shuffles arrays non-destructively', () => {
    const random = new SystemRandom();
    const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const copy = [...original];
    const shuffled = random.shuffle(original);

    expect(original).toEqual(copy); // Not mutated
    expect(shuffled).toHaveLength(original.length);
    expect(shuffled.sort((a, b) => a - b)).toEqual(original);
  });
});

describe('SeededRandom', () => {
  it('generates identical sequences for identical seeds', () => {
    const rng1 = new SeededRandom(12345);
    const rng2 = new SeededRandom(12345);

    const floats1 = Array.from({ length: 20 }, () => rng1.nextFloat());
    const floats2 = Array.from({ length: 20 }, () => rng2.nextFloat());

    expect(floats1).toEqual(floats2);

    const ints1 = Array.from({ length: 20 }, () => rng1.nextInt(1, 100));
    const ints2 = Array.from({ length: 20 }, () => rng2.nextInt(1, 100));

    expect(ints1).toEqual(ints2);
  });

  it('generates different sequences for different seeds', () => {
    const rng1 = new SeededRandom(111);
    const rng2 = new SeededRandom(222);

    const floats1 = Array.from({ length: 10 }, () => rng1.nextFloat());
    const floats2 = Array.from({ length: 10 }, () => rng2.nextFloat());

    expect(floats1).not.toEqual(floats2);
  });

  it('accepts string seeds deterministically', () => {
    const rng1 = new SeededRandom('air-deterministic-seed');
    const rng2 = new SeededRandom('air-deterministic-seed');

    const seq1 = Array.from({ length: 10 }, () => rng1.nextInt(0, 1000));
    const seq2 = Array.from({ length: 10 }, () => rng2.nextInt(0, 1000));

    expect(seq1).toEqual(seq2);
  });

  it('shuffles deterministically with SeededRandom', () => {
    const rng1 = new SeededRandom('shuffle-seed');
    const rng2 = new SeededRandom('shuffle-seed');

    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const s1 = rng1.shuffle(items);
    const s2 = rng2.shuffle(items);

    expect(s1).toEqual(s2);
  });

  it('throws when min > max for SeededRandom', () => {
    const rng = new SeededRandom(42);
    expect(() => rng.nextInt(10, 5)).toThrow(RangeError);
  });

  it('handles choice on empty and non-empty arrays with SeededRandom', () => {
    const rng = new SeededRandom(42);
    expect(rng.choice([])).toBeUndefined();

    const items = ['alpha', 'beta', 'gamma'];
    const chosen = rng.choice(items);
    expect(items).toContain(chosen);
  });
});
