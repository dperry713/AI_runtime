/**
 * Clock abstractions for AIR (Rule R6: No raw Date.now() in domain logic).
 */

export interface Clock {
  /** Returns the current Date. */
  now(): Date;
  /** Returns monotonic elapsed milliseconds. */
  monotonicMs(): number;
  /** Returns current time formatted as ISO-8601 UTC. */
  iso(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  monotonicMs(): number {
    return globalThis.performance.now();
  }

  iso(): string {
    return new Date().toISOString();
  }
}

export class FakeClock implements Clock {
  private currentTimeMs: number;
  private currentMonotonicMs: number;

  constructor(initialTimeOrIso?: Date | string | number) {
    if (initialTimeOrIso instanceof Date) {
      this.currentTimeMs = initialTimeOrIso.getTime();
    } else if (typeof initialTimeOrIso === 'string') {
      this.currentTimeMs = new Date(initialTimeOrIso).getTime();
    } else if (typeof initialTimeOrIso === 'number') {
      this.currentTimeMs = initialTimeOrIso;
    } else {
      this.currentTimeMs = new Date('2026-01-01T00:00:00.000Z').getTime();
    }
    this.currentMonotonicMs = 0;
  }

  now(): Date {
    return new Date(this.currentTimeMs);
  }

  monotonicMs(): number {
    return this.currentMonotonicMs;
  }

  iso(): string {
    return new Date(this.currentTimeMs).toISOString();
  }

  /** Advances the clock by the given number of milliseconds. */
  advance(ms: number): void {
    if (ms < 0) {
      throw new RangeError('Cannot advance FakeClock by negative milliseconds');
    }
    this.currentTimeMs += ms;
    this.currentMonotonicMs += ms;
  }

  /** Sets the clock to an absolute time. */
  setTime(timeOrIso: Date | string | number): void {
    const newMs = timeOrIso instanceof Date
      ? timeOrIso.getTime()
      : typeof timeOrIso === 'string'
        ? new Date(timeOrIso).getTime()
        : timeOrIso;

    if (isNaN(newMs)) {
      throw new RangeError('Invalid time passed to FakeClock.setTime');
    }

    if (newMs > this.currentTimeMs) {
      this.currentMonotonicMs += (newMs - this.currentTimeMs);
    }
    this.currentTimeMs = newMs;
  }
}
