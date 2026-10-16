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

  it('accepts SleepOptions object with signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(50, { signal: controller.signal })).rejects.toSatisfy(isAirError);
  });
});
