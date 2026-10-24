/**
 * AppContainer Process Runner (Phase W2 - AppContainer default sandbox).
 *
 * Provides AppContainer isolation for sandboxed process execution on Windows:
 * 1. AppContainer profile lifecycle via air-sandbox.exe (PowerShell-backed)
 * 2. Filesystem ACL granting for workspace jail access
 * 3. WFP filter integration for network enforcement scoped to AppContainer SID
 * 4. Process launching inside AppContainer via PowerShell Start-Process
 * 5. Fallback to Job Objects + restricted token when AppContainer unavailable
 *
 * AppContainer is the Windows equivalent of Landlock/seccomp-bpf: a
 * kernel-enforced sandbox that restricts process capabilities regardless of
 * environment variables.
 *
 * Adheres to:
 * - Rule R1: Structured logging via src/observability
 * - Rule R2: Process execution boundaries (sandbox helper)
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 */

import { spawn } from 'node:child_process';
import { AirError } from '../errors/index.js';
import { getLogger, type ComponentLogger } from '../observability/index.js';
import type { Clock } from '../util/index.js';
import { SystemClock } from '../util/index.js';
import type {
  ActiveProcessInfo,
  ProcessRunOptions,
  ProcessRunResult,
  ProcessRunner,
} from './types.js';
import type { JobLimitsConfig } from './helper-client.js';
import { WfpClient, createDefaultDenyFilter, createAllowFilter } from './wfp.js';

const defaultLogger = getLogger('appcontainer-runner');

export const APPCONTAINER_PROFILE_PREFIX = 'AIR-AC-';

// Helper response types for type-safe access
interface AcProfileCreatedResponse {
  readonly type: 'ac_profile_created';
  readonly profile: {
    readonly name: string;
    readonly sid: string;
    readonly capabilities: readonly string[];
  };
}

interface AcProfileDeletedResponse {
  readonly type: 'ac_profile_deleted';
  readonly success: boolean;
}

interface AcAccessGrantedResponse {
  readonly type: 'ac_access_granted';
  readonly result: {
    readonly success: boolean;
    readonly message: string;
  };
}

type AcHelperResponse = AcProfileCreatedResponse | AcProfileDeletedResponse | AcAccessGrantedResponse;

export interface AppContainerCapability {
  readonly name: string;
}

export const APPCONTAINER_CAPABILITIES: Record<string, AppContainerCapability> = {
  internetClient: { name: 'internetClient' },
  internetClientServer: { name: 'internetClientServer' },
  privateNetworkClientServer: { name: 'privateNetworkClientServer' },
  documentsLibrary: { name: 'documentsLibrary' },
  picturesLibrary: { name: 'picturesLibrary' },
};

export interface AppContainerProfile {
  readonly name: string;
  readonly sid: string;
  readonly capabilities: readonly string[];
  readonly createdAt: string;
}

export interface AppContainerRunnerOptions {
  readonly helperPath?: string | undefined;
  readonly clock?: Clock | undefined;
  readonly logger?: ComponentLogger | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly defaultLimits?: JobLimitsConfig | undefined;
  readonly fallbackRunner?: ProcessRunner | undefined;
  /** Optional mock handler for testing (bypasses spawning air-sandbox.exe). */
  readonly mockHandler?: ((request: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
}

export interface AppContainerLaunchOptions extends ProcessRunOptions {
  readonly profileName?: string | undefined;
  readonly capabilities?: readonly string[] | undefined;
  readonly allowNetwork?: boolean | undefined;
  readonly networkAllowlist?: readonly string[] | undefined;
}

export class AppContainerRunner implements ProcessRunner {
  private readonly helperPath: string;
  private readonly clock: Clock;
  private readonly logger: ComponentLogger;
  private readonly workspaceRoot?: string | undefined;
  private readonly fallbackRunner: ProcessRunner;
  private readonly wfpClient: WfpClient;
  private readonly mockHandler?: ((request: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
  private readonly profiles = new Map<string, AppContainerProfile>();
  private readonly isSupported: boolean;
  private readonly isAppContainerAvailable: boolean;

  constructor(options: AppContainerRunnerOptions = {}) {
    this.helperPath = options.helperPath ?? 'air-sandbox.exe';
    this.clock = options.clock ?? new SystemClock();
    this.logger = options.logger ?? defaultLogger;
    this.workspaceRoot = options.workspaceRoot;
    this.fallbackRunner = options.fallbackRunner ?? new BasicFallbackRunner();
    this.wfpClient = new WfpClient({ helperPath: this.helperPath, logger: options.logger });
    this.isSupported = process.platform === 'win32';
    this.isAppContainerAvailable = this.isSupported;
    this.mockHandler = options.mockHandler;
  }

  /**
   * Checks whether AppContainer isolation is available on the current host.
   */
  public isAvailable(): boolean {
    return this.isAppContainerAvailable;
  }

  /**
   * Creates an AppContainer profile with the requested security attributes.
   */
  public async createProfile(options: {
    readonly name: string;
    readonly displayName?: string | undefined;
    readonly description?: string | undefined;
    readonly capabilities?: readonly string[] | undefined;
  }): Promise<AppContainerProfile> {
    if (!this.isSupported) {
      throw new AirError(
        'SANDBOX_VIOLATION',
        'AppContainer is only supported on Windows',
      );
    }

    const profileName = `${APPCONTAINER_PROFILE_PREFIX}${options.name}`;
    const capabilities = options.capabilities ?? [];

    const request = {
      op: 'ac_create_profile' as const,
      profile: {
        name: profileName,
        displayName: options.displayName ?? profileName,
        description: options.description,
        capabilities,
      },
    };

    const response = await this.sendHelperRequest(request);

    if (response.type === 'ac_profile_created') {
      const profile: AppContainerProfile = {
        name: response.profile.name,
        sid: response.profile.sid,
        capabilities: response.profile.capabilities,
        createdAt: this.clock.iso(),
      };
      this.profiles.set(profileName, profile);
      this.logger.info(
        {
          event: 'sandbox.appcontainer.profile_created',
          name: profileName,
          sid: profile.sid,
          capabilities: profile.capabilities,
        },
        `Created AppContainer profile "${profileName}" with SID ${profile.sid}`,
      );
      return profile;
    }

    throw new AirError(
      'SANDBOX_VIOLATION',
      `Failed to create AppContainer profile: unknown error`,
      { context: { profileName } },
    );
  }

  /**
   * Deletes an AppContainer profile.
   */
  public async deleteProfile(name: string): Promise<boolean> {
    const profileName = `${APPCONTAINER_PROFILE_PREFIX}${name}`;

    const request = {
      op: 'ac_delete_profile' as const,
      name: profileName,
    };

    const response = await this.sendHelperRequest(request);

    if (response.type === 'ac_profile_deleted') {
      this.profiles.delete(profileName);
      return response.success;
    }

    throw new AirError(
      'SANDBOX_VIOLATION',
      `Failed to delete AppContainer profile: ${(response as { readonly message?: string }).message ?? 'unknown error'}`,
      { context: { profileName } },
    );
  }

  /**
   * Lists all AppContainer profiles managed by this instance.
   */
  public listProfiles(): readonly AppContainerProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Grants filesystem access to an AppContainer SID for the target folder.
   */
  public async grantAccessToPath(
    sid: string,
    targetPath: string,
    access: 'read' | 'full' = 'full',
  ): Promise<{ readonly success: boolean; readonly message: string }> {
    const request = {
      op: 'ac_grant_access' as const,
      sid,
      targetPath,
      access,
    };

    const response = await this.sendHelperRequest(request);

    if (response.type === 'ac_access_granted') {
      return {
        success: response.result.success,
        message: response.result.message,
      };
    }

    throw new AirError(
      'SANDBOX_VIOLATION',
      `Failed to grant AppContainer filesystem access: ${(response as { readonly message?: string }).message ?? 'unknown error'}`,
      { context: { sid, targetPath } },
    );
  }

  /**
   * Runs a process inside an AppContainer sandbox.
   *
   * If AppContainer is available, creates a profile, grants filesystem access,
   * sets up WFP filters, and launches the process. Falls back to Job Objects
   * + restricted token when AppContainer is unavailable.
   */
  public async run(options: AppContainerLaunchOptions): Promise<ProcessRunResult> {
    const useAppContainer = this.isAppContainerAvailable && options.appContainer !== false;

    if (useAppContainer) {
      try {
        return await this.runInAppContainer(options);
      } catch (err) {
        this.logger.warn(
          {
            event: 'sandbox.appcontainer.fallback',
            error: err instanceof Error ? err.message : String(err),
            command: options.command,
          },
          'AppContainer launch failed, falling back to Job Objects + restricted token',
        );
      }
    }

    // Fallback: Job Objects + restricted token via StandardProcessRunner
    return this.fallbackRunner.run({
      ...options,
    });
  }

  /**
   * Runs a process inside an AppContainer.
   */
  private async runInAppContainer(options: AppContainerLaunchOptions): Promise<ProcessRunResult> {
    const profileName = options.profileName ?? `AIR-AC-${options.command.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const capabilities = options.capabilities ?? [];

    // Ensure profile exists
    let profile = this.profiles.get(profileName);
    if (!profile) {
      profile = await this.createProfile({
        name: profileName.replace(APPCONTAINER_PROFILE_PREFIX, ''),
        displayName: profileName,
        capabilities,
      });
    }

    // Grant filesystem access to workspace root
    if (this.workspaceRoot) {
      await this.grantAccessToPath(profile.sid, this.workspaceRoot, 'full');
    }

    // Set up WFP filters for network enforcement
    const wfpFilterIds: number[] = [];
    if (options.allowNetwork && options.networkAllowlist) {
      // Default deny filter
      const defaultDeny = createDefaultDenyFilter(profileName);
      const denyResult = await this.wfpClient.addFilter(defaultDeny);
      wfpFilterIds.push(denyResult.filterId);

      // Allow filters for each allowlisted host
      for (const hostPattern of options.networkAllowlist) {
        const allowSpec = createAllowFilter(
          `Allow ${hostPattern}`,
          hostPattern,
          '443',
          6,
        );
        const allowResult = await this.wfpClient.addFilter(allowSpec);
        wfpFilterIds.push(allowResult.filterId);
      }
    } else {
      // Default deny all outbound
      const defaultDeny = createDefaultDenyFilter(profileName);
      const denyResult = await this.wfpClient.addFilter(defaultDeny);
      wfpFilterIds.push(denyResult.filterId);
    }

    try {
      // Launch process using PowerShell with AppContainer context
      const result = await this.launchViaPowerShell(options);
      return result;
    } finally {
      // Clean up WFP filters
      for (const filterId of wfpFilterIds) {
        try {
          await this.wfpClient.removeFilter(filterId);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Launches a process inside an AppContainer using PowerShell.
   *
   * Uses Start-Process with the AppContainer profile to launch the process
   * inside the AppContainer sandbox.
   */
  private async launchViaPowerShell(
    options: AppContainerLaunchOptions,
  ): Promise<ProcessRunResult> {
    // Build the command to execute inside AppContainer
    const psCommand = this.buildAppContainerPowerShellCommand(options);

    return new Promise<ProcessRunResult>((resolve, reject) => {
      const startMono = this.clock.monotonicMs();
      let resolved = false;

      const timeoutMs = options.timeoutMs ?? 60_000;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new AirError('TOOL_TIMEOUT', `AppContainer process timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      const cleanup = (): void => {
        clearTimeout(timer);
      };

      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        psCommand,
      ], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: options.cwd,
        env: options.env,
      });

      if (!child.stdin || !child.stdout || !child.stderr) {
        cleanup();
        return reject(new AirError('TOOL_EXECUTION_FAILED', 'Failed to initialize stdio pipes for AppContainer process'));
      }

      let stdout = '';
      let stderr = '';
      const pid: number | undefined = child.pid;

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });

      child.on('error', (err: Error) => {
        cleanup();
        reject(new AirError('TOOL_EXECUTION_FAILED', `AppContainer process error: ${err.message}`, { cause: err }));
      });

      child.on('close', (code: number | null) => {
        cleanup();
        if (!resolved) {
          resolved = true;
          const durationMs = this.clock.monotonicMs() - startMono;
          resolve({
            exitCode: code ?? 0,
            stdout,
            stderr,
            durationMs,
            timedOut: false,
            killed: false,
            pid,
          });
        }
      });
    });
  }

  /**
   * Builds a PowerShell command that launches a process inside an AppContainer.
   */
  private buildAppContainerPowerShellCommand(options: AppContainerLaunchOptions): string {
    // Escape the command for PowerShell
    const escapedCommand = options.command.replace(/'/g, "''");
    const escapedArgs = (options.args ?? []).map(a => a.replace(/'/g, "''")).join("', '");

    // Build the PowerShell command to launch in AppContainer
    // We use Start-Process with the AppContainer profile
    let argsStr = '';
    if (escapedArgs.length > 0) {
      argsStr = ` -ArgumentList '${escapedArgs}'`;
    }

    return `
$acProfile = Get-AppContainerProfile -Name '${options.profileName ?? 'default'}' -ErrorAction SilentlyContinue
if (-not $acProfile) {
    Write-Error "AppContainer profile not found"
    exit 1
}
Start-Process -FilePath '${escapedCommand}'${argsStr} -AppContainer $acProfile -Wait -NoNewWindow
`;
  }

  /**
   * Sends a request to the air-sandbox.exe helper and waits for a response.
   */
  private async sendHelperRequest(request: {
    readonly op: string;
    readonly [key: string]: unknown;
  }): Promise<AcHelperResponse> {
    // Mock handler for testing (bypasses spawning air-sandbox.exe)
    if (this.mockHandler) {
      const response = await this.mockHandler(request);
      return response as unknown as AcHelperResponse;
    }

    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.helperPath, [], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err: unknown) {
        return reject(
          new AirError(
            'TOOL_EXECUTION_FAILED',
            `Failed to launch sandbox helper "${this.helperPath}": ${(err as Error).message}`,
            { cause: err instanceof Error ? err : undefined },
          ),
        );
      }

      if (!child.stdin || !child.stdout || !child.stderr) {
        return reject(new AirError('TOOL_EXECUTION_FAILED', 'Failed to initialize stdio pipes for sandbox helper'));
      }

      const childStdin = child.stdin;
      const childStdout = child.stdout;
      const childStderr = child.stderr;

      let stdoutAccum = '';
      let resolved = false;

      const cleanup = (): void => {
        try {
          child.kill();
        } catch {
          // Ignore
        }
      };

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new AirError('TOOL_TIMEOUT', 'AppContainer helper request timed out'));
        }
      }, 10_000);

      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      childStdin.write(JSON.stringify(request) + '\n', () => {
        childStdin.end();
      });

      childStdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        stdoutAccum += text;
        const lines = stdoutAccum.split('\n');
        stdoutAccum = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;

          try {
            const resp = JSON.parse(trimmed) as { readonly type: string; readonly [key: string]: unknown };
            if (resp && typeof resp === 'object' && 'type' in resp) {
              if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                cleanup();
                resolve(resp as unknown as AcHelperResponse);
              }
              return;
            }
          } catch {
            // Not a JSON protocol line - ignore
          }
        }
      });

      childStderr.on('data', () => {
        // Ignore stderr
      });

      child.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          cleanup();
          reject(new AirError('TOOL_EXECUTION_FAILED', `Sandbox helper process error: ${err.message}`, { cause: err }));
        }
      });

      child.on('close', (code: number | null) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          cleanup();
          reject(new AirError('TOOL_EXECUTION_FAILED', `Sandbox helper exited with code ${code ?? -1} before response`));
        }
      });
    });
  }

  /**
   * Returns list of currently active child processes (delegates to fallback runner).
   */
  public getActiveProcesses(): readonly ActiveProcessInfo[] {
    return this.fallbackRunner.getActiveProcesses?.() ?? [];
  }

  /**
   * Force terminates all active child processes.
   */
  public killAll(): Promise<void> {
    return this.fallbackRunner.killAll?.() ?? Promise.resolve();
  }
}

/**
 * Minimal fallback ProcessRunner that throws on run().
 * Used when no fallbackRunner is provided and AppContainer is unavailable.
 */
class BasicFallbackRunner implements ProcessRunner {
  public run(): Promise<ProcessRunResult> {
    return Promise.reject(
      new AirError(
        'SANDBOX_VIOLATION',
        'AppContainer is unavailable and no fallback runner was provided',
      ),
    );
  }

  public getActiveProcesses(): readonly ActiveProcessInfo[] {
    return [];
  }

  public killAll(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Creates an AppContainerRunner with default settings for risky tools.
 */
export function createDefaultAppContainerRunner(options?: AppContainerRunnerOptions): AppContainerRunner {
  return new AppContainerRunner({
    helperPath: 'air-sandbox.exe',
    ...options,
  });
}
