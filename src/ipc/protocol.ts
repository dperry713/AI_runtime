/**
 * IPC Protocol — JSON-RPC 2.0 over NDJSON (Phase 9 - P9-T01).
 *
 * Defines the wire protocol between `air` (shell) and `aird` (daemon):
 * - JSON-RPC 2.0 request / notification / response envelopes
 * - Standard and AIR-defined error codes
 * - Method handler and context types
 * - Protocol version constant
 *
 * Adheres to:
 * - Rule R1: No console.log; uses observability logger
 * - Rule R6: No raw Date.now() / Math.random() in protocol logic
 * - Rule R7: No any; strict TypeScript
 * - Rule R11: Typed AirError errors
 * - Rule R12: Zod validation at the wire boundary
 */

import { z } from 'zod';
import { AirError, type ErrorCode } from '../errors/index.js';

// ============================================================================
// 1. Protocol Version & Constants
// ============================================================================

/** JSON-RPC 2.0 version string. */
export const JSONRPC_VERSION = '2.0' as const;

/** AIR IPC protocol major version. Clients refuse mismatched major versions. */
export const IPC_PROTOCOL_VERSION = 1;

/** Maximum frame size in bytes (4 MiB). Oversized frames are rejected. */
export const IPC_MAX_FRAME_SIZE = 4 * 1024 * 1024;

// ============================================================================
// 2. Error Codes (JSON-RPC 2.0 standard + AIR-defined)
// ============================================================================

/** Standard JSON-RPC 2.0 error codes. */
export const JsonRpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** AIR-defined IPC error codes mapped to AirError codes. */
export const AirIpcErrorCode = {
  PIPE_CONNECTION_FAILED: 'IPC_CONNECTION_FAILED' as const,
  PIPE_CLOSED: 'IPC_CONNECTION_FAILED' as const,
  REQUEST_TIMEOUT: 'DEADLINE_EXCEEDED' as const,
  PROTOCOL_VERSION_MISMATCH: 'IPC_PROTOCOL_ERROR' as const,
  FRAME_TOO_LARGE: 'IPC_PROTOCOL_ERROR' as const,
  UNAUTHORIZED: 'PERMISSION_DENIED' as const,
} as const;

export type JsonRpcErrorCode = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];
export type AirIpcErrorCode = (typeof AirIpcErrorCode)[keyof typeof AirIpcErrorCode];

// ============================================================================
// 3. Zod Schemas (wire validation)
// ============================================================================

/** JSON-RPC 2.0 Request envelope. */
export const JsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
    id: z.union([z.string(), z.number()]),
  })
  .strict();

/** JSON-RPC 2.0 Notification envelope (no id). */
export const JsonRpcNotificationSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** JSON-RPC 2.0 Success Response envelope. */
export const JsonRpcSuccessResponseSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    result: z.unknown(),
    id: z.union([z.string(), z.number()]),
  })
  .strict();

/** JSON-RPC 2.0 Error Response envelope. */
export const JsonRpcErrorResponseSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    error: z.object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    }),
    id: z.union([z.string(), z.number()]).nullable(),
  })
  .strict();

// ============================================================================
// 4. Inferred Types
// ============================================================================

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;
export type JsonRpcSuccessResponse = z.infer<typeof JsonRpcSuccessResponseSchema>;
export type JsonRpcErrorResponse = z.infer<typeof JsonRpcErrorResponseSchema>;

export type JsonRpcId = JsonRpcRequest['id'];

/** Any inbound message from a client (request or notification). */
export type InboundMessage = JsonRpcRequest | JsonRpcNotification;

/** Any outbound message to a client (success or error response). */
export type OutboundMessage = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ============================================================================
// 5. Method Handler Types
// ============================================================================

/** Context passed to every method handler. */
export interface IpcContext {
  /** Correlation ID for tracing this request through logs and journal. */
  readonly correlationId: string;
  /** Unique identifier for the client connection. */
  readonly clientId: string;
  /** Pipe name the client connected on. */
  readonly pipeName: string;
  /** Injected clock for deterministic timestamps (Rule R6). */
  readonly clock: { now(): Date };
}

/** Handler for a JSON-RPC method request. Returns a result or throws AirError. */
export type IpcMethodHandler<P = unknown, R = unknown> = (
  params: P,
  ctx: IpcContext,
) => Promise<R>;

/** Handler for a JSON-RPC notification (fire-and-forget, no response). */
export type IpcNotificationHandler<P = unknown> = (
  params: P,
  ctx: IpcContext,
) => Promise<void>;

/** Registered method entry. */
export interface RegisteredMethod {
  readonly method: string;
  readonly handler: IpcMethodHandler;
}

/** Registered notification entry. */
export interface RegisteredNotification {
  readonly method: string;
  readonly handler: IpcNotificationHandler;
}

// ============================================================================
// 6. IPC Error
// ============================================================================

/**
 * Typed error for IPC protocol failures. Carries a JSON-RPC error code so the
 * server can emit the correct error response to the client.
 */
export class IpcError extends AirError {
  readonly jsonRpcCode: number;

  constructor(
    jsonRpcCode: number,
    message: string,
    options?: {
      code?: ErrorCode;
      cause?: Error;
      context?: Record<string, unknown>;
    },
  ) {
    super(options?.code ?? 'IPC_PROTOCOL_ERROR', message, {
      cause: options?.cause,
      context: options?.context,
      exposeToModel: true,
    });
    this.jsonRpcCode = jsonRpcCode;
  }
}

// ============================================================================
// 7. Response Builders
// ============================================================================

/** Build a JSON-RPC success response. */
export function createSuccessResponse(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    result,
    id,
  };
}

/** Build a JSON-RPC error response from a code and message. */
export function createErrorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
    id,
  };
}

/** Build a JSON-RPC error response from an AirError/IpcError. */
export function errorToJsonRpc(
  id: JsonRpcId | null,
  err: Error,
): JsonRpcErrorResponse {
  if (err instanceof IpcError) {
    return createErrorResponse(id, err.jsonRpcCode, err.message, {
      code: err.code,
      ...(err.context ? { context: err.context } : {}),
    });
  }
  if (err instanceof AirError) {
    return createErrorResponse(id, JsonRpcErrorCode.INTERNAL_ERROR, err.message, {
      code: err.code,
      ...(err.context ? { context: err.context } : {}),
    });
  }
  return createErrorResponse(id, JsonRpcErrorCode.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
}

// ============================================================================
// 8. Validation Helpers
// ============================================================================

/** Validate and parse an inbound JSON-RPC message. Returns the parsed message
 * or throws an AirError with the appropriate JSON-RPC code. */
export function parseInboundMessage(raw: unknown): InboundMessage {
  const requestResult = JsonRpcRequestSchema.safeParse(raw);
  if (requestResult.success) {
    return requestResult.data;
  }

  const notificationResult = JsonRpcNotificationSchema.safeParse(raw);
  if (notificationResult.success) {
    return notificationResult.data;
  }

  throw new AirError('IPC_PROTOCOL_ERROR', 'Invalid JSON-RPC message', {
    context: { reason: requestResult.error.issues.map((i) => i.message).join('; ') },
    exposeToModel: true,
  });
}

/** Serialize an outbound message to a JSON string for NDJSON framing. */
export function serializeMessage(message: OutboundMessage): string {
  return JSON.stringify(message);
}
