import { describe, expect, it } from 'vitest';
import { sleep } from '../../../src/util/sleep.js';
import { isAirError } from '../../../src/errors/index.js';

describe('sleep', () => {
  it('resolves after specified milliseconds', async () => {
    const start = globalThis.performance.now();
    await sleep(20);
    const elapsed = globalThis.performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(15);
  });

  it('rejects on negative duration', async () => {
    await expect(sleep(-10)).rejects.toThrow(RangeError);
  });

  it('rejects immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Pre-aborted'));

    await expect(sleep(100, controller.signal)).rejects.toSatisfy((err: unknown) => {
      return isAirError(err) && err.cause?.message === 'Pre-aborted';
    });
  });

  it('aborts mid-sleep and rejects with AirError when aborted without explicit reason', async () => {
    const controller = new AbortController();
    const promise = sleep(500, controller.signal);

    setTimeout(() => {
      controller.abort();
    }, 20);

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      return isAirError(err) && err.code === 'CANCELLED';
    });
  });

  it('aborts mid-sleep with custom Error reason', async () => {
    const controller = new AbortController();
    const promise = sleep(500, controller.signal);

    setTimeout(() => {
      controller.abort(new Error('custom mid-sleep reason'));
    }, 20);

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      return isAirError(err) && err.code === 'CANCELLED' && err.cause?.message === 'custom mid-sleep reason';
    });
  });

  it('accepts SleepOptions object with signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(50, { signal: controller.signal })).rejects.toSatisfy(isAirError);
  });

  it('preserves existing AirError abort reason directly', async () => {
    const controller = new AbortController();
    const originalErr = new (await import('../../../src/errors/index.js')).AirError('CANCELLED', 'User explicitly cancelled');
    controller.abort(originalErr);

    await expect(sleep(50, controller.signal)).rejects.toBe(originalErr);
  });

  it('handles non-Error abort reason by setting cause to undefined', async () => {
    const controller = new AbortController();
    controller.abort('string-reason');

    await expect(sleep(50, controller.signal)).rejects.toSatisfy((err: unknown) => {
      return isAirError(err) && err.cause === undefined;
    });
  });
});
