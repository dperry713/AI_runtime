/**
 * Windows Service installation for `aird` (Phase W5 - Packaging).
 *
 * Registers `aird` as a Windows Service using the Service Control Manager (SCM).
 * Provides:
 * - SCM service registration with recovery actions (restart on failure)
 * - Install/uninstall via PowerShell scripts
 * - Service start/stop/status queries
 *
 * Adheres to:
 * - Rule R1: No console.log; uses observability logger
 * - Rule R2: Process execution boundaries (sandbox layer - child_process allowed here)
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 */

import { spawn } from 'node:child_process';
import { AirError } from '../errors/index.js';
import { getLogger, type ComponentLogger } from '../observability/index.js';

const defaultLogger = getLogger('windows-service');

export const AIR_SERVICE_NAME = 'aird';
export const AIR_SERVICE_DISPLAY_NAME = 'AIR Runtime Daemon';

export interface ServiceInstallOptions {
  /** Path to the aird executable. Defaults to process.execPath. */
  readonly exePath?: string | undefined;
  /** Service name. Defaults to 'aird'. */
  readonly serviceName?: string | undefined;
  /** Display name for the service. */
  readonly displayName?: string | undefined;
  /** Start type: 'auto', 'demand', or 'disabled'. Defaults to 'auto'. */
  readonly startType?: 'auto' | 'demand' | 'disabled' | undefined;
  /** Recovery action on first failure: 'restart', 'none', or 'reboot'. Defaults to 'restart'. */
  readonly failureAction?: 'restart' | 'none' | 'reboot' | undefined;
  /** Delay before restart in milliseconds. Defaults to 30000 (30 seconds). */
  readonly restartDelayMs?: number | undefined;
  /** Logger instance. */
  readonly logger?: ComponentLogger | undefined;
}

export interface ServiceStatus {
  readonly name: string;
  readonly displayName: string;
  readonly status: 'stopped' | 'start_pending' | 'stop_pending' | 'running' | 'continue_pending' | 'pause_pending' | 'pause';
  readonly acceptedControls: string[];
  readonly checkpoint: number;
  readonly waitHint: number;
  readonly pid: number;
  readonly flags: number;
}

/**
 * Windows Service manager for `aird`.
 *
 * Uses `sc.exe` (Service Control) to register, start, stop, and query the service.
 * All child_process usage is confined to the sandbox layer per Rule R2.
 */
export class WindowsService {
  private readonly exePath: string;
  private readonly serviceName: string;
  private readonly displayName: string;
  private readonly startType: string;
  private readonly failureAction: string;
  private readonly restartDelayMs: number;
  private readonly logger: ComponentLogger;

  constructor(options: ServiceInstallOptions = {}) {
    this.exePath = options.exePath ?? process.execPath;
    this.serviceName = options.serviceName ?? AIR_SERVICE_NAME;
    this.displayName = options.displayName ?? AIR_SERVICE_DISPLAY_NAME;
    this.startType = options.startType ?? 'auto';
    this.failureAction = options.failureAction ?? 'restart';
    this.restartDelayMs = options.restartDelayMs ?? 30_000;
    this.logger = options.logger ?? defaultLogger;
  }

  /**
   * Installs `aird` as a Windows Service via SCM.
   *
   * Creates the service with:
   * - Binary path pointing to `aird.exe`
   * - Start type (auto/demand/disabled)
   * - Recovery actions (restart on failure with configurable delay)
   * - Description and display name
   *
   * Throws AirError if the service already exists or installation fails.
   */
  async install(): Promise<void> {
    // Check if service already exists.
    const exists = await this.serviceExists();
    if (exists) {
      throw new AirError(
        'ALREADY_EXISTS',
        `Service "${this.serviceName}" is already installed`,
        { context: { serviceName: this.serviceName } },
      );
    }

    // Build the sc create command.
    const args = [
      'create',
      this.serviceName,
      `binPath= "${this.exePath}"`,
      `displayName= "${this.displayName}"`,
      `start= ${this.startType}`,
      `obj= LocalSystem`,
    ];

    const createResult = await this.runSc(args);
    if (!createResult.success) {
      throw new AirError(
        'INTERNAL',
        `Failed to create service "${this.serviceName}": ${createResult.message}`,
        { context: { serviceName: this.serviceName, args } },
      );
    }

    // Configure recovery actions.
    await this.configureRecovery();

    this.logger.info(
      {
        event: 'service.installed',
        serviceName: this.serviceName,
        exePath: this.exePath,
        startType: this.startType,
      },
      `Service "${this.serviceName}" installed successfully`,
    );
  }

  /**
   * Uninstalls the `aird` Windows Service.
   *
   * Stops the service if running, then deletes it from the SCM.
   */
  async uninstall(): Promise<void> {
    const exists = await this.serviceExists();
    if (!exists) {
      throw new AirError(
        'NOT_FOUND',
        `Service "${this.serviceName}" is not installed`,
        { context: { serviceName: this.serviceName } },
      );
    }

    // Stop the service if running.
    try {
      await this.stop();
    } catch {
      // Ignore stop errors during uninstall.
    }

    const deleteResult = await this.runSc(['delete', this.serviceName]);
    if (!deleteResult.success) {
      throw new AirError(
        'INTERNAL',
        `Failed to delete service "${this.serviceName}": ${deleteResult.message}`,
        { context: { serviceName: this.serviceName } },
      );
    }

    this.logger.info(
      { event: 'service.uninstalled', serviceName: this.serviceName },
      `Service "${this.serviceName}" uninstalled successfully`,
    );
  }

  /**
   * Starts the `aird` Windows Service.
   */
  async start(): Promise<void> {
    const exists = await this.serviceExists();
    if (!exists) {
      throw new AirError(
        'NOT_FOUND',
        `Service "${this.serviceName}" is not installed`,
        { context: { serviceName: this.serviceName } },
      );
    }

    const result = await this.runSc(['start', this.serviceName]);
    if (!result.success) {
      // ERROR_SERVICE_ALREADY_RUNNING (1056) is not an error.
      if (result.message.includes('1056')) {
        this.logger.info(
          { event: 'service.already_running', serviceName: this.serviceName },
          `Service "${this.serviceName}" is already running`,
        );
        return;
      }
      throw new AirError(
        'INTERNAL',
        `Failed to start service "${this.serviceName}": ${result.message}`,
        { context: { serviceName: this.serviceName } },
      );
    }

    this.logger.info(
      { event: 'service.started', serviceName: this.serviceName },
      `Service "${this.serviceName}" started`,
    );
  }

  /**
   * Stops the `aird` Windows Service.
   */
  async stop(): Promise<void> {
    const exists = await this.serviceExists();
    if (!exists) {
      return;
    }

    const result = await this.runSc(['stop', this.serviceName]);
    if (!result.success && !result.message.includes('1062')) {
      // ERROR_SERVICE_NOT_ACTIVE (1062) means already stopped.
      throw new AirError(
        'INTERNAL',
        `Failed to stop service "${this.serviceName}": ${result.message}`,
        { context: { serviceName: this.serviceName } },
      );
    }

    this.logger.info(
      { event: 'service.stopped', serviceName: this.serviceName },
      `Service "${this.serviceName}" stopped`,
    );
  }

  /**
   * Queries the current status of the `aird` Windows Service.
   */
  async status(): Promise<ServiceStatus | null> {
    const exists = await this.serviceExists();
    if (!exists) {
      return null;
    }

    const result = await this.runSc(['query', this.serviceName]);
    if (!result.success) {
      return null;
    }

    return this.parseQueryOutput(result.message);
  }

  /**
   * Configures recovery actions for the service.
   * Sets restart actions with configurable delay on failure.
   */
  private async configureRecovery(): Promise<void> {
    // sc failure <service> reset= <period> actions= <action>/<delay>...
    // reset period in seconds; 86400 = 1 day.
    const resetPeriod = 86400;

    let action1: string;
    let action2: string;
    let action3: string;

    switch (this.failureAction) {
      case 'restart':
        action1 = `restart/${this.restartDelayMs}`;
        action2 = `restart/${this.restartDelayMs}`;
        action3 = `restart/${this.restartDelayMs}`;
        break;
      case 'reboot':
        action1 = 'reboot/';
        action2 = 'reboot/';
        action3 = 'reboot/';
        break;
      case 'none':
      default:
        action1 = 'none/';
        action2 = 'none/';
        action3 = 'none/';
        break;
    }

    await this.runSc([
      'failure',
      this.serviceName,
      `reset= ${resetPeriod}`,
      `actions= ${action1}/${action2}/${action3}`,
    ]);

    // Also set the failure command to run the service executable again.
    await this.runSc([
      'failure',
      this.serviceName,
      `command= "${this.exePath}"`,
    ]);
  }

  /**
   * Checks whether the service exists in the SCM.
   */
  private async serviceExists(): Promise<boolean> {
    const result = await this.runSc(['query', this.serviceName]);
    return result.success && !result.message.includes('1060'); // ERROR_SERVICE_DOES_NOT_EXIST
  }

  /**
   * Runs an `sc.exe` command and returns the result.
   */
  private async runSc(args: readonly string[]): Promise<{ success: boolean; message: string }> {
    return new Promise<{ success: boolean; message: string }>((resolve) => {
      const child = spawn('sc.exe', args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });

      child.on('close', (code: number | null) => {
        const success = code === 0;
        const message = (stdout || stderr || '').trim();
        resolve({ success, message });
      });

      child.on('error', (err: Error) => {
        resolve({
          success: false,
          message: `Failed to execute sc.exe: ${err.message}`,
        });
      });
    });
  }

  /**
   * Parses the output of `sc query <service>` into a ServiceStatus.
   */
  private parseQueryOutput(output: string): ServiceStatus {
    const lines = output.split('\n');
    let name = '';
    let displayName = '';
    let status: ServiceStatus['status'] = 'stopped';
    let acceptedControls: string[] = [];
    let checkpoint = 0;
    let waitHint = 0;
    let pid = 0;
    let flags = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('SERVICE_NAME:')) {
        const parts = trimmed.split(':');
        name = (parts[1] ?? '').trim();
      } else if (trimmed.startsWith('DISPLAY_NAME:')) {
        const parts = trimmed.split(':');
        displayName = (parts[1] ?? '').trim();
      } else if (trimmed.startsWith('STATE')) {
        // Format: STATE : 4  RUNNING
        const stateMatch = trimmed.match(/STATE\s*:\s*\d+\s+(\w+)/);
        if (stateMatch) {
          const stateMatch1 = stateMatch[1];
          if (stateMatch1 !== undefined) {
            const stateStr = stateMatch1.toLowerCase();
            switch (stateStr) {
              case 'running':
                status = 'running';
                break;
              case 'start_pending':
                status = 'start_pending';
                break;
              case 'stop_pending':
                status = 'stop_pending';
                break;
              case 'continue_pending':
                status = 'continue_pending';
                break;
              case 'pause_pending':
                status = 'pause_pending';
                break;
              case 'paused':
                status = 'pause';
                break;
              case 'stopped':
              default:
                status = 'stopped';
                break;
            }
          }
        }
      } else if (trimmed.startsWith('ACCEPTS')) {
        // Format: ACCEPTS :  STOP SHUTDOWN ...
        const acceptsMatch = trimmed.match(/ACCEPTS\s*:\s*(.*)/);
        if (acceptsMatch) {
          const acceptsStr = acceptsMatch[1] ?? '';
          acceptedControls = acceptsStr
            .trim()
            .split(/\s+/)
            .filter((c) => c.length > 0);
        }
      } else if (trimmed.startsWith('CHECKPOINT')) {
        const cpMatch = trimmed.match(/CHECKPOINT\s*:\s*(\d+)/);
        if (cpMatch) {
          checkpoint = parseInt(cpMatch[1] ?? '0', 10) || 0;
        }
      } else if (trimmed.startsWith('WAIT_HINT')) {
        const whMatch = trimmed.match(/WAIT_HINT\s*:\s*(\d+)/);
        if (whMatch) {
          waitHint = parseInt(whMatch[1] ?? '0', 10) || 0;
        }
      } else if (trimmed.startsWith('PID')) {
        const pidMatch = trimmed.match(/PID\s*:\s*(\d+)/);
        if (pidMatch) {
          pid = parseInt(pidMatch[1] ?? '0', 10) || 0;
        }
      } else if (trimmed.startsWith('FLAGS')) {
        const flagsMatch = trimmed.match(/FLAGS\s*:\s*(\d+)/);
        if (flagsMatch) {
          flags = parseInt(flagsMatch[1] ?? '0', 10) || 0;
        }
      }
    }

    return {
      name,
      displayName,
      status,
      acceptedControls,
      checkpoint,
      waitHint,
      pid,
      flags,
    };
  }
}

/**
 * Installs `aird` as a Windows Service with default options.
 * Convenience function for programmatic installation.
 */
export async function installAirService(options?: ServiceInstallOptions): Promise<void> {
  const service = new WindowsService(options);
  await service.install();
}

/**
 * Uninstalls the `aird` Windows Service.
 */
export async function uninstallAirService(options?: ServiceInstallOptions): Promise<void> {
  const service = new WindowsService(options);
  await service.uninstall();
}

/**
 * Starts the `aird` Windows Service.
 */
export async function startAirService(options?: ServiceInstallOptions): Promise<void> {
  const service = new WindowsService(options);
  await service.start();
}

/**
 * Stops the `aird` Windows Service.
 */
export async function stopAirService(options?: ServiceInstallOptions): Promise<void> {
  const service = new WindowsService(options);
  await service.stop();
}

/**
 * Queries the status of the `aird` Windows Service.
 */
export async function queryAirService(options?: ServiceInstallOptions): Promise<ServiceStatus | null> {
  const service = new WindowsService(options);
  return service.status();
}
