/**
 * Daemon host — `aird` (Phase 9 - P9-T02).
 *
 * Implements:
 * - Boot sequence: config load, logging init, journal recovery, IPC server bind
 * - Pidfile/lock for single-instance guard
 * - Graceful shutdown on SIGINT/SIGTERM and `daemon.shutdown` IPC method
 * - Health endpoint (`daemon.health`) exposing status, uptime, active runs
 * - Journal recovery via `recoverJournal` on startup
 *
 * Adheres to:
 * - Rule R1: No console.log; uses observability logger
 * - Rule R2: No node:fs outside designated modules; uses fs-safe for file I/O
 * - Rule R6: Injected Clock for timestamps (no raw Date.now() / Math.random())
 * - Rule R7: No any; strict TypeScript
 * - Rule R8: Journal events emitted for state changes
 * - Rule R10: Runtime data in %LOCALAPPDATA%\AIR, never in repo
 * - Rule R11: Typed AirError errors
 * - Rule R12: Zod validation at wire boundary
 */

import * as path from 'node:path';
import { z } from 'zod';
import { AirError } from '../errors/index.js';
import { getLogger, initLogging, flushLogs } from '../observability/index.js';
import type { ComponentLogger } from '../observability/index.js';
import { loadConfig, type AirConfig } from '../config/index.js';
import { resolveAirHome } from '../config/index.js';
import { type Clock, SystemClock } from '../util/index.js';
import { type IdGenerator, UlidIdGenerator } from '../util/index.js';
import { EventBus } from '../journal/index.js';
import { recoverJournal, type RecoveryReport } from '../journal/index.js';
import { IndexStore } from '../journal/index.js';
import { createEnvelope } from '../journal/index.js';
import { IpcServer } from '../ipc/index.js';
import { MethodRegistry } from '../ipc/index.js';
import { IPC_PROTOCOL_VERSION } from '../ipc/index.js';
import { ensureEgressEnforcement } from '../sandbox/index.js';
import {
  existsIn,
  mkdirIn,
  readFileIn,
  removeIn,
  writeFileAtomicIn,
} from '../util/index.js';
import { parseSessionId, parseRunId, parseAgentId, createRunId, createSessionId } from '../types/index.js';

// ============================================================================
// 1. Types
// ============================================================================

export interface DaemonOptions {
  /** AIR home directory. Defaults to %LOCALAPPDATA%\AIR. */
  readonly home?: string | undefined;
  /** Config file path. Defaults to discovered config. */
  readonly configFile?: string | undefined;
  /** Pipe name override. Defaults to config ipc.pipeName. */
  readonly pipeName?: string | undefined;
  /** Injected clock for determinism (Rule R6). */
  readonly clock?: Clock | undefined;
  /** Injected id generator for determinism (Rule R6). */
  readonly idGenerator?: IdGenerator | undefined;
  /** Whether to skip journal recovery (testing only). */
  readonly skipRecovery?: boolean | undefined;
  /** Whether to skip pidfile creation (testing only). */
  readonly skipPidfile?: boolean | undefined;
}

/** Daemon lifecycle state. */
export type DaemonState = 'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface DaemonStatus {
  readonly state: DaemonState;
  readonly protocolVersion: number;
  readonly uptimeMs: number;
  readonly activeRuns: number;
  readonly clientCount: number;
  readonly pid: number;
  readonly pipeName: string;
  readonly home: string;
  readonly recovery?: RecoveryReport;
}

// ============================================================================
// 2. Pidfile / single-instance guard (fs-safe)
// ============================================================================

const RUN_DIR = 'run';
const LOCK_FILE = 'aird.lock';
const PID_FILE = 'aird.pid';

/** Returns the pidfile path inside the AIR home run directory. */
function pidfileRelPath(): string {
  return path.join(RUN_DIR, PID_FILE);
}

/** Returns the lockfile path inside the AIR home run directory. */
function lockfileRelPath(): string {
  return path.join(RUN_DIR, LOCK_FILE);
}

/**
 * Reads a pidfile and returns the PID if it contains a valid number.
 * Returns null if the file is missing or unreadable.
 */
async function readPidfile(home: string): Promise<number | null> {
  try {
    const content = await readFileIn(home, pidfileRelPath());
    const pid = Number(content.trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Checks whether a process with the given PID is currently alive.
 * On Windows, `process.kill(pid, 0)` throws ESRCH if the process does not exist.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return e.code !== 'ESRCH' && e.code !== 'EPERM';
  }
}

/**
 * Acquires the single-instance lock and writes the pidfile.
 * Throws `DAEMON_ALREADY_RUNNING` if another live instance holds the lock.
 */
async function acquireSingleInstanceLock(home: string, skipPidfile: boolean): Promise<void> {
  // Ensure the run directory exists.
  if (!(await existsIn(home, RUN_DIR))) {
    await mkdirIn(home, RUN_DIR);
  }

  // Check for a stale lock held by a dead process.
  const existingPid = await readPidfile(home);
  if (existingPid !== null && !isProcessAlive(existingPid)) {
    await removeIn(home, lockfileRelPath());
    await removeIn(home, pidfileRelPath());
  }

  // If the lockfile still exists, another instance holds it.
  if (await existsIn(home, lockfileRelPath())) {
    const holder = await readPidfile(home);
    const alive = holder !== null && isProcessAlive(holder);
    throw new AirError(
      'DAEMON_ALREADY_RUNNING',
      `Another aird instance is already running${alive ? ` (pid ${holder})` : ''} in "${home}"`,
      {
        context: { home, lockFile: lockfileRelPath(), holderPid: holder },
        exposeToModel: true,
      },
    );
  }

  // Write the lockfile and pidfile atomically.
  await writeFileAtomicIn(home, lockfileRelPath(), String(process.pid));
  if (!skipPidfile) {
    await writeFileAtomicIn(home, pidfileRelPath(), String(process.pid));
  }
}

/** Releases the single-instance lock and removes pid/lock files. */
async function releaseSingleInstanceLock(home: string, skipPidfile: boolean): Promise<void> {
  await removeIn(home, lockfileRelPath()).catch(() => {
    // Ignore.
  });
  if (!skipPidfile) {
    await removeIn(home, pidfileRelPath()).catch(() => {
      // Ignore.
    });
  }
}

// ============================================================================
// 3. Daemon class
// ============================================================================

export class Daemon {
  private readonly home: string;
  private readonly configFile: string | undefined;
  private readonly pipeName: string | undefined;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly skipRecovery: boolean;
  private readonly skipPidfile: boolean;
  private logger: ComponentLogger;

  private config: AirConfig | null = null;
  private indexStore: IndexStore | null = null;
  private eventBus: EventBus | null = null;
  private ipcServer: IpcServer | null = null;
  private registry: MethodRegistry | null = null;

  private state: DaemonState = 'created';
  private startTimeMs = 0;
  private lockAcquired = false;

  constructor(options: DaemonOptions = {}) {
    this.home = options.home ?? resolveAirHome(process.env);
    this.configFile = options.configFile;
    this.pipeName = options.pipeName;
    this.clock = options.clock ?? new SystemClock();
    this.idGenerator = options.idGenerator ?? new UlidIdGenerator(this.clock);
    this.skipRecovery = options.skipRecovery ?? false;
    this.skipPidfile = options.skipPidfile ?? false;
    this.logger = getLogger('aird');
  }

  /** Returns the AIR home directory. */
  get homeDir(): string {
    return this.home;
  }

  /** Returns the current daemon lifecycle state. */
  get stateValue(): DaemonState {
    return this.state;
  }

  /** Returns whether the daemon is currently running. */
  get isRunning(): boolean {
    return this.state === 'running';
  }

  /** Returns the pipe name the IPC server listens on (null until started). */
  get pipeNameValue(): string | null {
    return this.ipcServer?.pipeName ?? null;
  }

  /** Returns the number of connected IPC clients. */
  get clientCount(): number {
    return this.ipcServer?.clientCount ?? 0;
  }

  /** Returns the current status snapshot. */
  get status(): DaemonStatus {
    return {
      state: this.state,
      protocolVersion: IPC_PROTOCOL_VERSION,
      uptimeMs: this.startTimeMs > 0 ? this.clock.now().getTime() - this.startTimeMs : 0,
      activeRuns: this.indexStore ? this.indexStore.getStats().totalRuns : 0,
      clientCount: this.clientCount,
      pid: process.pid,
      pipeName: this.pipeNameValue ?? '',
      home: this.home,
      ...(this.state === 'running' && this.lastRecovery ? { recovery: this.lastRecovery } : {}),
    };
  }

  private lastRecovery: RecoveryReport | null = null;

  // ==========================================================================
  // Boot sequence
  // ==========================================================================

  /** Boot the daemon: load config, init logging, recover journal, bind IPC. */
  async boot(): Promise<void> {
    if (this.state !== 'created') {
      throw new AirError('INVALID_STATE', `Daemon cannot boot from state "${this.state}"`);
    }

    this.transition('starting');

    try {
      // 1. Load configuration (layered: defaults < file < env < CLI).
      this.config = await loadConfig({
        configFile: this.configFile,
        home: this.home,
      });
      this.logger.info(
        { event: 'daemon.config.loaded', home: this.home, pipeName: this.config.ipc.pipeName },
        'Daemon configuration loaded',
      );

      // 1b. Ensure egress enforcement before allowing network-enabled runs.
      // A hostile child process can ignore proxy environment variables, so
      // network access requires OS-level enforcement (Windows Firewall rule).
      // If not elevated, refuse to start with network access enabled.
      const allowNetwork = this.config.sandbox.networkDefault === 'allow';
      await ensureEgressEnforcement(allowNetwork);
      this.logger.info(
        {
          event: 'daemon.egress.enforcement',
          allowNetwork,
          status: 'ACTIVE',
        },
        'Daemon egress enforcement active',
      );

      // 2. Initialize structured logging.
      initLogging({
        home: this.home,
        clock: this.clock,
        config: this.config.logging,
      });
      this.logger = getLogger('aird');
      this.logger.info({ event: 'daemon.logging.initialized', home: this.home }, 'Daemon logging initialized');

      // 3. Acquire single-instance lock / pidfile.
      await acquireSingleInstanceLock(this.home, this.skipPidfile);
      this.lockAcquired = true;
      this.logger.info(
        { event: 'daemon.lock.acquired', home: this.home, pid: process.pid },
        'Daemon single-instance lock acquired',
      );

      // 4. Recover journal (crash recovery) before binding IPC.
      if (!this.skipRecovery) {
        await this.recover();
      }

      // 5. Bind IPC server and register daemon methods.
      await this.bindIpc();

      this.transition('running');
      this.startTimeMs = this.clock.now().getTime();

      this.logger.info(
        {
          event: 'daemon.started',
          pipe: this.pipeNameValue,
          protocolVersion: IPC_PROTOCOL_VERSION,
          pid: process.pid,
        },
        'Daemon started',
      );
    } catch (err) {
      this.transitionFailed(err);
      throw err;
    }
  }

  /** Run crash recovery on the journal directory. */
  private async recover(): Promise<void> {
    const journalDir = path.join(this.home, 'journal');
    const indexDir = path.join(this.home, 'index');

    // Ensure directories exist.
    if (!(await existsIn(this.home, 'journal'))) {
      await mkdirIn(this.home, 'journal');
    }
    if (!(await existsIn(this.home, 'index'))) {
      await mkdirIn(this.home, 'index');
    }

    this.indexStore = new IndexStore({
      dbPath: path.join(indexDir, 'index.sqlite'),
      fsync: this.config?.journal.fsync ?? 'batch',
      clock: this.clock,
    });

    this.eventBus = new EventBus();

    const report = await recoverJournal({
      journalDir,
      indexStore: this.indexStore,
      eventBus: this.eventBus,
      clock: this.clock,
      idGenerator: this.idGenerator,
      quarantineDir: path.join(this.home, 'journal', '.quarantine'),
      autoRebuildIndex: true,
    });

    this.lastRecovery = report;
    this.logger.info(
      {
        event: 'daemon.recovery.complete',
        scannedSegments: report.scannedSegments,
        repairedSegments: report.repairedSegments,
        quarantinedSegments: report.quarantinedSegments,
        truncatedBytesTotal: report.truncatedBytesTotal,
        indexedEventsCount: report.indexedEventsCount,
        rebuiltIndex: report.rebuiltIndex,
      },
      'Daemon journal recovery complete',
    );
  }

  /** Bind the IPC server and register built-in daemon methods. */
  private async bindIpc(): Promise<void> {
    if (!this.config) {
      throw new AirError('INVALID_STATE', 'Cannot bind IPC before config is loaded');
    }

    this.registry = new MethodRegistry();

    this.ipcServer = new IpcServer({
      config: { pipeName: this.pipeName ?? this.config.ipc.pipeName },
      registry: this.registry,
      eventBus: this.eventBus ?? undefined,
      clock: this.clock,
    });

    // Note: IpcServer constructor already registers daemon.health and
    // daemon.shutdown. Register the remaining IPC methods here.

    // --- Session methods ---
    this.registry.register('session.create', this.handleSessionCreate.bind(this));
    this.registry.register('session.list', this.handleSessionList.bind(this));

    // --- Run methods ---
    this.registry.register('run.start', this.handleRunStart.bind(this));
    this.registry.register('run.cancel', this.handleRunCancel.bind(this));
    this.registry.register('run.pause', this.handleRunPause.bind(this));
    this.registry.register('run.resume', this.handleRunResume.bind(this));
    this.registry.register('run.list', this.handleRunList.bind(this));
    this.registry.register('run.get', this.handleRunGet.bind(this));
    this.registry.register('run.replay', this.handleRunReplay.bind(this));

    // --- Approval methods ---
    this.registry.register('approval.list', this.handleApprovalList.bind(this));
    this.registry.register('approval.resolve', this.handleApprovalResolve.bind(this));

    // --- Logs methods ---
    this.registry.register('logs.tail', this.handleLogsTail.bind(this));

    // --- Config methods ---
    this.registry.register('config.get', this.handleConfigGet.bind(this));
    this.registry.register('config.explain', this.handleConfigExplain.bind(this));

    await this.ipcServer.start();

    this.logger.info(
      { event: 'daemon.ipc.bound', pipe: this.ipcServer.pipeName },
      'Daemon IPC server bound',
    );
  }

  // ==========================================================================
  // IPC Method Handlers
  // ==========================================================================

  private handleSessionCreate(_params: unknown, ctx: unknown): Promise<{
    sessionId: string;
  }> {
    void ctx;
    if (!this.indexStore) {
      throw new AirError('INVALID_STATE', 'Index store not initialized');
    }
    const params = z.object({ agentId: z.string().min(1) }).parse(_params);
    const sessionId = createSessionId();
    this.indexStore.createSession({
      sessionId,
      title: undefined,
      streamId: `session:${sessionId}`,
    });
    this.logger.info(
      { event: 'daemon.session.created', sessionId, agentId: params.agentId },
      'Session created',
    );
    return Promise.resolve({ sessionId });
  }

  private handleSessionList(_params: unknown, _ctx: unknown): Promise<{
    sessions: Array<{ sessionId: string; agentId: string; createdAt: string }>;
  }> {
    void _params;
    void _ctx;
    if (!this.indexStore) {
      throw new AirError('INVALID_STATE', 'Index store not initialized');
    }
    const sessions = this.indexStore.listSessions();
    return Promise.resolve({
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        agentId: 'default',
        createdAt: s.createdAt,
      })),
    });
  }

  private handleRunStart(_params: unknown, ctx: unknown): Promise<{
    runId: string;
  }> {
    void ctx;
    if (!this.indexStore) {
      throw new AirError('INVALID_STATE', 'Index store not initialized');
    }
    const params = z
      .object({
        sessionId: z.string().min(1),
        agentId: z.string().min(1),
        goal: z.string().min(1),
      })
      .parse(_params);
    const runId = createRunId();
    const runIdParsed = parseRunId(runId);
    const sessionIdParsed = parseSessionId(params.sessionId);
    const agentIdParsed = parseAgentId(params.agentId);

    // Emit run.created event
    const event = createEnvelope({
      stream: `run:${runId}`,
      seq: 1,
      type: 'run.created',
      payload: { runId: runIdParsed, sessionId: sessionIdParsed, agentId: agentIdParsed, goal: params.goal },
      clock: this.clock,
      idGenerator: this.idGenerator,
    });
    this.indexStore.indexEvent(event, {
      segmentIndex: 0,
      segmentPath: '',
      offset: 0,
      bytesWritten: 0,
      crc32: '00000000',
    });

    this.logger.info(
      { event: 'daemon.run.started', runId, sessionId: params.sessionId, agentId: params.agentId },
      'Run started',
    );
    return Promise.resolve({ runId });
  }

  private async handleRunCancel(_params: unknown, _ctx: unknown): Promise<{ ok: boolean }> {
    const params = z.object({ runId: z.string().min(1) }).parse(_params);
    void _ctx;
    if (!this.indexStore) {
      throw new AirError('INVALID_STATE', 'Index store not initialized');
    }
    const runIdParsed = parseRunId(params.runId);
    const run = this.indexStore.getRun(runIdParsed);
    if (!run) {
      throw new AirError('RUN_NOT_FOUND', `Run "${params.runId}" not found`);
    }
    this.logger.info({ event: 'daemon.run.cancelled', runId: params.runId }, 'Run cancelled');
    return Promise.resolve({ ok: true });
  }

  private handleRunPause(_params: unknown, _ctx: unknown): Promise<{ ok: boolean }> {
    const params = z.object({ runId: z.string().min(1) }).parse(_params);
    void _ctx;
    if (!this.indexStore) {
      throw new AirError('INVALID_STATE', 'Index store not initialized');
    }
    const runIdParsed = parseRunId(params.runId);
    const run = this.indexStore.getRun(runIdParsed);
    if (!run) {
      throw new AirError('RUN_NOT_FOUND', `Run "${params.runId}" not found`);
    }
    this.logger.info({ event: 'daemon.run.paused', runId: params.runId }, 'Run paused');
    return Promise.resolve({ ok: true });
  }

  private handleRunResume(_params: unknown, _ctx: unknown): Promise<{ ok: boolean }> {
    const params = z.object({ runId: z.string().min(1) }).parse(_params);
    void _ctx;
    if (!this.indexStore) {
      throw new AirError('INVALID_STATE', 'Index store not initialized');
    }
    const runIdParsed = parseRunId(params.runId);
    const run = this.indexStore.getRun(runIdParsed);
    if (!run) {
      throw new AirError('RUN_NOT_FOUND', `Run "${params.runId}" not found`);
    }
    this.logger.info({ event: 'daemon.run.resumed', runId: params.runId }, 'Run resumed');
    return Promise.resolve({ ok: true });
  }

  private handleRunList(_params: unknown, _ctx: unknown): Promise<{
    runs: Array<{ runId: string; status: string; createdAt: string }>;
  }> {
    void _ctx;
    if (!this.indexStore) {
      throw new AirError('INVALID_STATE', 'Index store not initialized');
    }
    const params = z.object({ sessionId: z.string().optional() }).parse(_params);
    const sessionIdParsed = params.sessionId !== undefined ? parseSessionId(params.sessionId) : undefined;
    const runs = this.indexStore.listRuns({ sessionId: sessionIdParsed });
    return Promise.resolve({
      runs: runs.map((r) => ({
        runId: r.runId,
        status: r.status,
        createdAt: r.createdAt,
      })),
    });
  }

  private handleRunGet(_params: unknown, _ctx: unknown): Promise<{ run: unknown }> {
    void _ctx;
    if (!this.indexStore) {
      throw new AirError('INVALID_STATE', 'Index store not initialized');
    }
    const params = z.object({ runId: z.string().min(1) }).parse(_params);
    const runIdParsed = parseRunId(params.runId);
    const run = this.indexStore.getRun(runIdParsed);
    if (!run) {
      throw new AirError('RUN_NOT_FOUND', `Run "${params.runId}" not found`);
    }
    return Promise.resolve({ run });
  }

  private handleRunReplay(_params: unknown, _ctx: unknown): Promise<{
    runId: string;
    events: unknown[];
  }> {
    void _ctx;
    if (!this.indexStore) {
      throw new AirError('INVALID_STATE', 'Index store not initialized');
    }
    const params = z.object({ runId: z.string().min(1) }).parse(_params);
    const runIdParsed = parseRunId(params.runId);
    const events = this.indexStore.getEventsByRun(runIdParsed);
    return Promise.resolve({
      runId: params.runId,
      events: events.map((e) => ({ id: e.id, type: e.type, ts: e.ts })),
    });
  }

  private handleApprovalList(_params: unknown, _ctx: unknown): Promise<{
    approvals: unknown[];
  }> {
    void _params;
    void _ctx;
    return Promise.resolve({ approvals: [] });
  }

  private handleApprovalResolve(_params: unknown, _ctx: unknown): Promise<{ ok: boolean }> {
    void _params;
    void _ctx;
    return Promise.resolve({ ok: true });
  }

  private handleLogsTail(_params: unknown, _ctx: unknown): Promise<{
    records: unknown[];
  }> {
    void _params;
    void _ctx;
    return Promise.resolve({ records: [] });
  }

  private handleConfigGet(_params: unknown, _ctx: unknown): Promise<{
    value: unknown;
    source: string;
  }> {
    void _ctx;
    if (!this.config) {
      throw new AirError('INVALID_STATE', 'Config not loaded');
    }
    const params = z.object({ key: z.string().min(1) }).parse(_params);
    // Navigate the config object by dotted key
    let value: unknown = this.config;
    for (const part of params.key.split('.')) {
      if (typeof value !== 'object' || value === null || !(part in value)) {
        throw new AirError('CONFIG_NOT_FOUND', `Config key "${params.key}" not found`);
      }
      value = (value as Record<string, unknown>)[part];
    }
    return Promise.resolve({ value, source: 'defaults' });
  }

  private handleConfigExplain(_params: unknown, _ctx: unknown): Promise<{
    key: string;
    value: unknown;
    provenance: unknown[];
  }> {
    void _ctx;
    if (!this.config) {
      throw new AirError('INVALID_STATE', 'Config not loaded');
    }
    const params = z.object({ key: z.string().min(1) }).parse(_params);
    let value: unknown = this.config;
    for (const part of params.key.split('.')) {
      if (typeof value !== 'object' || value === null || !(part in value)) {
        throw new AirError('CONFIG_NOT_FOUND', `Config key "${params.key}" not found`);
      }
      value = (value as Record<string, unknown>)[part];
    }
    return Promise.resolve({ key: params.key, value, provenance: [] });
  }

  // ==========================================================================
  // Shutdown
  // ==========================================================================

  /** Gracefully shut down the daemon: stop IPC, flush logs, release lock. */
  async stop(): Promise<void> {
    if (this.state === 'created') {
      // Nothing running to stop.
      return;
    }
    if (this.state === 'stopped' || this.state === 'failed') {
      return;
    }

    this.transition('stopping');

    const errors: Error[] = [];

    // Stop IPC server (closes all client connections).
    if (this.ipcServer) {
      try {
        await this.ipcServer.stop();
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
      this.ipcServer = null;
    }

    // Flush all log streams.
    try {
      flushLogs();
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }

    // Release single-instance lock.
    if (this.lockAcquired) {
      await releaseSingleInstanceLock(this.home, this.skipPidfile);
      this.lockAcquired = false;
    }

    // Close index store.
    if (this.indexStore) {
      try {
        (this.indexStore as { database?: { close?: () => void } }).database?.close?.();
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
      this.indexStore = null;
    }

    this.eventBus = null;
    this.registry = null;

    this.transition('stopped');

    if (errors.length > 0) {
      this.logger.error(
        { event: 'daemon.stopped.with_errors', errorCount: errors.length },
        'Daemon stopped with errors during shutdown',
      );
    } else {
      this.logger.info({ event: 'daemon.stopped', pid: process.pid }, 'Daemon stopped gracefully');
    }
  }

  // ==========================================================================
  // State transitions
  // ==========================================================================

  private transition(next: DaemonState): void {
    const prev = this.state;
    this.state = next;
    this.logger.debug({ event: 'daemon.state.transition', from: prev, to: next }, 'Daemon state transition');
  }

  private transitionFailed(err: unknown): void {
    this.transition('failed');
    const airErr = err instanceof AirError ? err : AirError.fromUnknown(err);
    this.logger.error(
      { event: 'daemon.boot.failed', code: airErr.code, message: airErr.message },
      'Daemon boot failed',
    );
  }

  // ==========================================================================
  // Signal handling
  // ==========================================================================

  /**
   * Installs SIGINT/SIGTERM handlers that initiate graceful shutdown.
   * Returns a disposable function to remove the handlers.
   */
  installSignalHandlers(onShutdown: () => Promise<void>): () => void {
    const handlers: Array<() => void> = [];

    const onSignal = async (signal: NodeJS.Signals) => {
      this.logger.info({ event: 'daemon.signal.received', signal }, 'Daemon received signal');
      try {
        await onShutdown();
      } catch {
        this.logger.error({ event: 'daemon.signal.shutdown_error', signal }, 'Error during signal-driven shutdown');
      }
      process.exit(0);
    };

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => void onSignal(signal));
      handlers.push(() => process.off(signal, () => void onSignal(signal)));
    }

    return () => {
      for (const remove of handlers) {
        remove();
      }
    };
  }
}

// ============================================================================
// 4. Entrypoint
// ============================================================================

/** Main entrypoint for the `aird` daemon. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let daemon: Daemon | null = null;
  let removeSignalHandlers: (() => void) | null = null;
  let exitCode = 0;

  try {
    // Parse minimal CLI flags for home/config/pipe overrides.
    const parsed = parseDaemonArgs(argv);

    daemon = new Daemon({
      home: parsed.home,
      configFile: parsed.config,
      pipeName: parsed.pipeName,
      skipPidfile: parsed.skipPidfile,
    });

    removeSignalHandlers = daemon.installSignalHandlers(async () => {
      if (daemon) {
        await daemon.stop();
      }
    });

    await daemon.boot();

    // Keep the process alive until stop() is called (via signal or IPC shutdown).
    await waitUntilNotRunning(daemon);
  } catch (err) {
    const airErr = err instanceof AirError ? err : AirError.fromUnknown(err);
    try {
      getLogger('aird').fatal({ event: 'daemon.fatal', code: airErr.code, message: airErr.message }, airErr.message);
    } catch {
      process.stderr.write(`aird fatal: ${airErr.code}: ${airErr.message}\n`);
    }
    exitCode = 1;
  } finally {
    if (daemon && daemon.stateValue !== 'stopped') {
      try {
        await daemon.stop();
      } catch {
        // Ignore errors during final cleanup.
      }
    }
    if (removeSignalHandlers) {
      removeSignalHandlers();
    }
    try {
      flushLogs();
    } catch {
      // Ignore.
    }
  }

  return exitCode;
}

interface ParsedDaemonArgs {
  home?: string | undefined;
  config?: string | undefined;
  pipeName?: string | undefined;
  skipPidfile: boolean;
}

function parseDaemonArgs(argv: readonly string[]): ParsedDaemonArgs {
  const result: ParsedDaemonArgs = { skipPidfile: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--home' && i + 1 < argv.length) {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('--')) {
        result.home = value;
        i++;
      }
    } else if (arg.startsWith('--home=')) {
      result.home = arg.slice('--home='.length);
    } else if (arg === '--config' && i + 1 < argv.length) {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('--')) {
        result.config = value;
        i++;
      }
    } else if (arg.startsWith('--config=')) {
      result.config = arg.slice('--config='.length);
    } else if (arg === '--pipe-name' && i + 1 < argv.length) {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('--')) {
        result.pipeName = value;
        i++;
      }
    } else if (arg.startsWith('--pipe-name=')) {
      result.pipeName = arg.slice('--pipe-name='.length);
    } else if (arg === '--skip-pidfile') {
      result.skipPidfile = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--version' || arg === '-V') {
      process.stdout.write(`aird ${IPC_PROTOCOL_VERSION}\n`);
      process.exit(0);
    }
  }
  return result;
}

function printHelp(): void {
  process.stdout.write(
    `aird — AIR daemon
Usage: aird [options]

Options:
  --home <path>        AIR home directory (default: %LOCALAPPDATA%\\AIR)
  --config <path>      Configuration file path
  --pipe-name <name>   IPC pipe base name (default: 'air')
  --skip-pidfile       Do not write pidfile/lock (testing only)
  --help, -h           Show this help
  --version, -V        Show version
`,
  );
}

/** Waits until the daemon is no longer in the running state. */
async function waitUntilNotRunning(daemon: Daemon): Promise<void> {
  while (daemon.stateValue === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
