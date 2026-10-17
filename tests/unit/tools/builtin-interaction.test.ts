import { describe, expect, it } from 'vitest';
import {
  createPlanUpdateTool,
  createRunFinishTool,
  createUserAskTool,
  planUpdateTool,
  registerBuiltinInteractionTools,
  runFinishTool,
  userAskTool,
} from '../../../src/tools/builtin/interaction.js';
import { ToolExecutor } from '../../../src/tools/executor.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { FakeClock } from '../../../src/util/index.js';

describe('Built-in Interaction Tools (P4-T07)', () => {
  describe('user.ask', () => {
    it('declares risk: low, non-idempotent semantics and capabilities', () => {
      expect(userAskTool.name).toBe('user.ask');
      expect(userAskTool.risk).toBe('low');
      expect(userAskTool.idempotent).toBe(false);

      const getCaps = userAskTool.capabilities;
      expect(getCaps).toBeDefined();
      if (!getCaps) return;

      const caps = getCaps({
        question: 'Should we deploy to production?',
        allowFreeform: true,
      });
      expect(caps[0]?.type).toBe('interaction');
      expect(caps[0]?.action).toBe('ask');
      expect(caps[0]?.resource).toBe('Should we deploy to production?');
    });

    it('returns default fallback answer when no handler is provided', async () => {
      const clock = new FakeClock('2026-10-17T12:00:00.000Z');
      const tool = createUserAskTool({ clock });
      const executor = new ToolExecutor();

      const result = await executor.execute({
        tool,
        runId: 'run-000001',
        input: {
          question: 'Proceed with migration?',
          options: ['Yes', 'No'],
        },
      });

      expect(result.output.answer).toBe('Proceed with default plan.');
      expect(result.output.selectedOption).toBe('Yes');
      expect(result.output.timedOut).toBe(false);
      expect(result.output.answeredAt).toBe('2026-10-17T12:00:00.000Z');
    });

    it('dispatches to custom onAsk handler and captures structured answer', async () => {
      const clock = new FakeClock('2026-10-17T12:05:00.000Z');
      let promptSeen = '';
      let optionsSeen: readonly string[] | undefined;

      const tool = createUserAskTool({
        clock,
        onAsk: (input) => {
          promptSeen = input.question;
          optionsSeen = input.options;
          return Promise.resolve({
            answer: 'Deploy immediately',
            selectedOption: 'Yes',
          });
        },
      });

      const executor = new ToolExecutor();
      const result = await executor.execute({
        tool,
        runId: 'run-000001',
        input: {
          question: 'Are you ready?',
          options: ['Yes', 'Later'],
        },
      });

      expect(promptSeen).toBe('Are you ready?');
      expect(optionsSeen).toEqual(['Yes', 'Later']);
      expect(result.output.answer).toBe('Deploy immediately');
      expect(result.output.selectedOption).toBe('Yes');
      expect(result.output.answeredAt).toBe('2026-10-17T12:05:00.000Z');
    });

    it('handles cancellation via AbortSignal', async () => {
      const abortCtrl = new AbortController();
      abortCtrl.abort();

      const tool = createUserAskTool();
      const executor = new ToolExecutor();

      await expect(
        executor.execute({
          tool,
          runId: 'run-000001',
          signal: abortCtrl.signal,
          input: {
            question: 'Will this be cancelled?',
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('plan.update', () => {
    it('declares risk: low, idempotent semantics and capabilities', () => {
      expect(planUpdateTool.name).toBe('plan.update');
      expect(planUpdateTool.risk).toBe('low');
      expect(planUpdateTool.idempotent).toBe(true);

      const getCaps = planUpdateTool.capabilities;
      expect(getCaps).toBeDefined();
      if (!getCaps) return;

      const caps = getCaps({
        plan: 'Build feature',
        steps: [{ id: '1', description: 'Step 1', status: 'pending' }],
      });
      expect(caps[0]?.type).toBe('agent');
      expect(caps[0]?.action).toBe('plan');
    });

    it('calculates step distribution and status counts accurately', async () => {
      let notifiedPlan = '';
      const tool = createPlanUpdateTool({
        onPlanUpdate: (input) => {
          notifiedPlan = input.plan;
        },
      });

      const executor = new ToolExecutor();
      const result = await executor.execute({
        tool,
        runId: 'run-000001',
        input: {
          plan: 'Complete Phase 4 deliverables',
          notes: 'Exec and HTTP tools verified',
          steps: [
            { id: 'step-1', description: 'Tool contract', status: 'completed' },
            { id: 'step-2', description: 'Registry', status: 'completed' },
            { id: 'step-3', description: 'Executor', status: 'completed' },
            { id: 'step-4', description: 'Built-in fs', status: 'completed' },
            { id: 'step-5', description: 'Built-in exec', status: 'completed' },
            { id: 'step-6', description: 'Built-in http', status: 'completed' },
            { id: 'step-7', description: 'Interaction tools', status: 'in_progress' },
            { id: 'step-8', description: 'Test kit', status: 'pending' },
            { id: 'step-9', description: 'Deprecated step', status: 'skipped' },
            { id: 'step-10', description: 'Broken prototype', status: 'failed' },
          ],
        },
      });

      expect(notifiedPlan).toBe('Complete Phase 4 deliverables');
      expect(result.output.updated).toBe(true);
      expect(result.output.totalSteps).toBe(10);
      expect(result.output.completedSteps).toBe(6);
      expect(result.output.inProgressSteps).toBe(1);
      expect(result.output.pendingSteps).toBe(1);
      expect(result.output.skippedSteps).toBe(1);
      expect(result.output.failedSteps).toBe(1);
    });

    it('rejects empty steps list with validation error', async () => {
      const tool = createPlanUpdateTool();
      const executor = new ToolExecutor();

      await expect(
        executor.execute({
          tool,
          runId: 'run-000001',
          input: {
            plan: 'Empty plan',
            steps: [],
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('run.finish', () => {
    it('declares risk: low, idempotent semantics and capabilities', () => {
      expect(runFinishTool.name).toBe('run.finish');
      expect(runFinishTool.risk).toBe('low');
      expect(runFinishTool.idempotent).toBe(true);

      const getCaps = runFinishTool.capabilities;
      expect(getCaps).toBeDefined();
      if (!getCaps) return;

      const caps = getCaps({
        status: 'success',
        summary: 'Completed all objectives',
      });
      expect(caps[0]?.type).toBe('agent');
      expect(caps[0]?.action).toBe('finish');
    });

    it('completes the run and records summary, status, and artifacts', async () => {
      const clock = new FakeClock('2026-10-17T15:30:00.000Z');
      let finishNotified = false;

      const tool = createRunFinishTool({
        clock,
        onFinish: () => {
          finishNotified = true;
        },
      });

      const executor = new ToolExecutor();
      const result = await executor.execute({
        tool,
        runId: 'run-000001',
        input: {
          status: 'success',
          summary: 'All 8 tasks in Phase 4 completed successfully with 100% test coverage.',
          artifacts: [
            { name: 'report.md', path: 'docs/report.md', description: 'Completion report' },
            { name: 'metrics.json', description: 'Run performance metrics' },
          ],
          metrics: {
            durationMs: 1250,
            testsPassed: 720,
          },
        },
      });

      expect(finishNotified).toBe(true);
      expect(result.output.finished).toBe(true);
      expect(result.output.status).toBe('success');
      expect(result.output.summary).toContain('Phase 4 completed');
      expect(result.output.artifactCount).toBe(2);
      expect(result.output.timestamp).toBe('2026-10-17T15:30:00.000Z');
    });

    it('rejects empty summary with validation error', async () => {
      const tool = createRunFinishTool();
      const executor = new ToolExecutor();

      await expect(
        executor.execute({
          tool,
          runId: 'run-000001',
          input: {
            status: 'success',
            summary: '',
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('Registry Integration', () => {
    it('registers user.ask, plan.update, run.finish into ToolRegistry and dispatches', async () => {
      const registry = new ToolRegistry();
      registerBuiltinInteractionTools(registry);

      expect(registry.has('user.ask')).toBe(true);
      expect(registry.has('plan.update')).toBe(true);
      expect(registry.has('run.finish')).toBe(true);

      const executor = new ToolExecutor({ registry });

      // Dispatch user.ask
      const askRes = await executor.execute({
        toolName: 'user.ask',
        runId: 'run-000001',
        input: {
          question: 'Continue?',
          options: ['Yes', 'No'],
        },
      });
      const askOut = askRes.output as { answer: string };
      expect(askOut.answer).toBe('Proceed with default plan.');

      // Dispatch plan.update
      const planRes = await executor.execute({
        toolName: 'plan.update',
        runId: 'run-000001',
        input: {
          plan: 'Test plan',
          steps: [{ id: '1', description: 'Step 1', status: 'completed' }],
        },
      });
      const planOut = planRes.output as { updated: boolean; totalSteps: number };
      expect(planOut.updated).toBe(true);
      expect(planOut.totalSteps).toBe(1);

      // Dispatch run.finish
      const finishRes = await executor.execute({
        toolName: 'run.finish',
        runId: 'run-000001',
        input: {
          summary: 'Run finished.',
        },
      });
      const finishOut = finishRes.output as { finished: boolean; status: string };
      expect(finishOut.finished).toBe(true);
      expect(finishOut.status).toBe('success');
    });
  });
});
