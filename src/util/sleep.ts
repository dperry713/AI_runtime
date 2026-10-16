/**
 * Abortable sleep utility for AIR.
 */

import { AirError, isAirError } from '../errors/index.js';

export interface SleepOptions {
  signal?: AbortSignal | undefined;
}

function toAbortAirError(reason: unknown, ms: number, beforeExecution: boolean): AirError {
  if (isAirError(reason)) {
    return reason;
  }
  const cause = reason instanceof Error ? reason : undefined;
  const message = beforeExecution
    ? 'Sleep was aborted before execution'
    : 'Sleep was aborted';
  return new AirError('CANCELLED', message, {
    retryable: false,
    cause,
    context: { ms },
  });
}

export function sleep(ms: number, signalOrOptions?: AbortSignal | SleepOptions): Promise<void> {
  if (ms < 0) {
    return Promise.reject(new RangeError(`Sleep duration must be non-negative, got ${ms}`));
  }

  const signal = signalOrOptions instanceof AbortSignal
    ? signalOrOptions
    : signalOrOptions?.signal;

  if (signal?.aborted) {
    return Promise.reject(toAbortAirError(signal.reason, ms, true));
  }

  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;

    const onAbort = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      reject(toAbortAirError(signal?.reason, ms, false));
    };

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
