/**
 * Typed Event Bus for the AIR runtime (Phase 2 - P2-T04).
 *
 * Provides in-process pub/sub, per-subscriber bounded queues with
 * configurable backpressure/drop policies ('drop-oldest', 'drop-newest', 'error'),
 * flexible subscription filters, drain lifecycle, and metrics integration.
 */

import { AirError } from '../errors/index.js';
import type { Counter, Gauge, MetricsRegistry } from '../observability/index.js';
import type { Clock, IdGenerator } from '../util/index.js';
import { SystemClock, UlidIdGenerator } from '../util/index.js';
import type { EventEnvelope } from './envelope.js';

export type DropPolicy = 'drop-oldest' | 'drop-newest' | 'error';

export type EventFilterPredicate = (event: EventEnvelope) => boolean;

export interface EventSubscriptionFilter {
  /**
   * Filter by exact stream name or RegExp.
   */
  stream?: string | RegExp | undefined;

  /**
   * Filter by stream prefix (e.g. 'run:' or 'session:').
   */
  streamPrefix?: string | undefined;

  /**
   * Filter by exact event types or wildcards (e.g. ['run.created', 'run.completed'] or 'run.*').
   */
  types?: string[] | Set<string> | undefined;

  /**
   * Filter by runId in meta or payload.
   */
  runId?: string | undefined;

  /**
   * Filter by sessionId in meta or payload.
   */
  sessionId?: string | undefined;

  /**
   * Custom filter predicate.
   */
  predicate?: EventFilterPredicate | undefined;
}

export interface SubscriptionOptions {
  name?: string | undefined;
  maxQueueSize?: number | undefined;
  dropPolicy?: DropPolicy | undefined;
  onError?: ((error: unknown, event: EventEnvelope, sub: Subscription) => void) | undefined;
}

export interface SubscriptionStats {
  id: string;
  name: string;
  queueDepth: number;
  enqueuedCount: number;
  processedCount: number;
  droppedCount: number;
  errorCount: number;
}

export interface Subscription {
  readonly id: string;
  readonly name: string;
  readonly filter: EventSubscriptionFilter;
  readonly isClosed: boolean;
  getStats(): SubscriptionStats;
  unsubscribe(): void;
  drain(): Promise<void>;
}

export type EventHandler = (event: EventEnvelope) => Promise<void> | void;

export interface EventBusOptions {
  clock?: Clock | undefined;
  idGenerator?: IdGenerator | undefined;
  defaultMaxQueueSize?: number | undefined;
  defaultDropPolicy?: DropPolicy | undefined;
  metrics?: MetricsRegistry | undefined;
}

export interface EventBusStats {
  activeSubscriptions: number;
  publishedTotal: number;
  deliveredTotal: number;
  droppedTotal: number;
  errorTotal: number;
  maxQueueDepth: number;
}

/**
 * Checks whether an event matches the given subscription filter.
 */
export function matchesEventFilter(event: EventEnvelope, filter: EventSubscriptionFilter): boolean {
  if (filter.stream !== undefined) {
    if (typeof filter.stream === 'string') {
      if (event.stream !== filter.stream) return false;
    } else if (!filter.stream.test(event.stream)) {
      return false;
    }
  }

  if (filter.streamPrefix !== undefined && !event.stream.startsWith(filter.streamPrefix)) {
    return false;
  }

  if (filter.types !== undefined) {
    const types = Array.isArray(filter.types) ? filter.types : Array.from(filter.types);
    const matches = types.some((t) => {
      if (t === '*') return true;
      if (t.endsWith('*')) {
        return event.type.startsWith(t.slice(0, -1));
      }
      return event.type === t;
    });
    if (!matches) return false;
  }

  const payload = event.payload as Record<string, unknown> | undefined;

  if (filter.runId !== undefined) {
    const eventRunId = event.meta?.runId ?? (payload && typeof payload['runId'] === 'string' ? payload['runId'] : undefined);
    if (eventRunId !== filter.runId) return false;
  }

  if (filter.sessionId !== undefined) {
    const eventSessionId = event.meta?.sessionId ?? (payload && typeof payload['sessionId'] === 'string' ? payload['sessionId'] : undefined);
    if (eventSessionId !== filter.sessionId) return false;
  }

  if (filter.predicate !== undefined && !filter.predicate(event)) {
    return false;
  }

  return true;
}

interface BusMetrics {
  publishedCounter?: Counter | undefined;
  deliveredCounter?: Counter | undefined;
  droppedCounter?: Counter | undefined;
  handlerErrorsCounter?: Counter | undefined;
  activeSubsGauge?: Gauge | undefined;
  queueDepthGauge?: Gauge | undefined;
}

interface InternalBusCounters {
  publishedTotal: number;
  deliveredTotal: number;
  droppedTotal: number;
  errorTotal: number;
}

/**
 * Internal subscriber implementation managing bounded queue and FIFO execution loop.
 */
class SubscriberImpl implements Subscription {
  public readonly id: string;
  public readonly name: string;
  public readonly filter: EventSubscriptionFilter;
  public readonly maxQueueSize: number;
  public readonly dropPolicy: DropPolicy;
  public readonly onError?: ((error: unknown, event: EventEnvelope, sub: Subscription) => void) | undefined;

  private queue: EventEnvelope[] = [];
  private isProcessing = false;
  private closed = false;
  private drainResolvers: Array<() => void> = [];

  private statsInternal = {
    enqueuedCount: 0,
    processedCount: 0,
    droppedCount: 0,
    errorCount: 0,
  };

  constructor(
    id: string,
    filter: EventSubscriptionFilter,
    private readonly handler: EventHandler,
    options: SubscriptionOptions | undefined,
    defaultMaxQueueSize: number,
    defaultDropPolicy: DropPolicy,
    private readonly onUnsubscribe: (sub: SubscriberImpl) => void,
    private readonly busCounters: InternalBusCounters,
    private readonly busMetrics: BusMetrics,
  ) {
    this.id = id;
    this.filter = filter;
    this.name = options?.name ?? `sub-${id}`;
    this.maxQueueSize = options?.maxQueueSize ?? defaultMaxQueueSize;
    this.dropPolicy = options?.dropPolicy ?? defaultDropPolicy;
    this.onError = options?.onError;
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public get queueDepth(): number {
    return this.queue.length;
  }

  public matches(event: EventEnvelope): boolean {
    if (this.closed) return false;
    return matchesEventFilter(event, this.filter);
  }

  public enqueue(event: EventEnvelope): void {
    if (this.closed) return;

    if (this.queue.length >= this.maxQueueSize) {
      this.handleBackpressure(event);
      return;
    }

    this.queue.push(event);
    this.statsInternal.enqueuedCount++;
    this.updateQueueDepthMetric();
    this.triggerProcess();
  }

  private handleBackpressure(event: EventEnvelope): void {
    if (this.dropPolicy === 'drop-oldest') {
      this.queue.shift();
      this.statsInternal.droppedCount++;
      this.busCounters.droppedTotal++;
      this.busMetrics.droppedCounter?.inc(1, { subscriber: this.name, policy: 'drop-oldest' });

      this.queue.push(event);
      this.statsInternal.enqueuedCount++;
      this.updateQueueDepthMetric();
      this.triggerProcess();
    } else if (this.dropPolicy === 'drop-newest') {
      this.statsInternal.droppedCount++;
      this.busCounters.droppedTotal++;
      this.busMetrics.droppedCounter?.inc(1, { subscriber: this.name, policy: 'drop-newest' });
    } else if (this.dropPolicy === 'error') {
      this.statsInternal.droppedCount++;
      this.busCounters.droppedTotal++;
      this.statsInternal.errorCount++;
      this.busCounters.errorTotal++;
      this.busMetrics.droppedCounter?.inc(1, { subscriber: this.name, policy: 'error' });
      this.busMetrics.handlerErrorsCounter?.inc(1, { subscriber: this.name });

      const err = new AirError(
        'RESOURCE_EXHAUSTED',
        `Queue for subscriber "${this.name}" is full (capacity: ${this.maxQueueSize})`,
      );

      if (this.onError) {
        try {
          this.onError(err, event, this);
        } catch {
          // Prevent onError throws from corrupting dispatcher
        }
      } else {
        throw err;
      }
    }
  }

  private triggerProcess(): void {
    if (this.isProcessing || this.closed) return;
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0 && !this.closed) {
        const event = this.queue.shift();
        if (!event) break;

        this.updateQueueDepthMetric();

        try {
          await this.handler(event);
          this.statsInternal.processedCount++;
          this.busCounters.deliveredTotal++;
          this.busMetrics.deliveredCounter?.inc(1, { subscriber: this.name });
        } catch (err) {
          this.statsInternal.errorCount++;
          this.busCounters.errorTotal++;
          this.busMetrics.handlerErrorsCounter?.inc(1, { subscriber: this.name });

          if (this.onError) {
            try {
              this.onError(err, event, this);
            } catch {
              // Ignore errors within onError handler
            }
          }
        }
      }
    } finally {
      this.isProcessing = false;
      this.updateQueueDepthMetric();

      if (this.queue.length > 0 && !this.closed) {
        this.triggerProcess();
      } else if (this.queue.length === 0 && this.drainResolvers.length > 0) {
        const resolvers = [...this.drainResolvers];
        this.drainResolvers = [];
        for (const resolve of resolvers) {
          resolve();
        }
      }
    }
  }

  private updateQueueDepthMetric(): void {
    this.busMetrics.queueDepthGauge?.set(this.queue.length, { subscriber: this.name });
  }

  public getStats(): SubscriptionStats {
    return {
      id: this.id,
      name: this.name,
      queueDepth: this.queue.length,
      enqueuedCount: this.statsInternal.enqueuedCount,
      processedCount: this.statsInternal.processedCount,
      droppedCount: this.statsInternal.droppedCount,
      errorCount: this.statsInternal.errorCount,
    };
  }

  public unsubscribe(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.updateQueueDepthMetric();

    if (this.drainResolvers.length > 0) {
      const resolvers = [...this.drainResolvers];
      this.drainResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }

    this.onUnsubscribe(this);
  }

  public drain(): Promise<void> {
    if (this.closed || (this.queue.length === 0 && !this.isProcessing)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }
}

/**
 * EventBus coordinates in-process event publish/subscribe across all streams.
 */
export class EventBus {
  private readonly defaultMaxQueueSize: number;
  private readonly defaultDropPolicy: DropPolicy;
  private readonly idGenerator: IdGenerator;
  private readonly subscribers = new Map<string, SubscriberImpl>();
  private closed = false;

  private readonly counters: InternalBusCounters = {
    publishedTotal: 0,
    deliveredTotal: 0,
    droppedTotal: 0,
    errorTotal: 0,
  };

  private readonly busMetrics: BusMetrics = {};

  constructor(options?: EventBusOptions) {
    const clock = options?.clock ?? new SystemClock();
    this.idGenerator = options?.idGenerator ?? new UlidIdGenerator(clock);
    this.defaultMaxQueueSize = options?.defaultMaxQueueSize ?? 1000;
    this.defaultDropPolicy = options?.defaultDropPolicy ?? 'drop-oldest';

    if (options?.metrics) {
      const reg = options.metrics;
      this.busMetrics.publishedCounter = reg.counter('eventbus_events_published_total', 'Total events published to event bus');
      this.busMetrics.deliveredCounter = reg.counter('eventbus_events_delivered_total', 'Total events delivered to subscribers');
      this.busMetrics.droppedCounter = reg.counter('eventbus_events_dropped_total', 'Total events dropped due to backpressure');
      this.busMetrics.handlerErrorsCounter = reg.counter('eventbus_handler_errors_total', 'Total subscriber handler errors');
      this.busMetrics.activeSubsGauge = reg.gauge('eventbus_subscriptions_active', 'Active subscribers count');
      this.busMetrics.queueDepthGauge = reg.gauge('eventbus_queue_depth', 'Subscriber queue depth');
    }
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Publishes a single event envelope to all matching active subscribers.
   */
  public publish(event: EventEnvelope): void {
    if (this.closed) {
      throw new AirError('INVALID_STATE', 'EventBus is closed');
    }

    this.counters.publishedTotal++;
    this.busMetrics.publishedCounter?.inc(1);

    for (const subscriber of this.subscribers.values()) {
      if (subscriber.matches(event)) {
        subscriber.enqueue(event);
      }
    }
  }

  /**
   * Publishes multiple events in sequence.
   */
  public publishBatch(events: EventEnvelope[]): void {
    for (const event of events) {
      this.publish(event);
    }
  }

  /**
   * Subscribes to events matching the provided filter.
   */
  public subscribe(
    filter: EventSubscriptionFilter,
    handler: EventHandler,
    options?: SubscriptionOptions,
  ): Subscription {
    if (this.closed) {
      throw new AirError('INVALID_STATE', 'EventBus is closed');
    }

    const subId = this.idGenerator.next();
    const subscriber = new SubscriberImpl(
      subId,
      filter,
      handler,
      options,
      this.defaultMaxQueueSize,
      this.defaultDropPolicy,
      (sub) => this.removeSubscriber(sub.id),
      this.counters,
      this.busMetrics,
    );

    this.subscribers.set(subId, subscriber);
    this.busMetrics.activeSubsGauge?.set(this.subscribers.size);

    return subscriber;
  }

  /**
   * Helper utility that waits for the first event matching the filter, then automatically unsubscribes.
   */
  public waitFor(filter: EventSubscriptionFilter, timeoutMs = 5000): Promise<EventEnvelope> {
    if (this.closed) {
      return Promise.reject(new AirError('INVALID_STATE', 'EventBus is closed'));
    }

    return new Promise<EventEnvelope>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;

      const sub = this.subscribe(filter, (event) => {
        if (timer) clearTimeout(timer);
        sub.unsubscribe();
        resolve(event);
      });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!sub.isClosed) {
            sub.unsubscribe();
          }
          reject(
            new AirError(
              'DEADLINE_EXCEEDED',
              `Timeout waiting for event matching filter after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }
    });
  }

  private removeSubscriber(id: string): void {
    this.subscribers.delete(id);
    this.busMetrics.activeSubsGauge?.set(this.subscribers.size);
  }

  /**
   * Returns runtime statistics for the event bus.
   */
  public getStats(): EventBusStats {
    const subs = Array.from(this.subscribers.values());
    const maxQueueDepth = subs.reduce((max, s) => Math.max(max, s.queueDepth), 0);

    return {
      activeSubscriptions: subs.length,
      publishedTotal: this.counters.publishedTotal,
      deliveredTotal: this.counters.deliveredTotal,
      droppedTotal: this.counters.droppedTotal,
      errorTotal: this.counters.errorTotal,
      maxQueueDepth,
    };
  }

  /**
   * Waits for all active subscribers to finish processing enqueued events.
   */
  public async drain(): Promise<void> {
    const drainPromises = Array.from(this.subscribers.values()).map((sub) => sub.drain());
    await Promise.all(drainPromises);
  }

  /**
   * Closes the event bus. If drain is true, awaits drain of all subscribers before closing.
   */
  public async close(drain = true): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (drain) {
      await this.drain();
    }

    for (const sub of Array.from(this.subscribers.values())) {
      sub.unsubscribe();
    }

    this.subscribers.clear();
    this.busMetrics.activeSubsGauge?.set(0);
    this.busMetrics.queueDepthGauge?.set(0);
  }
}
