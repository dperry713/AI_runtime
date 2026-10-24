/**
 * Production Process Runner (Phase 7 - P7-T01).
 *
 * Implements ProcessRunner with:
 * - Spawn via node:child_process (Rule R2 authorized sandbox module)
 * - Strict environment allowlist scrubbing (Rule R4 / ADR-0004)
 * - Path jail validation via src/util/paths (Rule R5)
 * - Stdio caps and stream truncation with streaming hooks
 * - Timeout and cooperative cancellation with process tree termination (taskkill /T)
 * - Injected Clock for determinism (Rule R6)
 * - Structured result reporting and active process tracking for orphan reaping (P7-T05)
 */

import { spawn } from 'node:child_process';
import { AirError } from '../errors/index.js';
import type { ComponentLogger } from '../observability/index.js';
import { getLogger } from '../observability/index.js';
import type { Clock } from '../util/index.js';
import { SystemClock, existsIn, isInside } from '../util/index.js';
import type {
  ActiveProcessInfo,
  ProcessRunner,
  ProcessRunOptions,
  ProcessRunResult,
} from './types.js';
import type { NetworkEgressController } from './network.js';
import { getEgressEnforcementStatus } from './network.js';
import { killProcessTree } from './process-tree.js';
import type { AppContainerRunner } from './appcontainer-runner.js';

// ============================================================================
// 1. Environment Allowlist & Scrubbing Engine
// ============================================================================

/**
 * Default safe environment variable names inherited by child processes on Windows.
 * System-critical paths and identifiers required for process execution.
 */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'COMPUTERNAME',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PSMODULEPATH',
  'PUBLIC',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
];

/**
 * Regex patterns identifying sensitive secret keys that must never be inherited.
 */
export const BLOCKED_ENV_PATTERNS: readonly RegExp[] = [
  /KEY/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PASSWD/i,
  /AUTH/i,
  /CREDENTIAL/i,
  /PRIVATE/i,
  /^AIR_/i,
  /ANTHROPIC/i,
  /OPENAI/i,
  /OLLAMA/i,
  /AWS_/i,
  /AZURE_/i,
  /GITHUB_/i,
  /GOOGLE_/i,
];

export interface ScrubEnvironmentOptions {
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
  readonly userEnv?: Record<string, string> | undefined;
  readonly allowlist?: readonly string[] | undefined;
  readonly passThrough?: boolean | undefined;
  readonly allowNetwork?: boolean | undefined;
}

/**
 * Tests whether an environment variable name matches sensitive blocked patterns.
 */
export function isBlockedEnvName(name: string): boolean {
  return BLOCKED_ENV_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Scrubs environment variables, ensuring untrusted processes cannot read ambient secrets.
 */
export function scrubEnvironment(options: ScrubEnvironmentOptions): Record<string, string> {
  const base = options.baseEnv ?? process.env;
  const user = options.userEnv ?? {};
  const allowlist = new Set((options.allowlist ?? DEFAULT_ENV_ALLOWLIST).map((k) => k.toUpperCase()));
  const passThrough = options.passThrough ?? false;
  const allowNetwork = options.allowNetwork ?? false;

  const result: Record<string, string> = {};

  for (const [key, val] of Object.entries(base)) {
    if (val === undefined) continue;

    const upperKey = key.toUpperCase();

    if (passThrough) {
      if (!isBlockedEnvName(key) || key in user) {
        result[key] = val;
      }
    } else {
      if (allowlist.has(upperKey) && !isBlockedEnvName(key)) {
        result[key] = val;
      }
    }
  }

  // Caller-provided user environment variables explicitly take precedence
  for (const [key, val] of Object.entries(user)) {
    result[key] = val;
  }

  // Network egress control: if network is not permitted (default false), strip proxy variables
  if (!allowNetwork) {
    const proxyVars = [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'no_proxy',
    ];
    for (const pv of proxyVars) {
      delete result[pv];
    }
  }

  return result;
}

// ============================================================================
// 2. Process Tree Termination & Child Tracking Contract
// ============================================================================

export { killProcessTree };

export interface ChildProcessTracker {
  registerChild(child: { pid: number; command: string; startTime: number }): Promise<void>;
  unregisterChild(pid: number): Promise<void>;
}

// ============================================================================
// 3. StandardProcessRunner
// ============================================================================

export interface StandardProcessRunnerOptions {
  readonly clock?: Clock | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly defaultMaxOutputBytes?: number | undefined;
  readonly defaultEnvAllowlist?: readonly string[] | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly egressController?: NetworkEgressController | undefined;
  readonly orphanReaper?: ChildProcessTracker | undefined;
  readonly logger?: ComponentLogger | undefined;
  readonly appContainerRunner?: AppContainerRunner | undefined;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB

export class StandardProcessRunner implements ProcessRunner {
  private readonly clock: Clock;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxOutputBytes: number;
  private readonly defaultEnvAllowlist: readonly string[];
  private readonly workspaceRoot?: string | undefined;
  private readonly egressController?: NetworkEgressController | undefined;
  private readonly orphanReaper?: ChildProcessTracker | undefined;
  private readonly appContainerRunner?: AppContainerRunner | undefined;
  private readonly logger: ComponentLogger;
  private readonly activeProcesses = new Map<number, ActiveProcessInfo>();

  public constructor(options?: StandardProcessRunnerOptions) {
    this.clock = options?.clock ?? new SystemClock();
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultMaxOutputBytes = options?.defaultMaxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.defaultEnvAllowlist = options?.defaultEnvAllowlist ?? DEFAULT_ENV_ALLOWLIST;
    this.workspaceRoot = options?.workspaceRoot;
    this.egressController = options?.egressController;
    this.orphanReaper = options?.orphanReaper;
    this.appContainerRunner = options?.appContainerRunner;
    this.logger = options?.logger ?? getLogger('process-runner');
  }

  /**
   * Retrieves snapshots of currently active child processes.
   */
  public getActiveProcesses(): readonly ActiveProcessInfo[] {
    return Array.from(this.activeProcesses.values());
  }

  /**
   * Forcibly terminates all registered active child processes.
   */
  public killAll(): Promise<void> {
    const pids = Array.from(this.activeProcesses.keys());
    for (const pid of pids) {
      killProcessTree(pid);
      this.activeProcesses.delete(pid);
    }
    return Promise.resolve();
  }

  /**
   * Spawns an isolated process, buffers output up to limit, and enforces timeout/cancellation.
   */
  public async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    if (!options.command || options.command.trim().length === 0) {
      throw new AirError('INVALID_ARGUMENT', 'Process command cannot be empty');
    }

    if (options.signal?.aborted) {
      throw new AirError('CANCELLED', 'Process execution was cancelled before start');
    }

    // Egress enforcement: a hostile child process can ignore proxy environment
    // variables and connect directly. Network-enabled runs are refused unless
    // OS-level enforcement (Windows Firewall rule) is active.
    if (options.allowNetwork && getEgressEnforcementStatus() !== 'ACTIVE') {
      throw new AirError(
        'PERMISSION_DENIED',
        'Network access is not enforced at the OS level. Refusing network-enabled process run.',
        {
          context: {
            allowNetwork: true,
            enforcementStatus: getEgressEnforcementStatus(),
          },
        },
      );
    }

    // AppContainer default sandbox for risky tools (W2-R003).
    // Network-enabled runs and any run with appContainer: true use AppContainer
    // by default, falling back to Job Objects + restricted token when unavailable.
    const useAppContainer =
      options.appContainer ?? (options.allowNetwork === true && this.appContainerRunner?.isAvailable());

    if (useAppContainer && this.appContainerRunner) {
      this.logger.debug(
        { event: 'process.appcontainer_selected', command: options.command, allowNetwork: options.allowNetwork },
        'Using AppContainer sandbox for process execution',
      );
      return this.appContainerRunner.run({
        ...options,
        profileName: options.appContainer !== false ? undefined : undefined,
        capabilities: options.allowNetwork ? ['internetClient'] : [],
        allowNetwork: options.allowNetwork,
        networkAllowlist: options.networkAllowlist,
      });
    }

    // 1. Path Jail & Working Directory Validation
    const effectiveWorkspace = options.workspaceRoot ?? this.workspaceRoot;
    if (options.cwd) {
      if (effectiveWorkspace) {
        if (!isInside(effectiveWorkspace, options.cwd)) {
          throw new AirError(
            'PERMISSION_DENIED',
            `Working directory "${options.cwd}" escapes workspace jail "${effectiveWorkspace}"`,
            { context: { cwd: options.cwd, workspaceRoot: effectiveWorkspace } },
          );
        }

        const dirExists = await existsIn(effectiveWorkspace, options.cwd);
        if (!dirExists) {
          throw new AirError(
            'INVALID_ARGUMENT',
            `Working directory does not exist: ${options.cwd}`,
            { context: { cwd: options.cwd } },
          );
        }
      }
    }

    // 2. Environment Scrubbing
    let scrubbedEnv = scrubEnvironment({
      baseEnv: process.env,
      userEnv: options.env,
      allowlist: options.envAllowlist ?? this.defaultEnvAllowlist,
      passThrough: options.passThroughEnv,
      allowNetwork: options.allowNetwork,
    });

    if (this.egressController) {
      scrubbedEnv = this.egressController.configureEnvironment(scrubbedEnv, options.allowNetwork ?? false);
    }

    // 3. Command & Argument Assembly
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
          env: scrubbedEnv,
          windowsHide: true,
          windowsVerbatimArguments: isCmd,
          stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        });
      } catch (err: unknown) {
        return reject(
          new AirError(
            'TOOL_EXECUTION_FAILED',
            `Failed to spawn process "${binary}": ${(err as Error).message}`,
            {
              cause: err instanceof Error ? err : undefined,
              context: { binary, command: options.command },
            },
          ),
        );
      }

      let reaperChain: Promise<void> = Promise.resolve();

      const pid = child.pid;
      if (pid) {
        this.activeProcesses.set(pid, {
          pid,
          command: options.command,
          startTime: this.clock.now().getTime(),
        });
        if (this.orphanReaper) {
          reaperChain = reaperChain.then(() =>
            this.orphanReaper?.registerChild({
              pid,
              command: options.command,
              startTime: this.clock.now().getTime(),
            }),
          );
        }
      }

      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let killed = false;
      let truncated = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
        if (pid) {
          this.activeProcesses.delete(pid);
          if (this.orphanReaper) {
            reaperChain = reaperChain.then(() => this.orphanReaper?.unregisterChild(pid));
          }
        }
      };

      const killProcess = (isTimeout: boolean): void => {
        if (killed) return;
        killed = true;
        if (isTimeout) timedOut = true;

        if (pid) {
          killProcessTree(pid);
        } else {
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore kill errors
          }
        }
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.logger.warn(
            { event: 'process.timeout', pid, command: options.command, timeoutMs },
            'Process execution timed out, terminating process tree',
          );
          killProcess(true);
        }, timeoutMs);
      }

      const onAbort = (): void => {
        this.logger.info(
          { event: 'process.aborted', pid, command: options.command },
          'Process execution aborted by caller signal',
        );
        killProcess(false);
      };

      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      // Write stdin if provided
      if (options.stdin !== undefined && child.stdin) {
        try {
          child.stdin.write(options.stdin, () => {
            child.stdin?.end();
          });
        } catch {
          // Ignore stdin write error
        }
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        const chunkStr = chunk.toString('utf-8');
        if (options.onStdoutChunk) {
          try {
            options.onStdoutChunk(chunkStr);
          } catch {
            // Suppress callback failure
          }
        }

        if (stdoutBytes < maxOutputBytes) {
          const available = maxOutputBytes - stdoutBytes;
          const toAdd = chunk.subarray(0, available);
          stdout += toAdd.toString('utf-8');
          stdoutBytes += chunk.length;
          if (stdoutBytes >= maxOutputBytes) {
            truncated = true;
            stdout += '\n\n[TRUNCATED: maxOutputBytes exceeded]';
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const chunkStr = chunk.toString('utf-8');
        if (options.onStderrChunk) {
          try {
            options.onStderrChunk(chunkStr);
          } catch {
            // Suppress callback failure
          }
        }

        if (stderrBytes < maxOutputBytes) {
          const available = maxOutputBytes - stderrBytes;
          const toAdd = chunk.subarray(0, available);
          stderr += toAdd.toString('utf-8');
          stderrBytes += chunk.length;
          if (stderrBytes >= maxOutputBytes) {
            truncated = true;
            stderr += '\n\n[TRUNCATED: maxOutputBytes exceeded]';
          }
        }
      });

      child.on('error', (err: Error) => {
        cleanup();
        reject(
          new AirError(
            'TOOL_EXECUTION_FAILED',
            `Process error for "${options.command}": ${err.message}`,
            {
              cause: err,
              context: { command: options.command, binary, pid },
            },
          ),
        );
      });

      child.on('close', (code: number | null) => {
        void (async () => {
          cleanup();
          await reaperChain.catch(() => {});
          const durationMs = this.clock.monotonicMs() - startMono;

          if (timedOut) {
            return reject(
              new AirError(
                'TOOL_TIMEOUT',
                `Process execution timed out after ${timeoutMs}ms`,
                {
                  context: { command: options.command, timeoutMs, durationMs, pid },
                },
              ),
            );
          }

          if (killed && options.signal?.aborted) {
            return reject(
              new AirError('CANCELLED', 'Process execution was cancelled', {
                context: { command: options.command, durationMs, pid },
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
            pid,
            truncated,
          });
        })();
      });
    });
  }

  private resolveExecutableAndArgs(options: ProcessRunOptions): {
    binary: string;
    args: string[];
  } {
    const rawShell = options.shell ?? (process.platform === 'win32' ? 'powershell' : 'none');

    if (rawShell === 'powershell' || rawShell === true) {
      return {
        binary: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          options.command,
        ],
      };
    }

    if (rawShell === 'pwsh') {
      return {
        binary: 'pwsh.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          options.command,
        ],
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
