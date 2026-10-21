/**
 * Unit tests for IPC Protocol (P9-T01).
 *
 * Covers: JSON-RPC 2.0 schema validation, error code mapping, response builders,
 * message parsing, and serialization.
 */

import { describe, expect, it } from 'vitest';
import {
  AirIpcErrorCode,
  AirIpcErrorCode as AirIpcErrorCodeAlias,
  createErrorResponse,
  createSuccessResponse,
  errorToJsonRpc,
  IPC_MAX_FRAME_SIZE,
  IPC_PROTOCOL_VERSION,
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  parseInboundMessage,
  serializeMessage,
} from '../../../src/ipc/protocol.js';
import { AirError } from '../../../src/errors/index.js';
import { IpcError } from '../../../src/ipc/protocol.js';

// ============================================================================
// Constants
// ============================================================================

describe('IPC protocol constants', () => {
  it('exports JSON-RPC 2.0 version string', () => {
    expect(JSONRPC_VERSION).toBe('2.0');
  });

  it('exports IPC protocol major version 1', () => {
    expect(IPC_PROTOCOL_VERSION).toBe(1);
  });

  it('exports max frame size of 4 MiB', () => {
    expect(IPC_MAX_FRAME_SIZE).toBe(4 * 1024 * 1024);
  });
});

// ============================================================================
// JSON-RPC Error Codes
// ============================================================================

describe('JSON-RPC error codes', () => {
  it('defines standard parse error code', () => {
    expect(JsonRpcErrorCode.PARSE_ERROR).toBe(-32700);
  });

  it('defines standard invalid request code', () => {
    expect(JsonRpcErrorCode.INVALID_REQUEST).toBe(-32600);
  });

  it('defines standard method not found code', () => {
    expect(JsonRpcErrorCode.METHOD_NOT_FOUND).toBe(-32601);
  });

  it('defines standard invalid params code', () => {
    expect(JsonRpcErrorCode.INVALID_PARAMS).toBe(-32602);
  });

  it('defines standard internal error code', () => {
    expect(JsonRpcErrorCode.INTERNAL_ERROR).toBe(-32603);
  });
});

// ============================================================================
// AIR IPC Error Codes
// ============================================================================

describe('AIR IPC error codes', () => {
  it('maps pipe connection failed to IPC_CONNECTION_FAILED', () => {
    expect(AirIpcErrorCode.PIPE_CONNECTION_FAILED).toBe('IPC_CONNECTION_FAILED');
  });

  it('maps request timeout to DEADLINE_EXCEEDED', () => {
    expect(AirIpcErrorCode.REQUEST_TIMEOUT).toBe('DEADLINE_EXCEEDED');
  });

  it('maps protocol version mismatch to IPC_PROTOCOL_ERROR', () => {
    expect(AirIpcErrorCode.PROTOCOL_VERSION_MISMATCH).toBe('IPC_PROTOCOL_ERROR');
  });

  it('maps frame too large to IPC_PROTOCOL_ERROR', () => {
    expect(AirIpcErrorCode.FRAME_TOO_LARGE).toBe('IPC_PROTOCOL_ERROR');
  });

  it('maps unauthorized to PERMISSION_DENIED', () => {
    expect(AirIpcErrorCode.UNAUTHORIZED).toBe('PERMISSION_DENIED');
  });
});

// ============================================================================
// Response Builders
// ============================================================================

describe('createSuccessResponse', () => {
  it('builds a valid JSON-RPC success response', () => {
    const response = createSuccessResponse('1', { ok: true });
    expect(response).toEqual({
      jsonrpc: '2.0',
      result: { ok: true },
      id: '1',
    });
  });

  it('accepts numeric ids', () => {
    const response = createSuccessResponse(42, null);
    expect(response.id).toBe(42);
  });
});

describe('createErrorResponse', () => {
  it('builds a valid JSON-RPC error response', () => {
    const response = createErrorResponse('1', -32601, 'Method not found');
    expect(response).toEqual({
      jsonrpc: '2.0',
      error: { code: -32601, message: 'Method not found' },
      id: '1',
    });
  });

  it('includes optional data field', () => {
    const response = createErrorResponse('1', -32602, 'Invalid params', { param: 'foo' });
    expect(response.error.data).toEqual({ param: 'foo' });
  });

  it('accepts null id for parse errors', () => {
    const response = createErrorResponse(null, -32700, 'Parse error');
    expect(response.id).toBeNull();
  });
});

// ============================================================================
// Error Conversion
// ============================================================================

describe('errorToJsonRpc', () => {
  it('converts IpcError to JSON-RPC error response', () => {
    const err = new IpcError(-32000, 'Pipe connection failed', {
      code: 'IPC_CONNECTION_FAILED',
      context: { pipe: 'air-user' },
    });
    const response = errorToJsonRpc('1', err);
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toBe('Pipe connection failed');
    expect(response.id).toBe('1');
  });

  it('converts AirError to JSON-RPC internal error', () => {
    const err = new AirError('INTERNAL', 'Something went wrong');
    const response = errorToJsonRpc('1', err);
    expect(response.error.code).toBe(JsonRpcErrorCode.INTERNAL_ERROR);
    expect(response.error.message).toBe('Something went wrong');
  });

  it('converts generic Error to JSON-RPC internal error', () => {
    const err = new Error('Unexpected');
    const response = errorToJsonRpc(null, err);
    expect(response.error.code).toBe(JsonRpcErrorCode.INTERNAL_ERROR);
    expect(response.error.message).toBe('Unexpected');
    expect(response.id).toBeNull();
  });
});

// ============================================================================
// Message Parsing
// ============================================================================

describe('parseInboundMessage', () => {
  it('parses a valid JSON-RPC request', () => {
    const message = parseInboundMessage({
      jsonrpc: '2.0',
      method: 'daemon.health',
      id: '1',
    });
    expect(message).toEqual({
      jsonrpc: '2.0',
      method: 'daemon.health',
      id: '1',
    });
  });

  it('parses a valid JSON-RPC notification (no id)', () => {
    const message = parseInboundMessage({
      jsonrpc: '2.0',
      method: 'event',
      params: { subscriptionId: 'default' },
    });
    expect('id' in message).toBe(false);
    expect(message.method).toBe('event');
  });

  it('parses a request with params', () => {
    const message = parseInboundMessage({
      jsonrpc: '2.0',
      method: 'run.start',
      params: { goal: 'hello' },
      id: '2',
    });
    expect((message as { params?: unknown }).params).toEqual({ goal: 'hello' });
  });

  it('throws on invalid JSON-RPC message', () => {
    expect(() => parseInboundMessage({ jsonrpc: '1.0', method: 'x' })).toThrow(AirError);
  });

  it('throws on non-object input', () => {
    expect(() => parseInboundMessage('not an object')).toThrow(AirError);
  });

  it('throws on null input', () => {
    expect(() => parseInboundMessage(null)).toThrow(AirError);
  });
});

// ============================================================================
// Serialization
// ============================================================================

describe('serializeMessage', () => {
  it('serializes a success response to JSON string', () => {
    const response = createSuccessResponse('1', { ok: true });
    const serialized = serializeMessage(response);
    expect(JSON.parse(serialized)).toEqual(response);
  });

  it('serializes an error response to JSON string', () => {
    const response = createErrorResponse('1', -32601, 'Not found');
    const serialized = serializeMessage(response);
    expect(JSON.parse(serialized)).toEqual(response);
  });
});

// ============================================================================
// Alias export check (AirIpcErrorCodeAlias)
// ============================================================================

describe('type-only exports', () => {
  it('AirIpcErrorCodeAlias is the same as AirIpcErrorCode', () => {
    expect(AirIpcErrorCodeAlias).toBe(AirIpcErrorCode);
  });
});
