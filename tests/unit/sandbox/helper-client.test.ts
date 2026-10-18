import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path, { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  HELPER_PROTOCOL_VERSION,
  SandboxHelperClient,
} from '../../../src/sandbox/helper-client.js';
import type { ProcessRunner } from '../../../src/sandbox/types.js';
import { FakeClock } from '../../../src/util/index.js';

describe('SandboxHelperClient (P7-T02)', () => {
  const binaryPath = resolve(
    process.cwd(),
    'native/air-sandbox/target/release/air-sandbox.exe',
  );
  const binaryAvailable = existsSync(binaryPath);

  describe('Integrity & Hashing', () => {
    it('computes sha256 of file in jail and verifies expected hash', async () => {
      const jail = mkdtempSync(path.join(os.tmpdir(), 'air-helper-test-'));
      try {
        const dummyFile = 'dummy.bin';
        writeFileSync(resolve(jail, dummyFile), 'air-sandbox-test-binary-content');

        const client = new SandboxHelperClient();
        const hash = await client.computeSha256(jail, dummyFile);
        expect(hash).toHaveLength(64);

        const verified = await client.verifyIntegrity(jail, dummyFile);
        expect(verified).toBe(true);

        const clientWithHash = new SandboxHelperClient({ expectedSha256: hash });
        const match = await clientWithHash.verifyIntegrity(jail, dummyFile);
        expect(match).toBe(true);

        const clientBadHash = new SandboxHelperClient({
          expectedSha256: '0000000000000000000000000000000000000000000000000000000000000000',
        });
        await expect(clientBadHash.verifyIntegrity(jail, dummyFile)).rejects.toThrow(
          /Integrity check failed/,
        );
      } finally {
        rmSync(jail, { recursive: true, force: true });
      }
    });
  });

  describe('Validation & Protocol', () => {
    it('throws INVALID_ARGUMENT if command is empty or whitespace', async () => {
      const client = new SandboxHelperClient();
      await expect(client.execute({ command: '' })).rejects.toThrow(AirError);
      await expect(client.execute({ command: '   ' })).rejects.toThrow(
        /Command cannot be empty/,
      );
    });

    it('throws CANCELLED if signal is already aborted', async () => {
      const client = new SandboxHelperClient();
      const ac = new AbortController();
      ac.abort();

      await expect(
        client.execute({ command: 'cmd.exe', signal: ac.signal }),
      ).rejects.toThrow(/cancelled before start/);
    });

    it('implements ProcessRunner interface', () => {
      const client = new SandboxHelperClient();
      const runner: ProcessRunner = client;
      expect(typeof runner.run).toBe('function');
    });
  });

  describe('Mock Execution Mode', () => {
    it('handles started and completed responses in mock mode', async () => {
      const clock = new FakeClock(1_000);
      const client = new SandboxHelperClient({
        clock,
        mockHandler: (req) => {
          expect(req.version).toBe(HELPER_PROTOCOL_VERSION);
          expect(req.command).toBe('echo');
          clock.advance(50);
          return Promise.resolve([
            { type: 'started', version: HELPER_PROTOCOL_VERSION, pid: 4321 },
            {
              type: 'completed',
              version: HELPER_PROTOCOL_VERSION,
              exit_code: 0,
              peak_memory_bytes: 4096,
              total_cpu_time_ms: 25,
            },
          ]);
        },
      });

      const result = await client.run({ command: 'echo', args: ['hello'] });
      expect(result.exitCode).toBe(0);
      expect(result.pid).toBe(4321);
      expect(result.durationMs).toBe(50);
      expect(result.timedOut).toBe(false);
      expect(result.killed).toBe(false);
    });

    it('translates error response to typed AirError', async () => {
      const client = new SandboxHelperClient({
        mockHandler: () =>
          Promise.resolve([
            {
              type: 'error',
              version: HELPER_PROTOCOL_VERSION,
              code: 'JOB_LIMITS_FAILED',
              message: 'Memory limit too small',
            },
          ]),
      });

      await expect(client.run({ command: 'test' })).rejects.toThrow(
        /Sandbox helper failed: Memory limit too small/,
      );
    });

    it('handles mock without explicit completed response', async () => {
      const client = new SandboxHelperClient({
        mockHandler: () => Promise.resolve([]),
      });

      const res = await client.run({ command: 'noop' });
      expect(res.exitCode).toBe(0);
    });
  });

  describe.runIf(binaryAvailable)('Real air-sandbox.exe Native Execution', () => {
    it('launches process in Job Object, returns pid, exit code and stdout', async () => {
      const client = new SandboxHelperClient({ helperPath: binaryPath });
      const stdoutChunks: string[] = [];

      const result = await client.execute({
        command: 'cmd.exe',
        args: ['/c', 'echo AIR_SANDBOX_OK'],
        limits: {
          killOnClose: true,
          maxProcesses: 4,
          maxMemoryBytes: 128 * 1024 * 1024,
        },
        onStdoutChunk: (chunk) => stdoutChunks.push(chunk),
      });

      expect(result.exitCode).toBe(0);
      expect(result.pid).toBeDefined();
      expect(result.pid).toBeGreaterThan(0);
      expect(result.stdout).toContain('AIR_SANDBOX_OK');
      expect(stdoutChunks.join('')).toContain('AIR_SANDBOX_OK');
      expect(result.timedOut).toBe(false);
      expect(result.killed).toBe(false);
    });

    it('captures non-zero exit codes accurately', async () => {
      const client = new SandboxHelperClient({ helperPath: binaryPath });
      const result = await client.execute({
        command: 'cmd.exe',
        args: ['/c', 'exit 42'],
      });

      expect(result.exitCode).toBe(42);
    });

    it('streams stderr chunks through onStderrChunk callback', async () => {
      const client = new SandboxHelperClient({ helperPath: binaryPath });
      const stderrChunks: string[] = [];

      const result = await client.execute({
        command: 'cmd.exe',
        args: ['/c', 'echo error_stream 1>&2'],
        onStderrChunk: (chunk) => stderrChunks.push(chunk),
      });

      expect(result.exitCode).toBe(0);
      expect(stderrChunks.join('')).toContain('error_stream');
    });

    it('aborts execution when signal triggers', async () => {
      const client = new SandboxHelperClient({ helperPath: binaryPath });
      const ac = new AbortController();

      setTimeout(() => ac.abort(), 100);

      await expect(
        client.execute({
          command: 'powershell.exe',
          args: ['-Command', 'Start-Sleep -Seconds 5'],
          signal: ac.signal,
        }),
      ).rejects.toThrow(/cancelled/);
    });

    it('handles timeout when process exceeds timeoutMs', async () => {
      const client = new SandboxHelperClient({ helperPath: binaryPath });

      const result = await client.execute({
        command: 'powershell.exe',
        args: ['-Command', 'Start-Sleep -Seconds 5'],
        timeoutMs: 300,
      });

      expect(result.timedOut).toBe(true);
      expect(result.killed).toBe(true);
    });

    it('returns error when command is invalid executable', async () => {
      const client = new SandboxHelperClient({ helperPath: binaryPath });

      await expect(
        client.execute({
          command: 'non_existent_binary_xyz_12345.exe',
        }),
      ).rejects.toThrow(AirError);
    });

    it('returns error when working directory does not exist', async () => {
      const client = new SandboxHelperClient({ helperPath: binaryPath });

      await expect(
        client.execute({
          command: 'cmd.exe',
          args: ['/c', 'echo test'],
          cwd: 'C:\\non_existent_directory_987654321',
        }),
      ).rejects.toThrow(/Working directory does not exist/);
    });
  });
});
