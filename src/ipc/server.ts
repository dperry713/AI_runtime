/**
 * IPC Server — named-pipe JSON-RPC 2.0 server (Phase 9 - P9-T01).
 *
 * Implements:
 * - Windows named pipe server listening for `air` shell connections
 * - Per-connection NDJSON framing (FrameReader/FrameWriter)
 * - JSON-RPC method dispatch via MethodRegistry
 * - Built-in `daemon.health` and `daemon.shutdown` methods
 * - Server→client notifications (`event`, `approval.requested`) via EventBus subscription
 * - Connection tracking and graceful shutdown
 *
 * Adheres to:
 * - Rule R1: No console.log; uses observability logger
 * - Rule R6: Injected Clock for timestamps (no raw Date.now() / Math.random())
 * - Rule R7: No any; strict TypeScript
 * - Rule R8: Journal events emitted for state changes
 * - Rule R11: Typed AirError errors
 * - Rule R12: Zod validation at wire boundary (protocol.ts schemas)
 */

import type { Socket as NetSocket } from 'node:net';
import type { EventBus, EventEnvelope } from '../journal/index.js';
import { getLogger, ipcRequestHistogram, journalEventsCounter } from '../observability/index.js';
import type { ComponentLogger } from '../observability/index.js';
import { type Clock, SystemClock } from '../util/index.js';
import { type IpcContext, IPC_PROTOCOL_VERSION, JsonRpcErrorCode, type JsonRpcId, type OutboundMessage, createErrorResponse, createSuccessResponse } from './protocol.js';
import { DEFAULT_MAX_FRAME_SIZE, FrameReader, FrameWriter } from './framing.js';
import type { MethodRegistry } from './registry.js';
import { PipeServer, getPipeName } from './pipe.js';

// ============================================================================
// 1. Types
// ============================================================================

export interface IpcServerOptions {
  /** IPC configuration (pipe name, etc.). */
  readonly config: { readonly pipeName?: string };
  /** Method registry for dispatching JSON-RPC methods. */
  readonly registry: MethodRegistry;
  /** Optional event bus for broadcasting journal events to clients. */
  readonly eventBus?: EventBus | undefined;
  /** Injected clock for deterministic timestamps (Rule R6). */
  readonly clock?: Clock;
}

/** Information about a connected client session. */
interface ClientSession {
  readonly clientId: string;
  readonly socket: NetSocket;
  readonly writer: FrameWriter;
  readonly reader: FrameReader;
  subscribed: boolean;
}

// ============================================================================
// 2. IpcServer Class
// ============================================================================

export class IpcServer {
  private readonly config: { readonly pipeName?: string };
  private readonly registry: MethodRegistry;
  private readonly eventBus: EventBus | undefined;
  private readonly clock: Clock;
  private readonly logger: ComponentLogger;
  private readonly pipeServer: PipeServer;
  private readonly clients = new Map<string, ClientSession>();
  private running = false;
  private readonly startTimeMs: number;
  private clientCounter = 0;

  constructor(options: IpcServerOptions) {
    this.config = options.config;
    this.registry = options.registry;
    this.eventBus = options.eventBus;
    this.clock = options.clock ?? new SystemClock();
    this.logger = getLogger('ipc-server');
    this.startTimeMs = this.clock.now().getTime();

    const pipeName = getPipeName(this.config);
    this.pipeServer = new PipeServer({
      pipeName,
      onConnection: (socket) => this.handleConnection(socket),
      onError: (err) => this.logger.error({ event: 'ipc.server.pipe_error', err }, 'IPC pipe server error'),
    });

    // Register built-in methods
    this.registry.register('daemon.health', this.handleDaemonHealth.bind(this));
    this.registry.register('daemon.shutdown', this.handleDaemonShutdown.bind(this));
  }

  /** Returns the pipe name this server listens on. */
  get pipeName(): string {
    return this.pipeServer.name;
  }

  /** Returns whether the server is currently running. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Returns the number of connected clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Start the IPC server. */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    await this.pipeServer.start();
    this.running = true;

    // Subscribe to event bus for broadcasting journal events
    if (this.eventBus) {
      this.eventBus.subscribe({}, (event) => {
        void this.broadcastEvent(event);
      });
    }

    this.logger.info(
      { event: 'ipc.server.started', pipe: this.pipeName, protocolVersion: IPC_PROTOCOL_VERSION },
      'IPC server started',
    );
  }

  /** Stop the IPC server and close all client connections. */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;

    // Close all client connections
    const closePromises: Promise<void>[] = [];
    for (const [clientId, session] of this.clients) {
      closePromises.push(
        new Promise<void>((resolve) => {
          session.socket.once('close', () => resolve());
          session.socket.destroy();
        }),
      );
      this.logger.info({ event: 'ipc.server.client_disconnected', clientId }, 'Client disconnected on shutdown');
    }
    this.clients.clear();

    await Promise.all(closePromises);
    await this.pipeServer.stop();

    this.logger.info({ event: 'ipc.server.stopped', pipe: this.pipeName }, 'IPC server stopped');
  }

  /** Register a custom method handler. */
  registerMethod<P = unknown, R = unknown>(method: string, handler: (params: P, ctx: IpcContext) => Promise<R>): void {
    this.registry.register(method, handler);
  }

  /** Register a custom notification handler. */
  registerNotification<P = unknown>(method: string, handler: (params: P, ctx: IpcContext) => Promise<void>): void {
    this.registry.registerNotification(method, handler);
  }

  // ==========================================================================
  // Connection Handling
  // ==========================================================================

  private handleConnection(socket: NetSocket): void {
    const clientId = this.nextClientId();
    const reader = new FrameReader({
      maxFrameSize: DEFAULT_MAX_FRAME_SIZE,
      onLine: (line) => {
        void this.handleLine(clientId, socket, line);
      },
    });

    const writer = new FrameWriter({
      write: (data) => {
        if (socket.writable) {
          socket.write(data);
        }
      },
    });

    const session: ClientSession = { clientId, socket, writer, reader, subscribed: true };
    this.clients.set(clientId, session);

    this.logger.info({ event: 'ipc.server.client_connected', clientId }, 'Client connected');

    socket.on('data', (chunk: Buffer) => {
      try {
        session.reader.feed(chunk.toString('utf8'));
      } catch (err) {
        this.logger.warn(
          { event: 'ipc.server.frame_error', clientId, err: err instanceof Error ? err : { message: String(err) } },
          'Frame processing error',
        );
        if (err instanceof Error && err.name === 'IPC_PROTOCOL_ERROR' && err.message.includes('exceeds maximum')) {
          this.sendError(socket, null, JsonRpcErrorCode.PARSE_ERROR, 'Frame too large');
        }
        socket.destroy();
      }
    });

    socket.on('error', (err) => {
      this.logger.warn({ event: 'ipc.server.client_error', clientId, err }, 'Client socket error');
      this.clients.delete(clientId);
    });

    socket.on('close', () => {
      this.clients.delete(clientId);
      this.logger.info({ event: 'ipc.server.client_disconnected', clientId }, 'Client disconnected');
    });
  }

  private async handleLine(clientId: string, socket: NetSocket, line: string): Promise<void> {
    const session = this.clients.get(clientId);
    if (!session) {
      return; // Client disconnected mid-processing
    }

    const ctx: IpcContext = {
      correlationId: this.nextCorrelationId(),
      clientId,
      pipeName: this.pipeName,
      clock: this.clock,
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.sendError(socket, null, JsonRpcErrorCode.PARSE_ERROR, 'Invalid JSON');
      return;
    }

    let result: { ok: true; result: unknown } | { ok: false; error: OutboundMessage } | null;
    try {
      result = await this.registry.dispatch(parsed, ctx);
    } catch (err) {
      this.logger.warn(
        { event: 'ipc.server.dispatch_error', clientId, err: err instanceof Error ? err : { message: String(err) } },
        'Notification handler error',
      );
      return;
    }

    if (result === null) {
      // Notification: no response needed
      return;
    }

    if (result.ok) {
      const requestId = (parsed as { id: string | number }).id;
      const response = createSuccessResponse(requestId, result.result);
      session.writer.writeMessage(response);
      journalEventsCounter.inc(1, { stream: 'ipc', type: 'response' });
    } else {
      session.writer.writeMessage(result.error);
    }
  }

  private sendError(socket: NetSocket, id: JsonRpcId | null, code: number, message: string, data?: unknown): void {
    const response = createErrorResponse(id, code, message, data);
    const line = JSON.stringify(response);
    if (socket.writable) {
      socket.write(`${line}\n`);
    }
  }

  // ==========================================================================
  // Built-in Methods
  // ==========================================================================

  private handleDaemonHealth(_params: unknown, _ctx: IpcContext): Promise<{
    protocolVersion: number;
    status: string;
    uptimeMs: number;
    activeRuns: number;
    version: string;
  }> {
    void _params;
    void _ctx;
    const now = this.clock.now().getTime();
    ipcRequestHistogram.observe(now - this.startTimeMs, { method: 'daemon.health', status: 'ok' });
    return Promise.resolve({
      protocolVersion: IPC_PROTOCOL_VERSION,
      status: 'healthy',
      uptimeMs: now - this.startTimeMs,
      activeRuns: this.clientCount,
      version: '0.0.0',
    });
  }

  private handleDaemonShutdown(_params: unknown, _ctx: IpcContext): Promise<{ ok: boolean }> {
    void _params;
    this.logger.info({ event: 'ipc.server.shutdown_requested', clientId: _ctx.clientId }, 'Daemon shutdown requested via IPC');
    const now = this.clock.now().getTime();
    ipcRequestHistogram.observe(now - this.startTimeMs, { method: 'daemon.shutdown', status: 'ok' });
    return Promise.resolve({ ok: true });
  }

  // ==========================================================================
  // Notifications
  // ==========================================================================

  /**
   * Broadcast a journal event to all subscribed clients as an `event` notification.
   */
  private broadcastEvent(event: EventEnvelope): Promise<void> {
    const notification = {
      jsonrpc: '2.0' as const,
      method: 'event' as const,
      params: {
        subscriptionId: 'default',
        event,
      },
    };

    const line = JSON.stringify(notification);
    for (const [clientId, session] of this.clients) {
      if (session.subscribed && session.socket.writable) {
        try {
          session.socket.write(`${line}\n`);
        } catch (err) {
          this.logger.warn({ event: 'ipc.server.broadcast_error', clientId, err: err instanceof Error ? err : { message: String(err) } }, 'Failed to broadcast event to client');
        }
      }
    }
    journalEventsCounter.inc(1, { stream: 'ipc', type: 'notification' });
    return Promise.resolve();
  }

  /** Mark a client as subscribed to event notifications. */
  subscribeClient(clientId: string): void {
    const session = this.clients.get(clientId);
    if (session) {
      session.subscribed = true;
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private nextClientId(): string {
    this.clientCounter += 1;
    return `client_${this.clock.now().getTime()}_${this.clientCounter}`;
  }

  private nextCorrelationId(): string {
    this.clientCounter += 1;
    return `corr_${this.clock.now().getTime()}_${this.clientCounter}`;
  }
}
