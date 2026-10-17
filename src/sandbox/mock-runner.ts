/**
 * Mock Process Runner for deterministic testing.
 */

import { AirError } from '../errors/index.js';
import type { ProcessRunner, ProcessRunOptions, ProcessRunResult } from './types.js';

export interface MockProcessStep {
  readonly exitCode?: number | undefined;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly timedOut?: boolean | undefined;
  readonly killed?: boolean | undefined;
  readonly error?: Error | undefined;
}

export class MockProcessRunner implements ProcessRunner {
  private readonly queuedSteps: MockProcessStep[] = [];
  public readonly history: ProcessRunOptions[] = [];

  public queueStep(step: MockProcessStep): this {
    this.queuedSteps.push(step);
    return this;
  }

  public run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    this.history.push(options);

    if (options.signal?.aborted) {
      return Promise.reject(new AirError('CANCELLED', 'Mock process execution was cancelled'));
    }

    const nextStep = this.queuedSteps.shift();
    if (!nextStep) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `mock stdout for: ${options.command}`,
        stderr: '',
        durationMs: 10,
        timedOut: false,
        killed: false,
      });
    }

    if (nextStep.error) {
      return Promise.reject(nextStep.error);
    }

    if (nextStep.timedOut) {
      return Promise.reject(new AirError('TOOL_TIMEOUT', `Mock process execution timed out`));
    }

    return Promise.resolve({
      exitCode: nextStep.exitCode ?? 0,
      stdout: nextStep.stdout ?? '',
      stderr: nextStep.stderr ?? '',
      durationMs: nextStep.durationMs ?? 10,
      timedOut: nextStep.timedOut ?? false,
      killed: nextStep.killed ?? false,
    });
  }

  public reset(): void {
    this.queuedSteps.length = 0;
    this.history.length = 0;
  }
}
