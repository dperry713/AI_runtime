/**
 * Universal resilience wrapper for AIR providers (Phase 3: P3-T06).
 *
 * Provides:
 * - Transparent timeout management and AbortSignal propagation
 * - Exponential backoff with full jitter (Rule R6: Injected Random)
 * - HTTP 429 / Retry-After header honoring
 * - Three-state Circuit Breaker (CLOSED, OPEN, HALF-OPEN)
 * - Fallback provider chain
 * - Stream recovery for unstarted streams
 */

import { AirError, isAirError } from '../errors/index.js';
import {
  calculateBackoff,
  type Clock,
  type Random,
  sleep,
  SystemClock,
  SystemRandom,
} from '../util/index.js';
import type {
  NormalizedRequest,
  NormalizedResponse,
  Provider,
  ProviderCallOptions,
  ProviderCapabilities,
  ProviderStreamEvent,
  ProviderType,
} from './types.js';

// ============================================================================
// Types & Options
// ============================================================================

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Consecutive failure threshold before tripping circuit to OPEN (default: 5). */
  readonly failureThreshold?: number | undefined;
  /** Cooldown duration in ms before transitioning from OPEN to HALF-OPEN (default: 30,000ms). */
  readonly recoveryTimeoutMs?: number | undefined;
  /** Number of consecutive trial successes in HALF-OPEN before closing circuit (default: 1). */
  readonly halfOpenMaxAttempts?: number | undefined;
  /** Predicate to decide if an error counts as a circuit breaker failure (default: service/network errors). */
  readonly isFailure?: ((error: unknown) => boolean) | undefined;
}

export interface RetryOptions {
  /** Maximum attempts per provider including the initial attempt (default: 3). Set to 1 to disable retry. */
  readonly maxAttempts?: number | undefined;
  /** Initial backoff delay in ms (default: 500ms). */
  readonly baseMs?: number | undefined;
  /** Maximum backoff delay in ms (default: 30,000ms). */
  readonly maxMs?: number | undefined;
  /** Multiplier per retry attempt (default: 2). */
  readonly factor?: number | undefined;
  /** Whether to apply full jitter to exponential backoff (default: true). */
  readonly jitter?: boolean | undefined;
  /** Whether to respect retry-after hint if present on 429 errors (default: true). */
  readonly respectRetryAfter?: boolean | undefined;
  /** Predicate to determine if an error is retryable (default: AirError.retryable or 429/5xx). */
  readonly isRetryable?: ((error: unknown) => boolean) | undefined;
}

export interface FallbackOptions {
  /** Ordered list of secondary providers to try if the primary fails. */
  readonly fallbacks?: readonly Provider[] | undefined;
  /** Predicate to determine if an error should trigger fallback (default: non-user-abort, non-invalid-request). */
  readonly shouldFallback?: ((error: unknown) => boolean) | undefined;
}

export type ResilienceEvent =
  | {
      readonly type: 'retry';
      readonly providerId: string;
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly error: unknown;
    }
  | {
      readonly type: 'timeout';
      readonly providerId: string;
      readonly attempt: number;
      readonly timeoutMs: number;
    }
  | {
      readonly type: 'circuit_state_change';
      readonly providerId: string;
      readonly from: CircuitState;
      readonly to: CircuitState;
      readonly reason?: string | undefined;
    }
  | {
      readonly type: 'fallback';
      readonly fromProviderId: string;
      readonly toProviderId: string;
      readonly error: unknown;
    };

export interface ResilienceOptions {
  /** Optional custom ID for the wrapped provider. */
  readonly id?: string | undefined;
  /** Per-attempt request timeout in milliseconds. If omitted, no attempt timeout is applied. */
  readonly timeoutMs?: number | undefined;
  /** Retry configuration. */
  readonly retry?: RetryOptions | undefined;
  /** Circuit breaker configuration. */
  readonly circuitBreaker?: CircuitBreakerOptions | undefined;
  /** Fallback chain configuration. */
  readonly fallback?: FallbackOptions | undefined;
  /** Injected monotonic clock (Rule R6). */
  readonly clock?: Clock | undefined;
  /** Injected random generator (Rule R6). */
  readonly random?: Random | undefined;
  /** Optional custom sleep function (useful for fast testing without real delays). */
  readonly sleepFn?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /** Observability hook for resilience events (retries, timeouts, circuit changes, fallbacks). */
  readonly onEvent?: ((event: ResilienceEvent) => void) | undefined;
}

// ============================================================================
// Defaults & Error Helpers
// ============================================================================

export function defaultIsFailure(error: unknown): boolean {
  if (isAirError(error)) {
    if (
      error.code === 'PROVIDER_INVALID_REQUEST' ||
      error.code === 'PROVIDER_AUTH_FAILED' ||
      error.code === 'PERMISSION_DENIED' ||
      error.code === 'CANCELLED'
    ) {
      return false;
    }
    return true;
  }
  return true;
}

export function defaultIsRetryable(error: unknown): boolean {
  if (isAirError(error)) {
    if (error.code === 'CANCELLED') {
      return false;
    }
    return (
      error.retryable ||
      error.code === 'PROVIDER_RATE_LIMITED' ||
      error.code === 'PROVIDER_UNAVAILABLE'
    );
  }
  return false;
}

export function defaultShouldFallback(error: unknown): boolean {
  if (isAirError(error)) {
    if (error.code === 'CANCELLED' || error.code === 'PROVIDER_INVALID_REQUEST') {
      return false;
    }
  }
  return true;
}

function toAirError(error: unknown): AirError {
  if (isAirError(error)) {
    return error;
  }
  if (error instanceof Error) {
    return new AirError('UNKNOWN', error.message, {
      cause: error,
    });
  }
  return new AirError('UNKNOWN', String(error));
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (isAirError(error) && error.context && typeof error.context['retryAfterMs'] === 'number') {
    return error.context['retryAfterMs'];
  }
  return undefined;
}

// ============================================================================
// Circuit Breaker
// ============================================================================

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private halfOpenAttempts = 0;
  private lastOpenedAtMonotonic = 0;

  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly halfOpenMaxAttempts: number;
  private readonly isFailurePredicate: (error: unknown) => boolean;

  constructor(
    public readonly providerId: string,
    options: CircuitBreakerOptions = {},
    private readonly clock: Clock = new SystemClock(),
    private readonly onStateChange?: ((from: CircuitState, to: CircuitState, reason?: string) => void) | undefined,
  ) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 5);
    this.recoveryTimeoutMs = Math.max(1, options.recoveryTimeoutMs ?? 30_000);
    this.halfOpenMaxAttempts = Math.max(1, options.halfOpenMaxAttempts ?? 1);
    this.isFailurePredicate = options.isFailure ?? defaultIsFailure;
  }

  getState(): CircuitState {
    if (this.state === 'OPEN') {
      const elapsed = this.clock.monotonicMs() - this.lastOpenedAtMonotonic;
      if (elapsed >= this.recoveryTimeoutMs) {
        this.transitionTo('HALF_OPEN', 'Recovery cooldown elapsed');
      }
    }
    return this.state;
  }

  canExecute(): boolean {
    const currentState = this.getState();
    if (currentState === 'CLOSED') {
      return true;
    }
    if (currentState === 'HALF_OPEN') {
      return this.halfOpenAttempts < this.halfOpenMaxAttempts;
    }
    return false;
  }

  recordAttempt(): void {
    if (this.getState() === 'HALF_OPEN') {
      this.halfOpenAttempts++;
    }
  }

  recordSuccess(): void {
    const currentState = this.getState();
    if (currentState === 'HALF_OPEN') {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.halfOpenMaxAttempts) {
        this.consecutiveFailures = 0;
        this.consecutiveSuccesses = 0;
        this.halfOpenAttempts = 0;
        this.transitionTo('CLOSED', 'Trial attempts succeeded');
      }
    } else if (currentState === 'CLOSED') {
      this.consecutiveFailures = 0;
    }
  }

  recordFailure(error: unknown): void {
    if (!this.isFailurePredicate(error)) {
      return;
    }

    const currentState = this.getState();
    if (currentState === 'HALF_OPEN') {
      this.lastOpenedAtMonotonic = this.clock.monotonicMs();
      this.halfOpenAttempts = 0;
      this.consecutiveSuccesses = 0;
      this.transitionTo('OPEN', 'Trial attempt failed in HALF-OPEN state');
    } else if (currentState === 'CLOSED') {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.lastOpenedAtMonotonic = this.clock.monotonicMs();
        this.halfOpenAttempts = 0;
        this.consecutiveSuccesses = 0;
        this.transitionTo('OPEN', `Failure threshold (${this.failureThreshold}) reached`);
      }
    }
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.halfOpenAttempts = 0;
    this.lastOpenedAtMonotonic = 0;
    this.transitionTo('CLOSED', 'Circuit manually reset');
  }

  forceOpen(): void {
    this.lastOpenedAtMonotonic = this.clock.monotonicMs();
    this.halfOpenAttempts = 0;
    this.consecutiveSuccesses = 0;
    this.transitionTo('OPEN', 'Circuit manually opened');
  }

  forceClose(): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.halfOpenAttempts = 0;
    this.lastOpenedAtMonotonic = 0;
    this.transitionTo('CLOSED', 'Circuit manually closed');
  }

  getStats(): {
    state: CircuitState;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    halfOpenAttempts: number;
    lastOpenedAtMonotonic: number;
  } {
    return {
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      halfOpenAttempts: this.halfOpenAttempts,
      lastOpenedAtMonotonic: this.lastOpenedAtMonotonic,
    };
  }

  private transitionTo(to: CircuitState, reason?: string): void {
    if (this.state !== to) {
      const from = this.state;
      this.state = to;
      this.onStateChange?.(from, to, reason);
    }
  }
}

// ============================================================================
// Signal & Timeout Management
// ============================================================================

interface AttemptSignalContext {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
  readonly isTimedOut: () => boolean;
}

function createAttemptSignal(timeoutMs: number, userSignal?: AbortSignal): AttemptSignalContext {
  const controller = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new AirError('PROVIDER_UNAVAILABLE', `Provider request timed out after ${timeoutMs}ms`, {
          retryable: true,
          context: { timeoutMs },
        }),
      );
    }, timeoutMs);
  }

  const onUserAbort = (): void => {
    controller.abort(userSignal?.reason ?? new AirError('CANCELLED', 'Request was cancelled'));
  };

  if (userSignal) {
    if (userSignal.aborted) {
      onUserAbort();
    } else {
      userSignal.addEventListener('abort', onUserAbort, { once: true });
    }
  }

  const cleanup = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (userSignal) {
      userSignal.removeEventListener('abort', onUserAbort);
    }
  };

  return {
    signal: controller.signal,
    cleanup,
    isTimedOut: () => timedOut,
  };
}

// ============================================================================
// ResilientProvider
// ============================================================================

export class ResilientProvider implements Provider {
  readonly id: string;
  readonly type: ProviderType;
  readonly defaultModel: string;
  readonly capabilities: ProviderCapabilities;

  readonly primary: Provider;
  readonly fallbacks: readonly Provider[];

  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly clock: Clock;
  private readonly random: Random;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly onEvent?: ((event: ResilienceEvent) => void) | undefined;

  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly factor: number;
  private readonly jitter: boolean;
  private readonly respectRetryAfter: boolean;
  private readonly isRetryablePredicate: (error: unknown) => boolean;
  private readonly shouldFallbackPredicate: (error: unknown) => boolean;

  constructor(primary: Provider, options: ResilienceOptions = {}) {
    if (!primary) {
      throw new TypeError('ResilientProvider requires a valid primary Provider');
    }

    this.primary = primary;
    this.fallbacks = options.fallback?.fallbacks ?? [];
    this.id = options.id ?? `resilient(${primary.id})`;
    this.type = primary.type;
    this.defaultModel = primary.defaultModel;
    this.capabilities = primary.capabilities;

    this.clock = options.clock ?? new SystemClock();
    this.random = options.random ?? new SystemRandom();
    this.sleepFn = options.sleepFn ?? sleep;
    this.onEvent = options.onEvent;

    this.timeoutMs = Math.max(0, options.timeoutMs ?? 0);
    this.maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 3);
    this.baseMs = Math.max(1, options.retry?.baseMs ?? 500);
    this.maxMs = Math.max(this.baseMs, options.retry?.maxMs ?? 30_000);
    this.factor = Math.max(1, options.retry?.factor ?? 2);
    this.jitter = options.retry?.jitter ?? true;
    this.respectRetryAfter = options.retry?.respectRetryAfter ?? true;
    this.isRetryablePredicate = options.retry?.isRetryable ?? defaultIsRetryable;
    this.shouldFallbackPredicate = options.fallback?.shouldFallback ?? defaultShouldFallback;

    // Initialize circuit breakers for all registered providers
    const cbOptions = options.circuitBreaker ?? {};
    const allProviders = [this.primary, ...this.fallbacks];
    for (const p of allProviders) {
      this.breakers.set(
        p.id,
        new CircuitBreaker(p.id, cbOptions, this.clock, (from, to, reason) => {
          this.emitEvent({
            type: 'circuit_state_change',
            providerId: p.id,
            from,
            to,
            reason,
          });
        }),
      );
    }
  }

  getCircuitBreaker(providerId?: string): CircuitBreaker | undefined {
    const id = providerId ?? this.primary.id;
    return this.breakers.get(id);
  }

  getCircuitState(providerId?: string): CircuitState {
    const breaker = this.getCircuitBreaker(providerId);
    return breaker ? breaker.getState() : 'CLOSED';
  }

  resetCircuitBreaker(providerId?: string): void {
    const breaker = this.getCircuitBreaker(providerId);
    breaker?.reset();
  }

  async complete(
    request: NormalizedRequest,
    options?: ProviderCallOptions,
  ): Promise<NormalizedResponse> {
    if (options?.signal?.aborted) {
      throw toAirError(options.signal.reason);
    }

    const providersToTry = [this.primary, ...this.fallbacks];
    let lastError: unknown;

    for (let pIdx = 0; pIdx < providersToTry.length; pIdx++) {
      const provider = providersToTry[pIdx];
      if (!provider) {
        continue;
      }
      const nextProvider = providersToTry[pIdx + 1];
      const breaker = this.getOrCreateBreaker(provider);

      if (!breaker.canExecute()) {
        const breakerErr = new AirError(
          'PROVIDER_UNAVAILABLE',
          `Circuit breaker is OPEN for provider "${provider.id}"`,
          {
            retryable: true,
            context: { providerId: provider.id, state: breaker.getState() },
          },
        );
        lastError = breakerErr;

        if (nextProvider && this.shouldFallbackPredicate(breakerErr)) {
          this.emitEvent({
            type: 'fallback',
            fromProviderId: provider.id,
            toProviderId: nextProvider.id,
            error: breakerErr,
          });
          continue;
        }
        throw breakerErr;
      }

      const effectiveTimeout = options?.timeoutMs ?? this.timeoutMs;
      let attempt = 0;

      while (attempt < this.maxAttempts) {
        if (options?.signal?.aborted) {
          throw toAirError(options.signal.reason);
        }

        const attemptCtx = createAttemptSignal(effectiveTimeout, options?.signal);
        breaker.recordAttempt();

        try {
          const response = await provider.complete(request, {
            ...options,
            signal: attemptCtx.signal,
          });
          attemptCtx.cleanup();
          breaker.recordSuccess();
          return response;
        } catch (err) {
          attemptCtx.cleanup();

          if (attemptCtx.isTimedOut()) {
            this.emitEvent({
              type: 'timeout',
              providerId: provider.id,
              attempt: attempt + 1,
              timeoutMs: effectiveTimeout,
            });
          }

          if (options?.signal?.aborted) {
            throw toAirError(options.signal.reason);
          }

          const airErr = toAirError(err);
          breaker.recordFailure(airErr);
          lastError = airErr;

          if (this.isRetryablePredicate(airErr) && attempt < this.maxAttempts - 1) {
            const delayMs = this.computeDelay(attempt, airErr);
            this.emitEvent({
              type: 'retry',
              providerId: provider.id,
              attempt: attempt + 1,
              maxAttempts: this.maxAttempts,
              delayMs,
              error: airErr,
            });
            await this.sleepFn(delayMs, options?.signal);
            attempt++;
            continue;
          }

          // Non-retryable or attempts exhausted
          if (nextProvider && this.shouldFallbackPredicate(airErr)) {
            this.emitEvent({
              type: 'fallback',
              fromProviderId: provider.id,
              toProviderId: nextProvider.id,
              error: airErr,
            });
            break; // break retry loop, try next provider
          }

          throw airErr;
        }
      }
    }

    throw toAirError(lastError ?? new AirError('PROVIDER_UNAVAILABLE', 'All providers in resilience chain failed'));
  }

  async *stream(
    request: NormalizedRequest,
    options?: ProviderCallOptions,
  ): AsyncIterable<ProviderStreamEvent> {
    if (options?.signal?.aborted) {
      throw toAirError(options.signal.reason);
    }

    const providersToTry = [this.primary, ...this.fallbacks];
    let lastError: unknown;

    for (let pIdx = 0; pIdx < providersToTry.length; pIdx++) {
      const provider = providersToTry[pIdx];
      if (!provider) {
        continue;
      }
      const nextProvider = providersToTry[pIdx + 1];
      const breaker = this.getOrCreateBreaker(provider);

      if (!breaker.canExecute()) {
        const breakerErr = new AirError(
          'PROVIDER_UNAVAILABLE',
          `Circuit breaker is OPEN for provider "${provider.id}"`,
          {
            retryable: true,
            context: { providerId: provider.id, state: breaker.getState() },
          },
        );
        lastError = breakerErr;

        if (nextProvider && this.shouldFallbackPredicate(breakerErr)) {
          this.emitEvent({
            type: 'fallback',
            fromProviderId: provider.id,
            toProviderId: nextProvider.id,
            error: breakerErr,
          });
          continue;
        }
        throw breakerErr;
      }

      const effectiveTimeout = options?.timeoutMs ?? this.timeoutMs;
      let attempt = 0;
      let streamSucceeded = false;

      while (attempt < this.maxAttempts) {
        if (options?.signal?.aborted) {
          throw toAirError(options.signal.reason);
        }

        const attemptCtx = createAttemptSignal(effectiveTimeout, options?.signal);
        breaker.recordAttempt();

        let iterator: AsyncIterator<ProviderStreamEvent> | undefined;
        let firstResult: IteratorResult<ProviderStreamEvent> | undefined;

        try {
          const providerStream = provider.stream(request, {
            ...options,
            signal: attemptCtx.signal,
          });
          iterator = providerStream[Symbol.asyncIterator]();
          firstResult = await iterator.next();
          if (!firstResult.done && firstResult.value.type === 'error') {
            throw toAirError(firstResult.value.error);
          }
        } catch (err) {
          attemptCtx.cleanup();

          if (attemptCtx.isTimedOut()) {
            this.emitEvent({
              type: 'timeout',
              providerId: provider.id,
              attempt: attempt + 1,
              timeoutMs: effectiveTimeout,
            });
          }

          if (options?.signal?.aborted) {
            throw toAirError(options.signal.reason);
          }

          const airErr = toAirError(err);
          breaker.recordFailure(airErr);
          lastError = airErr;

          if (this.isRetryablePredicate(airErr) && attempt < this.maxAttempts - 1) {
            const delayMs = this.computeDelay(attempt, airErr);
            this.emitEvent({
              type: 'retry',
              providerId: provider.id,
              attempt: attempt + 1,
              maxAttempts: this.maxAttempts,
              delayMs,
              error: airErr,
            });
            await this.sleepFn(delayMs, options?.signal);
            attempt++;
            continue;
          }

          if (nextProvider && this.shouldFallbackPredicate(airErr)) {
            this.emitEvent({
              type: 'fallback',
              fromProviderId: provider.id,
              toProviderId: nextProvider.id,
              error: airErr,
            });
            break; // break retry loop, move to next provider
          }

          throw airErr;
        }

        // First result succeeded: stream started yielding to consumer
        try {
          if (!firstResult.done) {
            yield firstResult.value;

            if (iterator) {
              while (true) {
                const nextResult = await iterator.next();
                if (nextResult.done) {
                  break;
                }
                yield nextResult.value;
              }
            }
          }

          breaker.recordSuccess();
          attemptCtx.cleanup();
          streamSucceeded = true;
          return;
        } catch (err) {
          attemptCtx.cleanup();

          if (attemptCtx.isTimedOut()) {
            this.emitEvent({
              type: 'timeout',
              providerId: provider.id,
              attempt: attempt + 1,
              timeoutMs: effectiveTimeout,
            });
          }

          const airErr = toAirError(err);
          if (!options?.signal?.aborted) {
            breaker.recordFailure(airErr);
          }

          // Cannot retry or fallback after chunks have already been yielded
          throw airErr;
        }
      }

      if (streamSucceeded) {
        return;
      }
    }

    throw toAirError(lastError ?? new AirError('PROVIDER_UNAVAILABLE', 'All providers in resilience chain failed'));
  }

  private computeDelay(attempt: number, error: unknown): number {
    const retryAfter = getRetryAfterMs(error);
    if (this.respectRetryAfter && retryAfter !== undefined && retryAfter > 0) {
      return Math.min(retryAfter, this.maxMs);
    }

    if (this.jitter) {
      return calculateBackoff(attempt, {
        baseMs: this.baseMs,
        maxMs: this.maxMs,
        factor: this.factor,
        random: this.random,
      });
    }

    // Non-jitter exponential backoff
    const multiplier = Math.pow(this.factor, Math.min(attempt, 30));
    return Math.min(this.maxMs, Math.round(this.baseMs * multiplier));
  }

  private getOrCreateBreaker(provider: Provider): CircuitBreaker {
    let breaker = this.breakers.get(provider.id);
    if (!breaker) {
      breaker = new CircuitBreaker(provider.id, {}, this.clock, (from, to, reason) => {
        this.emitEvent({
          type: 'circuit_state_change',
          providerId: provider.id,
          from,
          to,
          reason,
        });
      });
      this.breakers.set(provider.id, breaker);
    }
    return breaker;
  }

  private emitEvent(event: ResilienceEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch {
        // Observability listener must not break resilience flow
      }
    }
  }
}
