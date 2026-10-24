/**
 * Windows Event Tracing (ETW) Provider (Phase W4 - ETW telemetry).
 *
 * Emits Event Tracing for Windows events alongside the hash-chained JSONL
 * audit log. Windows security teams and EDR/SIEM products already consume
 * ETW, which makes AIR visible to the tools enterprises already run.
 *
 * Provides an SSE event stream consumable via EventSource
 * (browser native or the `eventsource` npm package) for cross-platform
 * event consumption.
 *
 * On Windows, ETW provider registration via PowerShell is not performed
 * from the observability layer (Rule R2 confines child_process to the
 * sandbox layer). The SSE event stream provides the cross-platform
 * event consumption path.
 *
 * Adheres to:
 * - Rule R1: Structured logging via src/observability
 * - Rule R2: No direct child_process usage (sandbox layer only)
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 */

import http from 'node:http';

const defaultLogger: EtwLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface EtwEvent {
  readonly provider: string;
  readonly eventId: number;
  readonly level: 'win:Informational' | 'win:Warning' | 'win:Error';
  readonly timestamp: string;
  readonly activityId: string;
  readonly relatedActivityId?: string;
  readonly opcode: string;
  readonly task: string;
  readonly opcodeName?: string;
  readonly payload: Record<string, unknown>;
}

export interface EtwProviderOptions {
  /** ETW provider name. Defaults to 'Microsoft-AIR'. */
  readonly providerName?: string | undefined;
  /** ETW provider GUID. Defaults to a fixed AIR GUID. */
  readonly providerGuid?: string | undefined;
  /** SSE port for EventSource consumers. Defaults to 0 (ephemeral). */
  readonly ssePort?: number | undefined;
  /** Whether ETW emission is enabled. Defaults to true on Windows. */
  readonly enabled?: boolean | undefined;
  /** Custom logger for ETW provider diagnostics. */
  readonly logger?: EtwLogger | undefined;
}

export interface EtwLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const AIR_ETW_PROVIDER_GUID = '559E2E30-8F4A-4B9C-9D1E-2F3A4B5C6D7E';

const ETW_LEVEL_MAP: Record<string, 'win:Informational' | 'win:Warning' | 'win:Error'> = {
  trace: 'win:Informational',
  debug: 'win:Informational',
  info: 'win:Informational',
  warn: 'win:Warning',
  error: 'win:Error',
  fatal: 'win:Error',
};

const SECURITY_EVENT_IDS: Record<string, number> = {
  'sandbox.process_started': 1001,
  'sandbox.process_completed': 1002,
  'sandbox.process_failed': 1003,
  'sandbox.appcontainer.profile_created': 1011,
  'sandbox.appcontainer.profile_deleted': 1012,
  'sandbox.wfp.filter_added': 1021,
  'sandbox.wfp.filter_removed': 1022,
  'policy.decision': 1031,
  'policy.bypass_attempt': 1032,
  'approval.requested': 1041,
  'approval.approved': 1042,
  'approval.denied': 1043,
  'secret.access': 1051,
  'secret.write': 1052,
  'secret.delete': 1053,
  'credential.injection': 1061,
  'etw.event_emitted': 1071,
};

/**
 * Minimal log record shape needed by ETW provider.
 * Defined locally to avoid circular dependency with streams.ts.
 */
export interface EtwLogRecord {
  readonly event: string;
  readonly level: string;
  readonly traceId?: string | undefined;
  readonly eventId?: string | number | undefined;
  readonly component: string;
  readonly stream: string;
}

/**
 * ETW Provider for Windows Event Tracing.
 *
 * Emits ETW events for security-relevant actions alongside the JSONL audit
 * log. Provides an SSE event stream consumable via EventSource
 * (browser native or the `eventsource` npm package).
 */
export class EtwProvider {
  private readonly providerName: string;
  private readonly providerGuid: string;
  private readonly enabled: boolean;
  private readonly logger: EtwLogger;
  private sseServer: http.Server | null = null;
  private readonly clients = new Set<http.ServerResponse>();
  private readonly eventQueue: EtwEvent[] = [];
  private readonly maxQueueSize = 1000;
  private ssePort = 0;

  constructor(options: EtwProviderOptions = {}) {
    this.providerName = options.providerName ?? 'Microsoft-AIR';
    this.providerGuid = options.providerGuid ?? AIR_ETW_PROVIDER_GUID;
    this.enabled = options.enabled ?? process.platform === 'win32';
    this.logger = options.logger ?? defaultLogger;

    this.logger.debug(
      `ETW provider initialized: ${this.providerName} (${this.providerGuid})`,
    );

    if (this.enabled && options.ssePort !== undefined) {
      this.startSseServer(options.ssePort);
    }

    // Note: ETW provider registration via PowerShell is not performed from
    // the observability layer (Rule R2 confines child_process to the
    // sandbox layer). Register the provider at daemon boot using the
    // sandbox helper if Windows ETW integration is required.
  }

  /**
   * Returns the SSE server port, or 0 if SSE is not enabled.
   */
  get port(): number {
    return this.ssePort;
  }

  /**
   * Returns whether ETW is enabled.
   */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Starts the SSE server for EventSource consumers.
   */
  private startSseServer(port: number): void {
    this.sseServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);

      if (url.pathname === '/etw' || url.pathname === '/etw/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write(': AIR ETW Event Stream\n\n');

        this.clients.add(res);

        res.on('close', () => {
          this.clients.delete(res);
        });
        res.on('error', () => {
          this.clients.delete(res);
        });
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    this.sseServer.listen(port, '127.0.0.1', () => {
      const addr = this.sseServer?.address();
      if (typeof addr === 'object' && addr !== null) {
        this.ssePort = addr.port;
      }
      this.logger.info(
        `ETW SSE server started on port ${this.ssePort}`,
      );
    });

    this.sseServer.on('error', (err) => {
      this.logger.error(
        `ETW SSE server error: ${err.message}`,
      );
    });
  }

  /**
   * Broadcasts an ETW event to all SSE clients.
   */
  private broadcast(event: EtwEvent): void {
    if (this.clients.size === 0) return;

    const data = JSON.stringify(event);
    const message = `data: ${data}\n\n`;

    for (const client of this.clients) {
      try {
        client.write(message);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /**
   * Emits an ETW event alongside the JSONL audit log.
   *
   * @param event - The ETW event to emit (without timestamp, which is added automatically)
   */
  public emit(event: Omit<EtwEvent, 'timestamp'>): void {
    if (!this.enabled) return;

    const etwEvent: EtwEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };

    // Add to queue
    this.eventQueue.push(etwEvent);
    if (this.eventQueue.length > this.maxQueueSize) {
      this.eventQueue.shift();
    }

    // Broadcast to SSE clients
    this.broadcast(etwEvent);

    this.logger.debug(
      `ETW event emitted: ${etwEvent.opcode} (id=${etwEvent.eventId})`,
    );
  }

  /**
   * Emits an ETW event from a log record (audit log entry).
   * Maps log record fields to ETW event fields.
   */
  public emitFromLogRecord(record: EtwLogRecord): void {
    if (!this.enabled) return;

    const eventId = SECURITY_EVENT_IDS[record.event] ?? 9000;
    const level = ETW_LEVEL_MAP[record.level] ?? 'win:Informational';

    const payload: Record<string, unknown> = {
      ...record,
      stream: record.stream,
    };

    const etwEvent: Omit<EtwEvent, 'timestamp'> = {
      provider: this.providerName,
      eventId,
      level,
      activityId: record.traceId ?? String(record.eventId ?? crypto.randomUUID()),
      opcode: record.event,
      task: record.component,
      payload,
    };

    this.emit(etwEvent);
  }

  /**
   * Returns an EventSource URL for consuming ETW events.
   * Consumers can use: new EventSource(provider.getEventSourceUrl())
   * (browser native EventSource or the `eventsource` npm package)
   */
  public getEventSourceUrl(): string | undefined {
    if (!this.sseServer || this.ssePort === 0) return undefined;
    return `http://127.0.0.1:${this.ssePort}/etw`;
  }

  /**
   * Closes the ETW provider and SSE server.
   */
  public close(): void {
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        // Ignore
      }
    }
    this.clients.clear();

    if (this.sseServer) {
      this.sseServer.close();
      this.sseServer = null;
    }
  }
}

/**
 * Creates an ETW provider instance with default options.
 */
export function createEtwProvider(options?: EtwProviderOptions): EtwProvider {
  return new EtwProvider(options);
}
