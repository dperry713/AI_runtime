/**
 * IPC module entry point (Phase 9 - P9-T01).
 *
 * Public API:
 * - Protocol: JSON-RPC 2.0 schemas, types, error codes, builders
 * - Framing: NDJSON FrameReader/FrameWriter with size limits
 * - Pipe: Windows named pipe server/client
 * - Registry: MethodRegistry for dispatch
 * - Server: IpcServer
 * - Client: IpcClient
 *
 * Layer 7 per ARCHITECTURE.md §3: may import layers 0–6 only through their index.ts.
 */

export {
  JSONRPC_VERSION,
  IPC_PROTOCOL_VERSION,
  IPC_MAX_FRAME_SIZE,
  JsonRpcErrorCode,
  AirIpcErrorCode,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcSuccessResponse,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type InboundMessage,
  type OutboundMessage,
  type IpcContext,
  type IpcMethodHandler,
  type IpcNotificationHandler,
  type RegisteredMethod,
  type RegisteredNotification,
  IpcError,
  JsonRpcRequestSchema,
  JsonRpcNotificationSchema,
  JsonRpcSuccessResponseSchema,
  JsonRpcErrorResponseSchema,
  createSuccessResponse,
  createErrorResponse,
  errorToJsonRpc,
  parseInboundMessage,
  serializeMessage,
} from './protocol.js';

export {
  DEFAULT_MAX_FRAME_SIZE,
  FRAME_TERMINATOR,
  FrameTooLargeError,
  MalformedFrameError,
  type FrameReaderOptions,
  FrameReader,
  type FrameWriterOptions,
  FrameWriter,
  parseFrameLine,
} from './framing.js';

export {
  getCurrentUsername,
  getPipeName,
  PipeError,
  type PipeServerOptions,
  PipeServer,
  type PipeClientOptions,
  PipeClient,
} from './pipe.js';

export {
  type IpcServerOptions,
  IpcServer,
} from './server.js';

export {
  type IpcClientOptions,
  IpcClient,
} from './client.js';

export {
  MethodRegistry,
} from './registry.js';
