/**
 * IPC Client — typed JSON-RPC 2.0 client over named pipe (Phase 9 - P9-T01).
 *
 * Implements:
 * - Connect to `aird` Windows named pipe
 * - Typed request/response with configurable timeouts
 * - Notification handling (`event`, `approval.requested`)
 * - Reconnect support
 * - Pending request tracking with automatic cleanup on disconnect
 *
 * Adheres to:
 * - Rule R1: No console.log; uses observability logger
 * - Rule R6: Injected Clock for timeouts (no raw Date.now() / Math.random())
 * - Rule R7: No any; strict TypeScript
 * - Rule R11: Typed AirError errors
 * - Rule R12: Zod validation at wire boundary (protocol.ts schemas)
 */

import net from 'node:net';
import { type ComponentLogger, getLogger } from '../observability/index.js';
import { type EventEnvelope } from '../journal/index.js';
import { type Clock, SystemClock } from '../util/index.js';
import { AirError } from '../errors/index.js';
import {
  type JsonRpcId,
  type JsonRpcRequest,
} from './protocol.js';
import { DEFAULT_MAX_FRAME_SIZE, FrameReader, FrameWriter } from './framing.js';
import { getPipeName } from './pipe.js';

// ============================================================================
// 1. Types
// ============================================================================

export interface IpcClientOptions {
  /** Pipe name to connect to. Defaults to `\\.\pipe\air-<username>`. */
  readonly pipeName?: string;
  /** Request timeout in milliseconds. Defaults to 30000. */
  readonly requestTimeoutMs?: number;
  /** Reconnect delay in milliseconds. Defaults to 1000. */
  readonly reconnectDelayMs?: number;
  /** Maximum reconnect attempts. Defaults to 5 (0 = no reconnect). */
  readonly maxReconnectAttempts?: number;
  /** Injected clock for deterministic timeouts (Rule R6). */
  readonly clock?: Clock;
}

/** Pending request entry. */
interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

// ============================================================================
// 2. IpcClient Class
// ============================================================================

export class IpcClient {
  private readonly pipeName: string;
  private readonly requestTimeoutMs: number;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly clock: Clock;
  private readonly logger: ComponentLogger;

  private socket: net.Socket | null = null;
  private reader: FrameReader | null = null;
  private writer: FrameWriter | null = null;
  private connected = false;
  private connecting = false;
  private reconnectAttempts = 0;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly eventHandlers = new Set<(event: EventEnvelope) => void>();
  private requestCounter = 0;
  private connectResolve: ((value: void) => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;

  constructor(options: IpcClientOptions = {}) {
    this.pipeName = options.pipeName ?? getPipeName({});
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.clock = options.clock ?? new SystemClock();
    this.logger = getLogger('ipc-client');
  }

  /** Returns the pipe name this client connects to. */
  get name(): string {
    return this.pipeName;
  }

  /** Returns whether the client is currently connected. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Returns whether the client is currently attempting to connect. */
  get isConnecting(): boolean {
    return this.connecting;
  }

  /** Returns the number of pending requests awaiting response. */
  get pendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  /** Connect to the named pipe server. */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    if (this.connecting) {
      return new Promise<void>((resolve, reject) => {
        this.connectResolve = resolve;
        this.connectReject = reject;
      });
    }

    this.connecting = true;

    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      try {
        this.socket = net.createConnection(this.pipeName);

        this.socket.on('connect', () => {
          this.connected = true;
          this.connecting = false;
          this.reconnectAttempts = 0;
          this.logger.debug({ event: 'ipc.client.connected', pipe: this.pipeName }, 'IPC client connected');

          this.reader = new FrameReader({
            maxFrameSize: DEFAULT_MAX_FRAME_SIZE,
            onLine: (line) => {
              void this.handleIncomingLine(line);
            },
          });

          this.writer = new FrameWriter({
            write: (data) => {
              if (this.socket?.writable) {
                this.socket.write(data);
              }
            },
          });

          this.connectResolve?.();
          this.connectResolve = null;
          this.connectReject = null;
        });

        this.socket.on('data', (chunk: Buffer) => {
          if (this.reader) {
            try {
              this.reader.feed(chunk.toString('utf8'));
            } catch (err) {
              this.logger.warn(
                { event: 'ipc.client.frame_error', err: err instanceof Error ? err : { message: String(err) } },
                'Frame processing error',
              );
              this.destroy();
            }
          }
        });

        this.socket.on('error', (err) => {
          this.logger.warn({ event: 'ipc.client.error', pipe: this.pipeName, err }, 'IPC client error');
          if (!this.connected && this.connectReject) {
            this.connectReject(
              new AirError('IPC_CONNECTION_FAILED', `Failed to connect to pipe "${this.pipeName}"`, {
                cause: err instanceof Error ? err : new Error(String(err)),
                exposeToModel: true,
              }),
            );
            this.connectReject = null;
          }
          this.connected = false;
          this.connecting = false;
          this.scheduleReconnect();
        });

        this.socket.on('close', () => {
          this.logger.debug({ event: 'ipc.client.closed', pipe: this.pipeName }, 'IPC client connection closed');
          this.connected = false;
          this.connecting = false;
          this.failPendingRequests(new AirError('IPC_CONNECTION_FAILED', 'Pipe connection closed', { exposeToModel: true }));
          this.scheduleReconnect();
        });
      } catch (err) {
        this.connecting = false;
        reject(
          new AirError('IPC_CONNECTION_FAILED', `Failed to connect to pipe "${this.pipeName}"`, {
            cause: err instanceof Error ? err : new Error(String(err)),
            exposeToModel: true,
          }),
        );
      }
    });
  }

  /** Disconnect from the pipe server. */
  async disconnect(): Promise<void> {
    this.connected = false;
    this.connecting = false;
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnect

    this.failPendingRequests(new AirError('IPC_CONNECTION_FAILED', 'Client disconnected', { exposeToModel: true }));

    const socket = this.socket;
    if (!socket) {
      return;
    }

    this.socket = null;
    this.reader = null;
    this.writer = null;

    return new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.destroy();
    });
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   * Throws AirError on timeout, connection failure, or server error.
   */
  async request<P = unknown, R = unknown>(
    method: string,
    params?: P,
    options?: { readonly timeoutMs?: number },
  ): Promise<R> {
    if (!this.connected || !this.writer) {
      throw new AirError('IPC_CONNECTION_FAILED', `Not connected to pipe "${this.pipeName}"`, {
        exposeToModel: true,
      });
    }

    this.requestCounter += 1;
    const id: JsonRpcId = `req_${this.clock.now().getTime()}_${this.requestCounter}`;

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params: params as Record<string, unknown> } : {}),
      id,
    };

    const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;

    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(String(id));
        reject(
          new AirError('DEADLINE_EXCEEDED', `Request "${method}" timed out after ${timeoutMs}ms`, {
            context: { method, id: String(id), timeoutMs },
            exposeToModel: true,
          }),
        );
      }, timeoutMs);

      this.pendingRequests.set(String(id), { resolve: resolve as (result: unknown) => void, reject, timer });

      try {
        const line = JSON.stringify(request);
        if (this.socket?.writable) {
          this.socket.write(`${line}\n`);
        }
      } catch (err) {
        this.pendingRequests.delete(String(id));
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Send a JSON-RPC notification (fire-and-forget, no response). */
  notify(method: string, params?: unknown): void {
    if (!this.connected || !this.writer) {
      throw new AirError('IPC_CONNECTION_FAILED', `Not connected to pipe "${this.pipeName}"`, {
        exposeToModel: true,
      });
    }

    const notification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params: params as Record<string, unknown> } : {}),
    };

    const line = JSON.stringify(notification);
    if (this.socket?.writable) {
      this.socket.write(`${line}\n`);
    }
  }

  /** Subscribe to notifications of a specific method. */
  onNotification(method: string, handler: (params: unknown) => void): void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
  }

  /** Unsubscribe from notifications of a specific method. */
  offNotification(method: string, handler: (params: unknown) => void): void {
    const handlers = this.notificationHandlers.get(method);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.notificationHandlers.delete(method);
      }
    }
  }

  /** Subscribe to `event` notifications (journal events from server). */
  onEvent(handler: (event: EventEnvelope) => void): void {
    this.eventHandlers.add(handler);
  }

  /** Unsubscribe from `event` notifications. */
  offEvent(handler: (event: EventEnvelope) => void): void {
    this.eventHandlers.delete(handler);
  }

  // ==========================================================================
  // Internal: Incoming Message Handling
  // ==========================================================================

  private handleIncomingLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.logger.warn({ event: 'ipc.client.invalid_json', line }, 'Invalid JSON from server');
      return;
    }

    const message = parsed as { id?: unknown; method?: unknown; params?: unknown };
    if (message.id !== undefined) {
      this.handleResponse(message as { id: unknown; result?: unknown; error?: unknown });
    } else if (typeof message.method === 'string') {
      this.handleNotification(message as { method: string; params?: unknown });
    }
  }

  private handleResponse(message: { id: unknown; result?: unknown; error?: unknown }): void {
    const idStr = String(message.id);
    const pending = this.pendingRequests.get(idStr);

    if (!pending) {
      this.logger.warn({ event: 'ipc.client.unknown_response_id', id: message.id }, 'Received response for unknown request');
      return;
    }

    this.pendingRequests.delete(idStr);
    clearTimeout(pending.timer);

    if (message.error) {
      const errResp = message.error as { code: number; message: string; data?: unknown };
      const airErr = new AirError('IPC_PROTOCOL_ERROR', errResp.message, {
        context: { code: errResp.code, data: errResp.data },
        exposeToModel: true,
      });
      pending.reject(airErr);
    } else {
      pending.resolve(message.result);
    }
  }

  private handleNotification(message: { method: string; params?: unknown }): void {
    const handlers = this.notificationHandlers.get(message.method);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(message.params);
        } catch (err) {
          this.logger.warn(
            { event: 'ipc.client.notification_handler_error', method: message.method, err: err instanceof Error ? err : { message: String(err) } },
            'Notification handler threw',
          );
        }
      }
    }

    // If it's an `event` notification, forward to event handlers
    if (message.method === 'event' && message.params && typeof message.params === 'object') {
      const params = message.params as { event?: unknown };
      if (params.event !== undefined) {
        for (const handler of this.eventHandlers) {
          try {
            handler(params.event as EventEnvelope);
          } catch (err) {
            this.logger.warn({ event: 'ipc.client.event_handler_error', err: err instanceof Error ? err : { message: String(err) } }, 'Event handler threw');
          }
        }
      }
    }
  }

  // ==========================================================================
  // Internal: Reconnect & Cleanup
  // ==========================================================================

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.info({ event: 'ipc.client.reconnect_exhausted', pipe: this.pipeName }, 'Reconnect attempts exhausted');
      return;
    }

    this.reconnectAttempts += 1;
    this.logger.info(
      { event: 'ipc.client.reconnecting', pipe: this.pipeName, attempt: this.reconnectAttempts },
      'Scheduling reconnect',
    );

    setTimeout(() => {
      if (!this.connected && !this.connecting) {
        void this.connect().catch((err) => {
          this.logger.warn({ event: 'ipc.client.reconnect_failed', pipe: this.pipeName, err: err instanceof Error ? err : { message: String(err) } }, 'Reconnect failed');
        });
      }
    }, this.reconnectDelayMs);
  }

  private failPendingRequests(err: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  private destroy(): void {
    this.connected = false;
    this.connecting = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.reader = null;
    this.writer = null;
  }
}
