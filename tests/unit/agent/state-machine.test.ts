import { describe, expect, it } from 'vitest';
import {
  isTerminalState,
  RunStateMachine,
  RunStateSchema,
  VALID_TRANSITIONS,
} from '../../../src/agent/state-machine.js';
import { AirError } from '../../../src/errors/index.js';
import { createEnvelope, EventBus } from '../../../src/journal/index.js';
import { parseRunId, parseToolCallId } from '../../../src/types/index.js';
import { FakeClock } from '../../../src/util/index.js';

describe('RunStateMachine (P6-T02)', () => {
  const testRunId = parseRunId('run-01HZY000000000000000000001');

  describe('Schemas and Transition Matrix', () => {
    it('validates state schema', () => {
      expect(RunStateSchema.parse('created')).toBe('created');
      expect(RunStateSchema.parse('completed')).toBe('completed');
      expect(() => RunStateSchema.parse('unknown_state')).toThrow();
    });

    it('identifies terminal states', () => {
      expect(isTerminalState('completed')).toBe(true);
      expect(isTerminalState('failed')).toBe(true);
      expect(isTerminalState('cancelled')).toBe(true);
      expect(isTerminalState('budget_exceeded')).toBe(true);

      expect(isTerminalState('created')).toBe(false);
      expect(isTerminalState('starting')).toBe(false);
      expect(isTerminalState('running')).toBe(false);
      expect(isTerminalState('paused')).toBe(false);
      expect(isTerminalState('waiting_approval')).toBe(false);
      expect(isTerminalState('waiting_user')).toBe(false);
    });

    it('defines non-empty transitions for non-terminal states and empty for terminal', () => {
      expect(VALID_TRANSITIONS.get('completed')?.size).toBe(0);
      expect(VALID_TRANSITIONS.get('failed')?.size).toBe(0);
      expect(VALID_TRANSITIONS.get('cancelled')?.size).toBe(0);
      expect(VALID_TRANSITIONS.get('budget_exceeded')?.size).toBe(0);

      expect(VALID_TRANSITIONS.get('created')?.has('starting')).toBe(true);
      expect(VALID_TRANSITIONS.get('starting')?.has('running')).toBe(true);
      expect(VALID_TRANSITIONS.get('running')?.has('completed')).toBe(true);
    });
  });

  describe('Lifecycle State Transitions', () => {
    it('initializes to created by default', () => {
      const clock = new FakeClock('2026-10-17T12:00:00.000Z');
      const machine = new RunStateMachine({ runId: testRunId, clock });

      expect(machine.getState()).toBe('created');
      expect(machine.getRunId()).toBe(testRunId);
      expect(machine.isTerminal()).toBe(false);
      expect(machine.getHistory()).toHaveLength(1);
      expect(machine.getHistory()[0]?.to).toBe('created');
    });

    it('executes normal happy path: created -> starting -> running -> completed', () => {
      const clock = new FakeClock('2026-10-17T12:00:00.000Z');
      const machine = new RunStateMachine({ runId: testRunId, clock });

      const startRec = machine.start();
      expect(startRec.from).toBe('created');
      expect(startRec.to).toBe('starting');
      expect(machine.getState()).toBe('starting');

      const runRec = machine.run(1);
      expect(runRec.from).toBe('starting');
      expect(runRec.to).toBe('running');
      expect(machine.getState()).toBe('running');

      const compRec = machine.complete({
        summary: 'All tasks finished',
        totalSteps: 5,
        result: { status: 'ok' },
      });
      expect(compRec.from).toBe('running');
      expect(compRec.to).toBe('completed');
      expect(machine.getState()).toBe('completed');
      expect(machine.isTerminal()).toBe(true);
    });

    it('handles pause and resume transitions', () => {
      const machine = new RunStateMachine({ runId: testRunId });
      machine.start();
      machine.run();

      const pauseRec = machine.pause('Rate limit cooldown');
      expect(pauseRec.from).toBe('running');
      expect(pauseRec.to).toBe('paused');
      expect(pauseRec.reason).toBe('Rate limit cooldown');
      expect(machine.getState()).toBe('paused');

      const resumeRec = machine.resume('Cooldown finished');
      expect(resumeRec.from).toBe('paused');
      expect(resumeRec.to).toBe('running');
      expect(resumeRec.reason).toBe('Cooldown finished');
      expect(machine.getState()).toBe('running');
    });

    it('handles waiting_approval transition', () => {
      const machine = new RunStateMachine({ runId: testRunId });
      machine.start();
      machine.run();

      const waitRec = machine.waitApproval({
        toolCallId: parseToolCallId('tc-01'),
        toolName: 'exec.run',
        riskLevel: 'high',
        reason: 'Command requires administrator approval',
      });
      expect(waitRec.to).toBe('waiting_approval');
      expect(machine.getState()).toBe('waiting_approval');

      machine.run();
      expect(machine.getState()).toBe('running');
    });

    it('handles waiting_user transition', () => {
      const machine = new RunStateMachine({ runId: testRunId });
      machine.start();
      machine.run();

      const waitRec = machine.waitUser('Please provide API credentials');
      expect(waitRec.to).toBe('waiting_user');
      expect(waitRec.reason).toBe('Please provide API credentials');
      expect(machine.getState()).toBe('waiting_user');

      machine.run();
      expect(machine.getState()).toBe('running');
    });

    it('handles fail terminal transition', () => {
      const machine = new RunStateMachine({ runId: testRunId });
      machine.start();
      machine.run();

      const failRec = machine.fail({
        code: 'TOOL_EXECUTION_FAILED',
        message: 'Compilation error',
        retryable: false,
      });
      expect(failRec.to).toBe('failed');
      expect(machine.getState()).toBe('failed');
      expect(machine.isTerminal()).toBe(true);
    });

    it('handles cancel terminal transition', () => {
      const machine = new RunStateMachine({ runId: testRunId });
      machine.start();
      machine.run();

      const cancelRec = machine.cancel('Operator requested abort');
      expect(cancelRec.to).toBe('cancelled');
      expect(machine.getState()).toBe('cancelled');
      expect(machine.isTerminal()).toBe(true);
    });

    it('handles budget_exceeded terminal transition', () => {
      const machine = new RunStateMachine({ runId: testRunId });
      machine.start();
      machine.run();

      const budgetRec = machine.exceedBudget({
        dimension: 'cost',
        limit: 5.0,
        actual: 5.4,
      });
      expect(budgetRec.to).toBe('budget_exceeded');
      expect(machine.getState()).toBe('budget_exceeded');
      expect(machine.isTerminal()).toBe(true);
    });
  });

  describe('Illegal Transition Guards & Validation', () => {
    it('throws RUN_ILLEGAL_TRANSITION when jumping from created to running', () => {
      const machine = new RunStateMachine({ runId: testRunId });
      expect(() => machine.run()).toThrow(AirError);
      try {
        machine.run();
      } catch (err) {
        expect(err).toBeInstanceOf(AirError);
        expect((err as AirError).code).toBe('RUN_ILLEGAL_TRANSITION');
      }
    });

    it('throws RUN_ILLEGAL_TRANSITION when jumping from created to completed', () => {
      const machine = new RunStateMachine({ runId: testRunId });
      expect(() => machine.complete()).toThrow(AirError);
    });

    it('throws RUN_ILLEGAL_TRANSITION when attempting transition from terminal state', () => {
      const machine = new RunStateMachine({ runId: testRunId });
      machine.start();
      machine.run();
      machine.complete();

      expect(machine.isTerminal()).toBe(true);
      expect(machine.canTransitionTo('running')).toBe(false);
      expect(() => machine.run()).toThrow(AirError);
      expect(() => machine.start()).toThrow(AirError);
      expect(() => machine.pause('wait')).toThrow(AirError);
      expect(() => machine.fail({ code: 'ERR', message: 'err' })).toThrow(AirError);
    });

    it('validates pause and waitUser arguments', () => {
      const machine = new RunStateMachine({ runId: testRunId });
      machine.start();
      machine.run();

      expect(() => machine.pause('')).toThrow(AirError);
      expect(() => machine.pause('   ')).toThrow(AirError);
      expect(() => machine.waitUser('')).toThrow(AirError);
      expect(() => machine.waitUser('   ')).toThrow(AirError);
    });
  });

  describe('Journal Event Emission via EventBus', () => {
    it('publishes corresponding envelopes to EventBus on transitions', async () => {
      const clock = new FakeClock('2026-10-17T12:00:00.000Z');
      const eventBus = new EventBus();
      const published: string[] = [];

      const sub = eventBus.subscribe({}, (event) => {
        published.push(event.type);
      });

      const machine = new RunStateMachine({
        runId: testRunId,
        clock,
        eventBus,
      });

      machine.start();
      machine.run(0);
      machine.pause('User requested pause');
      machine.resume('Resuming');
      machine.waitApproval({
        toolCallId: 'tc-1',
        toolName: 'fs.write',
        riskLevel: 'medium',
        reason: 'write permission',
      });
      machine.run(1);
      machine.waitUser('Need input');
      machine.run(2);
      machine.complete({ summary: 'Done' });

      await sub.drain();

      expect(published).toEqual([
        'run.starting',
        'run.running',
        'run.paused',
        'run.resumed',
        'run.waiting_approval',
        'run.running',
        'run.waiting_user',
        'run.running',
        'run.completed',
      ]);
    });
  });

  describe('Event Sourcing Fold (RunStateMachine.fromEvents)', () => {
    it('throws INVALID_ARGUMENT on empty event stream', () => {
      expect(() => RunStateMachine.fromEvents([])).toThrow(AirError);
    });

    it('reconstitutes machine state and history accurately from journal stream', () => {
      const clock = new FakeClock('2026-10-17T12:00:00.000Z');
      const events = [
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 1,
          type: 'run.created',
          payload: { runId: testRunId },
          meta: { runId: testRunId },
          clock,
        }),
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 2,
          type: 'run.starting',
          payload: {},
          meta: { runId: testRunId },
          clock,
        }),
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 3,
          type: 'run.running',
          payload: { turnIndex: 0 },
          meta: { runId: testRunId },
          clock,
        }),
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 4,
          type: 'tool.started', // Should be ignored by run machine fold
          payload: { toolName: 'fs.read' },
          meta: { runId: testRunId },
          clock,
        }),
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 5,
          type: 'run.paused',
          payload: { reason: 'Rate limited' },
          meta: { runId: testRunId },
          clock,
        }),
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 6,
          type: 'run.resumed',
          payload: { reason: 'Backoff expired' },
          meta: { runId: testRunId },
          clock,
        }),
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 7,
          type: 'run.completed',
          payload: { summary: 'Completed successfully' },
          meta: { runId: testRunId },
          clock,
        }),
      ];

      const reconstituted = RunStateMachine.fromEvents(events, { clock });
      expect(reconstituted.getState()).toBe('completed');
      expect(reconstituted.isTerminal()).toBe(true);
      expect(reconstituted.getHistory().length).toBe(6); // initial created + starting + running + paused + running + completed
    });

    it('reconstitutes waiting_approval and waiting_user states', () => {
      const clock = new FakeClock('2026-10-17T12:00:00.000Z');
      const approvalEvents = [
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 1,
          type: 'run.starting',
          payload: {},
          meta: { runId: testRunId },
          clock,
        }),
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 2,
          type: 'run.running',
          payload: {},
          meta: { runId: testRunId },
          clock,
        }),
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 3,
          type: 'run.waiting_approval',
          payload: {
            toolCallId: 'tc-01',
            toolName: 'exec.run',
            riskLevel: 'high',
            reason: 'operator approval needed',
          },
          meta: { runId: testRunId },
          clock,
        }),
      ];

      const approvalMachine = RunStateMachine.fromEvents(approvalEvents, { clock });
      expect(approvalMachine.getState()).toBe('waiting_approval');

      const userEvents = [
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 1,
          type: 'run.starting',
          payload: {},
          meta: { runId: testRunId },
          clock,
        }),
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 2,
          type: 'run.running',
          payload: {},
          meta: { runId: testRunId },
          clock,
        }),
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 3,
          type: 'run.waiting_user',
          payload: { prompt: 'enter password' },
          meta: { runId: testRunId },
          clock,
        }),
      ];

      const userMachine = RunStateMachine.fromEvents(userEvents, { clock });
      expect(userMachine.getState()).toBe('waiting_user');
    });

    it('reconstitutes failure and cancellation states', () => {
      const clock = new FakeClock('2026-10-17T12:00:00.000Z');
      const failEvents = [
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 1,
          type: 'run.created',
          payload: {},
          meta: { runId: testRunId },
          clock,
        }),
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 2,
          type: 'run.starting',
          payload: {},
          meta: { runId: testRunId },
          clock,
        }),
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 3,
          type: 'run.failed',
          payload: { error: { code: 'CRASH', message: 'Fatal exception' } },
          meta: { runId: testRunId },
          clock,
        }),
      ];

      const machine = RunStateMachine.fromEvents(failEvents, { clock });
      expect(machine.getState()).toBe('failed');
      expect(machine.isTerminal()).toBe(true);

      const cancelEvents = [
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 1,
          type: 'run.starting',
          payload: {},
          meta: { runId: testRunId },
          clock,
        }),
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 2,
          type: 'run.running',
          payload: {},
          meta: { runId: testRunId },
          clock,
        }),
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 3,
          type: 'run.cancelled',
          payload: { reason: 'User cancelled' },
          meta: { runId: testRunId },
          clock,
        }),
      ];

      const cancelMachine = RunStateMachine.fromEvents(cancelEvents, { clock });
      expect(cancelMachine.getState()).toBe('cancelled');
      expect(cancelMachine.isTerminal()).toBe(true);
    });

    it('reconstitutes budget_exceeded state', () => {
      const clock = new FakeClock('2026-10-17T12:00:00.000Z');
      const budgetEvents = [
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 1,
          type: 'run.starting',
          payload: {},
          meta: { runId: testRunId },
          clock,
        }),
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 2,
          type: 'run.running',
          payload: {},
          meta: { runId: testRunId },
          clock,
        }),
        createEnvelope({
          stream: `run:${testRunId}`,
          seq: 3,
          type: 'run.budget_exceeded',
          payload: { dimension: 'steps', limit: 10, actual: 11 },
          meta: { runId: testRunId },
          clock,
        }),
      ];

      const machine = RunStateMachine.fromEvents(budgetEvents, { clock });
      expect(machine.getState()).toBe('budget_exceeded');
      expect(machine.isTerminal()).toBe(true);
    });
  });
});
