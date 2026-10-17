import { describe, expect, it } from 'vitest';
import {
  computeToolCallSignature,
  StallDetector,
  type ToolCallSnapshot,
} from '../../../src/agent/detector.js';
import { AirError } from '../../../src/errors/index.js';

describe('StallDetector (P6-T07)', () => {
  describe('computeToolCallSignature', () => {
    it('produces identical signature regardless of argument key order', () => {
      const sig1 = computeToolCallSignature('fs.read', { path: 'a.txt', encoding: 'utf8' });
      const sig2 = computeToolCallSignature('fs.read', { encoding: 'utf8', path: 'a.txt' });
      expect(sig1).toBe(sig2);
    });

    it('produces distinct signatures for different arguments or tool names', () => {
      const sig1 = computeToolCallSignature('fs.read', { path: 'a.txt' });
      const sig2 = computeToolCallSignature('fs.read', { path: 'b.txt' });
      const sig3 = computeToolCallSignature('fs.write', { path: 'a.txt' });
      expect(sig1).not.toBe(sig2);
      expect(sig1).not.toBe(sig3);
    });
  });

  describe('Stall Detection Heuristics', () => {
    it('returns isStalled: false for diverse tool calls', () => {
      const detector = new StallDetector();

      const r1 = detector.recordTurn(0, [{ name: 'fs.read', arguments: { path: 'file1.ts' } }]);
      expect(r1.isStalled).toBe(false);

      const r2 = detector.recordTurn(1, [{ name: 'fs.write', arguments: { path: 'file1.ts' } }]);
      expect(r2.isStalled).toBe(false);

      const r3 = detector.recordTurn(2, [{ name: 'exec.run', arguments: { command: 'test' } }]);
      expect(r3.isStalled).toBe(false);
    });

    it('flags repeated identical tool calls', () => {
      const detector = new StallDetector({ maxIdenticalCalls: 3 });

      const call: ToolCallSnapshot = { name: 'fs.read', arguments: { path: 'loop.txt' } };

      detector.recordTurn(0, [call]);
      detector.recordTurn(1, [call]);
      const res = detector.recordTurn(2, [call]);

      expect(res.isStalled).toBe(true);
      expect(res.type).toBe('identical_calls');
      expect(res.reason).toContain('identical tool call 3 consecutive times');
    });

    it('assertNotStalled throws AGENT_STALL_DETECTED when stalled', () => {
      const detector = new StallDetector({ maxIdenticalCalls: 2 });
      const call: ToolCallSnapshot = { name: 'fs.read', arguments: { path: 'data.json' } };

      detector.assertNotStalled(0, [call]);
      expect(() => detector.assertNotStalled(1, [call])).toThrow(AirError);

      try {
        detector.assertNotStalled(1, [call]);
      } catch (err) {
        expect(err).toBeInstanceOf(AirError);
        expect((err as AirError).code).toBe('AGENT_STALL_DETECTED');
      }
    });

    it('flags repeating cycles (ping-pong loops)', () => {
      const detector = new StallDetector({ maxCycleRepetitions: 2 });
      const callA: ToolCallSnapshot = { name: 'toolA', arguments: {} };
      const callB: ToolCallSnapshot = { name: 'toolB', arguments: {} };

      // Cycle period 2: [A, B] repeated 3 times (len = 6)
      detector.recordTurn(0, [callA]);
      detector.recordTurn(1, [callB]);
      detector.recordTurn(2, [callA]);
      detector.recordTurn(3, [callB]);
      detector.recordTurn(4, [callA]);
      const res = detector.recordTurn(5, [callB]);

      expect(res.isStalled).toBe(true);
      expect(res.type).toBe('cycle_detected');
      expect(res.reason).toContain('repeating cycle of length 2');
    });

    it('flags repeated identical errors on the same tool call', () => {
      const detector = new StallDetector({ maxRepeatedErrors: 3 });
      const failedCall: ToolCallSnapshot = {
        name: 'fs.write',
        arguments: { path: 'protected.sys' },
        error: { code: 'PERMISSION_DENIED', message: 'Access denied' },
      };

      detector.recordTurn(0, [failedCall]);
      detector.recordTurn(1, [failedCall]);
      const res = detector.recordTurn(2, [failedCall]);

      expect(res.isStalled).toBe(true);
      expect(res.type).toBe('repeated_failure');
      expect(res.reason).toContain('failed with the same error "PERMISSION_DENIED"');
    });

    it('flags max turns exceeded', () => {
      const detector = new StallDetector({ maxTurns: 3 });

      detector.recordTurn(0, [{ name: 't1', arguments: {} }]);
      detector.recordTurn(1, [{ name: 't2', arguments: {} }]);
      detector.recordTurn(2, [{ name: 't3', arguments: {} }]);
      const res = detector.recordTurn(3, [{ name: 't4', arguments: {} }]);

      expect(res.isStalled).toBe(true);
      expect(res.type).toBe('max_turns_exceeded');
      expect(res.reason).toContain('exceeded maximum allowed turns limit of 3');
    });

    it('resets history upon reset()', () => {
      const detector = new StallDetector({ maxTurns: 2 });
      detector.recordTurn(0, [{ name: 't1', arguments: {} }]);
      detector.recordTurn(1, [{ name: 't2', arguments: {} }]);

      detector.reset();

      const res = detector.recordTurn(0, [{ name: 't1', arguments: {} }]);
      expect(res.isStalled).toBe(false);
    });
  });
});
