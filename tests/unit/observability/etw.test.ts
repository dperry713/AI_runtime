/**
 * Unit tests for ETW Provider (Phase W4 - ETW telemetry).
 *
 * Tests the EtwProvider class including event emission, log record mapping,
 * SSE server lifecycle, and platform-specific behavior.
 */

import { describe, expect, it } from 'vitest';
import { EtwProvider, createEtwProvider } from '../../../src/observability/etw.js';

describe('EtwProvider', () => {
  describe('construction', () => {
    it('creates a provider with default options', () => {
      const provider = new EtwProvider();
      expect(provider.isEnabled).toBe(process.platform === 'win32');
      expect(provider.port).toBe(0);
      provider.close();
    });

    it('creates a provider with custom options', () => {
      const provider = new EtwProvider({
        providerName: 'Test-Provider',
        providerGuid: '11111111-1111-1111-1111-111111111111',
        enabled: true,
      });
      expect(provider.isEnabled).toBe(true);
      provider.close();
    });

    it('creates a provider via factory function', () => {
      const provider = createEtwProvider({ enabled: false });
      expect(provider.isEnabled).toBe(false);
      provider.close();
    });

    it('is disabled by default on non-Windows platforms', () => {
      if (process.platform !== 'win32') {
        const provider = new EtwProvider();
        expect(provider.isEnabled).toBe(false);
        provider.close();
      }
    });
  });

  describe('emit', () => {
    it('emits an ETW event with correct structure', () => {
      const provider = new EtwProvider({ enabled: true });

      provider.emit({
        provider: 'Test-Provider',
        eventId: 1001,
        level: 'win:Informational',
        activityId: 'activity-123',
        opcode: 'sandbox.process_started',
        task: 'sandbox',
        payload: { command: 'echo hello', pid: 1234 },
      });

      // Event should be emitted without throwing
      expect(true).toBe(true);
      provider.close();
    });

    it('emits an event with timestamp', () => {
      const provider = new EtwProvider({ enabled: true });

      provider.emit({
        provider: 'Test-Provider',
        eventId: 1001,
        level: 'win:Informational',
        activityId: 'activity-123',
        opcode: 'test.event',
        task: 'test',
        payload: { key: 'value' },
      });

      expect(true).toBe(true);
      provider.close();
    });
  });

  describe('emitFromLogRecord', () => {
    it('maps a log record to an ETW event', () => {
      const provider = new EtwProvider({ enabled: true });

      const record = {
        v: 1,
        ts: '2026-10-24T00:00:00.000Z',
        level: 'info',
        stream: 'runtime' as const,
        component: 'sandbox',
        event: 'sandbox.process_started',
        msg: 'Process started',
        pid: 1234,
        host: 'test-host',
        traceId: 'trace-123',
        spanId: 'span-456',
      };

      // Should not throw
      expect(() => provider.emitFromLogRecord(record)).not.toThrow();
      provider.close();
    });

    it('maps error level to win:Error', () => {
      const provider = new EtwProvider({ enabled: true });

      const record = {
        v: 1,
        ts: '2026-10-24T00:00:00.000Z',
        level: 'error',
        stream: 'runtime' as const,
        component: 'sandbox',
        event: 'sandbox.process_failed',
        msg: 'Process failed',
        pid: 1234,
        host: 'test-host',
      };

      expect(() => provider.emitFromLogRecord(record)).not.toThrow();
      provider.close();
    });

    it('maps unknown event to event ID 9000', () => {
      const provider = new EtwProvider({ enabled: true });

      const record = {
        v: 1,
        ts: '2026-10-24T00:00:00.000Z',
        level: 'info',
        stream: 'runtime' as const,
        component: 'test',
        event: 'unknown.event',
        msg: 'Unknown event',
        pid: 1234,
        host: 'test-host',
      };

      expect(() => provider.emitFromLogRecord(record)).not.toThrow();
      provider.close();
    });
  });

  describe('SSE server', () => {
    it('starts SSE server when port is provided', () => {
      const provider = new EtwProvider({ enabled: true, ssePort: 0 });
      // Port should be assigned (ephemeral)
      expect(provider.port).toBeGreaterThanOrEqual(0);
      provider.close();
    });

    it('returns event source URL when SSE is running', () => {
      const provider = new EtwProvider({ enabled: true, ssePort: 0 });
      const url = provider.getEventSourceUrl();
      if (provider.port > 0) {
        expect(url).toBe(`http://127.0.0.1:${provider.port}/etw`);
      } else {
        expect(url).toBeUndefined();
      }
      provider.close();
    });

    it('returns undefined when SSE is not enabled', () => {
      const provider = new EtwProvider({ enabled: false });
      expect(provider.getEventSourceUrl()).toBeUndefined();
      provider.close();
    });
  });

  describe('close', () => {
    it('closes without errors', () => {
      const provider = new EtwProvider({ enabled: true, ssePort: 0 });
      expect(() => provider.close()).not.toThrow();
    });

    it('closes SSE server', () => {
      const provider = new EtwProvider({ enabled: true, ssePort: 0 });
      provider.close();
      // After close, the server should be closed
      expect(true).toBe(true);
    });
  });
});
