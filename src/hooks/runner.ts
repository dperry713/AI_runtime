/**
 * Hook Runner (Phase 10 - P10-T03).
 *
 * Coordinates hook execution with timeout bounds, error isolation, priority execution,
 * and strict policy non-weakening enforcement.
 */

import { AirError } from '../errors/index.js';
import { getLogger, type ComponentLogger } from '../observability/index.js';
import type { ToolExecutionObserver } from '../tools/index.js';
import { SystemClock, type Clock } from '../util/index.js';
import type { HookRegistry } from './registry.js';
import type {
  HookDecision,
  HookDefinition,
  HookExecutionRecord,
  OnEventHookContext,
  PostModelHookContext,
  PostToolHookContext,
  PreModelHookContext,
  PreToolHookContext,
  RunHookContext,
  SessionHookContext,
} from './types.js';

export interface HookRunnerOptions {
  readonly clock?: Clock | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly logger?: ComponentLogger | undefined;
}

export interface PreToolResult {
  readonly input: unknown;
  readonly records: readonly HookExecutionRecord[];
}

export interface PreModelResult {
  readonly messages: readonly unknown[];
  readonly records: readonly HookExecutionRecord[];
}

export class HookRunner {
  private readonly registry: HookRegistry;
  private readonly clock: Clock;
  private readonly defaultTimeoutMs: number;
  private readonly logger: ComponentLogger;

  constructor(registry: HookRegistry, options: HookRunnerOptions = {}) {
    this.registry = registry;
    this.clock = options.clock ?? new SystemClock();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
    this.logger = options.logger ?? getLogger('hooks');
  }

  /**
   * Asserts that a hook execution does not attempt to weaken a policy denial.
   * If policy denied an action, a hook cannot permit it.
   */
  assertCannotWeakenPolicy(policyAllowed: boolean, hookDecision?: HookDecision): void {
    if (!policyAllowed && hookDecision?.allowed === true) {
      throw new AirError(
        'SECURITY_VIOLATION',
        'Inadmissible hook decision: hook cannot weaken policy denial',
        { context: { hookDecision } },
      );
    }
  }

  /**
   * Executes a single hook with timeout and sandboxed error boundary.
   */
  private async runSingleHook<TContext extends object>(
    hook: HookDefinition<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
    context: TContext,
  ): Promise<{ decision: HookDecision | undefined; record: HookExecutionRecord }> {
    const timeoutMs = hook.timeoutMs ?? this.defaultTimeoutMs;
    const failureMode = hook.failureMode ?? 'fail-closed';
    const startTime = this.clock.now().getTime();
    const abortController = new AbortController();

    const timer = setTimeout(() => {
      abortController.abort(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const result = await Promise.race([
        Promise.resolve(hook.handler(context, abortController.signal)),
        new Promise<never>((_, reject) => {
          abortController.signal.addEventListener('abort', () => {
            reject(new AirError('HOOK_TIMED_OUT', `Hook "${hook.id}" timed out after ${timeoutMs}ms`));
          });
        }),
      ]);

      const durationMs = this.clock.now().getTime() - startTime;
      const decision = typeof result === 'object' && result !== null ? result : undefined;

      if (decision?.allowed === false) {
        return {
          decision,
          record: {
            hookId: hook.id,
            kind: hook.kind,
            status: 'vetoed',
            durationMs,
            reason: decision.reason,
          },
        };
      }

      return {
        decision,
        record: {
          hookId: hook.id,
          kind: hook.kind,
          status: 'success',
          durationMs,
        },
      };
    } catch (err) {
      const durationMs = this.clock.now().getTime() - startTime;
      const isTimeout =
        (err instanceof AirError && err.code === 'HOOK_TIMED_OUT') || abortController.signal.aborted;
      const status = isTimeout ? 'timed_out' : 'failed';
      const errMsg = err instanceof Error ? err.message : String(err);

      if (failureMode === 'fail-open') {
        this.logger.warn({ event: 'hook.failure', hookId: hook.id, error: errMsg }, `Hook "${hook.id}" ${status} (fail-open)`);
        return {
          decision: undefined,
          record: {
            hookId: hook.id,
            kind: hook.kind,
            status,
            durationMs,
            error: errMsg,
          },
        };
      }

      // Fail-closed throws
      if (isTimeout) {
        throw new AirError('HOOK_TIMED_OUT', `Hook "${hook.id}" timed out after ${timeoutMs}ms`, {
          cause: err instanceof Error ? err : undefined,
          context: { hookId: hook.id, timeoutMs },
        });
      }

      throw new AirError('HOOK_FAILED', `Hook "${hook.id}" failed: ${errMsg}`, {
        cause: err instanceof Error ? err : undefined,
        context: { hookId: hook.id },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Executes pre-tool hooks in priority order.
   * Can veto execution or modify input.
   */
  async executePreTool(context: PreToolHookContext): Promise<PreToolResult> {
    const hooks = this.registry.getMatchingHooks('pre-tool', {
      toolName: context.toolName,
      agentId: context.agentId,
    });

    let currentInput = context.input;
    const records: HookExecutionRecord[] = [];

    for (const hook of hooks) {
      const hookCtx: PreToolHookContext = {
        ...context,
        input: currentInput,
      };

      const { decision, record } = await this.runSingleHook(hook, hookCtx);
      records.push(record);

      if (decision?.allowed === false) {
        throw new AirError('HOOK_DENIED', decision.reason ?? `Tool call vetoed by hook "${hook.id}"`, {
          context: { hookId: hook.id, toolName: context.toolName },
        });
      }

      if (decision?.modifiedInput !== undefined) {
        currentInput = decision.modifiedInput;
      }
    }

    return { input: currentInput, records };
  }

  /**
   * Executes post-tool hooks in priority order.
   */
  async executePostTool(context: PostToolHookContext): Promise<readonly HookExecutionRecord[]> {
    const hooks = this.registry.getMatchingHooks('post-tool', {
      toolName: context.toolName,
      agentId: context.agentId,
    });

    const records: HookExecutionRecord[] = [];

    for (const hook of hooks) {
      const { record } = await this.runSingleHook(hook, context);
      records.push(record);
    }

    return records;
  }

  /**
   * Executes on-event hooks in priority order.
   */
  async executeOnEvent(context: OnEventHookContext): Promise<readonly HookExecutionRecord[]> {
    const hooks = this.registry.getMatchingHooks('on-event', {
      eventType: context.event.type,
      agentId: context.agentId,
    });

    const records: HookExecutionRecord[] = [];

    for (const hook of hooks) {
      const { record } = await this.runSingleHook(hook, context);
      records.push(record);
    }

    return records;
  }

  /**
   * Executes pre-model hooks in priority order.
   */
  async executePreModel(context: PreModelHookContext): Promise<PreModelResult> {
    const hooks = this.registry.getMatchingHooks('pre-model', {
      agentId: context.agentId,
    });

    let currentMessages = context.messages;
    const records: HookExecutionRecord[] = [];

    for (const hook of hooks) {
      const hookCtx: PreModelHookContext = {
        ...context,
        messages: currentMessages,
      };

      const { decision, record } = await this.runSingleHook(hook, hookCtx);
      records.push(record);

      if (decision?.allowed === false) {
        throw new AirError('HOOK_DENIED', decision.reason ?? `Model call vetoed by hook "${hook.id}"`, {
          context: { hookId: hook.id, model: context.model },
        });
      }

      if (decision?.modifiedInput !== undefined && Array.isArray(decision.modifiedInput)) {
        currentMessages = decision.modifiedInput as readonly unknown[];
      }
    }

    return { messages: currentMessages, records };
  }

  /**
   * Executes post-model hooks in priority order.
   */
  async executePostModel(context: PostModelHookContext): Promise<readonly HookExecutionRecord[]> {
    const hooks = this.registry.getMatchingHooks('post-model', {
      agentId: context.agentId,
    });

    const records: HookExecutionRecord[] = [];

    for (const hook of hooks) {
      const { record } = await this.runSingleHook(hook, context);
      records.push(record);
    }

    return records;
  }

  /**
   * Executes session start or session end hooks.
   */
  async executeSession(
    context: SessionHookContext,
    kind: 'session-start' | 'session-end',
  ): Promise<readonly HookExecutionRecord[]> {
    const hooks = this.registry.getMatchingHooks(kind, {
      agentId: context.agentId,
    });

    const records: HookExecutionRecord[] = [];

    for (const hook of hooks) {
      const { record } = await this.runSingleHook(hook, context);
      records.push(record);
    }

    return records;
  }

  /**
   * Executes run start or run end hooks.
   */
  async executeRun(
    context: RunHookContext,
    kind: 'run-start' | 'run-end',
  ): Promise<readonly HookExecutionRecord[]> {
    const hooks = this.registry.getMatchingHooks(kind, {
      agentId: context.agentId,
    });

    const records: HookExecutionRecord[] = [];

    for (const hook of hooks) {
      const { record } = await this.runSingleHook(hook, context);
      records.push(record);
    }

    return records;
  }

  /**
   * Creates an observer adapter that plugs directly into ToolExecutor.
   */
  toToolExecutionObserver(): ToolExecutionObserver {
    return {
      onToolStart: (event) => {
        // Fire-and-forget background execution or handled async
        void this.executePreTool({
          callId: event.callId,
          runId: event.runId,
          toolName: event.toolName,
          input: event.input,
          capabilities: event.capabilities,
          timestamp: event.timestamp,
        });
      },
      onToolSuccess: (event) => {
        void this.executePostTool({
          callId: event.callId,
          runId: event.runId,
          toolName: event.toolName,
          input: {},
          output: event.output,
          truncated: event.truncated,
          durationMs: event.durationMs,
          timestamp: event.timestamp,
        });
      },
      onToolError: (event) => {
        void this.executePostTool({
          callId: event.callId,
          runId: event.runId,
          toolName: event.toolName,
          input: {},
          error: event.error,
          truncated: false,
          durationMs: event.durationMs,
          timestamp: event.timestamp,
        });
      },
    };
  }
}
