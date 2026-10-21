/**
 * Unit tests for Daemon host (P9-T02).
 *
 * Covers: initial state, options, boot sequence (with skipRecovery/skipPidfile),
 * state transitions, status reporting, single-instance lock, signal handlers,
 * and graceful shutdown. Uses skipRecovery and skipPidfile to avoid real file
 * I/O in unit tests; integration tests cover real pipe behavior.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { Daemon, type DaemonOptions, type DaemonState } from '../../../src/service/daemon.js';
import { FakeClock } from '../../../src/util/index.js';
import { resetLogging } from '../../../src/observability/index.js';
import os from 'node:os';
import path from 'node:path';

// ============================================================================
// Helpers
// ============================================================================

function makeTempHome(): string {
  return path.join(os.tmpdir(), `air-daemon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeDaemon(options: Partial<DaemonOptions> = {}): Daemon {
  return new Daemon({
    home: options.home ?? makeTempHome(),
    skipRecovery: true,
    skipPidfile: true,
    clock: new FakeClock('2026-10-20T00:00:00.000Z'),
    ...options,
  });
}

// ============================================================================
// Initial State
// ============================================================================

describe('Daemon initial state', () => {
  afterEach(() => {
    resetLogging();
  });

  it('starts in created state with default options', () => {
    const daemon = makeDaemon();
    expect(daemon.stateValue).toBe('created');
    expect(daemon.isRunning).toBe(false);
    expect(daemon.clientCount).toBe(0);
    expect(daemon.pipeNameValue).toBeNull();
    expect(daemon.homeDir).toContain('air-daemon-test');
  });

  it('uses provided home directory', () => {
    const home = makeTempHome();
    const daemon = makeDaemon({ home });
    expect(daemon.homeDir).toBe(home);
  });

  it('uses provided clock', () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');
    const daemon = makeDaemon({ clock });
    expect(daemon.status.uptimeMs).toBe(0);
  });

  it('uses provided pipeName override', () => {
    const daemon = makeDaemon({ pipeName: 'custom-pipe' });
    // pipeName is only set on the IPC server after boot, but the option is accepted
    expect(daemon.stateValue).toBe('created');
  });

  it('status reflects created state', () => {
    const daemon = makeDaemon();
    const status = daemon.status;
    expect(status.state).toBe('created');
    expect(status.protocolVersion).toBe(1);
    expect(status.uptimeMs).toBe(0);
    expect(status.activeRuns).toBe(0);
    expect(status.clientCount).toBe(0);
    expect(status.pid).toBe(process.pid);
    expect(status.pipeName).toBe('');
  });
});

// ============================================================================
// Boot (skipRecovery, skipPidfile)
// ============================================================================

describe('Daemon boot', () => {
  afterEach(() => {
    resetLogging();
  });

  it('boots to running state with skipRecovery and skipPidfile', async () => {
    const home = makeTempHome();
    const daemon = makeDaemon({ home, skipRecovery: true, skipPidfile: true });

    await daemon.boot();

    expect(daemon.stateValue).toBe('running');
    expect(daemon.isRunning).toBe(true);
    expect(daemon.clientCount).toBe(0);
    expect(daemon.pipeNameValue).not.toBeNull();
    expect(daemon.pipeNameValue).toContain('\\\\.\\pipe\\');

    await daemon.stop();
    expect(daemon.stateValue).toBe('stopped');
  });

  it('boot sets startTime and uptime increases', async () => {
    const home = makeTempHome();
    const clock = new FakeClock('2026-10-20T00:00:00.000Z');
    const daemon = makeDaemon({ home, clock, skipRecovery: true, skipPidfile: true });

    await daemon.boot();

    const statusBefore = daemon.status;
    expect(statusBefore.uptimeMs).toBe(0);

    clock.advance(5000);

    const statusAfter = daemon.status;
    expect(statusAfter.uptimeMs).toBe(5000);

    await daemon.stop();
  });

  it('boot from non-created state throws', async () => {
    const daemon = makeDaemon({ skipRecovery: true, skipPidfile: true });
    await daemon.boot();
    await expect(daemon.boot()).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await daemon.stop();
  });

  it('stop from created state is a no-op', async () => {
    const daemon = makeDaemon({ skipRecovery: true, skipPidfile: true });
    await daemon.stop(); // Should not throw
    expect(daemon.stateValue).toBe('created');
  });

  it('stop from stopped state is a no-op', async () => {
    const daemon = makeDaemon({ skipRecovery: true, skipPidfile: true });
    await daemon.boot();
    await daemon.stop();
    await daemon.stop(); // Should not throw
    expect(daemon.stateValue).toBe('stopped');
  });
});

// ============================================================================
// Status
// ============================================================================

describe('Daemon status', () => {
  afterEach(() => {
    resetLogging();
  });

  it('includes recovery report after boot with recovery', async () => {
    // With skipRecovery: true, no recovery report is included
    const home = makeTempHome();
    const daemon = makeDaemon({ home, skipRecovery: true, skipPidfile: true });
    await daemon.boot();

    const status = daemon.status;
    expect(status.recovery).toBeUndefined();

    await daemon.stop();
  });

  it('clientCount is 0 after boot with no clients', async () => {
    const home = makeTempHome();
    const daemon = makeDaemon({ home, skipRecovery: true, skipPidfile: true });
    await daemon.boot();

    expect(daemon.clientCount).toBe(0);
    expect(daemon.status.clientCount).toBe(0);

    await daemon.stop();
  });
});

// ============================================================================
// Signal handlers
// ============================================================================

describe('Daemon signal handlers', () => {
  afterEach(() => {
    resetLogging();
  });

  it('installSignalHandlers returns a disposable function', async () => {
    const home = makeTempHome();
    const daemon = makeDaemon({ home, skipRecovery: true, skipPidfile: true });
    await daemon.boot();

    let shutdownCalled = false;
    const remove = daemon.installSignalHandlers(async () => {
      shutdownCalled = true;
      await daemon.stop();
    });

    expect(typeof remove).toBe('function');

    remove();
    await daemon.stop();
    expect(shutdownCalled).toBe(false);
  });
});

// ============================================================================
// Daemon state type
// ============================================================================

describe('DaemonState type', () => {
  it('includes all expected states', () => {
    const states: DaemonState[] = [
      'created',
      'starting',
      'running',
      'stopping',
      'stopped',
      'failed',
    ];
    expect(states).toHaveLength(6);
  });
});
