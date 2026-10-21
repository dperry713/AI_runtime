/**
 * IPC Pipe Transport — Windows named pipes (Phase 9 - P9-T01).
 *
 * Implements:
 * - Named pipe server (`net.createServer`) listening on `\\.\pipe\air-<username>`
 * - Named pipe client (`net.createConnection`) connecting to the same pipe
 * - User-scoped pipe names for isolation between Windows users
 * - Connection lifecycle: connect, data, error, close
 *
 * Adheres to:
 * - Rule R1: No console.log; uses observability logger
 * - Rule R2: `net` is used only here in the IPC layer for named-pipe IPC (not TCP network)
 * - Rule R5: Windows path handling for pipe names
 * - Rule R7: No any; strict TypeScript
 * - Rule R11: Typed AirError errors
 */

import net from 'node:net';
import os from 'node:os';
import { AirError } from '../errors/index.js';
import { getLogger } from '../observability/index.js';

// ============================================================================
// 1. Pipe Name Resolution
// ============================================================================

/** Returns the current Windows username for pipe name scoping. */
export function getCurrentUsername(): string {
  return os.userInfo().username ?? process.env.USERNAME ?? 'unknown';
}

/**
 * Builds the full Windows named pipe name for the current user.
 * Format: `\\.\pipe\<base>-<username>`
 */
export function getPipeName(options: { readonly pipeName?: string } = {}): string {
  const base = options.pipeName ?? 'air';
  const username = getCurrentUsername();
  return `\\\\.\\pipe\\${base}-${username}`;
}

// ============================================================================
// 2. Errors
// ============================================================================

/** Thrown when a pipe operation fails. */
export class PipeError extends AirError {
  constructor(message: string, options?: { cause?: Error; context?: Record<string, unknown> }) {
    super('IPC_CONNECTION_FAILED', message, {
      cause: options?.cause,
      context: options?.context,
      exposeToModel: true,
    });
  }
}

// ============================================================================
// 3. Pipe Server
// ============================================================================

export interface PipeServerOptions {
  /** Full pipe name to listen on (e.g. `\\.\pipe\air-<username>`). */
  readonly pipeName: string;
  /** Callback invoked when a client connects. */
  readonly onConnection: (socket: net.Socket) => void;
  /** Callback invoked on server error. */
  readonly onError?: ((error: Error) => void) | undefined;
}

/**
 * Windows named pipe server. Listens for client connections and invokes
 * `onConnection` for each accepted socket.
 */
export class PipeServer {
  private readonly pipeName: string;
  private readonly onConnection: (socket: net.Socket) => void;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly logger = getLogger('ipc-pipe-server');

  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private listening = false;

  constructor(options: PipeServerOptions) {
    this.pipeName = options.pipeName;
    this.onConnection = options.onConnection;
    this.onError = options.onError;
  }

  /** Returns the pipe name this server listens on. */
  get name(): string {
    return this.pipeName;
  }

  /** Returns whether the server is currently listening. */
  get isListening(): boolean {
    return this.listening;
  }

  /** Returns the number of currently connected client sockets. */
  get connectionCount(): number {
    return this.sockets.size;
  }

  /** Start listening for client connections. */
  async start(): Promise<void> {
    if (this.listening) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      try {
        this.server = net.createServer((socket) => {
          this.logger.info({ event: 'ipc.pipe.connected', pipe: this.pipeName }, 'Client connected to IPC pipe');
          this.sockets.add(socket);

          socket.on('close', () => {
            this.sockets.delete(socket);
            this.logger.debug({ event: 'ipc.pipe.disconnected', pipe: this.pipeName }, 'Client disconnected from IPC pipe');
          });

          socket.on('error', (err) => {
            this.logger.warn({ event: 'ipc.pipe.socket_error', pipe: this.pipeName, err }, 'IPC pipe socket error');
            this.onError?.(err);
          });

          this.onConnection(socket);
        });

        this.server.listen(this.pipeName, () => {
          this.listening = true;
          this.logger.info({ event: 'ipc.pipe.listening', pipe: this.pipeName }, 'IPC pipe server listening');
          resolve();
        });

        this.server.on('error', (err) => {
          this.logger.error({ event: 'ipc.pipe.server_error', pipe: this.pipeName, err }, 'IPC pipe server error');
          this.onError?.(err);
          reject(err);
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Stop listening and close all client connections. */
  async stop(): Promise<void> {
    if (!this.listening || !this.server) {
      return;
    }

    const closePromises: Promise<void>[] = [];

    for (const socket of this.sockets) {
      closePromises.push(
        new Promise<void>((resolve) => {
          socket.once('close', () => resolve());
          socket.destroy();
        }),
      );
    }

    this.sockets.clear();

    await Promise.all(closePromises);

    const server = this.server;
    if (!server) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      server.close((err) => {
        this.listening = false;
        this.server = null;
        if (err) {
          reject(err);
        } else {
          this.logger.info({ event: 'ipc.pipe.stopped', pipe: this.pipeName }, 'IPC pipe server stopped');
          resolve();
        }
      });
    });
  }
}

// ============================================================================
// 4. Pipe Client
// ============================================================================

export interface PipeClientOptions {
  /** Full pipe name to connect to (e.g. `\\.\pipe\air-<username>`). */
  readonly pipeName: string;
  /** Callback invoked when data is received from the server. */
  readonly onData: (data: Buffer) => void;
  /** Callback invoked on connection error. */
  readonly onError?: ((error: Error) => void) | undefined;
  /** Callback invoked when the connection is closed. */
  readonly onClose?: (() => void) | undefined;
  /** Connection timeout in milliseconds. Defaults to 10000. */
  readonly connectTimeoutMs?: number;
}

/**
 * Windows named pipe client. Connects to the server pipe and streams data.
 */
export class PipeClient {
  private readonly pipeName: string;
  private readonly onData: (data: Buffer) => void;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly onClose: (() => void) | undefined;
  private readonly connectTimeoutMs: number;
  private readonly logger = getLogger('ipc-pipe-client');

  private socket: net.Socket | null = null;
  private connected = false;
  private connectTimer: NodeJS.Timeout | null = null;

  constructor(options: PipeClientOptions) {
    this.pipeName = options.pipeName;
    this.onData = options.onData;
    this.onError = options.onError;
    this.onClose = options.onClose;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  }

  /** Returns the pipe name this client connects to. */
  get name(): string {
    return this.pipeName;
  }

  /** Returns whether the client is currently connected. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Connect to the named pipe server. */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (this.connectTimer) {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      this.connectTimer = setTimeout(() => {
        settle(new PipeError(`Connection to pipe "${this.pipeName}" timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      try {
        this.socket = net.createConnection(this.pipeName);

        this.socket.on('connect', () => {
          this.connected = true;
          this.logger.debug({ event: 'ipc.client.connected', pipe: this.pipeName }, 'IPC client connected to pipe');
          settle();
        });

        this.socket.on('data', (data: Buffer) => {
          this.onData(data);
        });

        this.socket.on('error', (err) => {
          this.logger.warn({ event: 'ipc.client.error', pipe: this.pipeName, err }, 'IPC client error');
          this.onError?.(err);
          if (!this.connected) {
            settle(err);
          }
        });

        this.socket.on('close', () => {
          this.connected = false;
          this.logger.debug({ event: 'ipc.client.closed', pipe: this.pipeName }, 'IPC client connection closed');
          this.onClose?.();
        });
      } catch (err) {
        settle(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Write data to the pipe. */
  write(data: Buffer | string): void {
    const socket = this.socket;
    if (!socket || !this.connected) {
      throw new PipeError(`Pipe "${this.pipeName}" is not connected`);
    }
    socket.write(data);
  }

  /** Disconnect from the pipe server. */
  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }

    this.connected = false;
    this.socket = null;

    return new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.destroy();
    });
  }
}
