/**
 * Parallel Tool Scheduler (Phase 6 - P6-T04).
 *
 * Implements concurrent tool scheduling with:
 * - Configurable concurrency limits (maxParallelTools)
 * - Explicit dependency resolution (DAG execution order via dependsOn)
 * - Deterministic, ordered result delivery matching input order
 * - AbortSignal propagation for graceful cooperative cancellation
 * - Safe error handling: failing dependencies skip or fail dependent tool calls
 *
 * Adheres to:
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 */

import { AirError } from '../errors/index.js';
import type { ToolCallId } from '../types/index.js';
import { type Clock, SystemClock } from '../util/index.js';

export interface ScheduledToolCall<TArgs = Record<string, unknown>> {
  readonly id: ToolCallId | string;
  readonly name: string;
  readonly arguments: TArgs;
  /** IDs of other tool calls in this batch that must complete before this one starts */
  readonly dependsOn?: readonly (ToolCallId | string)[] | undefined;
}

export interface ScheduledToolResult<TOutput = unknown> {
  readonly toolCallId: ToolCallId | string;
  readonly name: string;
  readonly success: boolean;
  readonly output?: TOutput | undefined;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean | undefined;
  } | undefined;
  readonly durationMs: number;
}

export type ToolExecutionHandler<TArgs = Record<string, unknown>, TOutput = unknown> = (
  call: ScheduledToolCall<TArgs>,
  signal: AbortSignal,
) => Promise<{
  success: boolean;
  output?: TOutput | undefined;
  error?: { code: string; message: string; retryable?: boolean | undefined } | undefined;
}>;

export interface ToolSchedulerOptions {
  /** Maximum number of concurrent tool executions. Default: 4. */
  readonly maxParallel?: number | undefined;
  /** Injected clock for timing measurements (Rule R6). */
  readonly clock?: Clock | undefined;
}

/**
 * Validates whether the tool call dependencies form a cycle (DAG check).
 */
export function validateToolDependencies<TArgs = unknown>(
  calls: readonly ScheduledToolCall<TArgs>[],
): void {
  const ids = new Set(calls.map((c) => String(c.id)));
  const adj = new Map<string, string[]>();

  for (const call of calls) {
    const callId = String(call.id);
    const deps = (call.dependsOn ?? []).map(String);
    for (const dep of deps) {
      if (!ids.has(dep)) {
        throw new AirError(
          'INVALID_ARGUMENT',
          `Tool call "${callId}" depends on non-existent tool call "${dep}"`,
          { context: { callId, missingDependency: dep } },
        );
      }
      if (dep === callId) {
        throw new AirError(
          'INVALID_ARGUMENT',
          `Tool call "${callId}" cannot depend on itself`,
          { context: { callId } },
        );
      }
    }
    adj.set(callId, deps);
  }

  // Detect cycles using 3-color DFS
  const visited = new Map<string, 'visiting' | 'visited'>();

  function dfs(node: string, path: string[]): void {
    const state = visited.get(node);
    if (state === 'visiting') {
      const cycle = [...path, node].join(' -> ');
      throw new AirError('INVALID_ARGUMENT', `Cyclic dependency detected in tool calls: ${cycle}`, {
        context: { cycle },
      });
    }
    if (state === 'visited') return;

    visited.set(node, 'visiting');
    const neighbors = adj.get(node) ?? [];
    for (const next of neighbors) {
      dfs(next, [...path, node]);
    }
    visited.set(node, 'visited');
  }

  for (const callId of ids) {
    if (!visited.has(callId)) {
      dfs(callId, []);
    }
  }
}

/**
 * Executes a batch of tool calls with dependency management and parallel worker pooling.
 * Guarantees that results are returned in the exact index order of the input `calls` array.
 */
export async function scheduleToolExecution<TArgs = Record<string, unknown>, TOutput = unknown>(
  calls: readonly ScheduledToolCall<TArgs>[],
  executor: ToolExecutionHandler<TArgs, TOutput>,
  options?: ToolSchedulerOptions & { signal?: AbortSignal | undefined },
): Promise<ScheduledToolResult<TOutput>[]> {
  if (calls.length === 0) {
    return [];
  }

  // 1. Validate dependencies & cycle check
  validateToolDependencies(calls);

  const signal = options?.signal;
  const maxParallel = Math.max(1, options?.maxParallel ?? 4);
  const clock = options?.clock ?? new SystemClock();

  // Results map keyed by tool call ID
  const results = new Map<string, ScheduledToolResult<TOutput>>();
  // Dependency tracking
  const pendingCalls = new Map<string, ScheduledToolCall<TArgs>>();
  const inDegree = new Map<string, number>();
  const dependentsOf = new Map<string, string[]>();

  for (const call of calls) {
    const id = String(call.id);
    pendingCalls.set(id, call);
    const deps = (call.dependsOn ?? []).map(String);
    inDegree.set(id, deps.length);

    for (const dep of deps) {
      const list = dependentsOf.get(dep) ?? [];
      list.push(id);
      dependentsOf.set(dep, list);
    }
  }

  // Ready queue: tools with 0 unfulfilled dependencies
  const readyQueue: string[] = [];
  for (const [id, count] of inDegree.entries()) {
    if (count === 0) {
      readyQueue.push(id);
    }
  }

  let inFlight = 0;

  return new Promise<ScheduledToolResult<TOutput>[]>((resolve) => {
    function checkCompletion(): void {
      if (results.size === calls.length) {
        // Return results ordered identically to calls input
        const ordered = calls.map((c) => {
          const res = results.get(String(c.id));
          if (!res) {
            throw new AirError('INTERNAL', `Missing scheduled tool result for "${String(c.id)}"`);
          }
          return res;
        });
        resolve(ordered);
      }
    }

    function scheduleMore(): void {

      if (signal?.aborted) {
        // Mark all remaining unexecuted tools as cancelled
        for (const [id, call] of pendingCalls.entries()) {
          if (!results.has(id)) {
            results.set(id, {
              toolCallId: call.id,
              name: call.name,
              success: false,
              durationMs: 0,
              error: {
                code: 'CANCELLED',
                message: signal.reason ? String(signal.reason) : 'Tool execution aborted',
              },
            });
          }
        }
        checkCompletion();
        return;
      }

      while (inFlight < maxParallel && readyQueue.length > 0) {
        const nextId = readyQueue.shift();
        if (!nextId) break;

        const call = pendingCalls.get(nextId);
        if (!call) continue;

        inFlight++;
        const startTime = clock.now().getTime();

        // Check if any prerequisite failed
        const deps = (call.dependsOn ?? []).map(String);
        const failedDep = deps.find((depId) => {
          const r = results.get(depId);
          return r && !r.success;
        });

        if (failedDep) {
          // Prerequisite failed: cascade skip/fail dependent tool
          inFlight--;
          results.set(nextId, {
            toolCallId: call.id,
            name: call.name,
            success: false,
            durationMs: 0,
            error: {
              code: 'FAILED_PRECONDITION',
              message: `Dependency "${failedDep}" failed; skipping execution`,
            },
          });

          // Unblock dependents with cascade
          const nextDependents = dependentsOf.get(nextId) ?? [];
          for (const depId of nextDependents) {
            const current = inDegree.get(depId) ?? 1;
            const updated = current - 1;
            inDegree.set(depId, updated);
            if (updated === 0) {
              readyQueue.push(depId);
            }
          }

          scheduleMore();
          checkCompletion();
          continue;
        }

        // Execute tool call via handler
        void (async () => {
          try {
            const execution = await executor(call, signal ?? new AbortController().signal);
            const durationMs = Math.max(0, clock.now().getTime() - startTime);

            results.set(nextId, {
              toolCallId: call.id,
              name: call.name,
              success: execution.success,
              output: execution.output,
              error: execution.error,
              durationMs,
            });
          } catch (err) {
            const durationMs = Math.max(0, clock.now().getTime() - startTime);
            const msg = err instanceof Error ? err.message : String(err);
            results.set(nextId, {
              toolCallId: call.id,
              name: call.name,
              success: false,
              durationMs,
              error: {
                code: 'TOOL_EXECUTION_FAILED',
                message: msg,
              },
            });
          } finally {
            inFlight--;

            // Update in-degree for dependents
            const nextDependents = dependentsOf.get(nextId) ?? [];
            for (const depId of nextDependents) {
              const current = inDegree.get(depId) ?? 1;
              const updated = current - 1;
              inDegree.set(depId, updated);
              if (updated === 0) {
                readyQueue.push(depId);
              }
            }

            scheduleMore();
            checkCompletion();
          }
        })();
      }

      checkCompletion();
    }

    scheduleMore();
  });
}
