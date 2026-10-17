/**
 * Approval Broker (Phase 5 - P5-T04).
 *
 * Implements interactive and policy-driven tool approval workflows:
 * - Request and resolve operator approval for high-risk actions (Rule S1).
 * - Approval scopes:
 *   - 'once': applies strictly to a single tool invocation.
 *   - 'run': grants approval for identical tool actions across the entire active run.
 *   - 'session': grants approval for identical tool actions across the entire session.
 * - Headless execution: automatic instant denial when running non-interactively.
 * - Configurable timeouts: requests transition to expired/denied upon timeout.
 * - Persistence across restart: restores pending requests and cached scope grants.
 * - Full journal integration: emits tool.approval_requested, tool.approved, tool.denied (Rule R8).
 * - Injected Clock and IdGenerator for deterministic testing and replay (Rule R6).
 *
 * Adheres to:
 * - Rule R1: No console.log; uses component logger.
 * - Rule R2: Safe atomic disk persistence via src/util/fs-safe.
 * - Rule R6: Injected Clock and IdGenerator.
 * - Rule R7: Strict TypeScript, no any.
 * - Rule R8: Journal events emitted for all approval transitions.
 * - Rule R11: Typed AirError errors (APPROVAL_DENIED, APPROVAL_EXPIRED, APPROVAL_NOT_FOUND).
 * - Rule S1: Deny-by-default.
 */

import { z } from 'zod';
import { AirError } from '../errors/index.js';
import type { Clock, IdGenerator } from '../util/index.js';
import {
  SystemClock,
  UlidIdGenerator,
  existsIn,
  readFileIn,
  writeFileAtomicIn,
} from '../util/index.js';
import type { EventBus } from '../journal/index.js';
import { createEnvelope } from '../journal/index.js';
import type { ComponentLogger } from '../observability/index.js';
import { getLogger } from '../observability/index.js';
import { parseToolCallId, type ToolCallId } from '../types/index.js';
import type { CapabilityAtom } from './capabilities.js';
import { CapabilityAtomSchema, formatCapability } from './capabilities.js';

// ============================================================================
// 1. Interfaces & Types & Zod Schemas
// ============================================================================

export const ApprovalScopeSchema = z.enum(['once', 'run', 'session']);
export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalRiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type ApprovalRiskLevel = z.infer<typeof ApprovalRiskLevelSchema>;

export const ApprovalRecordSchema = z.object({
  id: z.string().min(1),
  toolCallId: z.string().min(1) as unknown as z.ZodType<ToolCallId>,
  toolName: z.string().min(1),
  input: z.unknown().optional(),
  capabilities: z.array(CapabilityAtomSchema).default([]),
  prompt: z.string().min(1),
  riskLevel: ApprovalRiskLevelSchema.default('medium'),
  scope: ApprovalScopeSchema.default('once'),
  status: ApprovalStatusSchema,
  requestedAt: z.string().min(1),
  expiresAt: z.string().min(1),
  resolvedAt: z.string().optional(),
  resolvedBy: z.string().optional(),
  reason: z.string().optional(),
  runId: z.string().min(1),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export const CachedApprovalGrantSchema = z.object({
  scope: z.enum(['run', 'session']),
  targetId: z.string().min(1),
  toolName: z.string().min(1),
  capabilityHash: z.string().optional(),
  grantedAt: z.string().min(1),
});
export type CachedApprovalGrant = z.infer<typeof CachedApprovalGrantSchema>;

export const ApprovalPersistedStateSchema = z.object({
  version: z.literal(1),
  pendingApprovals: z.array(ApprovalRecordSchema).default([]),
  cachedGrants: z.array(CachedApprovalGrantSchema).default([]),
});
export type ApprovalPersistedState = z.infer<typeof ApprovalPersistedStateSchema>;

export interface RequestApprovalOptions {
  readonly toolCallId: ToolCallId | string;
  readonly toolName: string;
  readonly input?: unknown;
  readonly capabilities?: readonly CapabilityAtom[] | undefined;
  readonly prompt: string;
  readonly riskLevel?: ApprovalRiskLevel | undefined;
  readonly scope?: ApprovalScope | undefined;
  readonly timeoutMs?: number | undefined;
  readonly runId: string;
  readonly sessionId?: string | undefined;
  readonly agentId?: string | undefined;
}

export interface ResolveApprovalOptions {
  readonly approvalId: string;
  readonly decision: 'approved' | 'denied';
  readonly operator?: string | undefined;
  readonly reason?: string | undefined;
}

export interface CheckCachedApprovalParams {
  readonly toolName: string;
  readonly runId: string;
  readonly sessionId?: string | undefined;
  readonly capabilities?: readonly CapabilityAtom[] | undefined;
}

export interface ApprovalDecisionResult {
  readonly approved: boolean;
  readonly record: ApprovalRecord;
  readonly cached?: boolean | undefined;
  readonly reason?: string | undefined;
}

export interface ApprovalBrokerStorageOptions {
  /** Root jail folder within which the state file resides. */
  readonly root: string;
  /** Relative path to state file inside root jail. */
  readonly statePath: string;
}

export interface ApprovalBrokerOptions {
  readonly clock?: Clock | undefined;
  readonly idGenerator?: IdGenerator | undefined;
  readonly eventBus?: EventBus | undefined;
  readonly headless?: boolean | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly storage?: ApprovalBrokerStorageOptions | undefined;
  readonly logger?: ComponentLogger | undefined;
}

interface DeferredApproval {
  readonly resolve: (result: ApprovalDecisionResult) => void;
  readonly timeoutHandle?: NodeJS.Timeout | undefined;
}

// ============================================================================
// 2. Helper Functions
// ============================================================================

function computeCapabilitySignature(capabilities?: readonly CapabilityAtom[]): string {
  if (!capabilities || capabilities.length === 0) return '*';
  return capabilities
    .map((c) => formatCapability(c))
    .sort()
    .join('|');
}

// ============================================================================
// 3. ApprovalBroker Class
// ============================================================================

export class ApprovalBroker {
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly eventBus?: EventBus | undefined;
  private readonly headless: boolean;
  private readonly defaultTimeoutMs: number;
  private readonly storage?: ApprovalBrokerStorageOptions | undefined;
  private readonly logger: ComponentLogger;

  private readonly pending = new Map<string, ApprovalRecord>();
  private readonly deferred = new Map<string, DeferredApproval>();
  private readonly cachedGrants = new Map<string, CachedApprovalGrant>();
  private isDisposed = false;

  constructor(options: ApprovalBrokerOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.idGenerator = options.idGenerator ?? new UlidIdGenerator(this.clock);
    this.eventBus = options.eventBus;
    this.headless = options.headless ?? false;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
    this.storage = options.storage;
    this.logger = options.logger ?? getLogger('approval-broker');
  }

  /**
   * Initializes broker and restores pending requests and cached scope grants from storage.
   */
  public async load(): Promise<void> {
    if (!this.storage) return;

    try {
      const exists = await existsIn(this.storage.root, this.storage.statePath);
      if (!exists) return;

      const raw = await readFileIn(this.storage.root, this.storage.statePath, 'utf8');
      const parseResult = ApprovalPersistedStateSchema.safeParse(JSON.parse(raw));
      if (!parseResult.success) return;

      const state = parseResult.data;
      const now = this.clock.now();

      // Restore cached grants
      for (const grant of state.cachedGrants) {
        const key = this.buildGrantKey(grant.scope, grant.targetId, grant.toolName, grant.capabilityHash);
        this.cachedGrants.set(key, grant);
      }

      // Restore pending approvals; expire any whose timeout has passed during downtime
      for (const item of state.pendingApprovals) {
        const expiresAt = new Date(item.expiresAt);
        if (expiresAt <= now) {
          item.status = 'expired';
          item.resolvedAt = now.toISOString();
          item.resolvedBy = 'timeout';
          item.reason = 'Approval expired during system downtime';
        } else {
          this.pending.set(item.id, item);
          this.armTimeout(item);
        }
      }
    } catch (err) {
      this.logger.warn(
        {
          event: 'approval.load_failed',
          err: err instanceof Error ? err : new Error(String(err)),
        },
        'Failed to restore approval state from disk',
      );
    }
  }

  /**
   * Persists current approval state to disk if storage is configured.
   */
  public async save(): Promise<void> {
    if (!this.storage) return;

    const state: ApprovalPersistedState = {
      version: 1,
      pendingApprovals: Array.from(this.pending.values()),
      cachedGrants: Array.from(this.cachedGrants.values()),
    };

    try {
      await writeFileAtomicIn(
        this.storage.root,
        this.storage.statePath,
        JSON.stringify(state, null, 2),
      );
    } catch (err) {
      this.logger.warn(
        {
          event: 'approval.save_failed',
          err: err instanceof Error ? err : new Error(String(err)),
        },
        'Failed to save approval state to disk',
      );
    }
  }

  /**
   * Checks if an identical tool action has already been approved under 'run' or 'session' scope.
   */
  public checkCachedApproval(params: CheckCachedApprovalParams): boolean {
    const capSig = computeCapabilitySignature(params.capabilities);

    // 1. Check run scope
    const runKey = this.buildGrantKey('run', params.runId, params.toolName, capSig);
    if (this.cachedGrants.has(runKey)) return true;

    // 2. Check session scope
    if (params.sessionId) {
      const sessKey = this.buildGrantKey('session', params.sessionId, params.toolName, capSig);
      if (this.cachedGrants.has(sessKey)) return true;
    }

    return false;
  }

  /**
   * Creates an approval request record and persists it without waiting for operator resolution.
   */
  public async createApproval(options: RequestApprovalOptions): Promise<ApprovalRecord> {
    if (this.isDisposed) {
      throw new AirError('INVALID_STATE', 'ApprovalBroker has been disposed');
    }

    const toolCallId = parseToolCallId(options.toolCallId);

    // 1. Check cached approval
    if (this.checkCachedApproval({
      toolName: options.toolName,
      runId: options.runId,
      sessionId: options.sessionId,
      capabilities: options.capabilities,
    })) {
      const now = this.clock.now().toISOString();
      return {
        id: this.idGenerator.next(),
        toolCallId,
        toolName: options.toolName,
        input: options.input,
        capabilities: options.capabilities ? [...options.capabilities] : [],
        prompt: options.prompt,
        riskLevel: options.riskLevel ?? 'medium',
        scope: options.scope ?? 'run',
        status: 'approved',
        requestedAt: now,
        expiresAt: now,
        resolvedAt: now,
        resolvedBy: 'cache',
        reason: 'Auto-approved by prior scope grant',
        runId: options.runId,
        sessionId: options.sessionId,
        agentId: options.agentId,
      };
    }

    // 2. Headless execution: immediate deny (Rule S1)
    if (this.headless) {
      const now = this.clock.now().toISOString();
      const deniedRecord: ApprovalRecord = {
        id: this.idGenerator.next(),
        toolCallId,
        toolName: options.toolName,
        input: options.input,
        capabilities: options.capabilities ? [...options.capabilities] : [],
        prompt: options.prompt,
        riskLevel: options.riskLevel ?? 'medium',
        scope: options.scope ?? 'once',
        status: 'denied',
        requestedAt: now,
        expiresAt: now,
        resolvedAt: now,
        resolvedBy: 'headless',
        reason: 'Headless execution: interactive operator approval unavailable',
        runId: options.runId,
        sessionId: options.sessionId,
        agentId: options.agentId,
      };

      this.publishEvent('tool.approval_requested', {
        toolCallId,
        riskLevel: deniedRecord.riskLevel,
        prompt: deniedRecord.prompt,
      }, options.runId, options.sessionId, options.agentId);

      this.publishEvent('tool.denied', {
        toolCallId,
        reason: deniedRecord.reason ?? 'Denied',
      }, options.runId, options.sessionId, options.agentId);

      return deniedRecord;
    }

    // 3. Create pending approval record
    const approvalId = this.idGenerator.next();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const requestedAtDate = this.clock.now();
    const expiresAtDate = new Date(requestedAtDate.getTime() + timeoutMs);

    const record: ApprovalRecord = {
      id: approvalId,
      toolCallId,
      toolName: options.toolName,
      input: options.input,
      capabilities: options.capabilities ? [...options.capabilities] : [],
      prompt: options.prompt,
      riskLevel: options.riskLevel ?? 'medium',
      scope: options.scope ?? 'once',
      status: 'pending',
      requestedAt: requestedAtDate.toISOString(),
      expiresAt: expiresAtDate.toISOString(),
      runId: options.runId,
      sessionId: options.sessionId,
      agentId: options.agentId,
    };

    this.pending.set(approvalId, record);

    // Rule R8: Publish tool.approval_requested
    this.publishEvent('tool.approval_requested', {
      toolCallId,
      riskLevel: record.riskLevel,
      prompt: record.prompt,
    }, options.runId, options.sessionId, options.agentId);

    // Persist pending state
    await this.save();

    return record;
  }

  /**
   * Waits for a pending approval to be resolved or expired.
   */
  public waitForApproval(approvalId: string): Promise<ApprovalDecisionResult> {
    if (this.isDisposed) {
      throw new AirError('INVALID_STATE', 'ApprovalBroker has been disposed');
    }

    const record = this.pending.get(approvalId);
    if (!record) {
      throw new AirError('APPROVAL_NOT_FOUND', `Approval request '${approvalId}' not found`);
    }

    if (record.status !== 'pending') {
      return Promise.resolve({
        approved: record.status === 'approved',
        record,
        reason: record.reason,
      });
    }

    return new Promise<ApprovalDecisionResult>((resolve) => {
      const remainingMs = Math.max(0, new Date(record.expiresAt).getTime() - this.clock.now().getTime());
      const timeoutHandle = setTimeout(() => {
        this.handleTimeout(approvalId);
      }, remainingMs);

      if (typeof timeoutHandle.unref === 'function') {
        timeoutHandle.unref();
      }

      this.deferred.set(approvalId, { resolve, timeoutHandle });
    });
  }

  /**
   * Requests operator approval for a tool invocation and waits for resolution.
   */
  public async requestApproval(options: RequestApprovalOptions): Promise<ApprovalDecisionResult> {
    const record = await this.createApproval(options);
    if (record.status !== 'pending') {
      return {
        approved: record.status === 'approved',
        cached: record.resolvedBy === 'cache',
        record,
        reason: record.reason,
      };
    }
    return this.waitForApproval(record.id);
  }

  /**
   * Resolves a pending approval with an operator decision ('approved' or 'denied').
   */
  public async resolveApproval(options: ResolveApprovalOptions): Promise<ApprovalRecord> {
    if (this.isDisposed) {
      throw new AirError('INVALID_STATE', 'ApprovalBroker has been disposed');
    }

    const record = this.pending.get(options.approvalId);
    if (!record) {
      throw new AirError(
        'APPROVAL_NOT_FOUND',
        `Approval request '${options.approvalId}' not found or already completed`,
      );
    }

    if (record.status !== 'pending') {
      throw new AirError(
        'INVALID_STATE',
        `Approval request '${options.approvalId}' cannot be resolved from status '${record.status}'`,
      );
    }

    const deferred = this.deferred.get(options.approvalId);
    if (deferred?.timeoutHandle) {
      clearTimeout(deferred.timeoutHandle);
    }

    const resolvedAt = this.clock.now().toISOString();
    record.status = options.decision;
    record.resolvedAt = resolvedAt;
    record.resolvedBy = options.operator ?? 'operator';
    record.reason = options.reason ?? (options.decision === 'approved' ? 'Approved by operator' : 'Denied by operator');

    this.pending.delete(options.approvalId);
    this.deferred.delete(options.approvalId);

    if (options.decision === 'approved') {
      // Cache scope if 'run' or 'session'
      if (record.scope === 'run') {
        const capSig = computeCapabilitySignature(record.capabilities);
        const key = this.buildGrantKey('run', record.runId, record.toolName, capSig);
        this.cachedGrants.set(key, {
          scope: 'run',
          targetId: record.runId,
          toolName: record.toolName,
          capabilityHash: capSig,
          grantedAt: resolvedAt,
        });
      } else if (record.scope === 'session' && record.sessionId) {
        const capSig = computeCapabilitySignature(record.capabilities);
        const key = this.buildGrantKey('session', record.sessionId, record.toolName, capSig);
        this.cachedGrants.set(key, {
          scope: 'session',
          targetId: record.sessionId,
          toolName: record.toolName,
          capabilityHash: capSig,
          grantedAt: resolvedAt,
        });
      }

      // Rule R8: Publish tool.approved
      this.publishEvent('tool.approved', {
        toolCallId: record.toolCallId,
        operator: record.resolvedBy,
      }, record.runId, record.sessionId, record.agentId);

      deferred?.resolve({ approved: true, record });
    } else {
      // Rule R8: Publish tool.denied
      this.publishEvent('tool.denied', {
        toolCallId: record.toolCallId,
        reason: record.reason ?? 'Denied by operator',
      }, record.runId, record.sessionId, record.agentId);

      deferred?.resolve({ approved: false, record, reason: record.reason });
    }

    await this.save();
    return record;
  }

  /**
   * Retrieves an approval record by ID.
   */
  public getApproval(approvalId: string): ApprovalRecord | undefined {
    return this.pending.get(approvalId);
  }

  /**
   * Lists all pending approvals, optionally filtered by runId or sessionId.
   */
  public listPending(filter?: { runId?: string; sessionId?: string }): ApprovalRecord[] {
    const list = Array.from(this.pending.values());
    if (!filter) return list;

    return list.filter((r) => {
      if (filter.runId && r.runId !== filter.runId) return false;
      if (filter.sessionId && r.sessionId !== filter.sessionId) return false;
      return true;
    });
  }

  /**
   * Evaluates pending approvals against the current clock and expires any that timed out.
   */
  public checkTimeouts(): void {
    const now = this.clock.now();
    for (const record of Array.from(this.pending.values())) {
      if (record.status === 'pending' && new Date(record.expiresAt) <= now) {
        this.handleTimeout(record.id);
      }
    }
  }

  /**
   * Cancels all pending approvals for a given run or all pending approvals.
   */
  public async cancelPending(runId?: string, reason?: string): Promise<void> {
    const toCancel = this.listPending(runId ? { runId } : undefined);
    const cancelReason = reason ?? 'Execution cancelled';

    for (const record of toCancel) {
      const deferred = this.deferred.get(record.id);
      if (deferred?.timeoutHandle) {
        clearTimeout(deferred.timeoutHandle);
      }

      record.status = 'denied';
      record.resolvedAt = this.clock.now().toISOString();
      record.resolvedBy = 'system';
      record.reason = cancelReason;

      this.pending.delete(record.id);
      this.deferred.delete(record.id);

      this.publishEvent('tool.denied', {
        toolCallId: record.toolCallId,
        reason: cancelReason,
      }, record.runId, record.sessionId, record.agentId);

      deferred?.resolve({ approved: false, record, reason: cancelReason });
    }

    await this.save();
  }

  /**
   * Cleans up all pending timers and disposes resources.
   */
  public dispose(): void {
    this.isDisposed = true;
    for (const deferred of this.deferred.values()) {
      if (deferred.timeoutHandle) {
        clearTimeout(deferred.timeoutHandle);
      }
    }
    this.deferred.clear();
  }

  // ==========================================================================
  // Internal Helpers
  // ==========================================================================

  private armTimeout(record: ApprovalRecord): void {
    const remainingMs = Math.max(0, new Date(record.expiresAt).getTime() - this.clock.now().getTime());
    const timeoutHandle = setTimeout(() => {
      this.handleTimeout(record.id);
    }, remainingMs);

    if (typeof timeoutHandle.unref === 'function') {
      timeoutHandle.unref();
    }

    this.deferred.set(record.id, {
      resolve: () => {},
      timeoutHandle,
    });
  }

  private handleTimeout(approvalId: string): void {
    const record = this.pending.get(approvalId);
    if (!record || record.status !== 'pending') return;

    record.status = 'expired';
    record.resolvedAt = this.clock.now().toISOString();
    record.resolvedBy = 'timeout';
    record.reason = `Approval request timed out after expiration`;

    const deferred = this.deferred.get(approvalId);
    this.pending.delete(approvalId);
    this.deferred.delete(approvalId);

    this.publishEvent('tool.denied', {
      toolCallId: record.toolCallId,
      reason: record.reason,
    }, record.runId, record.sessionId, record.agentId);

    deferred?.resolve({ approved: false, record, reason: record.reason });

    void this.save();
  }

  private buildGrantKey(scope: 'run' | 'session', targetId: string, toolName: string, capSig?: string): string {
    return `${scope}:${targetId}:${toolName.toLowerCase()}:${capSig ?? '*'}`;
  }

  private publishEvent(
    type: 'tool.approval_requested' | 'tool.approved' | 'tool.denied',
    payload: Record<string, unknown>,
    runId: string,
    sessionId?: string,
    agentId?: string,
  ): void {
    if (!this.eventBus) return;

    try {
      this.eventBus.publish(
        createEnvelope({
          stream: `run:${runId}`,
          seq: 1,
          type,
          payload,
          meta: {
            runId,
            sessionId,
            agentId,
          },
          clock: this.clock,
          idGenerator: this.idGenerator,
        }),
      );
    } catch (err) {
      this.logger.warn(
        {
          event: 'approval.publish_failed',
          err: err instanceof Error ? err : new Error(String(err)),
        },
        `Failed to publish ${type} event to EventBus`,
      );
    }
  }
}
