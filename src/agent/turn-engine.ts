/**
 * Agent Turn Engine (Phase 6 - P6-T03).
 *
 * Implements the core execution turn of the AIR agent loop:
 * 1. Budget pre-check (steps, tokens, cost, wall-clock time)
 * 2. Context assembly (system prompt, rendered variables, compaction if needed)
 * 3. Provider streaming call (journaled model.requested / model.responded, usage accounting)
 * 4. Tool call extraction and validation
 * 5. Policy evaluation and approval broker interception (Rule R3 choke-point assertion)
 * 6. Parallel tool execution via ToolScheduler (P6-T04) with concurrency limits
 * 7. Untrusted output fencing (fenceOutput) and taint propagation (Rule S9, Threat T5)
 * 8. Stall and loop detection (P6-T07)
 * 9. Turn event lifecycle logging (turn.started, turn.completed, turn.failed)
 *
 * Adheres to:
 * - Rule R3: Every tool call through policy engine with valid decisionId
 * - Rule R6: Injected Clock and IdGenerator
 * - Rule R7: Strict TypeScript, no any
 * - Rule R8: Journal event emission for every transition and milestone
 * - Rule R11: Typed AirError errors
 * - Rule R12: All model and tool outputs validated with Zod
 */

import { AirError } from '../errors/index.js';
import { createEnvelope, type EventBus } from '../journal/index.js';
import type { ComponentLogger } from '../observability/index.js';
import {
  ApprovalBroker,
  BudgetTracker,
  fenceOutput,
  type PolicyEngine,
  TaintTracker,
  type PolicyDecision,
} from '../policy/index.js';
import {
  assembleStreamResponse,
  extractText,
  extractToolCalls,
  type NormalizedMessage,
  type NormalizedResponse,
  type Provider,
  type ProviderToolDefinition,
  type ToolResultPart,
} from '../providers/index.js';
import {
  toProviderToolDefinition,
  ToolExecutor,
  type ToolPolicyDecision,
  type ToolPolicyEvaluationContext,
  type ToolPolicyHook,
  type ToolRegistry,
} from '../tools/index.js';
import {
  isValidId,
  parseRunId,
  type RunId,
  type ToolCallId,
} from '../types/index.js';
import {
  type Clock,
  type IdGenerator,
  SystemClock,
  UlidIdGenerator,
} from '../util/index.js';
import { ContextManager } from './context.js';
import { StallDetector, type ToolCallSnapshot } from './detector.js';
import type { AgentManifest } from './manifest.js';
import {
  scheduleToolExecution,
  type ScheduledToolCall,
} from './scheduler.js';

// ============================================================================
// 1. Interfaces & Types
// ============================================================================

export interface TurnToolResult {
  readonly toolCallId: ToolCallId | string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly success: boolean;
  readonly output?: unknown;
  readonly error?: { readonly code: string; readonly message: string } | undefined;
  readonly durationMs: number;
  readonly decisionId?: string | undefined;
}

export type TurnStatus =
  | 'continue'
  | 'complete'
  | 'waiting_approval'
  | 'waiting_user'
  | 'budget_exceeded'
  | 'stalled'
  | 'error';

export interface TurnExecutionResult {
  readonly turnIndex: number;
  readonly status: TurnStatus;
  readonly assistantMessage?: NormalizedMessage | undefined;
  readonly text?: string | undefined;
  readonly toolCallsExecuted?: number | undefined;
  readonly toolResults?: readonly TurnToolResult[] | undefined;
  readonly reason?: string | undefined;
  readonly error?: AirError | undefined;
}

export interface TurnEngineOptions {
  readonly manifest: AgentManifest;
  readonly runId: RunId | string;
  readonly provider: Provider;
  readonly toolRegistry: ToolRegistry;
  readonly policyEngine: PolicyEngine;
  readonly toolExecutor?: ToolExecutor | undefined;
  readonly approvalBroker?: ApprovalBroker | undefined;
  readonly budgetTracker?: BudgetTracker | undefined;
  readonly taintTracker?: TaintTracker | undefined;
  readonly stallDetector?: StallDetector | undefined;
  readonly contextManager?: ContextManager | undefined;
  readonly eventBus?: EventBus | undefined;
  readonly logger?: ComponentLogger | undefined;
  readonly clock?: Clock | undefined;
  readonly idGenerator?: IdGenerator | undefined;
  readonly headless?: boolean | undefined;
  readonly workspaceRoot?: string | undefined;
}

/**
 * Creates a standard ToolPolicyHook bridging PolicyEngine and ApprovalBroker to ToolExecutor.
 */
export function createTurnEnginePolicyHook(
  policyEngine: PolicyEngine,
  approvalBroker: ApprovalBroker,
  taintTracker: TaintTracker,
  agentId: string,
): ToolPolicyHook {
  return {
    async evaluate(context: ToolPolicyEvaluationContext): Promise<ToolPolicyDecision> {
      const toolName = context.tool.name;
      const isTainted = taintTracker.isTainted(context.executionContext.runId);
      const decision = policyEngine.evaluate({
        agentId,
        runId: context.executionContext.runId,
        callId: context.executionContext.callId,
        toolName,
        input: context.input ?? {},
        capabilities: context.capabilities,
        tainted: isTainted,
      });

      if (decision.effect === 'deny') {
        return {
          allowed: false,
          decisionId: decision.decisionId,
          reason: decision.reason,
        };
      }

      if (decision.effect === 'ask_user') {
        if (
          approvalBroker.checkCachedApproval({
            runId: context.executionContext.runId,
            toolName,
            capabilities: context.capabilities,
          })
        ) {
          return {
            allowed: true,
            decisionId: decision.decisionId,
            reason: decision.reason,
          };
        }

        const approvalRes = await approvalBroker.requestApproval({
          runId: context.executionContext.runId,
          toolCallId: context.executionContext.callId,
          toolName,
          input: context.input,
          riskLevel: context.tool.risk,
          prompt: decision.reason,
        });

        if (!approvalRes.approved) {
          return {
            allowed: false,
            decisionId: decision.decisionId,
            reason: approvalRes.reason ?? 'Approval denied',
          };
        }

        return {
          allowed: true,
          decisionId: decision.decisionId,
          reason: decision.reason,
        };
      }

      return {
        allowed: true,
        decisionId: decision.decisionId,
        reason: decision.reason,
      };
    },
  };
}

// ============================================================================
// 2. TurnEngine Class
// ============================================================================

export class TurnEngine {
  private readonly manifest: AgentManifest;
  private readonly runId: RunId;
  private readonly provider: Provider;
  private readonly toolRegistry: ToolRegistry;
  private readonly toolExecutor: ToolExecutor;
  private readonly policyEngine: PolicyEngine;
  private readonly approvalBroker: ApprovalBroker;
  private readonly budgetTracker: BudgetTracker;
  private readonly taintTracker: TaintTracker;
  private readonly stallDetector: StallDetector;
  private readonly contextManager: ContextManager;
  private readonly eventBus?: EventBus | undefined;
  private readonly logger?: ComponentLogger | undefined;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly headless: boolean;
  private readonly workspaceRoot?: string | undefined;

  private seq = 1;

  public constructor(options: TurnEngineOptions) {
    this.manifest = options.manifest;
    this.runId = parseRunId(options.runId);
    this.provider = options.provider;
    this.toolRegistry = options.toolRegistry;
    this.policyEngine = options.policyEngine;
    this.clock = options.clock ?? new SystemClock();
    this.idGenerator = options.idGenerator ?? new UlidIdGenerator(this.clock);
    this.eventBus = options.eventBus;
    this.logger = options.logger;
    this.headless = options.headless ?? false;
    this.workspaceRoot = options.workspaceRoot;

    this.approvalBroker = options.approvalBroker ?? new ApprovalBroker({
      clock: this.clock,
      idGenerator: this.idGenerator,
      eventBus: this.eventBus,
      headless: this.headless,
    });

    this.taintTracker = options.taintTracker ?? new TaintTracker({
      clock: this.clock,
      idGenerator: this.idGenerator,
    });

    this.budgetTracker = options.budgetTracker ?? new BudgetTracker({
      clock: this.clock,
      eventBus: this.eventBus,
      throwOnExceeded: false,
    });

    if (!this.budgetTracker.hasBudget(this.runId)) {
      this.budgetTracker.createBudget(this.runId, {
        agentId: this.manifest.id,
        limits: {
          maxSteps: this.manifest.budgets?.maxSteps,
          maxTokens: this.manifest.budgets?.maxTokens,
          maxUsd: this.manifest.budgets?.maxCostUsd,
          maxWallClockMs: this.manifest.budgets?.maxWallClockSeconds
            ? this.manifest.budgets.maxWallClockSeconds * 1000
            : undefined,
        },
      });
    }

    this.stallDetector = options.stallDetector ?? new StallDetector();

    this.contextManager = options.contextManager ?? new ContextManager({
      runId: this.runId,
      maxContextTokens: this.manifest.maxContextTokens,
      clock: this.clock,
      idGenerator: this.idGenerator,
      eventBus: this.eventBus,
    });

    if (!this.contextManager.getSystemPrompt()) {
      this.contextManager.setSystemPrompt(this.manifest.systemPrompt);
    }

    this.toolExecutor = options.toolExecutor ?? new ToolExecutor({
      registry: this.toolRegistry,
      clock: this.clock,
      idGenerator: this.idGenerator,
      eventBus: this.eventBus,
      logger: this.logger,
      defaultWorkspaceRoot: this.workspaceRoot,
      requirePolicyDecision: true,
      policyHook: createTurnEnginePolicyHook(
        this.policyEngine,
        this.approvalBroker,
        this.taintTracker,
        this.manifest.id,
      ),
    });
  }

  public getContextManager(): ContextManager {
    return this.contextManager;
  }

  public getBudgetTracker(): BudgetTracker {
    return this.budgetTracker;
  }

  public getTaintTracker(): TaintTracker {
    return this.taintTracker;
  }

  /**
   * Executes a single turn of the agent lifecycle.
   */
  public async executeTurn(
    turnIndex: number,
    signal?: AbortSignal,
  ): Promise<TurnExecutionResult> {
    const activeSignal = signal ?? new AbortController().signal;

    // 1. Emit turn.started
    this.emitEvent('turn.started', { turnIndex });

    try {
      // 2. Budget pre-checks
      const stepPrecheck = this.budgetTracker.preCheckStep(this.runId);
      if (!stepPrecheck.allowed) {
        return {
          turnIndex,
          status: 'budget_exceeded',
          reason: `Step count limit / budget exceeded: ${stepPrecheck.exceeded?.message ?? ''}`,
        };
      }

      // 3. Assemble context & tools
      const toolDefs = this.getBoundToolDefinitions();
      const request = this.contextManager.assembleRequest(this.manifest, toolDefs);

      // Pre-check tokens
      const estimatedTokens = this.contextManager.getEstimatedTokens();
      const tokenPrecheck = this.budgetTracker.preCheckModelCall(this.runId, {
        tokens: estimatedTokens,
      });
      if (!tokenPrecheck.allowed) {
        return {
          turnIndex,
          status: 'budget_exceeded',
          reason: `Token limit / budget exceeded: ${tokenPrecheck.exceeded?.message ?? ''}`,
        };
      }

      // 4. Provider invocation (streaming with assembly)
      this.emitEvent('model.requested', {
        model: request.model,
        promptTokens: estimatedTokens,
        temperature: request.temperature,
      });

      const startTime = this.clock.now().getTime();
      let response: NormalizedResponse;

      try {
        const stream = this.provider.stream(request, { signal: activeSignal });
        response = await assembleStreamResponse(stream);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.emitEvent('model.failed', {
          model: request.model,
          error: errorMsg,
          retryable: false,
        });
        throw err;
      }

      const durationMs = Math.max(0, this.clock.now().getTime() - startTime);

      // Record model response & accounting
      this.emitEvent('model.responded', {
        model: response.model,
        completionTokens: response.usage.completionTokens,
        stopReason: response.stopReason,
        durationMs,
      });

      this.budgetTracker.recordTokens(this.runId, {
        input: response.usage.promptTokens,
        output: response.usage.completionTokens,
        total: response.usage.totalTokens,
        cacheRead: response.usage.cacheReadTokens,
        cacheWrite: response.usage.cacheWriteTokens,
      });

      this.budgetTracker.recordStep(this.runId, 1);

      // 5. Append assistant message to context
      this.contextManager.addMessage(response.message);

      // 6. Extract tool calls
      const toolCalls = extractToolCalls(response.message);

      // If no tool calls, turn completes with assistant text
      if (toolCalls.length === 0) {
        const text = extractText(response.message);
        this.emitEvent('turn.completed', {
          turnIndex,
          toolCallsCount: 0,
        });

        return {
          turnIndex,
          status: 'complete',
          assistantMessage: response.message,
          text,
          toolCallsExecuted: 0,
        };
      }

      // 7. Execute tool calls via ToolScheduler & Policy Choke-Point
      const scheduledCalls: ScheduledToolCall[] = toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: typeof tc.arguments === 'string'
          ? (this.safeParseJson(tc.arguments) ?? {})
          : tc.arguments,
      }));

      const toolResults = await this.executeToolCalls(scheduledCalls, activeSignal);

      // 8. Construct tool results message and append to context
      const toolResultParts: ToolResultPart[] = toolResults.map((tr) => {
        const isError = !tr.success;
        const rawContent = isError
          ? (tr.error?.message ?? 'Tool execution failed')
          : (typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output));

        // Rule S9 / Threat T5: Untrusted output fencing
        const fenced = fenceOutput(rawContent, {
          toolName: tr.name,
          sourceType: 'tool_output',
          taintLevel: 'tainted',
        });

        // Record output in taint tracker
        this.taintTracker.inspectAndTagToolOutput(this.runId, tr.name, tr.output);

        return {
          type: 'tool_result',
          toolCallId: String(tr.toolCallId),
          content: fenced,
          isError,
        };
      });

      this.contextManager.addMessage({
        role: 'tool',
        content: toolResultParts,
      });

      // 9. Stall & loop evaluation
      const snapshots: ToolCallSnapshot[] = toolResults.map((tr) => ({
        name: tr.name,
        arguments: tr.arguments,
        output: tr.output,
        error: tr.error,
      }));

      const stallResult = this.stallDetector.recordTurn(turnIndex, snapshots);
      if (stallResult.isStalled) {
        this.emitEvent('turn.completed', {
          turnIndex,
          toolCallsCount: toolResults.length,
        });

        return {
          turnIndex,
          status: 'stalled',
          reason: stallResult.reason,
          toolCallsExecuted: toolResults.length,
          toolResults,
        };
      }

      // Check if any tool called was interactive waiting for user
      const waitingUserResult = toolResults.find((r) => r.name === 'user.ask');
      const nextStatus: TurnStatus = waitingUserResult ? 'waiting_user' : 'continue';

      this.emitEvent('turn.completed', {
        turnIndex,
        toolCallsCount: toolResults.length,
      });

      return {
        turnIndex,
        status: nextStatus,
        assistantMessage: response.message,
        toolCallsExecuted: toolResults.length,
        toolResults,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emitEvent('turn.failed', {
        turnIndex,
        error: errorMsg,
      });

      if (err instanceof AirError) {
        if (err.code === 'RUN_BUDGET_EXCEEDED') {
          return {
            turnIndex,
            status: 'budget_exceeded',
            error: err,
            reason: err.message,
          };
        }

        return {
          turnIndex,
          status: 'error',
          error: err,
          reason: err.message,
        };
      }

      return {
        turnIndex,
        status: 'error',
        error: new AirError('INTERNAL', errorMsg, { cause: err instanceof Error ? err : undefined }),
        reason: errorMsg,
      };
    }
  }

  /**
   * Executes scheduled tool calls through policy validation, approvals, and ToolExecutor.
   */
  private async executeToolCalls(
    calls: readonly ScheduledToolCall[],
    signal: AbortSignal,
  ): Promise<TurnToolResult[]> {
    const scheduledResults = await scheduleToolExecution(
      calls,
      async (call, callSignal) => {
        try {
          const rawId = call.id;
          const toolCallId: ToolCallId = isValidId(rawId)
            ? (rawId as ToolCallId)
            : this.idGenerator.nextToolCallId();
          const toolName = call.name;
          const args = call.arguments ?? {};

          this.emitEvent('tool.requested', {
            toolCallId,
            name: toolName,
            arguments: args,
          });

          // 1. Tool existence check
          const tool = this.toolRegistry.get(toolName);
          if (!tool) {
            return {
              success: false,
              error: {
                code: 'TOOL_NOT_FOUND',
                message: `Tool "${toolName}" is not registered in runtime registry`,
              },
            };
          }

          // 2. Policy evaluation (Rule R3 single choke-point)
          const isTainted = this.taintTracker.isTainted(this.runId);
          const capabilities = tool.capabilities ? tool.capabilities(args) : [];

          const decision: PolicyDecision = this.policyEngine.evaluate({
            agentId: this.manifest.id,
            runId: this.runId,
            callId: toolCallId,
            toolName,
            input: args,
            capabilities,
            tainted: isTainted,
          });

          this.emitEvent('tool.policy_decided', {
            toolCallId,
            decision: decision.effect === 'ask_user' ? 'ask' : decision.effect,
            ruleId: decision.ruleId,
            reason: decision.reason,
          });

          // 3. Handle policy denial
          if (decision.effect === 'deny') {
            this.emitEvent('tool.denied', {
              toolCallId,
              reason: decision.reason,
            });

            return {
              success: false,
              output: { decisionId: decision.decisionId },
              error: {
                code: 'POLICY_DENIED',
                message: `Policy denied execution: ${decision.reason}`,
              },
            };
          }

          // 4. Handle ask_user approval
          let effectiveDecisionId = decision.decisionId;
          if (decision.effect === 'ask_user') {
            this.emitEvent('tool.approval_requested', {
              toolCallId,
              riskLevel: tool.risk,
              prompt: `Approval requested for ${toolName}: ${decision.reason}`,
            });

            const approvalRes = await this.approvalBroker.requestApproval({
              runId: this.runId,
              toolCallId,
              toolName,
              input: args,
              riskLevel: tool.risk,
              scope: 'run',
              prompt: decision.reason,
            });

            if (!approvalRes.approved) {
              this.emitEvent('tool.denied', {
                toolCallId,
                reason: approvalRes.reason ?? 'User denied execution',
              });

              return {
                success: false,
                output: { decisionId: decision.decisionId },
                error: {
                  code: 'APPROVAL_DENIED',
                  message: approvalRes.reason ?? 'Approval was denied',
                },
              };
            }

            this.emitEvent('tool.approved', {
              toolCallId,
              operator: approvalRes.record.resolvedBy,
            });

            effectiveDecisionId = decision.decisionId;
          }

          // 5. Tool pre-check budget
          const toolPrecheck = this.budgetTracker.preCheckToolCall(this.runId, toolName);
          if (!toolPrecheck.allowed) {
            return {
              success: false,
              output: { decisionId: effectiveDecisionId },
              error: {
                code: 'RESOURCE_EXHAUSTED',
                message: toolPrecheck.exceeded?.message ?? 'Tool budget exceeded',
              },
            };
          }

          // 6. Tool execution via ToolExecutor (pass precomputed decisionId to avoid re-evaluation)
          try {
            const execRes = await this.toolExecutor.execute({
              tool,
              input: args,
              callId: toolCallId,
              runId: this.runId,
              agentId: this.manifest.id,
              workspaceRoot: this.workspaceRoot,
              signal: callSignal,
              precomputedDecisionId: effectiveDecisionId,
            });

            this.budgetTracker.recordToolCall(this.runId, toolName);

            return {
              success: true,
              output: execRes.output,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const code = (err as AirError).code ?? 'TOOL_EXECUTION_FAILED';
            return {
              success: false,
              error: { code, message: msg },
            };
          }
        } catch (unhandledErr) {
          const msg = unhandledErr instanceof Error ? unhandledErr.message : String(unhandledErr);
          const code = (unhandledErr as AirError).code ?? 'INTERNAL';
          return {
            success: false,
            error: { code, message: msg },
          };
        }
      },
      {
        maxParallel: this.manifest.maxParallelTools,
        signal,
      },
    );

    return scheduledResults.map((r) => {
      const call = calls.find((c) => String(c.id) === String(r.toolCallId));
      return {
        toolCallId: r.toolCallId,
        name: r.name,
        arguments: (call?.arguments as Record<string, unknown>) ?? {},
        success: r.success,
        output: r.output,
        error: r.error,
        durationMs: r.durationMs,
      };
    });
  }

  private getBoundToolDefinitions(): ProviderToolDefinition[] {
    const boundPatterns = this.manifest.tools;
    const allTools = this.toolRegistry.list();

    return allTools
      .filter((tool) => {
        return boundPatterns.some((pattern) => {
          if (pattern === '*') return true;
          if (pattern.endsWith('*')) return tool.name.startsWith(pattern.slice(0, -1));
          return tool.name === pattern;
        });
      })
      .map((tool) => toProviderToolDefinition(tool));
  }

  private safeParseJson(raw: string): Record<string, unknown> | undefined {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private emitEvent(type: string, payload: Record<string, unknown>): void {
    if (!this.eventBus) return;

    try {
      this.eventBus.publish(
        createEnvelope({
          stream: `run:${this.runId}`,
          seq: this.seq++,
          type,
          payload,
          meta: { runId: this.runId },
          clock: this.clock,
          idGenerator: this.idGenerator,
        }),
      );
    } catch {
      // Non-fatal event emission
    }
  }
}
