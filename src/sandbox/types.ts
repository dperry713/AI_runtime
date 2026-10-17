/**
 * Sandbox Process Runner Types (Phase 4 / Phase 7).
 *
 * Defines the contract for hosting and executing OS processes.
 */

export type ShellType = 'powershell' | 'pwsh' | 'cmd' | 'none';

export interface ProcessRunOptions {
  /** The command line or script or executable name. */
  readonly command: string;
  /** Command line arguments when shell is 'none' or direct. */
  readonly args?: readonly string[] | undefined;
  /** Working directory for the process. */
  readonly cwd?: string | undefined;
  /** Environment variables to merge with process.env. */
  readonly env?: Record<string, string> | undefined;
  /** Shell interpreter to use. Default 'powershell' on Windows. */
  readonly shell?: ShellType | boolean | undefined;
  /** Maximum execution duration in milliseconds before SIGKILL/taskkill. */
  readonly timeoutMs?: number | undefined;
  /** Maximum bytes captured for stdout and stderr before truncation. */
  readonly maxOutputBytes?: number | undefined;
  /** Cooperative cancellation signal. */
  readonly signal?: AbortSignal | undefined;
}

export interface ProcessRunResult {
  /** Process exit status code (-1 if terminated by signal/killed). */
  readonly exitCode: number;
  /** Captured standard output. */
  readonly stdout: string;
  /** Captured standard error. */
  readonly stderr: string;
  /** Elapsed duration in milliseconds. */
  readonly durationMs: number;
  /** Whether the process was killed due to timeout. */
  readonly timedOut: boolean;
  /** Whether the process was killed prematurely (timeout or abort signal). */
  readonly killed: boolean;
}

export interface ProcessRunner {
  /**
   * Spawns and awaits completion of an isolated or managed process.
   */
  run(options: ProcessRunOptions): Promise<ProcessRunResult>;
}
