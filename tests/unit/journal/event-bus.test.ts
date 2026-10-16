import { describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  createEnvelope,
  EventBus,
  type EventEnvelope,
  type EventMeta,
  type EventSubscriptionFilter,
  matchesEventFilter,
} from '../../../src/journal/index.js';
import { MetricsRegistry } from '../../../src/observability/index.js';
import { FakeClock, FakeIdGenerator } from '../../../src/util/index.js';

describe('EventBus (P2-T04)', () => {
  const fakeClock = new FakeClock('2026-10-16T12:00:00.000Z');
  const fakeIdGen = new FakeIdGenerator('01J9SUB000000000000000000');

  const makeEvent = (
    stream: string,
    type: string,
    seq = 1,
    meta?: EventMeta,
    payload?: Record<string, unknown>,
  ): EventEnvelope => {
    return createEnvelope({
      stream,
      seq,
      type,
      payload: payload ?? {},
      ...(meta !== undefined ? { meta } : {}),
      clock: fakeClock,
    });
  };

  // ==========================================================================
  // Basic Pub/Sub & Delivery
  // ==========================================================================

  describe('Basic Pub/Sub & Delivery', () => {
    it('delivers published events to a subscriber', async () => {
      const bus = new EventBus({ clock: fakeClock, idGenerator: fakeIdGen });
      const received: EventEnvelope[] = [];

      const sub = bus.subscribe({}, (ev) => {
        received.push(ev);
      });

      const ev1 = makeEvent('run:1', 'run.created');
      const ev2 = makeEvent('run:1', 'run.running', 2);

      bus.publish(ev1);
      bus.publish(ev2);

      await sub.drain();

      expect(received).toHaveLength(2);
      expect(received[0]?.id).toBe(ev1.id);
      expect(received[1]?.id).toBe(ev2.id);

      await bus.close();
    });

    it('publishes batch of events to multiple subscribers', async () => {
      const bus = new EventBus({ clock: fakeClock });
      const sub1Events: EventEnvelope[] = [];
      const sub2Events: EventEnvelope[] = [];

      const sub1 = bus.subscribe({}, (ev) => {
        sub1Events.push(ev);
      });
      const sub2 = bus.subscribe({}, (ev) => {
        sub2Events.push(ev);
      });

      const batch = [
        makeEvent('s1', 'e1', 1),
        makeEvent('s1', 'e2', 2),
        makeEvent('s2', 'e3', 1),
      ];

      bus.publishBatch(batch);

      await Promise.all([sub1.drain(), sub2.drain()]);

      expect(sub1Events).toHaveLength(3);
      expect(sub2Events).toHaveLength(3);

      await bus.close();
    });
  });

  // ==========================================================================
  // Filtering Logic
  // ==========================================================================

  describe('Filtering Logic', () => {
    it('filters by exact stream and regex stream', async () => {
      const bus = new EventBus();
      const exactEvents: EventEnvelope[] = [];
      const regexEvents: EventEnvelope[] = [];

      const sub1 = bus.subscribe({ stream: 'run:01' }, (ev) => {
        exactEvents.push(ev);
      });
      const sub2 = bus.subscribe({ stream: /^run:\d+$/ }, (ev) => {
        regexEvents.push(ev);
      });

      bus.publish(makeEvent('run:01', 'e'));
      bus.publish(makeEvent('run:02', 'e'));
      bus.publish(makeEvent('other:01', 'e'));

      await Promise.all([sub1.drain(), sub2.drain()]);

      expect(exactEvents).toHaveLength(1);
      expect(exactEvents[0]?.stream).toBe('run:01');

      expect(regexEvents).toHaveLength(2);
      expect(regexEvents.map((e) => e.stream)).toEqual(['run:01', 'run:02']);

      await bus.close();
    });

    it('filters by streamPrefix', async () => {
      const bus = new EventBus();
      const sessionEvents: EventEnvelope[] = [];

      const sub = bus.subscribe({ streamPrefix: 'session:' }, (ev) => {
        sessionEvents.push(ev);
      });

      bus.publish(makeEvent('session:123', 'session.started'));
      bus.publish(makeEvent('run:456', 'run.created'));

      await sub.drain();

      expect(sessionEvents).toHaveLength(1);
      expect(sessionEvents[0]?.stream).toBe('session:123');

      await bus.close();
    });

    it('filters by event types including wildcards and sets', async () => {
      const bus = new EventBus();
      const runEvents: EventEnvelope[] = [];
      const multiEvents: EventEnvelope[] = [];
      const allWildcardEvents: EventEnvelope[] = [];

      const sub1 = bus.subscribe({ types: ['run.*'] }, (ev) => {
        runEvents.push(ev);
      });
      const sub2 = bus.subscribe({ types: new Set(['tool.called', 'tool.completed']) }, (ev) => {
        multiEvents.push(ev);
      });
      const sub3 = bus.subscribe({ types: ['*'] }, (ev) => {
        allWildcardEvents.push(ev);
      });

      bus.publish(makeEvent('s', 'run.created'));
      bus.publish(makeEvent('s', 'run.completed'));
      bus.publish(makeEvent('s', 'tool.called'));
      bus.publish(makeEvent('s', 'memory.written'));

      await Promise.all([sub1.drain(), sub2.drain(), sub3.drain()]);

      expect(runEvents.map((e) => e.type)).toEqual(['run.created', 'run.completed']);
      expect(multiEvents.map((e) => e.type)).toEqual(['tool.called']);
      expect(allWildcardEvents).toHaveLength(4);

      await bus.close();
    });

    it('filters by runId and sessionId in meta or payload', async () => {
      const bus = new EventBus();
      const runMatched: EventEnvelope[] = [];
      const sessionMatched: EventEnvelope[] = [];

      const subRun = bus.subscribe({ runId: 'run-target' }, (ev) => {
        runMatched.push(ev);
      });
      const subSession = bus.subscribe({ sessionId: 'session-target' }, (ev) => {
        sessionMatched.push(ev);
      });

      // Event with runId in meta
      bus.publish(makeEvent('s', 'e1', 1, { runId: 'run-target' }));
      // Event with runId in payload
      bus.publish(makeEvent('s', 'e2', 2, {}, { runId: 'run-target' }));
      // Event with different runId
      bus.publish(makeEvent('s', 'e3', 3, { runId: 'other-run' }));

      // Event with sessionId in meta
      bus.publish(makeEvent('s', 's1', 4, { sessionId: 'session-target' }));
      // Event with sessionId in payload
      bus.publish(makeEvent('s', 's2', 5, {}, { sessionId: 'session-target' }));

      await Promise.all([subRun.drain(), subSession.drain()]);

      expect(runMatched).toHaveLength(2);
      expect(sessionMatched).toHaveLength(2);

      await bus.close();
    });

    it('filters using custom predicate function', async () => {
      const bus = new EventBus();
      const evenSeqEvents: EventEnvelope[] = [];

      const sub = bus.subscribe({ predicate: (ev) => ev.seq % 2 === 0 }, (ev) => {
        evenSeqEvents.push(ev);
      });

      for (let i = 1; i <= 4; i++) {
        bus.publish(makeEvent('s', 'e', i));
      }

      await sub.drain();

      expect(evenSeqEvents.map((e) => e.seq)).toEqual([2, 4]);

      await bus.close();
    });

    it('standalone matchesEventFilter evaluates accurately', () => {
      const ev = makeEvent('stream:1', 'run.created', 1, { runId: 'r1' });
      const streamFilter: EventSubscriptionFilter = { stream: 'stream:1' };

      expect(matchesEventFilter(ev, streamFilter)).toBe(true);
      expect(matchesEventFilter(ev, { stream: 'other' })).toBe(false);
      expect(matchesEventFilter(ev, { streamPrefix: 'stream:' })).toBe(true);
      expect(matchesEventFilter(ev, { streamPrefix: 'session:' })).toBe(false);
      expect(matchesEventFilter(ev, { types: ['run.created'] })).toBe(true);
      expect(matchesEventFilter(ev, { types: ['tool.*'] })).toBe(false);
      expect(matchesEventFilter(ev, { runId: 'r1' })).toBe(true);
      expect(matchesEventFilter(ev, { runId: 'r2' })).toBe(false);
      expect(matchesEventFilter(ev, { sessionId: 's1' })).toBe(false);
      expect(matchesEventFilter(ev, { predicate: () => false })).toBe(false);
    });
  });

  // ==========================================================================
  // Bounded Queues & Backpressure Drop Policies
  // ==========================================================================

  describe('Bounded Queue & Backpressure', () => {
    it('drops oldest events when queue reaches capacity with drop-oldest policy', async () => {
      const bus = new EventBus({ clock: fakeClock });
      const received: EventEnvelope[] = [];

      // Slow handler to force queue backup
      let resolveFirst: (() => void) | undefined;
      const firstHold = new Promise<void>((res) => {
        resolveFirst = res;
      });

      const sub = bus.subscribe(
        {},
        async (ev) => {
          if (ev.seq === 1) {
            await firstHold;
          }
          received.push(ev);
        },
        {
          name: 'slow-drop-oldest',
          maxQueueSize: 2,
          dropPolicy: 'drop-oldest',
        },
      );

      // Event 1 is popped and enters in-flight handler
      bus.publish(makeEvent('s', 'e', 1));

      // Events 2 and 3 fill queue (size = 2)
      bus.publish(makeEvent('s', 'e', 2));
      bus.publish(makeEvent('s', 'e', 3));

      // Event 4 arrives when queue is full: seq 2 should be dropped, seq 4 queued
      bus.publish(makeEvent('s', 'e', 4));

      // Release first handler
      resolveFirst?.();

      await sub.drain();

      // Expected: 1 (processed first), 3, 4 (2 was dropped)
      expect(received.map((e) => e.seq)).toEqual([1, 3, 4]);

      const stats = sub.getStats();
      expect(stats.droppedCount).toBe(1);

      await bus.close();
    });

    it('drops newest events when queue reaches capacity with drop-newest policy', async () => {
      const bus = new EventBus();
      const received: EventEnvelope[] = [];

      let resolveFirst: (() => void) | undefined;
      const firstHold = new Promise<void>((res) => {
        resolveFirst = res;
      });

      const sub = bus.subscribe(
        {},
        async (ev) => {
          if (ev.seq === 1) {
            await firstHold;
          }
          received.push(ev);
        },
        {
          name: 'slow-drop-newest',
          maxQueueSize: 2,
          dropPolicy: 'drop-newest',
        },
      );

      bus.publish(makeEvent('s', 'e', 1)); // Enters in-flight handler
      bus.publish(makeEvent('s', 'e', 2)); // Queue index 0
      bus.publish(makeEvent('s', 'e', 3)); // Queue index 1 (queue full: length 2)
      bus.publish(makeEvent('s', 'e', 4)); // Dropped because drop-newest

      resolveFirst?.();
      await sub.drain();

      expect(received.map((e) => e.seq)).toEqual([1, 2, 3]);

      const stats = sub.getStats();
      expect(stats.droppedCount).toBe(1);

      await bus.close();
    });

    it('invokes onError when queue reaches capacity with error policy', async () => {
      const bus = new EventBus();
      let caughtError: unknown;

      let resolveFirst: (() => void) | undefined;
      const firstHold = new Promise<void>((res) => {
        resolveFirst = res;
      });

      const sub = bus.subscribe(
        {},
        async (ev) => {
          if (ev.seq === 1) {
            await firstHold;
          }
        },
        {
          name: 'slow-error',
          maxQueueSize: 2,
          dropPolicy: 'error',
          onError: (err) => {
            caughtError = err;
          },
        },
      );

      bus.publish(makeEvent('s', 'e', 1)); // In-flight
      bus.publish(makeEvent('s', 'e', 2)); // In queue
      bus.publish(makeEvent('s', 'e', 3)); // In queue (full)
      bus.publish(makeEvent('s', 'e', 4)); // Overflows, triggers onError

      expect(caughtError).toBeInstanceOf(AirError);
      expect((caughtError as AirError).code).toBe('RESOURCE_EXHAUSTED');

      resolveFirst?.();
      await sub.drain();

      await bus.close();
    });

    it('throws RESOURCE_EXHAUSTED if error policy and no onError handler provided', async () => {
      const bus = new EventBus();

      let resolveFirst: (() => void) | undefined;
      const firstHold = new Promise<void>((res) => {
        resolveFirst = res;
      });

      const sub = bus.subscribe(
        {},
        async (ev) => {
          if (ev.seq === 1) await firstHold;
        },
        {
          maxQueueSize: 1,
          dropPolicy: 'error',
        },
      );

      bus.publish(makeEvent('s', 'e', 1));
      bus.publish(makeEvent('s', 'e', 2)); // Queue full (size 1)

      expect(() => bus.publish(makeEvent('s', 'e', 3))).toThrow(AirError);

      resolveFirst?.();
      await sub.drain();
      await bus.close();
    });
  });

  // ==========================================================================
  // Error Isolation & Handler Resilience
  // ==========================================================================

  describe('Error Isolation', () => {
    it('isolates errors from failing subscriber handlers and calls onError', async () => {
      const bus = new EventBus();
      let reportedError: unknown;
      const healthyReceived: EventEnvelope[] = [];

      const failingSub = bus.subscribe(
        {},
        (ev) => {
          if (ev.seq === 1) {
            throw new Error('Handler crashed intentionally');
          }
        },
        {
          onError: (err) => {
            reportedError = err;
          },
        },
      );

      const healthySub = bus.subscribe({}, (ev) => {
        healthyReceived.push(ev);
      });

      bus.publish(makeEvent('s', 'e', 1));
      bus.publish(makeEvent('s', 'e', 2));

      await Promise.all([failingSub.drain(), healthySub.drain()]);

      expect(reportedError).toBeInstanceOf(Error);
      expect((reportedError as Error).message).toBe('Handler crashed intentionally');

      // Healthy subscriber processed both events uninterrupted
      expect(healthyReceived).toHaveLength(2);

      // Failing subscriber stats recorded the error
      expect(failingSub.getStats().errorCount).toBe(1);
      expect(failingSub.getStats().processedCount).toBe(1); // seq 2 succeeded

      await bus.close();
    });
  });

  // ==========================================================================
  // Drain, Unsubscribe, and Close Lifecycle
  // ==========================================================================

  describe('Lifecycle: Drain, Unsubscribe, and Close', () => {
    it('supports clean unsubscribe and stops receiving subsequent events', async () => {
      const bus = new EventBus();
      const received: EventEnvelope[] = [];

      const sub = bus.subscribe({}, (ev) => {
        received.push(ev);
      });

      bus.publish(makeEvent('s', 'e', 1));
      await sub.drain();
      expect(received).toHaveLength(1);

      sub.unsubscribe();
      expect(sub.isClosed).toBe(true);

      // Idempotent unsubscribe
      expect(() => sub.unsubscribe()).not.toThrow();

      bus.publish(makeEvent('s', 'e', 2));
      expect(received).toHaveLength(1); // No new events delivered

      await bus.close();
    });

    it('drains active queue on bus.close(true)', async () => {
      const bus = new EventBus();
      const received: EventEnvelope[] = [];

      bus.subscribe({}, async (ev) => {
        await new Promise((r) => setTimeout(r, 10));
        received.push(ev);
      });

      bus.publish(makeEvent('s', 'e', 1));
      bus.publish(makeEvent('s', 'e', 2));

      await bus.close(true);

      expect(received).toHaveLength(2);
      expect(bus.isClosed).toBe(true);
    });

    it('abruptly closes on bus.close(false)', async () => {
      const bus = new EventBus();
      bus.subscribe({}, async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      bus.publish(makeEvent('s', 'e', 1));
      await bus.close(false);

      expect(bus.isClosed).toBe(true);
      expect(bus.getStats().activeSubscriptions).toBe(0);
    });

    it('rejects publish after close with INVALID_STATE', async () => {
      const bus = new EventBus();
      await bus.close();

      expect(() => bus.publish(makeEvent('s', 'e'))).toThrow(AirError);
      expect(() => bus.subscribe({}, () => {})).toThrow(AirError);
    });

    it('resolves pending drain resolvers when subscriber is unsubscribed', async () => {
      const bus = new EventBus();
      let holdResolver: (() => void) | undefined;
      const hold = new Promise<void>((r) => {
        holdResolver = r;
      });

      const sub = bus.subscribe({}, async () => {
        await hold;
      });

      bus.publish(makeEvent('s', 'e', 1));
      // drain is now pending because handler is holding
      const drainPromise = sub.drain();

      // Unsubscribe while drain is pending
      sub.unsubscribe();
      holdResolver?.();

      // Drain promise should resolve cleanly
      await expect(drainPromise).resolves.toBeUndefined();
      await bus.close();
    });
  });

  // ==========================================================================
  // waitFor Utility
  // ==========================================================================

  describe('waitFor utility', () => {
    it('resolves when matching event is published and cleans up', async () => {
      const bus = new EventBus();

      const waitPromise = bus.waitFor({ types: ['run.completed'] }, 2000);

      bus.publish(makeEvent('s', 'run.started', 1));
      bus.publish(makeEvent('s', 'run.completed', 2));

      const result = await waitPromise;
      expect(result.type).toBe('run.completed');
      expect(result.seq).toBe(2);

      // Subscription should be automatically closed
      expect(bus.getStats().activeSubscriptions).toBe(0);

      await bus.close();
    });

    it('rejects with DEADLINE_EXCEEDED when timeout expires', async () => {
      const bus = new EventBus();

      await expect(bus.waitFor({ types: ['nonexistent'] }, 50)).rejects.toThrow(AirError);
      expect(bus.getStats().activeSubscriptions).toBe(0);

      await bus.close();
    });

    it('rejects with INVALID_STATE when waitFor called on closed bus', async () => {
      const bus = new EventBus();
      await bus.close();

      await expect(bus.waitFor({})).rejects.toThrow(AirError);
    });
  });

  // ==========================================================================
  // Metrics Integration & Statistics
  // ==========================================================================

  describe('Metrics & Stats', () => {
    it('records counters and gauges in MetricRegistry and reports getStats()', async () => {
      const reg = new MetricsRegistry();
      const bus = new EventBus({ metrics: reg });

      const sub1 = bus.subscribe({}, () => {}, { name: 'sub-A' });
      const sub2 = bus.subscribe({}, () => {}, { name: 'sub-B' });

      expect(bus.getStats().activeSubscriptions).toBe(2);

      bus.publish(makeEvent('s', 'e', 1));
      await Promise.all([sub1.drain(), sub2.drain()]);

      const stats = bus.getStats();
      expect(stats.publishedTotal).toBe(1);
      expect(stats.deliveredTotal).toBe(2);
      expect(stats.droppedTotal).toBe(0);
      expect(stats.errorTotal).toBe(0);

      const snapshot = reg.snapshot();
      expect(snapshot.counters['eventbus_events_published_total']).toBe(1);
      expect(snapshot.counters['eventbus_events_delivered_total{subscriber="sub-A"}']).toBe(1);
      expect(snapshot.counters['eventbus_events_delivered_total{subscriber="sub-B"}']).toBe(1);

      await bus.close();
      expect(reg.snapshot().gauges['eventbus_subscriptions_active']).toBe(0);
    });
  });
});
