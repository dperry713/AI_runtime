/**
 * Sandbox Native Helper Client (Phase 7 - P7-T02).
 *
 * Client adapter for the native Windows isolation helper (air-sandbox.exe).
 * - Spawns air-sandbox.exe with versioned stdin/stdout JSON protocol (ADR-0004)
 * - Enforces Job Object limits (kill-on-close, max processes, memory cap, CPU rate)
 * - Verifies helper binary integrity and expected SHA-256 hash (Rule S2)
 * - Maps protocol events (started, completed, error) to structured results
 * - Error normalization into typed AirError
 * - Provides protocol test double for testing and fallback environments
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { AirError } from '../errors/index.js';
import type { ComponentLogger } from '../observability/index.js';
import { getLogger } from '../observability/index.js';
import type { Clock } from '../util/index.js';
import { SystemClock, readFileIn } from '../util/index.js';
import type { ProcessRunOptions, ProcessRunResult, ProcessRunner } from './types.js';

export const HELPER_PROTOCOL_VERSION = 1;

export interface JobLimitsConfig {
  readonly maxMemoryBytes?: number | undefined;
  readonly maxProcesses?: number | undefined;
  readonly cpuRateLimitPercent?: number | undefined;
  readonly killOnClose?: boolean | undefined;
}

export interface HelperLaunchRequest {
  readonly version: number;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string> | undefined;
  readonly limits?: JobLimitsConfig | undefined;
  readonly restrictedToken?: boolean | undefined;
}

export type HelperResponse =
  | {
      readonly type: 'started';
      readonly version: number;
      readonly pid: number;
    }
  | {
      readonly type: 'completed';
      readonly version: number;
      readonly exit_code: number;
      readonly peak_memory_bytes: number;
      readonly total_cpu_time_ms: number;
    }
  | {
      readonly type: 'error';
      readonly version: number;
      readonly code: string;
      readonly message: string;
    };

export interface SandboxHelperClientOptions {
  readonly helperPath?: string | undefined;
  readonly expectedSha256?: string | undefined;
  readonly clock?: Clock | undefined;
  readonly logger?: ComponentLogger | undefined;
  readonly defaultLimits?: JobLimitsConfig | undefined;
  readonly mockHandler?: ((request: HelperLaunchRequest) => Promise<HelperResponse[]>) | undefined;
}

export class SandboxHelperClient implements ProcessRunner {
  private readonly helperPath?: string | undefined;
  private readonly expectedSha256?: string | undefined;
  private readonly clock: Clock;
  private readonly logger: ComponentLogger;
  private readonly defaultLimits?: JobLimitsConfig | undefined;
  private readonly mockHandler?: ((request: HelperLaunchRequest) => Promise<HelperResponse[]>) | undefined;

  public constructor(options?: SandboxHelperClientOptions) {
    this.helperPath = options?.helperPath;
    this.expectedSha256 = options?.expectedSha256;
    this.clock = options?.clock ?? new SystemClock();
    this.logger = options?.logger ?? getLogger('sandbox-helper-client');
    this.defaultLimits = options?.defaultLimits;
    this.mockHandler = options?.mockHandler;
  }

  /**
   * Implements ProcessRunner interface for seamless integration.
   */
  public async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    return this.execute(options);
  }

  /**
   * Validates integrity of the helper binary using SHA-256 hash checking.
   */
  public async verifyIntegrity(rootJail: string, binaryRelPath: string): Promise<boolean> {
    const fileBytes = await readFileIn(rootJail, binaryRelPath);
    const hash = createHash('sha256').update(fileBytes).digest('hex');
    if (this.expectedSha256 && hash.toLowerCase() !== this.expectedSha256.toLowerCase()) {
      throw new AirError(
        'SECURITY_VIOLATION',
        `Integrity check failed for sandbox helper binary "${binaryRelPath}": expected ${this.expectedSha256}, got ${hash}`,
      );
    }
    return true;
  }

  /**
   * Computes the SHA-256 hash of a helper binary.
   */
  public async computeSha256(rootJail: string, binaryRelPath: string): Promise<string> {
    const fileBytes = await readFileIn(rootJail, binaryRelPath);
    return createHash('sha256').update(fileBytes).digest('hex');
  }

  /**
   * Executes a command inside the native Job Object sandbox helper.
   */
  public async execute(
    options: ProcessRunOptions & {
      readonly limits?: JobLimitsConfig | undefined;
      readonly restrictedToken?: boolean | undefined;
    },
  ): Promise<ProcessRunResult> {
    if (!options.command || options.command.trim().length === 0) {
      throw new AirError('INVALID_ARGUMENT', 'Command cannot be empty');
    }

    if (options.signal?.aborted) {
      throw new AirError('CANCELLED', 'Sandbox execution was cancelled before start');
    }

    const request: HelperLaunchRequest = {
      version: HELPER_PROTOCOL_VERSION,
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      limits: options.limits ?? this.defaultLimits,
      restrictedToken: options.restrictedToken ?? false,
    };

    // If mock handler is provided (e.g. test environments or mock mode)
    if (this.mockHandler) {
      return this.executeMock(request);
    }

    const helperExe = this.helperPath ?? 'air-sandbox.exe';
    const startMono = this.clock.monotonicMs();

    return new Promise<ProcessRunResult>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(helperExe, [], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err: unknown) {
        return reject(
          new AirError(
            'TOOL_EXECUTION_FAILED',
            `Failed to launch sandbox helper "${helperExe}": ${(err as Error).message}`,
            { cause: err instanceof Error ? err : undefined },
          ),
        );
      }

      if (!child.stdin || !child.stdout || !child.stderr) {
        return reject(
          new AirError('TOOL_EXECUTION_FAILED', 'Failed to initialize stdio pipes for sandbox helper'),
        );
      }

      const childStdin = child.stdin;
      const childStdout = child.stdout;
      const childStderr = child.stderr;

      let stdoutAccum = '';
      let userStdoutAccum = '';
      let stderrAccum = '';
      let pid: number | undefined;
      let completed = false;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
      };

      const onAbort = (): void => {
        if (!completed) {
          completed = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore kill error
          }
          cleanup();
          reject(new AirError('CANCELLED', 'Sandbox execution was cancelled'));
        }
      };

      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!completed) {
            completed = true;
            try {
              child.kill('SIGKILL');
            } catch {
              // Ignore
            }
            cleanup();
            resolve({
              exitCode: -1,
              stdout: userStdoutAccum,
              stderr: stderrAccum,
              durationMs: this.clock.monotonicMs() - startMono,
              timedOut: true,
              killed: true,
              pid,
            });
          }
        }, options.timeoutMs);
      }

      // Write JSON request line to helper stdin
      try {
        childStdin.write(JSON.stringify(request) + '\n', () => {
          childStdin.end();
        });
      } catch {
        // Handled on close
      }

      childStdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        stdoutAccum += text;
        const lines = stdoutAccum.split('\n');
        stdoutAccum = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;

          let isProtocolEvent = false;
          try {
            const resp = JSON.parse(trimmed) as HelperResponse;
            if (resp && (resp.type === 'started' || resp.type === 'completed' || resp.type === 'error')) {
              isProtocolEvent = true;
              if (resp.type === 'started') {
                pid = resp.pid;
                this.logger.debug({ event: 'sandbox.child_started', pid }, 'Sandbox child started in Job Object');
              } else if (resp.type === 'completed') {
                completed = true;
                cleanup();
                const durationMs = this.clock.monotonicMs() - startMono;
                resolve({
                  exitCode: resp.exit_code,
                  stdout: userStdoutAccum,
                  stderr: stderrAccum,
                  durationMs,
                  timedOut: false,
                  killed: false,
                  pid,
                });
                return;
              } else if (resp.type === 'error') {
                completed = true;
                cleanup();
                reject(
                  new AirError('TOOL_EXECUTION_FAILED', `Sandbox helper failed: ${resp.message}`, {
                    context: { code: resp.code },
                  }),
                );
                return;
              }
            }
          } catch {
            // Not a JSON protocol line - treat as user stdout
          }

          if (!isProtocolEvent) {
            userStdoutAccum += line + '\n';
            if (options.onStdoutChunk) {
              options.onStdoutChunk(line + '\n');
            }
          }
        }
      });

      childStderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        stderrAccum += text;
        if (options.onStderrChunk) {
          options.onStderrChunk(text);
        }
      });

      child.on('error', (err: Error) => {
        cleanup();
        reject(
          new AirError('TOOL_EXECUTION_FAILED', `Sandbox helper process error: ${err.message}`, {
            cause: err,
          }),
        );
      });

      child.on('close', (code: number | null) => {
        cleanup();
        if (!completed) {
          completed = true;
          if (options.signal?.aborted) {
            return reject(new AirError('CANCELLED', 'Sandbox execution was cancelled'));
          }

          resolve({
            exitCode: code ?? 0,
            stdout: userStdoutAccum,
            stderr: stderrAccum,
            durationMs: this.clock.monotonicMs() - startMono,
            timedOut: false,
            killed: false,
            pid,
          });
        }
      });
    });
  }

  private async executeMock(request: HelperLaunchRequest): Promise<ProcessRunResult> {
    const startMono = this.clock.monotonicMs();
    if (!this.mockHandler) {
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
        killed: false,
      };
    }
    const responses = await this.mockHandler(request);

    let pid: number | undefined;
    for (const resp of responses) {
      if (resp.type === 'started') {
        pid = resp.pid;
      } else if (resp.type === 'completed') {
        return {
          exitCode: resp.exit_code,
          stdout: `[sandboxed output for ${request.command}]`,
          stderr: '',
          durationMs: this.clock.monotonicMs() - startMono,
          timedOut: false,
          killed: false,
          pid,
        };
      } else if (resp.type === 'error') {
        throw new AirError('TOOL_EXECUTION_FAILED', `Sandbox helper failed: ${resp.message}`, {
          context: { code: resp.code },
        });
      }
    }

    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: this.clock.monotonicMs() - startMono,
      timedOut: false,
      killed: false,
      pid,
    };
  }
}
