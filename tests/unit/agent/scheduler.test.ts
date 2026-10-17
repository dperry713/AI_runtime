import { describe, expect, it } from 'vitest';
import {
  scheduleToolExecution,
  validateToolDependencies,
  type ScheduledToolCall,
} from '../../../src/agent/scheduler.js';
import { AirError } from '../../../src/errors/index.js';

describe('ToolScheduler (P6-T04)', () => {
  describe('validateToolDependencies', () => {
    it('accepts valid DAG without dependencies', () => {
      const calls: ScheduledToolCall[] = [
        { id: 't1', name: 'fs.read', arguments: {} },
        { id: 't2', name: 'fs.read', arguments: {} },
      ];
      expect(() => validateToolDependencies(calls)).not.toThrow();
    });

    it('accepts valid linear and branching dependencies', () => {
      const calls: ScheduledToolCall[] = [
        { id: 't1', name: 'fs.read', arguments: {} },
        { id: 't2', name: 'fs.write', arguments: {}, dependsOn: ['t1'] },
        { id: 't3', name: 'exec.run', arguments: {}, dependsOn: ['t1', 't2'] },
      ];
      expect(() => validateToolDependencies(calls)).not.toThrow();
    });

    it('rejects self-dependency', () => {
      const calls: ScheduledToolCall[] = [
        { id: 't1', name: 'fs.read', arguments: {}, dependsOn: ['t1'] },
      ];
      expect(() => validateToolDependencies(calls)).toThrow(AirError);
      try {
        validateToolDependencies(calls);
      } catch (err) {
        expect((err as AirError).code).toBe('INVALID_ARGUMENT');
      }
    });

    it('rejects non-existent dependency', () => {
      const calls: ScheduledToolCall[] = [
        { id: 't1', name: 'fs.read', arguments: {}, dependsOn: ['missing-t0'] },
      ];
      expect(() => validateToolDependencies(calls)).toThrow(AirError);
    });

    it('rejects cyclic dependency', () => {
      const calls: ScheduledToolCall[] = [
        { id: 't1', name: 'fs.read', arguments: {}, dependsOn: ['t2'] },
        { id: 't2', name: 'fs.write', arguments: {}, dependsOn: ['t1'] },
      ];
      expect(() => validateToolDependencies(calls)).toThrow(AirError);
      try {
        validateToolDependencies(calls);
      } catch (err) {
        expect((err as AirError).code).toBe('INVALID_ARGUMENT');
        expect((err as AirError).message).toContain('Cyclic dependency');
      }
    });
  });

  describe('scheduleToolExecution', () => {
    it('returns empty array when calls list is empty', async () => {
      const results = await scheduleToolExecution([], () =>
        Promise.resolve({
          success: true,
        }),
      );
      expect(results).toEqual([]);
    });

    it('preserves exact output order even when tools finish out of order', async () => {
      const calls: ScheduledToolCall[] = [
        { id: 'slow-1', name: 't1', arguments: { delay: 40 } },
        { id: 'fast-2', name: 't2', arguments: { delay: 5 } },
        { id: 'medium-3', name: 't3', arguments: { delay: 20 } },
      ];

      const completedOrder: string[] = [];

      const results = await scheduleToolExecution(
        calls,
        async (call) => {
          const delay = (call.arguments as { delay: number }).delay;
          await new Promise((r) => setTimeout(r, delay));
          completedOrder.push(String(call.id));
          return { success: true, output: `result-of-${String(call.id)}` };
        },
        { maxParallel: 4 },
      );

      // Finished out of order
      expect(completedOrder).toEqual(['fast-2', 'medium-3', 'slow-1']);

      // But returned results are in exact original order
      expect(results.map((r) => r.toolCallId)).toEqual(['slow-1', 'fast-2', 'medium-3']);
      expect(results[0]?.output).toBe('result-of-slow-1');
      expect(results[1]?.output).toBe('result-of-fast-2');
      expect(results[2]?.output).toBe('result-of-medium-3');
    });

    it('enforces concurrency limit', async () => {
      const calls: ScheduledToolCall[] = [
        { id: 'c1', name: 't', arguments: {} },
        { id: 'c2', name: 't', arguments: {} },
        { id: 'c3', name: 't', arguments: {} },
        { id: 'c4', name: 't', arguments: {} },
      ];

      let inFlight = 0;
      let maxObservedInFlight = 0;

      await scheduleToolExecution(
        calls,
        async () => {
          inFlight++;
          if (inFlight > maxObservedInFlight) {
            maxObservedInFlight = inFlight;
          }
          await new Promise((r) => setTimeout(r, 15));
          inFlight--;
          return { success: true };
        },
        { maxParallel: 2 },
      );

      expect(maxObservedInFlight).toBeLessThanOrEqual(2);
    });

    it('executes tools according to dependency DAG order', async () => {
      const executionOrder: string[] = [];

      const calls: ScheduledToolCall[] = [
        { id: 'step3', name: 'exec', arguments: {}, dependsOn: ['step2'] },
        { id: 'step1', name: 'read', arguments: {} },
        { id: 'step2', name: 'write', arguments: {}, dependsOn: ['step1'] },
      ];

      const results = await scheduleToolExecution(
        calls,
        async (call) => {
          executionOrder.push(String(call.id));
          await new Promise((r) => setTimeout(r, 5));
          return { success: true, output: `done-${String(call.id)}` };
        },
        { maxParallel: 3 },
      );

      expect(executionOrder).toEqual(['step1', 'step2', 'step3']);
      expect(results.every((r) => r.success)).toBe(true);
      expect(results.map((r) => r.toolCallId)).toEqual(['step3', 'step1', 'step2']);
    });

    it('cascades failure when prerequisite tool fails', async () => {
      const calls: ScheduledToolCall[] = [
        { id: 'parent', name: 'flaky', arguments: {} },
        { id: 'child', name: 'downstream', arguments: {}, dependsOn: ['parent'] },
      ];

      const results = await scheduleToolExecution(calls, (call) => {
        if (call.id === 'parent') {
          return Promise.resolve({
            success: false,
            error: { code: 'FAIL', message: 'Parent step crashed' },
          });
        }
        return Promise.resolve({ success: true });
      });

      expect(results[0]?.success).toBe(false);
      expect(results[0]?.error?.code).toBe('FAIL');

      expect(results[1]?.success).toBe(false);
      expect(results[1]?.error?.code).toBe('FAILED_PRECONDITION');
      expect(results[1]?.error?.message).toContain('failed; skipping execution');
    });

    it('honors AbortSignal for cooperative cancellation', async () => {
      const controller = new AbortController();

      const calls: ScheduledToolCall[] = [
        { id: 'c1', name: 't1', arguments: {} },
        { id: 'c2', name: 't2', arguments: {} },
      ];

      controller.abort(new Error('User aborted execution'));

      const results = await scheduleToolExecution(
        calls,
        async () => {
          await new Promise((r) => setTimeout(r, 50));
          return { success: true };
        },
        { signal: controller.signal },
      );

      expect(results.every((r) => !r.success)).toBe(true);
      expect(results.some((r) => r.error?.code === 'CANCELLED')).toBe(true);
    });
  });
});
