import { describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  createEnvelope,
  isKnownEventType,
  isMemoryEvent,
  isModelEvent,
  isRunEvent,
  isSystemEvent,
  isToolEvent,
  isTurnEvent,
  KNOWN_EVENT_TYPES,
  parseEventEnvelope,
  safeParseEventEnvelope,
} from '../../../src/journal/index.js';
import {
  createAgentId,
  createEventId,
  createRunId,
  createSessionId,
  createToolCallId,
  createTurnId,
} from '../../../src/types/index.js';
import { FakeClock, type IdGenerator } from '../../../src/util/index.js';

describe('Event envelope & registry (P2-T01)', () => {
  const fakeClock = new FakeClock('2026-10-16T12:00:00.000Z');

  describe('createEnvelope constructor', () => {
    it('constructs an immutable envelope with injected Clock and IdGenerator', () => {
      const fixedId = createEventId();
      const mockIdGen: IdGenerator = {
        next: () => fixedId,
        nextRunId: () => createRunId(),
        nextToolCallId: () => createToolCallId(),
        nextEventId: () => fixedId,
        nextTurnId: () => createTurnId(),
        nextSessionId: () => createSessionId(),
        nextAgentId: () => createAgentId(),
      };

      const agentId = createAgentId();
      const envelope = createEnvelope({
        stream: 'run:01ARZ3NDEKTSV4RRFFQ69G5FAV',
        seq: 1,
        type: 'run.created',
        payload: {
          goal: 'Build AIR runtime',
          agentId,
        },
        clock: fakeClock,
        idGenerator: mockIdGen,
      });

      expect(envelope.id).toBe(fixedId);
      expect(envelope.stream).toBe('run:01ARZ3NDEKTSV4RRFFQ69G5FAV');
      expect(envelope.seq).toBe(1);
      expect(envelope.ts).toBe('2026-10-16T12:00:00.000Z');
      expect(envelope.type).toBe('run.created');
      expect(envelope.payload).toEqual({
        goal: 'Build AIR runtime',
        agentId,
      });

      // Assert envelope is frozen (immutable)
      expect(Object.isFrozen(envelope)).toBe(true);
    });

    it('attaches optional metadata context when provided', () => {
      const runId = createRunId();
      const sessionId = createSessionId();
      const agentId = createAgentId();
      const turnId = createTurnId();
      const toolCallId = createToolCallId();
      const causationId = createEventId();

      const envelope = createEnvelope({
        stream: `run:${runId}`,
        seq: 2,
        type: 'tool.requested',
        payload: {
          toolCallId,
          name: 'fs.read',
          arguments: { path: 'file.txt' },
        },
        meta: {
          runId,
          sessionId,
          agentId,
          turnId,
          toolCallId,
          causationId,
          traceId: 'trace-abc',
          spanId: 'span-xyz',
          correlationId: 'corr-123',
        },
        clock: fakeClock,
      });

      expect(envelope.meta).toBeDefined();
      expect(envelope.meta?.runId).toBe(runId);
      expect(envelope.meta?.sessionId).toBe(sessionId);
      expect(envelope.meta?.agentId).toBe(agentId);
      expect(envelope.meta?.turnId).toBe(turnId);
      expect(envelope.meta?.toolCallId).toBe(toolCallId);
      expect(envelope.meta?.causationId).toBe(causationId);
      expect(envelope.meta?.traceId).toBe('trace-abc');
      expect(envelope.meta?.spanId).toBe('span-xyz');
      expect(envelope.meta?.correlationId).toBe('corr-123');
    });

    it('rejects empty stream, non-positive seq, or empty type with AirError', () => {
      expect(() =>
        createEnvelope({
          stream: '',
          seq: 1,
          type: 'run.created',
          payload: {},
        }),
      ).toThrowError(AirError);

      expect(() =>
        createEnvelope({
          stream: 'run:1',
          seq: 0,
          type: 'run.created',
          payload: {},
        }),
      ).toThrowError(AirError);

      expect(() =>
        createEnvelope({
          stream: 'run:1',
          seq: -1,
          type: 'run.created',
          payload: {},
        }),
      ).toThrowError(AirError);

      expect(() =>
        createEnvelope({
          stream: 'run:1',
          seq: 1,
          type: '',
          payload: {},
        }),
      ).toThrowError(AirError);
    });
  });

  describe('discriminated union parsing and validation', () => {
    it('parses valid run lifecycle events', () => {
      const agentId = createAgentId();
      const rawRunCreated = {
        id: createEventId(),
        stream: 'run:123',
        seq: 1,
        ts: fakeClock.iso(),
        type: 'run.created',
        payload: { goal: 'Test run', agentId },
      };

      const parsed = parseEventEnvelope(rawRunCreated);
      expect(parsed.type).toBe('run.created');
      if (parsed.type === 'run.created') {
        expect(parsed.payload.goal).toBe('Test run');
        expect(parsed.payload.agentId).toBe(agentId);
        expect(parsed.payload.config).toEqual({});
      }

      const rawBudgetExceeded = {
        id: createEventId(),
        stream: 'run:123',
        seq: 2,
        ts: fakeClock.iso(),
        type: 'run.budget_exceeded',
        payload: { dimension: 'wall_time', limit: 300, actual: 305 },
      };

      const parsedBudget = parseEventEnvelope(rawBudgetExceeded);
      expect(parsedBudget.type).toBe('run.budget_exceeded');
      if (parsedBudget.type === 'run.budget_exceeded') {
        expect(parsedBudget.payload.dimension).toBe('wall_time');
        expect(parsedBudget.payload.limit).toBe(300);
        expect(parsedBudget.payload.actual).toBe(305);
      }
    });

    it('parses tool lifecycle events and validates arguments', () => {
      const toolCallId = createToolCallId();
      const rawToolStarted = {
        id: createEventId(),
        stream: 'run:123',
        seq: 3,
        ts: fakeClock.iso(),
        type: 'tool.started',
        payload: { toolCallId, name: 'fs.write', idempotent: false },
      };

      const parsed = parseEventEnvelope(rawToolStarted);
      expect(parsed.type).toBe('tool.started');
      if (parsed.type === 'tool.started') {
        expect(parsed.payload.toolCallId).toBe(toolCallId);
        expect(parsed.payload.name).toBe('fs.write');
        expect(parsed.payload.idempotent).toBe(false);
      }
    });

    it('parses model and turn events', () => {
      const rawTurnStarted = {
        id: createEventId(),
        stream: 'run:123',
        seq: 4,
        ts: fakeClock.iso(),
        type: 'turn.started',
        payload: { turnIndex: 0 },
      };

      const parsedTurn = parseEventEnvelope(rawTurnStarted);
      expect(parsedTurn.type).toBe('turn.started');

      const rawModelReq = {
        id: createEventId(),
        stream: 'run:123',
        seq: 5,
        ts: fakeClock.iso(),
        type: 'model.requested',
        payload: { model: 'nvidia/meta/llama-3.1-70b-instruct', promptTokens: 150 },
      };

      const parsedModel = parseEventEnvelope(rawModelReq);
      expect(parsedModel.type).toBe('model.requested');
      if (parsedModel.type === 'model.requested') {
        expect(parsedModel.payload.model).toBe('nvidia/meta/llama-3.1-70b-instruct');
        expect(parsedModel.payload.promptTokens).toBe(150);
      }
    });

    it('parses memory and system lifecycle events', () => {
      const rawMem = {
        id: createEventId(),
        stream: 'system',
        seq: 1,
        ts: fakeClock.iso(),
        type: 'memory.written',
        payload: { key: 'user_pref', category: 'preferences' },
      };
      expect(parseEventEnvelope(rawMem).type).toBe('memory.written');

      const rawSysRecovered = {
        id: createEventId(),
        stream: 'system',
        seq: 2,
        ts: fakeClock.iso(),
        type: 'system.recovered',
        payload: { stream: 'run:123', truncatedBytes: 42, lastValidSeq: 10 },
      };
      expect(parseEventEnvelope(rawSysRecovered).type).toBe('system.recovered');
    });

    it('throws AirError VALIDATION_FAILED on invalid payload, bad ULID, or missing fields', () => {
      const badId = {
        id: 'bad-ulid',
        stream: 'run:1',
        seq: 1,
        ts: fakeClock.iso(),
        type: 'run.created',
        payload: { goal: 'Test', agentId: createAgentId() },
      };

      expect(() => parseEventEnvelope(badId)).toThrowError(AirError);

      const missingGoal = {
        id: createEventId(),
        stream: 'run:1',
        seq: 1,
        ts: fakeClock.iso(),
        type: 'run.created',
        payload: { agentId: createAgentId() },
      };

      expect(() => parseEventEnvelope(missingGoal)).toThrowError(AirError);
      const safeResult = safeParseEventEnvelope(missingGoal);
      expect(safeResult.success).toBe(false);
    });

    it('throws AirError on unknown event type in registry', () => {
      const unknownType = {
        id: createEventId(),
        stream: 'run:1',
        seq: 1,
        ts: fakeClock.iso(),
        type: 'ad_hoc.unregistered_event',
        payload: { foo: 'bar' },
      };

      expect(() => parseEventEnvelope(unknownType)).toThrowError(AirError);
    });
  });

  describe('type guards & category classifications', () => {
    it('classifies event categories accurately', () => {
      const runEnv = createEnvelope({
        stream: 'run:1',
        seq: 1,
        type: 'run.created',
        payload: { goal: 'Goal', agentId: createAgentId() },
        clock: fakeClock,
      });

      const toolEnv = createEnvelope({
        stream: 'run:1',
        seq: 2,
        type: 'tool.started',
        payload: { toolCallId: createToolCallId(), name: 'exec' },
        clock: fakeClock,
      });

      const turnEnv = createEnvelope({
        stream: 'run:1',
        seq: 3,
        type: 'turn.started',
        payload: { turnIndex: 1 },
        clock: fakeClock,
      });

      const modelEnv = createEnvelope({
        stream: 'run:1',
        seq: 4,
        type: 'model.responded',
        payload: { model: 'llama3' },
        clock: fakeClock,
      });

      const memEnv = createEnvelope({
        stream: 'run:1',
        seq: 5,
        type: 'memory.written',
        payload: { key: 'k', category: 'c' },
        clock: fakeClock,
      });

      const sysEnv = createEnvelope({
        stream: 'system',
        seq: 6,
        type: 'system.started',
        payload: { version: '0.0.0', pid: 100, airHome: 'C:\\AIR' },
        clock: fakeClock,
      });

      expect(isRunEvent(runEnv)).toBe(true);
      expect(isRunEvent(toolEnv)).toBe(false);

      expect(isToolEvent(toolEnv)).toBe(true);
      expect(isTurnEvent(turnEnv)).toBe(true);
      expect(isModelEvent(modelEnv)).toBe(true);
      expect(isMemoryEvent(memEnv)).toBe(true);
      expect(isSystemEvent(sysEnv)).toBe(true);

      expect(isKnownEventType('run.created')).toBe(true);
      expect(isKnownEventType('unknown.action')).toBe(false);
      expect(KNOWN_EVENT_TYPES.length).toBeGreaterThan(20);
    });
  });
});
