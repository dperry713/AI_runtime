/**
 * Fault-injection tests for the OS process boundary.
 *
 * All child processes are local Node.js processes with bounded runtime. No
 * shell payloads, network requests, privilege escalation, or host mutations.
 */
import { describe, expect, it } from 'vitest';
import { AirError } from '../../src/errors/index.js';
import { StandardProcessRunner } from '../../src/sandbox/index.js';

describe('Chaos & Fault-Injection: Process lifecycle', () => {
  it('terminates a process that exceeds its deadline and reports a typed timeout', async () => {
    const runner = new StandardProcessRunner({ defaultTimeoutMs: 150 });
    let caught: unknown;

    try {
      await runner.run({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 30_000)'],
        shell: 'none',
        timeoutMs: 150,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AirError);
    expect((caught as AirError).code).toBe('TOOL_TIMEOUT');
    expect(runner.getActiveProcesses()).toHaveLength(0);
  }, 10_000);

  it('cancels an in-flight process and leaves no active child tracked', async () => {
    const runner = new StandardProcessRunner();
    const controller = new AbortController();
    const execution = runner.run({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30_000)'],
      shell: 'none',
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    controller.abort();

    await expect(execution).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AirError);
      expect((error as AirError).code).toBe('CANCELLED');
      return true;
    });
    expect(runner.getActiveProcesses()).toHaveLength(0);
  }, 10_000);

  it('bounds captured output from a noisy child process', async () => {
    const runner = new StandardProcessRunner();
    const result = await runner.run({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(100_000))'],
      shell: 'none',
      maxOutputBytes: 256,
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThan(512);
    expect(result.stdout).toContain('[TRUNCATED: maxOutputBytes exceeded]');
  }, 10_000);

  it('killAll leaves no tracked processes after service-style shutdown', async () => {
    const runner = new StandardProcessRunner();
    const execution = runner.run({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30_000)'],
      shell: 'none',
      timeoutMs: 10_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(runner.getActiveProcesses().length).toBeGreaterThan(0);
    await runner.killAll();
    await execution.catch(() => undefined);
    expect(runner.getActiveProcesses()).toHaveLength(0);
  }, 10_000);
});
