/**
 * Unit tests for IPC Method Registry (P9-T01).
 *
 * Covers: method/notification registration, duplicate detection, dispatch of
 * requests and notifications, unknown method handling, and error isolation.
 */

import { describe, expect, it } from 'vitest';
import { MethodRegistry } from '../../../src/ipc/registry.js';
import { AirError } from '../../../src/errors/index.js';
import { JsonRpcErrorCode } from '../../../src/ipc/protocol.js';

// ============================================================================
// Helpers
// ============================================================================

const ctx = {
  correlationId: 'test-corr',
  clientId: 'test-client',
  pipeName: '\\\\.\\pipe\\air-test',
  clock: { now: () => new Date('2026-10-19T00:00:00.000Z') },
};

// ============================================================================
// Registration
// ============================================================================

describe('MethodRegistry registration', () => {
  it('starts with zero methods and notifications', () => {
    const registry = new MethodRegistry();
    expect(registry.size).toBe(0);
    expect(registry.listMethods()).toEqual([]);
    expect(registry.listNotifications()).toEqual([]);
  });

  it('registers a method handler', () => {
    const registry = new MethodRegistry();
    const handler = () => Promise.resolve({ ok: true });
    registry.register('test.method', handler);
    expect(registry.size).toBe(1);
    expect(registry.listMethods()).toEqual(['test.method']);
    expect(registry.hasMethod('test.method')).toBe(true);
  });

  it('registers a notification handler', () => {
    const registry = new MethodRegistry();
    const handler = () => Promise.resolve();
    registry.registerNotification('test.notify', handler);
    expect(registry.hasNotification('test.notify')).toBe(true);
    expect(registry.listNotifications()).toEqual(['test.notify']);
  });

  it('throws on duplicate method registration', () => {
    const registry = new MethodRegistry();
    registry.register('dup.method', () => Promise.resolve());
    expect(() => registry.register('dup.method', () => Promise.resolve())).toThrow(AirError);
  });

  it('throws on duplicate notification registration', () => {
    const registry = new MethodRegistry();
    registry.registerNotification('dup.notify', () => Promise.resolve());
    expect(() => registry.registerNotification('dup.notify', () => Promise.resolve())).toThrow(AirError);
  });

  it('unregisters a method', () => {
    const registry = new MethodRegistry();
    registry.register('temp.method', () => Promise.resolve());
    expect(registry.unregisterMethod('temp.method')).toBe(true);
    expect(registry.hasMethod('temp.method')).toBe(false);
    expect(registry.unregisterMethod('temp.method')).toBe(false);
  });

  it('unregisters a notification', () => {
    const registry = new MethodRegistry();
    registry.registerNotification('temp.notify', () => Promise.resolve());
    expect(registry.unregisterNotification('temp.notify')).toBe(true);
    expect(registry.hasNotification('temp.notify')).toBe(false);
  });
});

// ============================================================================
// Request Dispatch
// ============================================================================

describe('MethodRegistry request dispatch', () => {
  it('dispatches a request to the registered handler', async () => {
    const registry = new MethodRegistry();
    registry.register('echo', (params) => Promise.resolve(params));
    const result = await registry.handleRequest(
      { jsonrpc: '2.0', method: 'echo', params: { msg: 'hi' }, id: '1' },
      ctx,
    );
    expect(result).toEqual({ ok: true, result: { msg: 'hi' } });
  });

  it('returns method not found for unknown method', async () => {
    const registry = new MethodRegistry();
    const result = await registry.handleRequest(
      { jsonrpc: '2.0', method: 'unknown.method', id: '1' },
      ctx,
    );
    expect(result).toEqual({
      ok: false,
      error: {
        jsonrpc: '2.0',
        error: { code: JsonRpcErrorCode.METHOD_NOT_FOUND, message: 'Method "unknown.method" not found' },
        id: '1',
      },
    });
  });

  it('isolates handler errors and returns error response', async () => {
    const registry = new MethodRegistry();
    registry.register('failing', () => {
      throw new Error('boom');
    });
    const result = await registry.handleRequest(
      { jsonrpc: '2.0', method: 'failing', id: '1' },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe(JsonRpcErrorCode.INTERNAL_ERROR);
      expect(result.error.error.message).toBe('boom');
    }
  });

  it('handles request with no params', async () => {
    const registry = new MethodRegistry();
    registry.register('noargs', () => Promise.resolve({ done: true }));
    const result = await registry.handleRequest(
      { jsonrpc: '2.0', method: 'noargs', id: '1' },
      ctx,
    );
    expect(result).toEqual({ ok: true, result: { done: true } });
  });
});

// ============================================================================
// Notification Dispatch
// ============================================================================

describe('MethodRegistry notification dispatch', () => {
  it('dispatches a notification to the registered handler', async () => {
    let received: unknown = null;
    const registry = new MethodRegistry();
    registry.registerNotification('log', (params) => {
      received = params;
      return Promise.resolve();
    });
    await registry.handleNotification(
      { jsonrpc: '2.0', method: 'log', params: { msg: 'hello' } },
      ctx,
    );
    expect(received).toEqual({ msg: 'hello' });
  });

  it('silently ignores unknown notifications', async () => {
    const registry = new MethodRegistry();
    // Should not throw
    await registry.handleNotification(
      { jsonrpc: '2.0', method: 'unknown.notify', params: {} },
      ctx,
    );
  });

  it('propagates errors from notification handlers', async () => {
    const registry = new MethodRegistry();
    registry.registerNotification('failing', () => {
      throw new Error('notify boom');
    });
    await expect(
      registry.handleNotification({ jsonrpc: '2.0', method: 'failing' }, ctx),
    ).rejects.toThrow('notify boom');
  });
});

// ============================================================================
// Full Dispatch
// ============================================================================

describe('MethodRegistry dispatch', () => {
  it('dispatches a request and returns a success result', async () => {
    const registry = new MethodRegistry();
    registry.register('add', (params) => {
      const p = params as { a: number; b: number };
      return Promise.resolve(p.a + p.b);
    });
    const result = await registry.dispatch(
      { jsonrpc: '2.0', method: 'add', params: { a: 1, b: 2 }, id: '1' },
      ctx,
    );
    expect(result).toEqual({ ok: true, result: 3 });
  });

  it('dispatches a notification and returns null', async () => {
    const registry = new MethodRegistry();
    registry.registerNotification('ping', () => Promise.resolve());
    const result = await registry.dispatch(
      { jsonrpc: '2.0', method: 'ping' },
      ctx,
    );
    expect(result).toBeNull();
  });

  it('throws on invalid raw input', async () => {
    const registry = new MethodRegistry();
    await expect(registry.dispatch('not an object', ctx)).rejects.toThrow(AirError);
  });
});
