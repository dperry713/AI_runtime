/**
 * Client SDK — typed `AirClient` wrapping `IpcClient` (Phase 9 - P9-T03).
 *
 * Implements:
 * - Typed method wrappers for every IPC method in docs/specs/ipc.md §5
 * - Zod validation of request params and response shapes at the wire boundary (Rule R12)
 * - Reconnect, subscriptions, and request timeouts delegated to `IpcClient`
 * - Event notification handling (`event`, `approval.requested`)
 *
 * Layer 8 per ARCHITECTURE.md §3: imports layers 0–7 only through their index.ts.
 *
 * Adheres to:
 * - Rule R1: No console.log; uses observability logger
 * - Rule R6: Injected Clock for timestamps (no raw Date.now() / Math.random())
 * - Rule R7: No any; strict TypeScript
 * - Rule R11: Typed AirError errors
 * - Rule R12: Zod validation at wire boundary
 */

import { z } from 'zod';
import { getLogger } from '../observability/index.js';
import type { ComponentLogger } from '../observability/index.js';
import type { EventEnvelope } from '../journal/index.js';
import { IpcClient } from '../ipc/index.js';

// ============================================================================
// 1. Response / request schemas (wire validation)
// ============================================================================

const HealthResponseSchema = z.object({
  protocolVersion: z.number(),
  status: z.string(),
  uptimeMs: z.number(),
  activeRuns: z.number(),
  version: z.string(),
});
type HealthResponse = z.infer<typeof HealthResponseSchema>;

const ShutdownResponseSchema = z.object({
  ok: z.boolean(),
});
type ShutdownResponse = z.infer<typeof ShutdownResponseSchema>;

const SessionCreateRequestSchema = z.object({
  agentId: z.string().min(1),
});
type SessionCreateRequest = z.infer<typeof SessionCreateRequestSchema>;

const SessionCreateResponseSchema = z.object({
  sessionId: z.string().min(1),
});
type SessionCreateResponse = z.infer<typeof SessionCreateResponseSchema>;

const SessionListResponseSchema = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string().min(1),
      agentId: z.string().min(1),
      createdAt: z.string(),
    }),
  ),
});
type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

const RunStartRequestSchema = z.object({
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  goal: z.string().min(1),
});
type RunStartRequest = z.infer<typeof RunStartRequestSchema>;

const RunStartResponseSchema = z.object({
  runId: z.string().min(1),
});
type RunStartResponse = z.infer<typeof RunStartResponseSchema>;

const RunIdRequestSchema = z.object({
  runId: z.string().min(1),
});
type RunIdRequest = z.infer<typeof RunIdRequestSchema>;

const RunOkResponseSchema = z.object({
  ok: z.boolean(),
});
type RunOkResponse = z.infer<typeof RunOkResponseSchema>;

const RunListRequestSchema = z.object({
  sessionId: z.string().optional(),
});
type RunListRequest = z.infer<typeof RunListRequestSchema>;

const RunListResponseSchema = z.object({
  runs: z.array(
    z.object({
      runId: z.string().min(1),
      status: z.string(),
      createdAt: z.string(),
    }),
  ),
});
type RunListResponse = z.infer<typeof RunListResponseSchema>;

const RunGetResponseSchema = z.object({
  run: z.unknown(),
});
type RunGetResponse = z.infer<typeof RunGetResponseSchema>;

const RunReplayResponseSchema = z.object({
  runId: z.string().min(1),
  events: z.array(z.unknown()),
});
type RunReplayResponse = z.infer<typeof RunReplayResponseSchema>;

const ApprovalListResponseSchema = z.object({
  approvals: z.array(
    z.object({
      approvalId: z.string().min(1),
      tool: z.string().min(1),
      reason: z.string(),
      createdAt: z.string(),
    }),
  ),
});
type ApprovalListResponse = z.infer<typeof ApprovalListResponseSchema>;

const ApprovalResolveRequestSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(['approve', 'deny']),
  reason: z.string().optional(),
});
type ApprovalResolveRequest = z.infer<typeof ApprovalResolveRequestSchema>;

const ApprovalResolveResponseSchema = z.object({
  ok: z.boolean(),
});
type ApprovalResolveResponse = z.infer<typeof ApprovalResolveResponseSchema>;

const LogsTailRequestSchema = z.object({
  stream: z.string().optional(),
  limit: z.number().int().nonnegative().optional(),
});
type LogsTailRequest = z.infer<typeof LogsTailRequestSchema>;

const LogsTailResponseSchema = z.object({
  records: z.array(z.unknown()),
});
type LogsTailResponse = z.infer<typeof LogsTailResponseSchema>;

const ConfigGetRequestSchema = z.object({
  key: z.string().min(1),
});
type ConfigGetRequest = z.infer<typeof ConfigGetRequestSchema>;

const ConfigGetResponseSchema = z.object({
  value: z.unknown(),
  source: z.string(),
});
type ConfigGetResponse = z.infer<typeof ConfigGetResponseSchema>;

const ConfigExplainRequestSchema = z.object({
  key: z.string().min(1),
});
type ConfigExplainRequest = z.infer<typeof ConfigExplainRequestSchema>;

const ConfigExplainResponseSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  provenance: z.array(z.unknown()),
});
type ConfigExplainResponse = z.infer<typeof ConfigExplainResponseSchema>;

// ============================================================================
// 2. Client options
// ============================================================================

export interface AirClientOptions {
  /** Pipe name to connect to. Defaults to `\\.\pipe\air-<username>`. */
  readonly pipeName?: string | undefined;
  /** Request timeout in milliseconds. Defaults to 30000. */
  readonly requestTimeoutMs?: number | undefined;
  /** Reconnect delay in milliseconds. Defaults to 1000. */
  readonly reconnectDelayMs?: number | undefined;
  /** Maximum reconnect attempts. Defaults to 5 (0 = no reconnect). */
  readonly maxReconnectAttempts?: number | undefined;
}

// ============================================================================
// 3. Notification payload types
// ============================================================================

export interface EventNotification {
  readonly subscriptionId: string;
  readonly event: EventEnvelope;
}

export interface ApprovalRequestedNotification {
  readonly approvalId: string;
  readonly runId: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly reason: string;
  readonly createdAt: string;
}

// ============================================================================
// 4. AirClient class
// ============================================================================

/**
 * Typed AIR IPC client. Wraps `IpcClient` with strongly-typed method wrappers
 * for every IPC method defined in docs/specs/ipc.md §5.
 *
 * All request params and response shapes are validated with Zod at the wire
 * boundary (Rule R12). Invalid responses throw `AirError`.
 */
export class AirClient {
  private readonly client: IpcClient;
  private readonly logger: ComponentLogger;

  private readonly eventHandlers = new Set<(notification: EventNotification) => void>();
  private readonly approvalRequestedHandlers = new Set<
    (notification: ApprovalRequestedNotification) => void
  >();

  constructor(options: AirClientOptions = {}) {
    const clientOptions: { pipeName?: string; requestTimeoutMs?: number; reconnectDelayMs?: number; maxReconnectAttempts?: number } = {};
    if (options.pipeName !== undefined) {
      clientOptions.pipeName = options.pipeName;
    }
    if (options.requestTimeoutMs !== undefined) {
      clientOptions.requestTimeoutMs = options.requestTimeoutMs;
    }
    if (options.reconnectDelayMs !== undefined) {
      clientOptions.reconnectDelayMs = options.reconnectDelayMs;
    }
    if (options.maxReconnectAttempts !== undefined) {
      clientOptions.maxReconnectAttempts = options.maxReconnectAttempts;
    }
    this.client = new IpcClient(clientOptions);
    this.logger = getLogger('air-client');

    this.client.onNotification('event', (params) => {
      this.handleEventNotification(params);
    });

    this.client.onNotification('approval.requested', (params) => {
      this.handleApprovalRequestedNotification(params);
    });
  }

  /** Returns the pipe name this client connects to. */
  get name(): string {
    return this.client.name;
  }

  /** Returns whether the client is currently connected. */
  get isConnected(): boolean {
    return this.client.isConnected;
  }

  /** Returns whether the client is currently attempting to connect. */
  get isConnecting(): boolean {
    return this.client.isConnecting;
  }

  /** Returns the number of pending requests awaiting response. */
  get pendingRequestCount(): number {
    return this.client.pendingRequestCount;
  }

  // ==========================================================================
  // Connection
  // ==========================================================================

  /** Connect to the named pipe server. */
  async connect(): Promise<void> {
    await this.client.connect();
    this.logger.info({ event: 'air.client.connected', pipe: this.name }, 'AirClient connected');
  }

  /** Disconnect from the pipe server. */
  async disconnect(): Promise<void> {
    await this.client.disconnect();
    this.logger.info({ event: 'air.client.disconnected', pipe: this.name }, 'AirClient disconnected');
  }

  // ==========================================================================
  // Daemon methods
  // ==========================================================================

  /** Returns daemon status and protocol version. */
  async health(): Promise<HealthResponse> {
    const raw = await this.client.request<unknown, unknown>('daemon.health');
    return HealthResponseSchema.parse(raw);
  }

  /** Requests graceful daemon shutdown. */
  async shutdown(): Promise<ShutdownResponse> {
    const raw = await this.client.request<unknown, unknown>('daemon.shutdown');
    return ShutdownResponseSchema.parse(raw);
  }

  // ==========================================================================
  // Session methods
  // ==========================================================================

  /** Create a new session. */
  async createSession(params: SessionCreateRequest): Promise<SessionCreateResponse> {
    const validated = SessionCreateRequestSchema.parse(params);
    const raw = await this.client.request<SessionCreateRequest, unknown>('session.create', validated);
    return SessionCreateResponseSchema.parse(raw);
  }

  /** List active sessions. */
  async listSessions(): Promise<SessionListResponse> {
    const raw = await this.client.request<unknown, unknown>('session.list');
    return SessionListResponseSchema.parse(raw);
  }

  // ==========================================================================
  // Run methods
  // ==========================================================================

  /** Start a new agent run. */
  async startRun(params: RunStartRequest): Promise<RunStartResponse> {
    const validated = RunStartRequestSchema.parse(params);
    const raw = await this.client.request<RunStartRequest, unknown>('run.start', validated);
    return RunStartResponseSchema.parse(raw);
  }

  /** Cancel a running agent run. */
  async cancelRun(params: RunIdRequest): Promise<RunOkResponse> {
    const validated = RunIdRequestSchema.parse(params);
    const raw = await this.client.request<RunIdRequest, unknown>('run.cancel', validated);
    return RunOkResponseSchema.parse(raw);
  }

  /** Pause a running agent run. */
  async pauseRun(params: RunIdRequest): Promise<RunOkResponse> {
    const validated = RunIdRequestSchema.parse(params);
    const raw = await this.client.request<RunIdRequest, unknown>('run.pause', validated);
    return RunOkResponseSchema.parse(raw);
  }

  /** Resume a paused agent run. */
  async resumeRun(params: RunIdRequest): Promise<RunOkResponse> {
    const validated = RunIdRequestSchema.parse(params);
    const raw = await this.client.request<RunIdRequest, unknown>('run.resume', validated);
    return RunOkResponseSchema.parse(raw);
  }

  /** List runs (optionally filtered by session). */
  async listRuns(params: RunListRequest = {}): Promise<RunListResponse> {
    const validated = RunListRequestSchema.parse(params);
    const raw = await this.client.request<RunListRequest, unknown>('run.list', validated);
    return RunListResponseSchema.parse(raw);
  }

  /** Get run details and current state. */
  async getRun(params: RunIdRequest): Promise<RunGetResponse> {
    const validated = RunIdRequestSchema.parse(params);
    const raw = await this.client.request<RunIdRequest, unknown>('run.get', validated);
    return RunGetResponseSchema.parse(raw);
  }

  /** Replay a completed run from the journal. */
  async replayRun(params: RunIdRequest): Promise<RunReplayResponse> {
    const validated = RunIdRequestSchema.parse(params);
    const raw = await this.client.request<RunIdRequest, unknown>('run.replay', validated);
    return RunReplayResponseSchema.parse(raw);
  }

  // ==========================================================================
  // Approval methods
  // ==========================================================================

  /** List pending approval requests. */
  async listApprovals(): Promise<ApprovalListResponse> {
    const raw = await this.client.request<unknown, unknown>('approval.list');
    return ApprovalListResponseSchema.parse(raw);
  }

  /** Approve or deny a pending approval. */
  async resolveApproval(params: ApprovalResolveRequest): Promise<ApprovalResolveResponse> {
    const validated = ApprovalResolveRequestSchema.parse(params);
    const raw = await this.client.request<ApprovalResolveRequest, unknown>(
      'approval.resolve',
      validated,
    );
    return ApprovalResolveResponseSchema.parse(raw);
  }

  // ==========================================================================
  // Logs methods
  // ==========================================================================

  /** Tail recent log records. */
  async tailLogs(params: LogsTailRequest = {}): Promise<LogsTailResponse> {
    const validated = LogsTailRequestSchema.parse(params);
    const raw = await this.client.request<LogsTailRequest, unknown>('logs.tail', validated);
    return LogsTailResponseSchema.parse(raw);
  }

  // ==========================================================================
  // Config methods
  // ==========================================================================

  /** Get effective configuration value. */
  async getConfig(params: ConfigGetRequest): Promise<ConfigGetResponse> {
    const validated = ConfigGetRequestSchema.parse(params);
    const raw = await this.client.request<ConfigGetRequest, unknown>('config.get', validated);
    return ConfigGetResponseSchema.parse(raw);
  }

  /** Explain configuration provenance for a key. */
  async explainConfig(params: ConfigExplainRequest): Promise<ConfigExplainResponse> {
    const validated = ConfigExplainRequestSchema.parse(params);
    const raw = await this.client.request<ConfigExplainRequest, unknown>('config.explain', validated);
    return ConfigExplainResponseSchema.parse(raw);
  }

  // ==========================================================================
  // Notifications
  // ==========================================================================

  /** Subscribe to `event` notifications (live journal events from server). */
  onEvent(handler: (notification: EventNotification) => void): void {
    this.eventHandlers.add(handler);
  }

  /** Unsubscribe from `event` notifications. */
  offEvent(handler: (notification: EventNotification) => void): void {
    this.eventHandlers.delete(handler);
  }

  /** Subscribe to `approval.requested` notifications. */
  onApprovalRequested(handler: (notification: ApprovalRequestedNotification) => void): void {
    this.approvalRequestedHandlers.add(handler);
  }

  /** Unsubscribe from `approval.requested` notifications. */
  offApprovalRequested(handler: (notification: ApprovalRequestedNotification) => void): void {
    this.approvalRequestedHandlers.delete(handler);
  }

  // ==========================================================================
  // Internal: notification handling
  // ==========================================================================

  private handleEventNotification(params: unknown): void {
    const parsed = z
      .object({
        subscriptionId: z.string(),
        event: z.unknown(),
      })
      .safeParse(params);

    if (!parsed.success) {
      this.logger.warn(
        { event: 'air.client.invalid_event_notification', issues: parsed.error.issues },
        'Invalid event notification received',
      );
      return;
    }

    const notification: EventNotification = {
      subscriptionId: parsed.data.subscriptionId,
      event: parsed.data.event as EventEnvelope,
    };

    for (const handler of this.eventHandlers) {
      try {
        handler(notification);
      } catch (err) {
        this.logger.warn(
          { event: 'air.client.event_handler_error', err: err instanceof Error ? err : { message: String(err) } },
          'Event handler threw',
        );
      }
    }
  }

  private handleApprovalRequestedNotification(params: unknown): void {
    const parsed = z
      .object({
        approvalId: z.string(),
        runId: z.string(),
        tool: z.string(),
        args: z.record(z.string(), z.unknown()),
        reason: z.string(),
        createdAt: z.string(),
      })
      .safeParse(params);

    if (!parsed.success) {
      this.logger.warn(
        { event: 'air.client.invalid_approval_notification', issues: parsed.error.issues },
        'Invalid approval.requested notification received',
      );
      return;
    }

    const notification: ApprovalRequestedNotification = {
      approvalId: parsed.data.approvalId,
      runId: parsed.data.runId,
      tool: parsed.data.tool,
      args: parsed.data.args,
      reason: parsed.data.reason,
      createdAt: parsed.data.createdAt,
    };

    for (const handler of this.approvalRequestedHandlers) {
      try {
        handler(notification);
      } catch (err) {
        this.logger.warn(
          {
            event: 'air.client.approval_handler_error',
            err: err instanceof Error ? err : { message: String(err) },
          },
          'Approval handler threw',
        );
      }
    }
  }
}

// ============================================================================
// 5. Re-export types for consumers
// ============================================================================

export type {
  HealthResponse,
  ShutdownResponse,
  SessionCreateRequest,
  SessionCreateResponse,
  SessionListResponse,
  RunStartRequest,
  RunStartResponse,
  RunIdRequest,
  RunOkResponse,
  RunListRequest,
  RunListResponse,
  RunGetResponse,
  RunReplayResponse,
  ApprovalListResponse,
  ApprovalResolveRequest,
  ApprovalResolveResponse,
  LogsTailRequest,
  LogsTailResponse,
  ConfigGetRequest,
  ConfigGetResponse,
  ConfigExplainRequest,
  ConfigExplainResponse,
};
