/**
 * Naive Process Runner (Phase 4 temporary runner until Phase 7 Job Object isolation).
 *
 * Implements ProcessRunner via node:child_process with:
 * - Windows shell mapping ('powershell', 'pwsh', 'cmd', 'none')
 * - Timeout handling and cooperative cancellation
 * - Stdout/stderr streaming and byte truncation
 * - Clean error normalization into typed AirError
 */

import { spawn } from 'node:child_process';
import { AirError } from '../errors/index.js';
import type { Clock } from '../util/index.js';
import { SystemClock } from '../util/index.js';
import type { ProcessRunner, ProcessRunOptions, ProcessRunResult } from './types.js';

export interface NaiveProcessRunnerOptions {
  readonly clock?: Clock | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly defaultMaxOutputBytes?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB

export class NaiveProcessRunner implements ProcessRunner {
  private readonly clock: Clock;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxOutputBytes: number;

  public constructor(options?: NaiveProcessRunnerOptions) {
    this.clock = options?.clock ?? new SystemClock();
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultMaxOutputBytes = options?.defaultMaxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  public async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    if (!options.command || options.command.trim().length === 0) {
      throw new AirError('INVALID_ARGUMENT', 'Process command cannot be empty');
    }

    if (options.signal?.aborted) {
      throw new AirError('CANCELLED', 'Process execution was cancelled before start');
    }

    const { binary, args } = this.resolveExecutableAndArgs(options);
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxOutputBytes = options.maxOutputBytes ?? this.defaultMaxOutputBytes;

    const startMono = this.clock.monotonicMs();

    const isCmd = options.shell === 'cmd';

    return new Promise<ProcessRunResult>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(binary, args, {
          cwd: options.cwd,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          windowsHide: true,
          windowsVerbatimArguments: isCmd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err: unknown) {
        return reject(
          new AirError('TOOL_EXECUTION_FAILED', `Failed to spawn process "${binary}": ${(err as Error).message}`, {
            cause: err instanceof Error ? err : undefined,
            context: { binary, command: options.command },
          }),
        );
      }

      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let killed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
      };

      const killProcess = (isTimeout: boolean): void => {
        if (killed) return;
        killed = true;
        if (isTimeout) timedOut = true;

        try {
          if (process.platform === 'win32' && child.pid) {
            // Force terminate process tree on Windows
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
            });
          } else {
            child.kill('SIGKILL');
          }
        } catch {
          // Ignore kill failures
        }
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          killProcess(true);
        }, timeoutMs);
      }

      const onAbort = (): void => {
        killProcess(false);
      };

      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutBytes < maxOutputBytes) {
          const available = maxOutputBytes - stdoutBytes;
          const toAdd = chunk.subarray(0, available);
          stdout += toAdd.toString('utf-8');
          stdoutBytes += chunk.length;
          if (stdoutBytes >= maxOutputBytes) {
            stdout += '\n\n[TRUNCATED: maxOutputBytes exceeded]';
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes < maxOutputBytes) {
          const available = maxOutputBytes - stderrBytes;
          const toAdd = chunk.subarray(0, available);
          stderr += toAdd.toString('utf-8');
          stderrBytes += chunk.length;
          if (stderrBytes >= maxOutputBytes) {
            stderr += '\n\n[TRUNCATED: maxOutputBytes exceeded]';
          }
        }
      });

      child.on('error', (err: Error) => {
        cleanup();
        reject(
          new AirError('TOOL_EXECUTION_FAILED', `Process error for "${options.command}": ${err.message}`, {
            cause: err,
            context: { command: options.command, binary },
          }),
        );
      });

      child.on('close', (code: number | null) => {
        cleanup();
        const durationMs = this.clock.monotonicMs() - startMono;

        if (timedOut) {
          return reject(
            new AirError('TOOL_TIMEOUT', `Process execution timed out after ${timeoutMs}ms`, {
              context: { command: options.command, timeoutMs, durationMs },
            }),
          );
        }

        if (killed && options.signal?.aborted) {
          return reject(
            new AirError('CANCELLED', 'Process execution was cancelled', {
              context: { command: options.command, durationMs },
            }),
          );
        }

        resolve({
          exitCode: code ?? (killed ? -1 : 0),
          stdout,
          stderr,
          durationMs,
          timedOut,
          killed,
        });
      });
    });
  }

  private resolveExecutableAndArgs(options: ProcessRunOptions): {
    binary: string;
    args: string[];
  } {
    const rawShell = options.shell ?? (process.platform === 'win32' ? 'powershell' : 'none');

    if (rawShell === 'powershell') {
      return {
        binary: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', options.command],
      };
    }

    if (rawShell === 'pwsh') {
      return {
        binary: 'pwsh.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', options.command],
      };
    }

    if (rawShell === 'cmd') {
      return {
        binary: 'cmd.exe',
        args: ['/d', '/s', '/c', options.command],
      };
    }

    // Direct execution
    return {
      binary: options.command,
      args: options.args ? [...options.args] : [],
    };
  }
}
