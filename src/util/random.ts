/**
 * Randomness abstractions for AIR (Rule R6: No raw Math.random() in domain logic).
 */

import { getRandomValues } from 'node:crypto';

export interface Random {
  /** Returns a pseudo-random floating point number in [0, 1). */
  nextFloat(): number;
  /** Returns a pseudo-random integer in [min, max] inclusive. */
  nextInt(min: number, max: number): number;
  /** Returns a random element from an array, or undefined if empty. */
  choice<T>(items: ReadonlyArray<T>): T | undefined;
  /** Returns a new array with elements shuffled using the Fisher-Yates algorithm. */
  shuffle<T>(items: ReadonlyArray<T>): T[];
}

export class SystemRandom implements Random {
  nextFloat(): number {
    const buffer = new Uint32Array(1);
    getRandomValues(buffer);
    const view = new DataView(buffer.buffer);
    const value = view.getUint32(0);
    return value / 0x100000000;
  }

  nextInt(min: number, max: number): number {
    if (min > max) {
      throw new RangeError(`min (${min}) must be <= max (${max})`);
    }
    const range = max - min + 1;
    return min + Math.floor(this.nextFloat() * range);
  }

  choice<T>(items: ReadonlyArray<T>): T | undefined {
    if (items.length === 0) {
      return undefined;
    }
    const index = this.nextInt(0, items.length - 1);
    return items[index];
  }

  shuffle<T>(items: ReadonlyArray<T>): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i);
      const temp = copy[i];
      const target = copy[j];
      if (temp !== undefined && target !== undefined) {
        copy[i] = target;
        copy[j] = temp;
      }
    }
    return copy;
  }
}

/**
 * Deterministic pseudo-random number generator based on Mulberry32 algorithm.
 */
export class SeededRandom implements Random {
  private state: number;

  constructor(seed: number | string = 0) {
    if (typeof seed === 'string') {
      let hash = 0;
      for (let i = 0; i < seed.length; i++) {
        hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
      }
      this.state = hash;
    } else {
      this.state = seed >>> 0;
    }
  }

  nextFloat(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextInt(min: number, max: number): number {
    if (min > max) {
      throw new RangeError(`min (${min}) must be <= max (${max})`);
    }
    const range = max - min + 1;
    return min + Math.floor(this.nextFloat() * range);
  }

  choice<T>(items: ReadonlyArray<T>): T | undefined {
    if (items.length === 0) {
      return undefined;
    }
    const index = this.nextInt(0, items.length - 1);
    return items[index];
  }

  shuffle<T>(items: ReadonlyArray<T>): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i);
      const temp = copy[i];
      const target = copy[j];
      if (temp !== undefined && target !== undefined) {
        copy[i] = target;
        copy[j] = temp;
      }
    }
    return copy;
  }
}
