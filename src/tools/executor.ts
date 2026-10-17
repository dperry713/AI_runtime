/**
 * Tool Executor (Phase 4 - P4-T03).
 *
 * Orchestrates tool execution lifecycle:
 * - Untrusted argument validation against tool input schema (Rule R12)
 * - Output validation against tool output schema
 * - Cooperative cancellation and timeout management via AbortSignal
 * - Output size capping and byte truncation
 * - Injected policy hook integration point (Phase 5 ready)
 * - Journal event emission via EventBus (Rule R8)
 * - Structured metrics and observability hooks
 * - Error normalization into typed AirError (Rule R11)
 */

import { AirError } from '../errors/index.js';
import {
  createEnvelope,
  type EventBus,
} from '../journal/index.js';
import {
  type ComponentLogger,
  getLogger,
  toolCallsTotalCounter,
  toolDurationHistogram,
} from '../observability/index.js';
import {
  parseAgentId,
  parseRunId,
  parseSessionId,
  parseToolCallId,
  type ToolCallId,
} from '../types/index.js';
import {
  type Clock,
  type IdGenerator,
  type Random,
  SystemClock,
  SystemRandom,
  UlidIdGenerator,
} from '../util/index.js';
import {
  type AnyTool,
  toAnyTool,
  type ToolCapability,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
  validateToolInput,
  validateToolOutput,
} from './contract.js';
import type { ToolRegistry } from './registry.js';

export interface ToolPolicyEvaluationContext {
  readonly tool: AnyTool;
  readonly input: unknown;
  readonly capabilities: readonly ToolCapability[];
  readonly executionContext: ToolExecutionContext;
}

export interface ToolPolicyDecision {
  readonly allowed: boolean;
  readonly decisionId?: string | undefined;
  readonly reason?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ToolPolicyHook {
  evaluate(context: ToolPolicyEvaluationContext): Promise<ToolPolicyDecision>;
}

export interface ToolExecutionObserver {
  onToolStart?(event: {
    readonly callId: ToolCallId;
    readonly runId: string;
    readonly toolName: string;
    readonly input: unknown;
    readonly capabilities: readonly ToolCapability[];
    readonly timestamp: string;
  }): void | Promise<void>;

  onToolSuccess?(event: {
    readonly callId: ToolCallId;
    readonly runId: string;
    readonly toolName: string;
    readonly output: unknown;
    readonly truncated: boolean;
    readonly durationMs: number;
    readonly timestamp: string;
  }): void | Promise<void>;

  onToolError?(event: {
    readonly callId: ToolCallId;
    readonly runId: string;
    readonly toolName: string;
    readonly error: AirError;
    readonly durationMs: number;
    readonly timestamp: string;
  }): void | Promise<void>;
}

export interface ToolExecutionRequest<TInput = unknown, TOutput = unknown> {
  readonly callId?: ToolCallId | string | undefined;
  readonly runId: string;
  readonly sessionId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly tool?: ToolDefinition<TInput, TOutput> | AnyTool | undefined;
  readonly input: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly contextMeta?: Record<string, unknown> | undefined;
}

export interface ToolExecutorOptions {
  readonly registry?: ToolRegistry | undefined;
  readonly clock?: Clock | undefined;
  readonly random?: Random | undefined;
  readonly idGenerator?: IdGenerator | undefined;
  readonly policyHook?: ToolPolicyHook | undefined;
  readonly eventBus?: EventBus | undefined;
  readonly logger?: ComponentLogger | undefined;
  readonly observer?: ToolExecutionObserver | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly defaultMaxOutputBytes?: number | undefined;
  readonly defaultWorkspaceRoot?: string | undefined;
  /**
   * If true, strictly asserts that every tool execution must pass through a policy engine
   * and receive a valid decision ID (Rule R3, Threat T6, Exit Gate P5).
   */
  readonly requirePolicyDecision?: boolean | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024; // 100 KB
const TRUNCATION_NOTICE = '\n\n[TRUNCATED: maxOutputBytes exceeded]';

/**
 * Truncates an output value if its byte representation exceeds maxBytes.
 */
export function truncateOutput(
  output: unknown,
  maxBytes: number,
): { output: unknown; truncated: boolean } {
  if (maxBytes <= 0) {
    return { output, truncated: false };
  }

  if (typeof output === 'string') {
    const byteLen = Buffer.byteLength(output, 'utf8');
    if (byteLen > maxBytes) {
      const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, 'utf8');
      const budget = Math.max(0, maxBytes - noticeBytes);
      const buf = Buffer.from(output, 'utf8').subarray(0, budget);
      return {
        output: buf.toString('utf8') + TRUNCATION_NOTICE,
        truncated: true,
      };
    }
    return { output, truncated: false };
  }

  if (Buffer.isBuffer(output) || output instanceof Uint8Array) {
    if (output.byteLength > maxBytes) {
      return {
        output: output.subarray(0, maxBytes),
        truncated: true,
      };
    }
    return { output, truncated: false };
  }

  if (typeof output === 'object' && output !== null) {
    try {
      const json = JSON.stringify(output);
      if (Buffer.byteLength(json, 'utf8') > maxBytes) {
        const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, 'utf8');
        const budget = Math.max(0, maxBytes - noticeBytes);
        const buf = Buffer.from(json, 'utf8').subarray(0, budget);
        return {
          output: buf.toString('utf8') + TRUNCATION_NOTICE,
          truncated: true,
        };
      }
    } catch {
      // If serialization fails, return output without modification
    }
  }

  return { output, truncated: false };
}

export class ToolExecutor {
  private readonly registry?: ToolRegistry | undefined;
  private readonly clock: Clock;
  private readonly random: Random;
  private readonly idGenerator: IdGenerator;
  private readonly policyHook?: ToolPolicyHook | undefined;
  private readonly eventBus?: EventBus | undefined;
  private readonly logger: ComponentLogger;
  private readonly observer?: ToolExecutionObserver | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxOutputBytes: number;
  private readonly defaultWorkspaceRoot?: string | undefined;
  private readonly requirePolicyDecision: boolean;

  public constructor(options?: ToolExecutorOptions) {
    this.registry = options?.registry;
    this.clock = options?.clock ?? new SystemClock();
    this.random = options?.random ?? new SystemRandom();
    this.idGenerator = options?.idGenerator ?? new UlidIdGenerator(this.clock);
    this.policyHook = options?.policyHook;
    this.eventBus = options?.eventBus;
    this.logger = options?.logger ?? getLogger('tools.executor');
    this.observer = options?.observer;
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultMaxOutputBytes = options?.defaultMaxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.defaultWorkspaceRoot = options?.defaultWorkspaceRoot;
    this.requirePolicyDecision = options?.requirePolicyDecision ?? false;
  }

  /**
   * Executes a tool invocation under policy governance, timeout bounds, and size limits.
   */
  public async execute<TOutput, TInput>(
    request: ToolExecutionRequest<TInput, TOutput> & { readonly tool: ToolDefinition<TInput, TOutput> },
  ): Promise<ToolExecutionResult<TOutput>>;

  public async execute<TOutput = unknown, TInput = unknown>(
    request: ToolExecutionRequest<TInput, TOutput>,
  ): Promise<ToolExecutionResult<TOutput>>;

  public async execute<TOutput = unknown, TInput = unknown>(
    request: ToolExecutionRequest<TInput, TOutput>,
  ): Promise<ToolExecutionResult<TOutput>> {
    // 1. Resolve Tool
    const tool = this.resolveTool(request);

    // 2. Resolve identifiers
    const callId = this.resolveCallId(request.callId);
    const runId = parseRunId(request.runId);
    const sessionId = request.sessionId ? parseSessionId(request.sessionId) : undefined;
    const agentId = request.agentId ? parseAgentId(request.agentId) : undefined;

    // 3. Validate untrusted arguments
    const validatedInput = validateToolInput(tool, request.input);

    // 4. Derive capabilities
    let capabilities: readonly ToolCapability[] = [];
    if (tool.capabilities) {
      try {
        capabilities = tool.capabilities(validatedInput);
      } catch (err) {
        throw new AirError('INTERNAL', `Failed to derive capabilities for tool "${tool.name}": ${(err as Error).message}`, {
          cause: err instanceof Error ? err : undefined,
          context: { toolName: tool.name },
        });
      }
    }

    // 5. Build Execution Context & Timeout/Abort controllers
    const timeoutMs = request.timeoutMs ?? tool.defaultTimeoutMs ?? this.defaultTimeoutMs;
    const maxOutputBytes = request.maxOutputBytes ?? tool.maxOutputBytes ?? this.defaultMaxOutputBytes;

    if (request.signal?.aborted) {
      throw new AirError('CANCELLED', `Tool "${tool.name}" execution was cancelled prior to start`, {
        context: { toolName: tool.name, callId },
      });
    }

    const abortController = new AbortController();
    let isTimedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        isTimedOut = true;
        abortController.abort('TOOL_TIMEOUT');
      }, timeoutMs);
    }

    const onCallerAbort = (): void => {
      abortController.abort(request.signal?.reason ?? 'CANCELLED');
    };

    if (request.signal) {
      request.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    const execContext: ToolExecutionContext = {
      callId,
      runId,
      sessionId,
      agentId,
      signal: abortController.signal,
      clock: this.clock,
      random: this.random,
      timeoutMs,
      maxOutputBytes,
      workspaceRoot: request.workspaceRoot ?? this.defaultWorkspaceRoot,
    };

    // 6. Policy Evaluation (P5-T08 Choke point: Rule R3, Threat T6)
    let decisionId: string | undefined;

    if (this.policyHook) {
      const decision = await this.policyHook.evaluate({
        tool,
        input: validatedInput,
        capabilities,
        executionContext: execContext,
      });

      // P5-T08: Single choke point runtime assertion: cannot run tool without a valid decisionId
      if (
        !decision ||
        typeof decision.decisionId !== 'string' ||
        decision.decisionId.trim().length === 0
      ) {
        throw new AirError(
          'SECURITY_VIOLATION',
          `Security violation: tool "${tool.name}" cannot execute without a valid policy decision ID`,
          {
            context: {
              toolName: tool.name,
              callId,
              decision,
            },
          },
        );
      }

      if (!decision.allowed) {
        const reason = decision.reason ?? `Policy denied execution of tool "${tool.name}"`;
        throw new AirError('PERMISSION_DENIED', reason, {
          context: {
            toolName: tool.name,
            callId,
            decisionId: decision.decisionId,
            reason,
          },
        });
      }

      decisionId = decision.decisionId;
    } else if (this.requirePolicyDecision) {
      throw new AirError(
        'SECURITY_VIOLATION',
        `Security violation: executor cannot run tool "${tool.name}" without a policy engine (Rule R3)`,
        { context: { toolName: tool.name, callId } },
      );
    }

    // 7. Emit tool.started event & observer notification
    const startTimestamp = this.clock.iso();
    const startMono = this.clock.monotonicMs();

    toolCallsTotalCounter.inc(1, { tool: tool.name, risk: tool.risk });
    this.logger.debug({
      event: 'tool.executing',
      data: {
        callId,
        toolName: tool.name,
        runId,
        risk: tool.risk,
      },
    }, 'Executing tool invocation');

    if (this.observer?.onToolStart) {
      try {
        await this.observer.onToolStart({
          callId,
          runId,
          toolName: tool.name,
          input: validatedInput,
          capabilities,
          timestamp: startTimestamp,
        });
      } catch (obsErr) {
        this.logger.warn(
          { event: 'tool.observer_error', err: obsErr instanceof Error ? obsErr : new Error(String(obsErr)) },
          'Error in onToolStart observer',
        );
      }
    }

    if (this.eventBus) {
      this.eventBus.publish(
        createEnvelope({
          stream: `run:${runId}`,
          seq: 1,
          type: 'tool.started',
          payload: {
            toolCallId: callId,
            name: tool.name,
            idempotent: tool.idempotent,
            decisionId,
          },
          meta: {
            runId,
            sessionId,
            agentId,
            toolCallId: callId,
          },
          clock: this.clock,
          idGenerator: this.idGenerator,
        }),
      );
    }

    // 8. Execute Tool
    let rawOutput: unknown;
    try {
      rawOutput = await tool.execute(validatedInput, execContext);
    } catch (err: unknown) {
      const durationMs = this.clock.monotonicMs() - startMono;
      const normalizedError = this.normalizeError(err, tool.name, callId, isTimedOut, timeoutMs, abortController.signal);

      toolDurationHistogram.observe(durationMs, { tool: tool.name });
      this.logger.warn({
        event: 'tool.failed',
        data: {
          callId,
          toolName: tool.name,
          code: normalizedError.code,
          durationMs,
        },
      }, 'Tool execution failed');

      if (this.observer?.onToolError) {
        try {
          await this.observer.onToolError({
            callId,
            runId,
            toolName: tool.name,
            error: normalizedError,
            durationMs,
            timestamp: this.clock.iso(),
          });
        } catch (obsErr) {
          this.logger.warn(
            { event: 'tool.observer_error', err: obsErr instanceof Error ? obsErr : new Error(String(obsErr)) },
            'Error in onToolError observer',
          );
        }
      }

      this.publishFailureEvent(runId, sessionId, agentId, callId, normalizedError, isTimedOut, timeoutMs);
      throw normalizedError;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (request.signal) {
        request.signal.removeEventListener('abort', onCallerAbort);
      }
    }

    // 9. Output Validation
    const durationMs = this.clock.monotonicMs() - startMono;
    toolDurationHistogram.observe(durationMs, { tool: tool.name });

    if (tool.outputSchema) {
      rawOutput = validateToolOutput(tool, rawOutput);
    }

    // 10. Output Truncation
    const { output: finalOutput, truncated } = truncateOutput(rawOutput, maxOutputBytes);

    // 11. Emit tool.completed event & observer notification
    if (this.observer?.onToolSuccess) {
      try {
        await this.observer.onToolSuccess({
          callId,
          runId,
          toolName: tool.name,
          output: finalOutput,
          truncated,
          durationMs,
          timestamp: this.clock.iso(),
        });
      } catch (obsErr) {
        this.logger.warn(
          { event: 'tool.observer_error', err: obsErr instanceof Error ? obsErr : new Error(String(obsErr)) },
          'Error in onToolSuccess observer',
        );
      }
    }

    if (this.eventBus) {
      this.eventBus.publish(
        createEnvelope({
          stream: `run:${runId}`,
          seq: 1,
          type: 'tool.completed',
          payload: {
            toolCallId: callId,
            output: finalOutput,
            durationMs,
          },
          meta: {
            runId,
            sessionId,
            agentId,
            toolCallId: callId,
          },
          clock: this.clock,
          idGenerator: this.idGenerator,
        }),
      );
    }

    return {
      callId,
      toolName: tool.name,
      output: finalOutput as TOutput,
      truncated,
      durationMs,
      capabilities,
      decisionId,
      meta: request.contextMeta,
    };
  }

  private resolveTool(request: { tool?: unknown; toolName?: string | undefined }): AnyTool {
    if (request.tool) {
      return toAnyTool(request.tool as ToolDefinition<unknown, unknown>);
    }

    if (request.toolName) {
      if (!this.registry) {
        throw new AirError('NOT_FOUND', `Cannot resolve tool "${request.toolName}": no ToolRegistry configured`, {
          context: { toolName: request.toolName },
        });
      }
      return this.registry.getOrThrow(request.toolName);
    }

    throw new AirError('INVALID_ARGUMENT', 'Tool execution request must specify either "tool" or "toolName"');
  }

  private resolveCallId(callId?: ToolCallId | string): ToolCallId {
    if (callId) {
      return parseToolCallId(String(callId));
    }
    return this.idGenerator.nextToolCallId();
  }

  private normalizeError(
    err: unknown,
    toolName: string,
    callId: ToolCallId,
    isTimedOut: boolean,
    timeoutMs: number,
    signal: AbortSignal,
  ): AirError {
    if (isTimedOut || signal.reason === 'TOOL_TIMEOUT') {
      return new AirError('TOOL_TIMEOUT', `Tool "${toolName}" timed out after ${timeoutMs}ms`, {
        context: { toolName, callId, timeoutMs },
      });
    }

    if (signal.aborted) {
      return new AirError('CANCELLED', `Tool "${toolName}" execution was cancelled`, {
        cause: err instanceof Error ? err : undefined,
        context: { toolName, callId },
      });
    }

    if (err instanceof AirError) {
      return err;
    }

    if (err instanceof Error) {
      return new AirError('INTERNAL', `Tool "${toolName}" failed: ${err.message}`, {
        cause: err,
        context: { toolName, callId },
      });
    }

    return new AirError('INTERNAL', `Tool "${toolName}" failed with unknown error`, {
      context: { toolName, callId, rawError: String(err) },
    });
  }

  private publishFailureEvent(
    runId: string,
    sessionId: string | undefined,
    agentId: string | undefined,
    callId: ToolCallId,
    error: AirError,
    isTimedOut: boolean,
    timeoutMs: number,
  ): void {
    if (!this.eventBus) return;

    if (isTimedOut || error.code === 'TOOL_TIMEOUT') {
      this.eventBus.publish(
        createEnvelope({
          stream: `run:${runId}`,
          seq: 1,
          type: 'tool.timed_out',
          payload: {
            toolCallId: callId,
            timeoutMs,
          },
          meta: { runId: parseRunId(runId), sessionId: sessionId ? parseSessionId(sessionId) : undefined, agentId: agentId ? parseAgentId(agentId) : undefined, toolCallId: callId },
          clock: this.clock,
          idGenerator: this.idGenerator,
        }),
      );
      return;
    }

    if (error.code === 'CANCELLED') {
      this.eventBus.publish(
        createEnvelope({
          stream: `run:${runId}`,
          seq: 1,
          type: 'tool.cancelled',
          payload: {
            toolCallId: callId,
            reason: error.message,
          },
          meta: { runId: parseRunId(runId), sessionId: sessionId ? parseSessionId(sessionId) : undefined, agentId: agentId ? parseAgentId(agentId) : undefined, toolCallId: callId },
          clock: this.clock,
          idGenerator: this.idGenerator,
        }),
      );
      return;
    }

    this.eventBus.publish(
      createEnvelope({
        stream: `run:${runId}`,
        seq: 1,
        type: 'tool.failed',
        payload: {
          toolCallId: callId,
          error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
          },
        },
        meta: { runId: parseRunId(runId), sessionId: sessionId ? parseSessionId(sessionId) : undefined, agentId: agentId ? parseAgentId(agentId) : undefined, toolCallId: callId },
        clock: this.clock,
        idGenerator: this.idGenerator,
      }),
    );
  }
}
