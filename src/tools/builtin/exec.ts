/**
 * Built-in Exec Tool (Phase 4 - P4-T05).
 *
 * Implements exec.run:
 * - Executes command lines and scripts in PowerShell, pwsh, or cmd
 * - Dispatches through the sandbox.ProcessRunner abstraction (Rule R2)
 * - Declares 'high' intrinsic risk classification per docs/specs/tools.md §2
 * - Dynamic capability derivation ({ type: 'exec', action: 'run', resource: command })
 * - Cooperative cancellation and timeout management via AbortSignal
 */

import { z } from 'zod';
import type { ProcessRunner } from '../../sandbox/index.js';
import { StandardProcessRunner } from '../../sandbox/index.js';
import {
  type AnyTool,
  defineTool,
  toAnyTool,
  type ToolCapability,
  type ToolDefinition,
  type ToolExecutionContext,
} from '../contract.js';
import type { ToolRegistry } from '../registry.js';

export const ExecRunInputSchema = z.object({
  command: z.string().min(1).describe('Command line, script, or executable to run'),
  shell: z.enum(['powershell', 'pwsh', 'cmd', 'none']).optional().default('powershell').describe('Shell interpreter to host execution'),
  cwd: z.string().optional().describe('Working directory relative to workspace or absolute'),
  timeoutMs: z.number().int().positive().optional().describe('Maximum execution time in milliseconds'),
  maxOutputBytes: z.number().int().positive().optional().describe('Maximum bytes captured before truncation'),
  env: z.record(z.string(), z.string()).optional().describe('Additional environment variables to merge'),
});

export type ExecRunInput = z.infer<typeof ExecRunInputSchema>;

export const ExecRunOutputSchema = z.object({
  command: z.string().describe('Executed command line'),
  exitCode: z.number().int().describe('Process exit code (-1 if killed or timed out)'),
  stdout: z.string().describe('Standard output captured'),
  stderr: z.string().describe('Standard error captured'),
  durationMs: z.number().nonnegative().describe('Elapsed execution duration in milliseconds'),
  timedOut: z.boolean().describe('Whether execution was terminated due to timeout'),
});

export type ExecRunOutput = z.infer<typeof ExecRunOutputSchema>;

/**
 * Creates an exec.run tool definition with an optional injected ProcessRunner.
 */
export function createExecRunTool(
  customRunner?: ProcessRunner,
): ToolDefinition<ExecRunInput, ExecRunOutput> {
  const runner = customRunner ?? new StandardProcessRunner();

  return defineTool({
    name: 'exec.run',
    description: 'Executes a command line or script in PowerShell, pwsh, or cmd via the OS process runner.',
    risk: 'high',
    idempotent: false,
    inputSchema: ExecRunInputSchema,
    outputSchema: ExecRunOutputSchema,
    capabilities: (args): readonly ToolCapability[] => [
      {
        type: 'exec',
        action: 'run',
        resource: args.command,
        meta: {
          shell: args.shell,
          cwd: args.cwd,
        },
      },
    ],
    execute: async (args: ExecRunInput, ctx: ToolExecutionContext): Promise<ExecRunOutput> => {
      const effectiveCwd = args.cwd ?? ctx.workspaceRoot ?? process.cwd();
      const timeoutMs = args.timeoutMs ?? ctx.timeoutMs;
      const maxOutputBytes = args.maxOutputBytes ?? ctx.maxOutputBytes;

      const result = await runner.run({
        command: args.command,
        shell: args.shell,
        cwd: effectiveCwd,
        env: args.env,
        timeoutMs,
        maxOutputBytes,
        signal: ctx.signal,
      });

      return {
        command: args.command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
      };
    },
  });
}

/**
 * Default exec.run tool instance using NaiveProcessRunner.
 */
export const execRunTool: ToolDefinition<ExecRunInput, ExecRunOutput> = createExecRunTool();

export const BUILTIN_EXEC_TOOLS: readonly AnyTool[] = [
  toAnyTool(execRunTool),
];

/**
 * Registers exec.run into a ToolRegistry with an optional custom runner.
 */
export function registerBuiltinExecTools(
  registry: ToolRegistry,
  runner?: ProcessRunner,
): void {
  const tool = runner ? createExecRunTool(runner) : execRunTool;
  registry.register(tool);
}
