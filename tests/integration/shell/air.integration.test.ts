/**
 * Integration tests for the `air` shell (P9-T04/P9-T05/P9-T07).
 *
 * Spawns a real Daemon with an IPC server on a unique named pipe and verifies
 * the `runAir` entrypoint executes commands end-to-end.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { Daemon } from '../../../src/service/daemon.js';
import { runAir } from '../../../src/shell/main.js';
import { resetLogging } from '../../../src/observability/index.js';
import os from 'node:os';
import path from 'node:path';

function makeTestPipeBase(): string {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2);
  return `air-shell-int-${suffix}`;
}

describe('air shell integration over IPC', () => {
  let daemon: Daemon | null = null;

  afterEach(async () => {
    if (daemon) {
      try {
        await daemon.stop();
      } catch {
        // Ignore stop errors during cleanup
      }
      daemon = null;
    }
    resetLogging();
  });

  it('executes health command and returns success', async () => {
    const home = path.join(os.tmpdir(), `air-shell-int-home-${Date.now()}`);
    const pipeBase = makeTestPipeBase();

    daemon = new Daemon({
      home,
      pipeName: pipeBase,
      skipPidfile: true,
    });
    await daemon.boot();

    const pipeName = daemon.pipeNameValue ?? '';
    // Options must precede the command for commander to parse them
    const code = await runAir(['--pipe-name', pipeName, 'health']);
    expect(code).toBe(0);
  });

  it('executes session.create and session.list commands', async () => {
    const home = path.join(os.tmpdir(), `air-shell-int-home-${Date.now()}`);
    const pipeBase = makeTestPipeBase();

    daemon = new Daemon({
      home,
      pipeName: pipeBase,
      skipPidfile: true,
    });
    await daemon.boot();

    const pipeName = daemon.pipeNameValue ?? '';

    const createCode = await runAir(['--pipe-name', pipeName, 'session.create', 'agent-1']);
    expect(createCode).toBe(0);

    const listCode = await runAir(['--pipe-name', pipeName, 'session.list']);
    expect(listCode).toBe(0);
  });

  it('returns connection error when daemon is not running', async () => {
    const code = await runAir(['--pipe-name', '\\\\.\\pipe\\air-nonexistent-shell-test', 'health']);
    expect(code).toBe(2); // CONNECTION_ERROR
  });

  it('returns command not found for unknown command', async () => {
    const home = path.join(os.tmpdir(), `air-shell-int-home-${Date.now()}`);
    const pipeBase = makeTestPipeBase();

    daemon = new Daemon({
      home,
      pipeName: pipeBase,
      skipRecovery: true,
      skipPidfile: true,
    });
    await daemon.boot();

    const pipeName = daemon.pipeNameValue ?? '';
    const code = await runAir(['--pipe-name', pipeName, 'nonexistent.command']);
    expect(code).toBe(3); // COMMAND_NOT_FOUND
  });
});
