/**
 * Unit tests for Provider Resilience Wrapper & Circuit Breaker (P3-T06).
 */

import { describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import { MockProvider } from '../../../src/providers/mock.js';
import {
  CircuitBreaker,
  defaultIsFailure,
  defaultIsRetryable,
  defaultShouldFallback,
  ResilientProvider,
  type ResilienceEvent,
} from '../../../src/providers/resilience.js';
import {
  extractText,
  type NormalizedRequest,
  type ProviderStreamEvent,
} from '../../../src/providers/types.js';
import { FakeClock } from '../../../src/util/clock.js';
import { SeededRandom } from '../../../src/util/random.js';

describe('CircuitBreaker', () => {
  it('starts in CLOSED state with 0 failures', () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker('test-p', { failureThreshold: 3 }, clock);

    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.canExecute()).toBe(true);
    const stats = breaker.getStats();
    expect(stats.consecutiveFailures).toBe(0);
    expect(stats.consecutiveSuccesses).toBe(0);
  });

  it('trips to OPEN after failureThreshold consecutive failures', () => {
    const clock = new FakeClock();
    const stateChanges: Array<{ from: string; to: string; reason?: string | undefined }> = [];
    const breaker = new CircuitBreaker(
      'test-p',
      { failureThreshold: 3, recoveryTimeoutMs: 5000 },
      clock,
      (from, to, reason) => stateChanges.push({ from, to, reason }),
    );

    breaker.recordFailure(new AirError('PROVIDER_UNAVAILABLE', 'Server down 1'));
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.canExecute()).toBe(true);

    breaker.recordFailure(new AirError('PROVIDER_UNAVAILABLE', 'Server down 2'));
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.canExecute()).toBe(true);

    breaker.recordFailure(new AirError('PROVIDER_UNAVAILABLE', 'Server down 3'));
    expect(breaker.getState()).toBe('OPEN');
    expect(breaker.canExecute()).toBe(false);
    expect(stateChanges).toEqual([
      { from: 'CLOSED', to: 'OPEN', reason: 'Failure threshold (3) reached' },
    ]);
  });

  it('resets consecutive failures when recordSuccess() is called in CLOSED state', () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker('test-p', { failureThreshold: 3 }, clock);

    breaker.recordFailure(new AirError('PROVIDER_UNAVAILABLE', 'Temporary blip'));
    expect(breaker.getStats().consecutiveFailures).toBe(1);

    breaker.recordSuccess();
    expect(breaker.getStats().consecutiveFailures).toBe(0);
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('transitions to HALF-OPEN after recoveryTimeoutMs', () => {
    const clock = new FakeClock();
    const stateChanges: Array<{ from: string; to: string; reason?: string | undefined }> = [];
    const breaker = new CircuitBreaker(
      'test-p',
      { failureThreshold: 2, recoveryTimeoutMs: 10_000, halfOpenMaxAttempts: 1 },
      clock,
      (from, to, reason) => stateChanges.push({ from, to, reason }),
    );

    breaker.recordFailure(new AirError('PROVIDER_UNAVAILABLE', 'err 1'));
    breaker.recordFailure(new AirError('PROVIDER_UNAVAILABLE', 'err 2'));
    expect(breaker.getState()).toBe('OPEN');
    expect(breaker.canExecute()).toBe(false);

    // Advance 5 seconds — still OPEN
    clock.advance(5_000);
    expect(breaker.getState()).toBe('OPEN');
    expect(breaker.canExecute()).toBe(false);

    // Advance 5 more seconds — hits 10s cooldown
    clock.advance(5_000);
    expect(breaker.getState()).toBe('HALF_OPEN');
    expect(breaker.canExecute()).toBe(true);
    expect(stateChanges).toContainEqual({
      from: 'OPEN',
      to: 'HALF_OPEN',
      reason: 'Recovery cooldown elapsed',
    });
  });

  it('closes circuit after successful trial in HALF-OPEN state', () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker(
      'test-p',
      { failureThreshold: 1, recoveryTimeoutMs: 1_000, halfOpenMaxAttempts: 1 },
      clock,
    );

    breaker.recordFailure(new AirError('PROVIDER_UNAVAILABLE', 'failure'));
    expect(breaker.getState()).toBe('OPEN');

    clock.advance(1_000);
    expect(breaker.getState()).toBe('HALF_OPEN');

    breaker.recordAttempt();
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.canExecute()).toBe(true);
  });

  it('re-opens circuit immediately if trial in HALF-OPEN state fails', () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker(
      'test-p',
      { failureThreshold: 1, recoveryTimeoutMs: 1_000, halfOpenMaxAttempts: 1 },
      clock,
    );

    breaker.recordFailure(new AirError('PROVIDER_UNAVAILABLE', 'failure'));
    clock.advance(1_000);
    expect(breaker.getState()).toBe('HALF_OPEN');

    breaker.recordAttempt();
    breaker.recordFailure(new AirError('PROVIDER_UNAVAILABLE', 'trial failed'));
    expect(breaker.getState()).toBe('OPEN');
    expect(breaker.canExecute()).toBe(false);
  });

  it('supports manual forceOpen, forceClose, and reset', () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker('test-p', {}, clock);

    breaker.forceOpen();
    expect(breaker.getState()).toBe('OPEN');

    breaker.forceClose();
    expect(breaker.getState()).toBe('CLOSED');

    breaker.forceOpen();
    expect(breaker.getState()).toBe('OPEN');

    breaker.reset();
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('ignores non-service errors according to defaultIsFailure', () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker('test-p', { failureThreshold: 2 }, clock);

    breaker.recordFailure(new AirError('PROVIDER_INVALID_REQUEST', 'bad json'));
    breaker.recordFailure(new AirError('PROVIDER_AUTH_FAILED', 'bad key'));
    breaker.recordFailure(new AirError('PERMISSION_DENIED', 'forbidden'));
    breaker.recordFailure(new AirError('CANCELLED', 'user aborted'));

    expect(breaker.getStats().consecutiveFailures).toBe(0);
    expect(breaker.getState()).toBe('CLOSED');
  });
});

describe('ResilientProvider', () => {
  const dummyRequest: NormalizedRequest = {
    model: 'claude-3-5-sonnet',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  };

  it('throws TypeError if primary provider is missing', () => {
    expect(() => new ResilientProvider(undefined as unknown as MockProvider)).toThrow(TypeError);
  });

  it('transparently executes complete() on a healthy primary provider', async () => {
    const primary = new MockProvider({ id: 'mock-primary' });
    primary.enqueueResponse('Success response', {
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    const resilient = new ResilientProvider(primary);
    expect(resilient.id).toBe('resilient(mock-primary)');
    expect(resilient.type).toBe('mock');
    expect(resilient.defaultModel).toBe(primary.defaultModel);
    expect(resilient.capabilities).toEqual(primary.capabilities);

    const response = await resilient.complete(dummyRequest);
    expect(extractText(response.message)).toBe('Success response');
    expect(resilient.getCircuitState()).toBe('CLOSED');
  });

  it('transparently streams on a healthy primary provider', async () => {
    const primary = new MockProvider({ id: 'mock-primary' });
    primary.enqueueResponse('Streamed message');

    const resilient = new ResilientProvider(primary);
    const events: ProviderStreamEvent[] = [];
    for await (const event of resilient.stream(dummyRequest)) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.type).toBe('stream_start');
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(events.some((e) => e.type === 'stream_end')).toBe(true);
  });

  it('retries with exponential backoff on retryable error', async () => {
    const primary = new MockProvider({ id: 'mock-primary' });
    primary.enqueueError(new AirError('PROVIDER_UNAVAILABLE', 'Temporary outage 1', { retryable: true }));
    primary.enqueueError(new AirError('PROVIDER_UNAVAILABLE', 'Temporary outage 2', { retryable: true }));
    primary.enqueueResponse('Recovered after 2 retries');

    const clock = new FakeClock();
    const random = new SeededRandom(12345);
    const sleepCalls: number[] = [];
    const events: ResilienceEvent[] = [];

    const resilient = new ResilientProvider(primary, {
      clock,
      random,
      retry: {
        maxAttempts: 3,
        baseMs: 100,
        factor: 2,
        jitter: true,
      },
      sleepFn: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
      onEvent: (evt) => events.push(evt),
    });

    const response = await resilient.complete(dummyRequest);
    expect(extractText(response.message)).toBe('Recovered after 2 retries');
    expect(sleepCalls.length).toBe(2);

    const retryEvents = events.filter((e) => e.type === 'retry');
    expect(retryEvents.length).toBe(2);
    expect(retryEvents[0]?.attempt).toBe(1);
    expect(retryEvents[1]?.attempt).toBe(2);
  });

  it('respects 429 Retry-After context header', async () => {
    const primary = new MockProvider({ id: 'mock-primary' });
    primary.enqueueError(
      new AirError('PROVIDER_RATE_LIMITED', 'Rate limited', {
        retryable: true,
        context: { status: 429, retryAfterMs: 1500 },
      }),
    );
    primary.enqueueResponse('Success after 429');

    const sleepCalls: number[] = [];
    const resilient = new ResilientProvider(primary, {
      retry: {
        maxAttempts: 2,
        respectRetryAfter: true,
      },
      sleepFn: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
    });

    const response = await resilient.complete(dummyRequest);
    expect(extractText(response.message)).toBe('Success after 429');
    expect(sleepCalls).toEqual([1500]);
  });

  it('does not retry non-retryable errors (e.g. PROVIDER_AUTH_FAILED)', async () => {
    const primary = new MockProvider({ id: 'mock-primary' });
    primary.enqueueError(new AirError('PROVIDER_AUTH_FAILED', 'Invalid API key', { retryable: false }));
    primary.enqueueResponse('Should not run');

    let retried = false;
    const resilient = new ResilientProvider(primary, {
      retry: { maxAttempts: 3 },
      sleepFn: () => {
        retried = true;
        return Promise.resolve();
      },
    });

    let caughtError: unknown;
    try {
      await resilient.complete(dummyRequest);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(AirError);
    expect((caughtError as AirError).code).toBe('PROVIDER_AUTH_FAILED');
    expect(retried).toBe(false);
  });

  it('handles per-attempt request timeout with retry', async () => {
    const primary = new MockProvider({ id: 'mock-primary' });
    primary.enqueue({
      delayMs: 100,
      response: 'Too slow',
    });
    primary.enqueueResponse('Fast response');

    const events: ResilienceEvent[] = [];
    const resilient = new ResilientProvider(primary, {
      timeoutMs: 30,
      retry: { maxAttempts: 2, baseMs: 10, jitter: false },
      onEvent: (evt) => events.push(evt),
    });

    const response = await resilient.complete(dummyRequest);
    expect(extractText(response.message)).toBe('Fast response');
    expect(events.some((e) => e.type === 'timeout')).toBe(true);
    expect(events.some((e) => e.type === 'retry')).toBe(true);
  });

  it('aborts immediately without retry when user signal cancels', async () => {
    const primary = new MockProvider({ id: 'mock-primary' });
    primary.enqueue({
      delayMs: 1000,
      response: 'Slow',
    });

    const resilient = new ResilientProvider(primary, {
      retry: { maxAttempts: 3 },
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(new AirError('CANCELLED', 'User abort')), 20);

    let caughtError: unknown;
    try {
      await resilient.complete(dummyRequest, { signal: controller.signal });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(AirError);
    expect((caughtError as AirError).code).toBe('CANCELLED');
    expect(resilient.getCircuitState()).toBe('CLOSED');
  });

  it('aborts immediately if user signal is already aborted', async () => {
    const primary = new MockProvider({ id: 'mock-primary' });
    primary.enqueueResponse('OK');

    const resilient = new ResilientProvider(primary);
    const controller = new AbortController();
    controller.abort(new AirError('CANCELLED', 'Already cancelled'));

    await expect(
      resilient.complete(dummyRequest, { signal: controller.signal }),
    ).rejects.toThrow('Already cancelled');

    const stream = resilient.stream(dummyRequest, { signal: controller.signal });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow('Already cancelled');
  });

  it('falls back to secondary provider when primary fails and exhausts retries', async () => {
    const primary = new MockProvider({ id: 'primary-mock' });
    primary.enqueueError(new AirError('PROVIDER_UNAVAILABLE', 'Primary down 1', { retryable: true }));
    primary.enqueueError(new AirError('PROVIDER_UNAVAILABLE', 'Primary down 2', { retryable: true }));

    const fallback = new MockProvider({ id: 'fallback-mock' });
    fallback.enqueueResponse('Fallback response');

    const events: ResilienceEvent[] = [];
    const resilient = new ResilientProvider(primary, {
      retry: { maxAttempts: 2, baseMs: 1, jitter: false },
      fallback: {
        fallbacks: [fallback],
      },
      onEvent: (evt) => events.push(evt),
    });

    const response = await resilient.complete(dummyRequest);
    expect(extractText(response.message)).toBe('Fallback response');

    const fallbackEvents = events.filter((e) => e.type === 'fallback');
    expect(fallbackEvents.length).toBe(1);
    expect(fallbackEvents[0]?.fromProviderId).toBe('primary-mock');
    expect(fallbackEvents[0]?.toProviderId).toBe('fallback-mock');
  });

  it('short-circuits to fallback immediately when primary circuit breaker is OPEN', async () => {
    const primary = new MockProvider({ id: 'primary-mock' });
    const fallback = new MockProvider({ id: 'fallback-mock' });
    fallback.enqueueResponse('Served by fallback while primary is down');

    const resilient = new ResilientProvider(primary, {
      fallback: { fallbacks: [fallback] },
    });

    // Force primary circuit breaker OPEN
    resilient.getCircuitBreaker('primary-mock')?.forceOpen();
    expect(resilient.getCircuitState('primary-mock')).toBe('OPEN');

    const response = await resilient.complete(dummyRequest);
    expect(extractText(response.message)).toBe('Served by fallback while primary is down');
  });

  it('throws circuit breaker OPEN error if no fallbacks exist', async () => {
    const primary = new MockProvider({ id: 'primary-mock' });

    const resilient = new ResilientProvider(primary);
    resilient.getCircuitBreaker()?.forceOpen();

    let caughtError: unknown;
    try {
      await resilient.complete(dummyRequest);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(AirError);
    expect((caughtError as AirError).code).toBe('PROVIDER_UNAVAILABLE');
    expect((caughtError as AirError).message).toContain('Circuit breaker is OPEN');
  });

  it('handles stream connection failure with retry and fallback', async () => {
    const primary = new MockProvider({ id: 'primary-mock' });
    primary.enqueueError(new AirError('PROVIDER_UNAVAILABLE', 'Stream connect error', { retryable: true }));

    const fallback = new MockProvider({ id: 'fallback-mock' });
    fallback.enqueueResponse('Streamed from fallback');

    const resilient = new ResilientProvider(primary, {
      retry: { maxAttempts: 1 },
      fallback: { fallbacks: [fallback] },
    });

    const events: ProviderStreamEvent[] = [];
    for await (const event of resilient.stream(dummyRequest)) {
      events.push(event);
    }

    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(events.some((e) => e.type === 'stream_end')).toBe(true);
  });

  it('propagates mid-stream error without restarting stream', async () => {
    // Custom failing generator provider
    const failingStreamProvider = {
      id: 'mid-fail-provider',
      type: 'mock' as const,
      defaultModel: 'test-model',
      capabilities: {
        streaming: true,
        toolCalling: false,
        imageInput: false,
        systemPrompt: true,
        extendedThinking: false,
        promptCaching: false,
      },
      complete: () => Promise.reject(new Error('not implemented')),
      async *stream(): AsyncIterable<ProviderStreamEvent> {
        await Promise.resolve();
        yield { type: 'stream_start', id: 'stream-1', model: 'test-model' };
        yield { type: 'text_delta', text: 'First chunk ' };
        throw new AirError('PROVIDER_UNAVAILABLE', 'Network disconnected mid-stream');
      },
    };

    const resilient = new ResilientProvider(failingStreamProvider, {
      retry: { maxAttempts: 3 },
    });

    const receivedChunks: ProviderStreamEvent[] = [];
    let streamError: unknown;

    try {
      for await (const chunk of resilient.stream(dummyRequest)) {
        receivedChunks.push(chunk);
      }
    } catch (err) {
      streamError = err;
    }

    expect(receivedChunks.length).toBe(2);
    expect(streamError).toBeInstanceOf(AirError);
    expect((streamError as AirError).code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('evaluates helper predicates correctly', () => {
    expect(defaultIsRetryable(new AirError('PROVIDER_RATE_LIMITED', '429'))).toBe(true);
    expect(defaultIsRetryable(new AirError('PROVIDER_UNAVAILABLE', '503'))).toBe(true);
    expect(defaultIsRetryable(new AirError('UNKNOWN', 'flagged', { retryable: true }))).toBe(true);
    expect(defaultIsRetryable(new AirError('CANCELLED', 'abort'))).toBe(false);
    expect(defaultIsRetryable(new Error('raw error'))).toBe(false);

    expect(defaultIsFailure(new AirError('PROVIDER_INVALID_REQUEST', 'bad args'))).toBe(false);
    expect(defaultIsFailure(new AirError('PROVIDER_AUTH_FAILED', 'bad key'))).toBe(false);
    expect(defaultIsFailure(new AirError('PERMISSION_DENIED', 'forbidden'))).toBe(false);
    expect(defaultIsFailure(new AirError('CANCELLED', 'user cancelled'))).toBe(false);
    expect(defaultIsFailure(new AirError('PROVIDER_UNAVAILABLE', '500'))).toBe(true);

    expect(defaultShouldFallback(new AirError('CANCELLED', 'abort'))).toBe(false);
    expect(defaultShouldFallback(new AirError('PROVIDER_INVALID_REQUEST', 'bad prompt'))).toBe(false);
    expect(defaultShouldFallback(new AirError('PROVIDER_UNAVAILABLE', '500'))).toBe(true);
    expect(defaultShouldFallback(new AirError('PROVIDER_AUTH_FAILED', 'bad key'))).toBe(true);
  });
});
