import { describe, expect, it } from 'vitest';
import { FakeClock, SystemClock } from '../../../src/util/clock.js';

describe('SystemClock', () => {
  it('provides current Date and ISO string', () => {
    const clock = new SystemClock();
    const now = clock.now();
    expect(now).toBeInstanceOf(Date);
    expect(Number.isNaN(now.getTime())).toBe(false);

    const iso = clock.iso();
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('measures monotonic elapsed time', () => {
    const clock = new SystemClock();
    const t1 = clock.monotonicMs();
    expect(typeof t1).toBe('number');
    expect(t1).toBeGreaterThanOrEqual(0);
  });
});

describe('FakeClock', () => {
  it('initializes with default date', () => {
    const clock = new FakeClock();
    expect(clock.iso()).toBe('2026-01-01T00:00:00.000Z');
    expect(clock.monotonicMs()).toBe(0);
  });

  it('initializes with custom Date or ISO string', () => {
    const clock = new FakeClock('2026-06-15T12:00:00.000Z');
    expect(clock.iso()).toBe('2026-06-15T12:00:00.000Z');
  });

  it('advances time and monotonic counter deterministically', () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');
    clock.advance(5000);

    expect(clock.iso()).toBe('2026-01-01T00:00:05.000Z');
    expect(clock.monotonicMs()).toBe(5000);
    expect(clock.now().getTime()).toBe(new Date('2026-01-01T00:00:05.000Z').getTime());

    clock.advance(2500);
    expect(clock.iso()).toBe('2026-01-01T00:00:07.500Z');
    expect(clock.monotonicMs()).toBe(7500);
  });

  it('throws when advancing by negative milliseconds', () => {
    const clock = new FakeClock();
    expect(() => clock.advance(-100)).toThrow(RangeError);
  });

  it('sets absolute time and updates monotonic counter', () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');
    clock.setTime('2026-01-01T00:01:00.000Z');

    expect(clock.iso()).toBe('2026-01-01T00:01:00.000Z');
    expect(clock.monotonicMs()).toBe(60000);
  });

  it('throws when setting an invalid time', () => {
    const clock = new FakeClock();
    expect(() => clock.setTime('invalid-date-string')).toThrow(RangeError);
  });
});
