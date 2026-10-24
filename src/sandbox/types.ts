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
  /** Root jail folder within which the working directory must reside. */
  readonly workspaceRoot?: string | undefined;
  /** Environment variables to merge with process.env. */
  readonly env?: Record<string, string> | undefined;
  /** Explicit allowlist of environment variable names to inherit. */
  readonly envAllowlist?: readonly string[] | undefined;
  /** Whether to bypass scrubbing and pass all host environment variables (default false). */
  readonly passThroughEnv?: boolean | undefined;
  /** Whether outbound network access is permitted (default false: deny-by-default). */
  readonly allowNetwork?: boolean | undefined;
  /** Explicit allowed network host patterns (e.g. ['api.github.com', '*.anthropic.com']). */
  readonly networkAllowlist?: readonly string[] | undefined;
  /** Whether to use AppContainer sandbox (default: auto - enabled for network-enabled runs on Windows). */
  readonly appContainer?: boolean | undefined;
  /** Shell interpreter to use. Default 'powershell' on Windows. */
  readonly shell?: ShellType | boolean | undefined;
  /** Maximum execution duration in milliseconds before SIGKILL/taskkill. */
  readonly timeoutMs?: number | undefined;
  /** Maximum bytes captured for stdout and stderr before truncation. */
  readonly maxOutputBytes?: number | undefined;
  /** Cooperative cancellation signal. */
  readonly signal?: AbortSignal | undefined;
  /** Optional standard input to write to the child process. */
  readonly stdin?: string | Buffer | undefined;
  /** Real-time callback for captured standard output chunks. */
  readonly onStdoutChunk?: ((chunk: string) => void) | undefined;
  /** Real-time callback for captured standard error chunks. */
  readonly onStderrChunk?: ((chunk: string) => void) | undefined;
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
  /** Operating system process identifier (PID) if spawned. */
  readonly pid?: number | undefined;
  /** Whether output exceeded maxOutputBytes and was truncated. */
  readonly truncated?: boolean | undefined;
}

export interface ActiveProcessInfo {
  readonly pid: number;
  readonly command: string;
  readonly startTime: number;
}

export interface ProcessRunner {
  /**
   * Spawns and awaits completion of an isolated or managed process.
   */
  run(options: ProcessRunOptions): Promise<ProcessRunResult>;

  /**
   * Returns list of currently active child processes spawned by this runner.
   */
  getActiveProcesses?(): readonly ActiveProcessInfo[];

  /**
   * Force terminates all active child processes spawned by this runner.
   */
  killAll?(signal?: string): Promise<void>;
}
