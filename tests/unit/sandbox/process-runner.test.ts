/**
 * StandardProcessRunner Unit Tests (Phase 7 - P7-T01).
 *
 * Verifies:
 * - Environment allowlist scrubbing and sensitive token redaction (ADR-0004 / Rule R4)
 * - Working directory jailing via paths library (Rule R5)
 * - Stdio caps, byte truncation, and real-time streaming hooks
 * - Stdin data piping to child processes
 * - Timeout enforcement with process tree termination (taskkill /T)
 * - Cooperative AbortSignal cancellation
 * - Active process tracking and killAll orphan cleanup
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  DEFAULT_ENV_ALLOWLIST,
  StandardProcessRunner,
  isBlockedEnvName,
  scrubEnvironment,
} from '../../../src/sandbox/index.js';

describe('StandardProcessRunner (P7-T01)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-sandbox-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe('Environment Scrubbing & Allowlisting (Rule R4 / ADR-0004)', () => {
    it('detects blocked sensitive environment variable patterns', () => {
      expect(isBlockedEnvName('OPENAI_API_KEY')).toBe(true);
      expect(isBlockedEnvName('ANTHROPIC_API_KEY')).toBe(true);
      expect(isBlockedEnvName('AIR_ENCRYPTION_KEY')).toBe(true);
      expect(isBlockedEnvName('GITHUB_TOKEN')).toBe(true);
      expect(isBlockedEnvName('AWS_SECRET_ACCESS_KEY')).toBe(true);
      expect(isBlockedEnvName('DATABASE_PASSWORD')).toBe(true);
      expect(isBlockedEnvName('JWT_AUTH_SECRET')).toBe(true);
      expect(isBlockedEnvName('PRIVATE_CERT_KEY')).toBe(true);

      expect(isBlockedEnvName('PATH')).toBe(false);
      expect(isBlockedEnvName('SYSTEMROOT')).toBe(false);
      expect(isBlockedEnvName('TEMP')).toBe(false);
      expect(isBlockedEnvName('HOMEDRIVE')).toBe(false);

      expect(DEFAULT_ENV_ALLOWLIST).toContain('PATH');
      expect(DEFAULT_ENV_ALLOWLIST).toContain('TEMP');
      expect(DEFAULT_ENV_ALLOWLIST).toContain('SYSTEMROOT');
    });

    it('scrubs ambient secrets from base environment by default', () => {
      const baseEnv: NodeJS.ProcessEnv = {
        PATH: 'C:\\Windows\\system32',
        TEMP: 'C:\\Temp',
        USERPROFILE: 'C:\\Users\\alice',
        OPENAI_API_KEY: 'sk-secret-12345',
        ANTHROPIC_API_KEY: 'sk-ant-secret-67890',
        AIR_SECRET_KEY: 'rad-radioactive',
        CUSTOM_AUTH_TOKEN: 'bearer-xyz',
        RANDOM_UNLISTED_VAR: 'untrusted_value',
      };

      const scrubbed = scrubEnvironment({
        baseEnv,
        userEnv: { CUSTOM_APP_VAR: 'hello' },
      });

      // Allowlisted safe variables retained
      expect(scrubbed['PATH']).toBe('C:\\Windows\\system32');
      expect(scrubbed['TEMP']).toBe('C:\\Temp');
      expect(scrubbed['USERPROFILE']).toBe('C:\\Users\\alice');

      // Sensitive and unlisted variables scrubbed
      expect(scrubbed['OPENAI_API_KEY']).toBeUndefined();
      expect(scrubbed['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(scrubbed['AIR_SECRET_KEY']).toBeUndefined();
      expect(scrubbed['CUSTOM_AUTH_TOKEN']).toBeUndefined();
      expect(scrubbed['RANDOM_UNLISTED_VAR']).toBeUndefined();

      // Explicit userEnv added
      expect(scrubbed['CUSTOM_APP_VAR']).toBe('hello');
    });

    it('handles case-insensitive allowlisting on Windows', () => {
      const baseEnv: NodeJS.ProcessEnv = {
        path: 'C:\\Windows\\system32',
        Temp: 'C:\\Temp',
        Windir: 'C:\\Windows',
      };

      const scrubbed = scrubEnvironment({ baseEnv });
      expect(scrubbed['path']).toBe('C:\\Windows\\system32');
      expect(scrubbed['Temp']).toBe('C:\\Temp');
      expect(scrubbed['Windir']).toBe('C:\\Windows');
    });

    it('still scrubs blocked sensitive tokens even in passThrough mode unless explicitly in userEnv', () => {
      const baseEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
        MY_SETTING: 'active',
        OPENAI_API_KEY: 'sk-ambient-secret',
        AIR_MASTER_KEY: 'radioactive',
      };

      const scrubbed = scrubEnvironment({
        baseEnv,
        passThrough: true,
        userEnv: {
          OPENAI_API_KEY: 'explicitly-passed-key',
        },
      });

      expect(scrubbed['NODE_ENV']).toBe('test');
      expect(scrubbed['MY_SETTING']).toBe('active');
      expect(scrubbed['AIR_MASTER_KEY']).toBeUndefined();
      expect(scrubbed['OPENAI_API_KEY']).toBe('explicitly-passed-key');
    });
  });

  describe('OS Process Execution & Shell Handling', () => {
    it('executes a command line and captures stdout', async () => {
      const runner = new StandardProcessRunner();
      const result = await runner.run({
        command: 'node -e "process.stdout.write(\'HELLO_AIR_SANDBOX\')"',
        shell: 'cmd',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('HELLO_AIR_SANDBOX');
      expect(result.stderr).toBe('');
      expect(result.timedOut).toBe(false);
      expect(result.killed).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.pid).toBe('number');
    });

    it('captures stderr from failing commands', async () => {
      const runner = new StandardProcessRunner();
      const result = await runner.run({
        command: 'node -e "process.stderr.write(\'SANDBOX_ERROR_LOG\'); process.exit(13)"',
        shell: 'cmd',
      });

      expect(result.exitCode).toBe(13);
      expect(result.stderr).toBe('SANDBOX_ERROR_LOG');
      expect(result.timedOut).toBe(false);
    });

    it('executes direct binary execution without shell', async () => {
      const runner = new StandardProcessRunner();
      const result = await runner.run({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("DIRECT_EXEC_SUCCESS")'],
        shell: 'none',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('DIRECT_EXEC_SUCCESS');
    });

    it('throws INVALID_ARGUMENT on empty command', async () => {
      const runner = new StandardProcessRunner();
      await expect(runner.run({ command: '   ' })).rejects.toThrow(AirError);
      await expect(runner.run({ command: '' })).rejects.toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      );
    });
  });

  describe('Working Directory & Path Jail Validation (Rule R5)', () => {
    it('allows execution inside workspace jail', async () => {
      const subDir = path.join(tempDir, 'subproject');
      fs.mkdirSync(subDir);

      const runner = new StandardProcessRunner({ workspaceRoot: tempDir });
      const result = await runner.run({
        command: 'node -e "process.stdout.write(process.cwd())"',
        cwd: subDir,
        shell: 'cmd',
      });

      expect(result.exitCode).toBe(0);
      // Normalized path should match subDir
      expect(result.stdout.toLowerCase()).toBe(subDir.toLowerCase());
    });

    it('throws PERMISSION_DENIED when cwd escapes workspace jail', async () => {
      const outsideDir = os.tmpdir();
      const jail = path.join(tempDir, 'jail');
      fs.mkdirSync(jail);

      const runner = new StandardProcessRunner({ workspaceRoot: jail });
      try {
        await runner.run({
          command: 'node -e "process.exit(0)"',
          cwd: outsideDir,
          shell: 'cmd',
        });
        expect.fail('Expected PERMISSION_DENIED error');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AirError);
        const airErr = err as AirError;
        expect(airErr.code).toBe('PERMISSION_DENIED');
        expect(airErr.message).toContain('escapes workspace jail');
      }
    });

    it('throws INVALID_ARGUMENT when cwd does not exist inside jail', async () => {
      const runner = new StandardProcessRunner({ workspaceRoot: tempDir });
      const nonExistent = path.join(tempDir, 'does-not-exist');

      try {
        await runner.run({
          command: 'node -e "process.exit(0)"',
          cwd: nonExistent,
          shell: 'cmd',
        });
        expect.fail('Expected INVALID_ARGUMENT error');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AirError);
        const airErr = err as AirError;
        expect(airErr.code).toBe('INVALID_ARGUMENT');
        expect(airErr.message).toContain('does not exist');
      }
    });
  });

  describe('Stdio Caps, Stream Truncation & Streaming Hooks', () => {
    it('truncates stdout when exceeding maxOutputBytes', async () => {
      const runner = new StandardProcessRunner({ defaultMaxOutputBytes: 50 });
      const result = await runner.run({
        command: 'node -e "process.stdout.write(\'A\'.repeat(200))"',
        maxOutputBytes: 50,
        shell: 'cmd',
      });

      expect(result.exitCode).toBe(0);
      expect(result.truncated).toBe(true);
      expect(result.stdout).toContain('[TRUNCATED: maxOutputBytes exceeded]');
    });

    it('invokes onStdoutChunk and onStderrChunk streaming hooks', async () => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      const runner = new StandardProcessRunner();
      const result = await runner.run({
        command:
          'node -e "process.stdout.write(\'chunk1 \'); process.stderr.write(\'err1 \'); process.stdout.write(\'chunk2\')"',
        shell: 'cmd',
        onStdoutChunk: (chunk) => stdoutChunks.push(chunk),
        onStderrChunk: (chunk) => stderrChunks.push(chunk),
      });

      expect(result.exitCode).toBe(0);
      expect(stdoutChunks.join('')).toBe('chunk1 chunk2');
      expect(stderrChunks.join('')).toBe('err1 ');
    });

    it('pipes stdin into child process', async () => {
      const runner = new StandardProcessRunner();
      const result = await runner.run({
        command:
          'node -e "let b=\'\'; process.stdin.on(\'data\', d => b+=d); process.stdin.on(\'end\', () => process.stdout.write(\'ECHO:\' + b))"',
        shell: 'cmd',
        stdin: 'payload_from_caller',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('ECHO:payload_from_caller');
    });
  });

  describe('Timeout, Cancellation & Process Tree Termination', () => {
    it('throws CANCELLED when signal is already aborted before spawn', async () => {
      const runner = new StandardProcessRunner();
      const controller = new AbortController();
      controller.abort();

      await expect(
        runner.run({
          command: 'node -e "process.exit(0)"',
          signal: controller.signal,
          shell: 'cmd',
        }),
      ).rejects.toThrow(
        expect.objectContaining({ code: 'CANCELLED' }),
      );
    });

    it('terminates process tree and throws CANCELLED on abort during execution', async () => {
      const runner = new StandardProcessRunner();
      const controller = new AbortController();

      const runPromise = runner.run({
        command: 'node -e "setTimeout(() => {}, 10000)"',
        signal: controller.signal,
        shell: 'cmd',
      });

      // Abort after 50ms
      setTimeout(() => {
        controller.abort();
      }, 50);

      await expect(runPromise).rejects.toThrow(
        expect.objectContaining({ code: 'CANCELLED' }),
      );
    });

    it('terminates process tree and throws TOOL_TIMEOUT on timeout', async () => {
      const runner = new StandardProcessRunner();

      try {
        await runner.run({
          command: 'node -e "setTimeout(() => {}, 10000)"',
          timeoutMs: 100,
          shell: 'cmd',
        });
        expect.fail('Expected TOOL_TIMEOUT error');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AirError);
        const airErr = err as AirError;
        expect(airErr.code).toBe('TOOL_TIMEOUT');
        expect(airErr.message).toContain('timed out after 100ms');
      }
    });
  });

  describe('Active Process Tracking & killAll', () => {
    it('tracks active processes and cleans up after completion', async () => {
      const runner = new StandardProcessRunner();
      expect(runner.getActiveProcesses()).toHaveLength(0);

      const promise = runner.run({
        command: 'node -e "setTimeout(() => {}, 200)"',
        shell: 'cmd',
      });

      // Wait a tick for process to spawn
      await new Promise((r) => setTimeout(r, 50));
      const active = runner.getActiveProcesses();
      expect(active.length).toBeGreaterThanOrEqual(1);

      await promise;
      expect(runner.getActiveProcesses()).toHaveLength(0);
    });

    it('killAll terminates all running processes', async () => {
      const runner = new StandardProcessRunner();

      const p1 = runner.run({
        command: 'node -e "setTimeout(() => {}, 15000)"',
        shell: 'cmd',
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(runner.getActiveProcesses().length).toBeGreaterThanOrEqual(1);

      await runner.killAll();

      // Catch the terminated process promise
      await p1.catch(() => {});
      expect(runner.getActiveProcesses()).toHaveLength(0);
    });
  });
});
