/**
 * Sandbox Orphan Process Reaper (Phase 7 - P7-T05).
 *
 * Implements crash-safe orphan process recovery for AIR sandboxed processes:
 * 1. Tracks spawned child processes in `%LOCALAPPDATA%\AIR\run\children.json` (or configured runtime dir).
 * 2. On daemon startup (`aird`) or sandbox initialization, detects leftover active PIDs from previous runs.
 * 3. Safely verifies process liveness and forcibly reaps orphan process trees using `taskkill /T /F`.
 * 4. Persists state atomically with Windows lock handling and strict jail boundaries (Rule R2, R5, R10).
 *
 * Adheres to:
 * - Rule R1: Structured logging via src/observability
 * - Rule R2: File operations strictly via src/util/fs-safe
 * - Rule R6: Injectable Clock
 * - Rule R7: Strict TypeScript, no any
 * - Rule R10: Runtime data in AIR_HOME / %LOCALAPPDATA%\AIR
 * - Rule R11: Typed AirError errors
 */

import { AirError } from '../errors/index.js';
import { getLogger, type ComponentLogger } from '../observability/index.js';
import {
  readFileIn,
  writeFileAtomicIn,
  existsIn,
  type Clock,
  SystemClock,
} from '../util/index.js';
import { resolveAirHome } from '../config/index.js';
import { killProcessTree } from './process-runner.js';

const defaultLogger = getLogger('orphan-reaper');

export const CHILDREN_REGISTRY_FILENAME = 'run/children.json';
export const CHILDREN_REGISTRY_VERSION = 1;

// ============================================================================
// Types
// ============================================================================

export interface TrackedChildProcess {
  readonly pid: number;
  readonly command: string;
  readonly startTime: number;
  readonly jobName?: string | undefined;
}

export interface TrackedChildrenFile {
  readonly version: number;
  readonly updatedAt: string;
  readonly processes: readonly TrackedChildProcess[];
}

export interface ReapedProcessInfo {
  readonly pid: number;
  readonly command: string;
  readonly terminated: boolean;
  readonly reason: 'alive_and_terminated' | 'already_dead' | 'kill_failed';
  readonly error?: string | undefined;
}

export interface ReapResult {
  readonly totalTracked: number;
  readonly reaped: readonly ReapedProcessInfo[];
  readonly cleanedPids: readonly number[];
}

export interface OrphanReaperOptions {
  /** Root directory for AIR runtime home. Defaults to resolveAirHome(). */
  readonly airHome?: string | undefined;
  /** Injected clock for timestamps. Defaults to SystemClock. */
  readonly clock?: Clock | undefined;
  /** Custom logger instance. */
  readonly logger?: ComponentLogger | undefined;
  /** Optional custom process liveness predicate (for unit testing/mocking). */
  readonly isProcessAliveFn?: ((pid: number) => boolean) | undefined;
  /** Optional custom kill process function (for unit testing/mocking). */
  readonly killProcessTreeFn?: ((pid: number) => void) | undefined;
}

// ============================================================================
// Liveness Helper
// ============================================================================

/**
 * Checks whether an operating system process with the given PID is currently active.
 * Uses signal 0 which checks existence and permissions without delivering a signal.
 */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but is owned by another user or higher integrity level
    return code === 'EPERM';
  }
}

// ============================================================================
// OrphanReaper Implementation
// ============================================================================

export class OrphanReaper {
  private readonly airHome: string;
  private readonly clock: Clock;
  private readonly logger: ComponentLogger;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly killProcessTree: (pid: number) => void;
  private readonly memoryProcesses = new Map<number, TrackedChildProcess>();
  private isLoaded = false;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(options: OrphanReaperOptions = {}) {
    this.airHome = options.airHome ?? resolveAirHome();
    this.clock = options.clock ?? new SystemClock();
    this.logger = options.logger ?? defaultLogger;
    this.isProcessAlive = options.isProcessAliveFn ?? isProcessAlive;
    this.killProcessTree = options.killProcessTreeFn ?? killProcessTree;
  }

  /**
   * Returns the base directory for runtime data.
   */
  getAirHome(): string {
    return this.airHome;
  }

  /**
   * Registers a newly spawned child process into tracking.
   */
  async registerChild(child: TrackedChildProcess): Promise<void> {
    if (child.pid <= 0) {
      throw new AirError('INVALID_ARGUMENT', `Invalid child PID: ${child.pid}`);
    }

    await this.ensureLoaded();
    this.memoryProcesses.set(child.pid, child);
    await this.persist();
  }

  /**
   * Unregisters a completed child process.
   */
  async unregisterChild(pid: number): Promise<void> {
    await this.ensureLoaded();
    if (this.memoryProcesses.has(pid)) {
      this.memoryProcesses.delete(pid);
      await this.persist();
    }
  }

  /**
   * Returns list of currently active tracked child processes.
   */
  async getActiveChildren(): Promise<readonly TrackedChildProcess[]> {
    await this.ensureLoaded();
    return Array.from(this.memoryProcesses.values());
  }

  /**
   * Scans children.json on startup, detects abandoned/orphan processes,
   * terminates alive process trees, and cleans up the tracking file.
   */
  async reapOrphans(): Promise<ReapResult> {
    const rawProcesses = await this.readDiskFile();
    const reaped: ReapedProcessInfo[] = [];
    const cleanedPids: number[] = [];

    for (const proc of rawProcesses) {
      cleanedPids.push(proc.pid);
      const alive = this.isProcessAlive(proc.pid);

      if (alive) {
        try {
          this.killProcessTree(proc.pid);
          reaped.push({
            pid: proc.pid,
            command: proc.command,
            terminated: true,
            reason: 'alive_and_terminated',
          });
          this.logger.warn(
            {
              event: 'sandbox.orphan_reaper.terminated',
              pid: proc.pid,
              command: proc.command,
            },
            `Reaped orphan sandboxed process PID ${proc.pid}`,
          );
        } catch (err) {
          reaped.push({
            pid: proc.pid,
            command: proc.command,
            terminated: false,
            reason: 'kill_failed',
            error: (err as Error).message,
          });
        }
      } else {
        reaped.push({
          pid: proc.pid,
          command: proc.command,
          terminated: false,
          reason: 'already_dead',
        });
      }
    }

    // Reset memory state and persist cleared file
    this.memoryProcesses.clear();
    this.isLoaded = true;
    await this.persist();

    this.logger.info(
      {
        event: 'sandbox.orphan_reaper.completed',
        totalTracked: rawProcesses.length,
        reapedCount: reaped.filter((r) => r.terminated).length,
      },
      `Orphan reaper completed. Cleaned ${rawProcesses.length} tracked records.`,
    );

    return {
      totalTracked: rawProcesses.length,
      reaped,
      cleanedPids,
    };
  }

  /**
   * Clears the children registry file.
   */
  async clearRegistry(): Promise<void> {
    this.memoryProcesses.clear();
    this.isLoaded = true;
    await this.persist();
  }

  // ============================================================================
  // Private Persistence Helpers
  // ============================================================================

  private async ensureLoaded(): Promise<void> {
    if (this.isLoaded) return;
    const fromDisk = await this.readDiskFile();
    this.memoryProcesses.clear();
    for (const proc of fromDisk) {
      this.memoryProcesses.set(proc.pid, proc);
    }
    this.isLoaded = true;
  }

  private async readDiskFile(): Promise<readonly TrackedChildProcess[]> {
    try {
      const exists = await existsIn(this.airHome, CHILDREN_REGISTRY_FILENAME);
      if (!exists) {
        return [];
      }

      const content = await readFileIn(this.airHome, CHILDREN_REGISTRY_FILENAME);
      const parsed = JSON.parse(content) as unknown;

      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'processes' in parsed &&
        Array.isArray((parsed as TrackedChildrenFile).processes)
      ) {
        return (parsed as TrackedChildrenFile).processes;
      }
      return [];
    } catch {
      // In case of torn read or corrupted JSON, return empty and log warning
      return [];
    }
  }

  private async persist(): Promise<void> {
    // Chain writes to ensure serialized atomic updates
    this.writeLock = this.writeLock.then(async () => {
      const payload: TrackedChildrenFile = {
        version: CHILDREN_REGISTRY_VERSION,
        updatedAt: this.clock.now().toISOString(),
        processes: Array.from(this.memoryProcesses.values()),
      };

      const json = JSON.stringify(payload, null, 2);
      await writeFileAtomicIn(this.airHome, CHILDREN_REGISTRY_FILENAME, json);
    });

    await this.writeLock;
  }
}
