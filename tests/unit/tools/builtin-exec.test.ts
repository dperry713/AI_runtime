/**
 * Unit tests for Built-in Exec Tool (Phase 4 - P4-T05).
 */

import { describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import { MockProcessRunner } from '../../../src/sandbox/index.js';
import {
  BUILTIN_EXEC_TOOLS,
  createExecRunTool,
  execRunTool,
  registerBuiltinExecTools,
} from '../../../src/tools/builtin/exec.js';
import { ToolExecutor } from '../../../src/tools/executor.js';
import { ToolRegistry } from '../../../src/tools/registry.js';

describe('Built-in Exec Tool (P4-T05)', () => {
  describe('Contract and Metadata', () => {
    it('declares high risk and non-idempotent semantics', () => {
      expect(execRunTool.name).toBe('exec.run');
      expect(execRunTool.risk).toBe('high');
      expect(execRunTool.idempotent).toBe(false);
      expect(BUILTIN_EXEC_TOOLS.length).toBe(1);
    });

    it('derives exec capabilities dynamically', () => {
      const caps = execRunTool.capabilities?.({
        command: 'Get-Process',
        shell: 'powershell',
        cwd: 'c:/workspace',
      });

      expect(caps).toEqual([
        {
          type: 'exec',
          action: 'run',
          resource: 'Get-Process',
          meta: { shell: 'powershell', cwd: 'c:/workspace' },
        },
      ]);
    });
  });

  describe('Execution via MockProcessRunner', () => {
    it('dispatches command to runner and returns stdout/exitCode', async () => {
      const mockRunner = new MockProcessRunner();
      mockRunner.queueStep({
        exitCode: 0,
        stdout: 'Node v22.0.0\n',
        stderr: '',
        durationMs: 45,
      });

      const tool = createExecRunTool(mockRunner);
      const executor = new ToolExecutor();

      const result = await executor.execute({
        tool,
        runId: 'run-000001',
        input: { command: 'node -v', shell: 'none' },
      });

      const output = result.output;

      expect(output.command).toBe('node -v');
      expect(output.exitCode).toBe(0);
      expect(output.stdout).toBe('Node v22.0.0\n');
      expect(output.stderr).toBe('');
      expect(output.timedOut).toBe(false);

      expect(mockRunner.history.length).toBe(1);
      expect(mockRunner.history[0]?.command).toBe('node -v');
      expect(mockRunner.history[0]?.shell).toBe('none');
    });

    it('returns non-zero exit codes and stderr accurately', async () => {
      const mockRunner = new MockProcessRunner();
      mockRunner.queueStep({
        exitCode: 1,
        stdout: '',
        stderr: 'Error: Cannot find module\n',
        durationMs: 30,
      });

      const tool = createExecRunTool(mockRunner);
      const executor = new ToolExecutor();

      const result = await executor.execute({
        tool,
        runId: 'run-000001',
        input: { command: 'node missing.js' },
      });

      const output = result.output as { exitCode: number; stderr: string };
      expect(output.exitCode).toBe(1);
      expect(output.stderr).toContain('Cannot find module');
    });

    it('propagates runner timeout error', async () => {
      const mockRunner = new MockProcessRunner();
      mockRunner.queueStep({ timedOut: true });

      const tool = createExecRunTool(mockRunner);
      const executor = new ToolExecutor();

      await expect(
        executor.execute({
          tool,
          runId: 'run-000001',
          input: { command: 'sleep 100' },
        }),
      ).rejects.toThrowError(AirError);
    });

    it('propagates cancellation signal', async () => {
      const mockRunner = new MockProcessRunner();
      const tool = createExecRunTool(mockRunner);
      const executor = new ToolExecutor();
      const abortCtrl = new AbortController();
      abortCtrl.abort();

      await expect(
        executor.execute({
          tool,
          runId: 'run-000001',
          input: { command: 'long-job' },
          signal: abortCtrl.signal,
        }),
      ).rejects.toThrowError(AirError);
    });
  });

  describe('Execution via Real OS Process (NaiveProcessRunner)', () => {
    it('executes a real command and captures stdout', async () => {
      const executor = new ToolExecutor();

      // Run node to ensure cross-platform reproducibility
      const result = await executor.execute({
        tool: execRunTool,
        runId: 'run-000001',
        input: {
          command: 'node -e "console.log(\'AIR_EXEC_SUCCESS\')"',
          shell: 'cmd',
        },
      });

      const output = result.output as {
        exitCode: number;
        stdout: string;
        stderr: string;
      };

      expect(output.exitCode).toBe(0);
      expect(output.stdout).toContain('AIR_EXEC_SUCCESS');
    });

    it('captures non-zero exit code from failing real command', async () => {
      const executor = new ToolExecutor();

      const result = await executor.execute({
        tool: execRunTool,
        runId: 'run-000001',
        input: {
          command: 'node -e "process.exit(42)"',
          shell: 'cmd',
        },
      });

      const output = result.output as { exitCode: number };
      expect(output.exitCode).toBe(42);
    });

    it('kills process and throws TOOL_TIMEOUT on real timeout', async () => {
      const executor = new ToolExecutor();

      await expect(
        executor.execute({
          tool: execRunTool,
          runId: 'run-000001',
          input: {
            command: 'node -e "setTimeout(() => {}, 5000)"',
            shell: 'cmd',
            timeoutMs: 50,
          },
        }),
      ).rejects.toThrowError(AirError);

      try {
        await executor.execute({
          tool: execRunTool,
          runId: 'run-000001',
          input: {
            command: 'node -e "setTimeout(() => {}, 5000)"',
            shell: 'cmd',
            timeoutMs: 50,
          },
        });
      } catch (err) {
        expect((err as AirError).code).toBe('TOOL_TIMEOUT');
      }
    });
  });

  describe('Registry Integration', () => {
    it('registers exec.run into ToolRegistry and dispatches correctly', async () => {
      const registry = new ToolRegistry();
      const mockRunner = new MockProcessRunner();
      mockRunner.queueStep({ exitCode: 0, stdout: 'registry works' });

      registerBuiltinExecTools(registry, mockRunner);

      expect(registry.has('exec.run')).toBe(true);

      const executor = new ToolExecutor({ registry });
      const result = await executor.execute({
        toolName: 'exec.run',
        runId: 'run-000001',
        input: { command: 'echo test' },
      });

      expect((result.output as { stdout: string }).stdout).toBe('registry works');
    });
  });
});
