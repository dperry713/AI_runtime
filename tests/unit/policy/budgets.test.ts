/**
 * Budgets & Quotas Tests (Phase 5 - P5-T05).
 *
 * Verifies:
 * - Multi-dimensional budget tracking: tokens, USD, steps, tool-calls, wall-clock.
 * - Per-tool quota enforcement.
 * - Pre-check validation before steps, model inference, and tool executions.
 * - In-flight recording and post-call limit violations.
 * - Single-shot journal event emission (`run.budget_exceeded`) via EventBus (Rule R8).
 * - Configuration translation via BudgetTracker.fromConfig.
 * - Reset and lifecycle management.
 * - throwOnExceeded flag behavior (throw vs report).
 */

import { describe, expect, it } from 'vitest';
import {
  BudgetTracker,
} from '../../../src/policy/index.js';
import { FakeClock, FakeIdGenerator } from '../../../src/util/index.js';
import { EventBus } from '../../../src/journal/index.js';
import { AirError } from '../../../src/errors/index.js';

describe('BudgetTracker (P5-T05)', () => {
  const clock = new FakeClock(new Date('2026-10-17T12:00:00.000Z'));
  const idGen = new FakeIdGenerator();

  describe('Step Quota Enforcement', () => {
    it('allows steps within quota and throws on pre-check when exhausted', () => {
      const tracker = new BudgetTracker({ clock, idGenerator: idGen });
      tracker.createBudget('run-steps-1', {
        limits: { maxSteps: 3 },
      });

      // Steps 1, 2, 3 allowed
      expect(tracker.preCheckStep('run-steps-1').allowed).toBe(true);
      tracker.recordStep('run-steps-1');

      expect(tracker.preCheckStep('run-steps-1').allowed).toBe(true);
      tracker.recordStep('run-steps-1');

      expect(tracker.preCheckStep('run-steps-1').allowed).toBe(true);
      tracker.recordStep('run-steps-1');

      // Step 4 pre-check throws RUN_BUDGET_EXCEEDED
      expect(() => tracker.preCheckStep('run-steps-1')).toThrowError(AirError);
      try {
        tracker.preCheckStep('run-steps-1');
      } catch (err) {
        const airErr = err as AirError;
        expect(airErr.code).toBe('RUN_BUDGET_EXCEEDED');
        expect(airErr.context?.dimension).toBe('steps');
        expect(airErr.context?.limit).toBe(3);
      }
    });

    it('records multiple steps and triggers in-flight violation', () => {
      const tracker = new BudgetTracker({ clock, idGenerator: idGen });
      tracker.createBudget('run-steps-2', {
        limits: { maxSteps: 5 },
      });

      tracker.recordStep('run-steps-2', 3);
      const snap = tracker.getSnapshot('run-steps-2');
      expect(snap.usage.steps).toBe(3);
      expect(snap.status).toBe('active');

      expect(() => tracker.recordStep('run-steps-2', 3)).toThrowError(AirError);
      const snapExceeded = tracker.getSnapshot('run-steps-2');
      expect(snapExceeded.status).toBe('exceeded');
      expect(snapExceeded.usage.steps).toBe(6);
    });
  });

  describe('Token & USD Spend Quotas', () => {
    it('enforces cumulative token limit and pre-check projected tokens', () => {
      const tracker = new BudgetTracker({ clock, idGenerator: idGen });
      tracker.createBudget('run-tokens-1', {
        limits: { maxTokens: 10_000 },
      });

      tracker.recordTokens('run-tokens-1', { input: 4000, output: 2000 });
      let snap = tracker.getSnapshot('run-tokens-1');
      expect(snap.usage.tokens).toBe(6000);
      expect(snap.utilization.tokensPct).toBe(60);

      // Pre-check with projected estimate that exceeds limit
      expect(() =>
        tracker.preCheckModelCall('run-tokens-1', { tokens: 5000 }),
      ).toThrowError(AirError);

      // Pre-check with safe estimate passes
      expect(
        tracker.preCheckModelCall('run-tokens-1', { tokens: 3000 }).allowed,
      ).toBe(true);

      // Record tokens that breach limit
      expect(() =>
        tracker.recordTokens('run-tokens-1', { input: 3000, output: 2000 }),
      ).toThrowError(AirError);

      snap = tracker.getSnapshot('run-tokens-1');
      expect(snap.status).toBe('exceeded');
      expect(snap.exceeded?.dimension).toBe('tokens');
      expect(snap.usage.tokens).toBe(11_000);
    });

    it('enforces USD cost quota and pre-check projected spend', () => {
      const tracker = new BudgetTracker({ clock, idGenerator: idGen });
      tracker.createBudget('run-cost-1', {
        limits: { maxUsd: 0.5 },
      });

      tracker.recordTokens('run-cost-1', { costUsd: 0.25 });
      expect(tracker.getSnapshot('run-cost-1').usage.costUsd).toBe(0.25);

      // Projected spend of $0.30 exceeds remaining $0.25
      expect(() =>
        tracker.preCheckModelCall('run-cost-1', { costUsd: 0.3 }),
      ).toThrowError(AirError);

      // Incurring additional spend exceeding budget throws
      expect(() =>
        tracker.recordTokens('run-cost-1', { costUsd: 0.3 }),
      ).toThrowError(AirError);

      const snap = tracker.getSnapshot('run-cost-1');
      expect(snap.status).toBe('exceeded');
      expect(snap.exceeded?.dimension).toBe('cost');
    });
  });

  describe('Tool Quotas (Overall & Per-Tool)', () => {
    it('enforces total tool call quota', () => {
      const tracker = new BudgetTracker({ clock, idGenerator: idGen });
      tracker.createBudget('run-tool-1', {
        limits: { maxToolCalls: 2 },
      });

      expect(tracker.preCheckToolCall('run-tool-1', 'fs.read').allowed).toBe(true);
      tracker.recordToolCall('run-tool-1', 'fs.read');

      expect(tracker.preCheckToolCall('run-tool-1', 'fs.write').allowed).toBe(true);
      tracker.recordToolCall('run-tool-1', 'fs.write');

      // Pre-check for third call throws
      expect(() => tracker.preCheckToolCall('run-tool-1', 'fs.stat')).toThrowError(AirError);
      try {
        tracker.preCheckToolCall('run-tool-1', 'fs.stat');
      } catch (err) {
        const airErr = err as AirError;
        expect(airErr.code).toBe('RUN_BUDGET_EXCEEDED');
        expect(airErr.context?.dimension).toBe('tool_calls');
      }
    });

    it('enforces tool-specific limits independently', () => {
      const tracker = new BudgetTracker({ clock, idGenerator: idGen });
      tracker.createBudget('run-pertool-1', {
        limits: {
          maxToolCalls: 10,
          perToolLimits: {
            'exec.run': 1,
            'fs.delete': 2,
          },
        },
      });

      // exec.run first call passes
      expect(tracker.preCheckToolCall('run-pertool-1', 'exec.run').allowed).toBe(true);
      tracker.recordToolCall('run-pertool-1', 'exec.run');

      // exec.run second call blocked
      expect(() => tracker.preCheckToolCall('run-pertool-1', 'exec.run')).toThrowError(AirError);

      // other tools still allowed
      expect(tracker.preCheckToolCall('run-pertool-1', 'fs.read').allowed).toBe(true);
      tracker.recordToolCall('run-pertool-1', 'fs.read');

      expect(tracker.preCheckToolCall('run-pertool-1', 'fs.delete').allowed).toBe(true);
      tracker.recordToolCall('run-pertool-1', 'fs.delete');
      expect(tracker.preCheckToolCall('run-pertool-1', 'fs.delete').allowed).toBe(true);
      tracker.recordToolCall('run-pertool-1', 'fs.delete');

      // fs.delete third call blocked
      expect(() => tracker.preCheckToolCall('run-pertool-1', 'fs.delete')).toThrowError(AirError);
    });
  });

  describe('Wall-Clock Budget Enforcement', () => {
    it('detects wall-clock time limit expiration via pre-check and explicit check', () => {
      const testClock = new FakeClock(new Date('2026-10-17T12:00:00.000Z'));
      const tracker = new BudgetTracker({ clock: testClock, idGenerator: idGen });

      tracker.createBudget('run-wall-1', {
        limits: { maxWallClockMs: 60_000 }, // 1 minute
      });

      // After 30 seconds: allowed
      testClock.advance(30_000);
      expect(tracker.checkWallClock('run-wall-1').allowed).toBe(true);
      expect(tracker.preCheckStep('run-wall-1').allowed).toBe(true);
      expect(tracker.preCheckModelCall('run-wall-1').allowed).toBe(true);
      expect(tracker.preCheckToolCall('run-wall-1', 'fs.read').allowed).toBe(true);

      // After another 40 seconds (70s total): exceeded
      testClock.advance(40_000);
      expect(() => tracker.checkWallClock('run-wall-1')).toThrowError(AirError);
      expect(() => tracker.preCheckStep('run-wall-1')).toThrowError(AirError);
      expect(() => tracker.preCheckToolCall('run-wall-1', 'fs.read')).toThrowError(AirError);

      const snap = tracker.getSnapshot('run-wall-1');
      expect(snap.status).toBe('exceeded');
      expect(snap.exceeded?.dimension).toBe('wall_time');
      expect(snap.usage.wallClockElapsedMs).toBe(70_000);
    });
  });

  describe('Single-Shot Journal Event Emission (Rule R8)', () => {
    it('publishes run.budget_exceeded to EventBus exactly once per run breach', async () => {
      const eventBus = new EventBus({ clock, idGenerator: idGen });
      const events: unknown[] = [];

      const sub = eventBus.subscribe({ types: ['run.budget_exceeded'] }, (e) => {
        events.push(e);
      });

      const tracker = new BudgetTracker({
        clock,
        idGenerator: idGen,
        eventBus,
      });

      tracker.createBudget('run-event-1', {
        limits: { maxSteps: 2 },
        sessionId: 'session-xyz',
        agentId: 'agent-coder',
      });

      tracker.recordStep('run-event-1');
      tracker.recordStep('run-event-1');

      // Next step triggers violation and publishes event
      expect(() => tracker.recordStep('run-event-1')).toThrowError(AirError);

      // Subsequent actions on already-exceeded budget do not emit duplicate event
      expect(() => tracker.recordStep('run-event-1')).toThrowError(AirError);
      expect(() => tracker.preCheckStep('run-event-1')).toThrowError(AirError);

      await sub.drain();

      expect(events).toHaveLength(1);
      const evt = events[0] as {
        type: string;
        payload: { dimension: string; limit: number; actual: number };
        meta: { runId: string; sessionId: string; agentId: string };
      };
      expect(evt.type).toBe('run.budget_exceeded');
      expect(evt.payload.dimension).toBe('steps');
      expect(evt.payload.limit).toBe(2);
      expect(evt.payload.actual).toBe(3);
      expect(evt.meta.runId).toBe('run-event-1');
      expect(evt.meta.sessionId).toBe('session-xyz');
      expect(evt.meta.agentId).toBe('agent-coder');
    });
  });

  describe('Configuration Translation & Management', () => {
    it('translates BudgetsConfig into RunBudgetLimits via fromConfig', () => {
      const limits = BudgetTracker.fromConfig({
        maxUsdPerRun: 5.0,
        maxTokensPerRun: 1_000_000,
        maxStepsPerRun: 50,
        maxWallClockMinutes: 30,
      });

      expect(limits.maxUsd).toBe(5.0);
      expect(limits.maxTokens).toBe(1_000_000);
      expect(limits.maxSteps).toBe(50);
      expect(limits.maxWallClockMs).toBe(30 * 60 * 1000);
    });

    it('manages budget reset, delete, and active runs listing', () => {
      const tracker = new BudgetTracker({ clock, idGenerator: idGen });
      tracker.createBudget('run-lifecycle-1', { limits: { maxSteps: 10 } });
      tracker.createBudget('run-lifecycle-2', { limits: { maxSteps: 20 } });

      expect(tracker.listActiveRuns()).toEqual(['run-lifecycle-1', 'run-lifecycle-2']);
      expect(tracker.hasBudget('run-lifecycle-1')).toBe(true);

      tracker.recordStep('run-lifecycle-1', 4);
      expect(tracker.getSnapshot('run-lifecycle-1').usage.steps).toBe(4);

      // Reset
      const resetSnap = tracker.reset('run-lifecycle-1');
      expect(resetSnap.usage.steps).toBe(0);
      expect(resetSnap.status).toBe('active');

      // Delete
      expect(tracker.deleteBudget('run-lifecycle-1')).toBe(true);
      expect(tracker.hasBudget('run-lifecycle-1')).toBe(false);
      expect(tracker.listActiveRuns()).toEqual(['run-lifecycle-2']);
    });

    it('respects throwOnExceeded: false option to report instead of throw', () => {
      const tracker = new BudgetTracker({
        clock,
        idGenerator: idGen,
        throwOnExceeded: false,
      });

      tracker.createBudget('run-nothrow', { limits: { maxSteps: 1 } });
      tracker.recordStep('run-nothrow');

      // Pre-check returns allowed: false without throwing
      const checkRes = tracker.preCheckStep('run-nothrow');
      expect(checkRes.allowed).toBe(false);
      expect(checkRes.exceeded?.dimension).toBe('steps');
    });
  });
});
