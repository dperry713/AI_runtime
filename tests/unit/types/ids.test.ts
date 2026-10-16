import { describe, expect, it } from 'vitest';
import {
  createRunId,
  createAgentId,
  createSessionId,
  createTurnId,
  createToolCallId,
  createEventId,
  parseRunId,
  parseAgentId,
  parseSessionId,
  parseTurnId,
  parseToolCallId,
  parseEventId,
  isValidId,
  ID_REGEX,
} from '../../../src/types/ids.js';
import {
  RunIdSchema,
  AgentIdSchema,
  SessionIdSchema,
  TurnIdSchema,
  ToolCallIdSchema,
  EventIdSchema,
  safeParseRunId,
  isValidIdString,
} from '../../../src/types/schemas.js';

describe('branded IDs', () => {
  describe('creation', () => {
    it('creates RunId', () => {
      const id = createRunId();
      expect(typeof id).toBe('string');
      expect(ID_REGEX.test(id)).toBe(true);
    });

    it('creates AgentId', () => {
      const id = createAgentId();
      expect(typeof id).toBe('string');
      expect(ID_REGEX.test(id)).toBe(true);
    });

    it('creates SessionId', () => {
      const id = createSessionId();
      expect(typeof id).toBe('string');
      expect(ID_REGEX.test(id)).toBe(true);
    });

    it('creates TurnId', () => {
      const id = createTurnId();
      expect(typeof id).toBe('string');
      expect(ID_REGEX.test(id)).toBe(true);
    });

    it('creates ToolCallId', () => {
      const id = createToolCallId();
      expect(typeof id).toBe('string');
      expect(ID_REGEX.test(id)).toBe(true);
    });

    it('creates EventId', () => {
      const id = createEventId();
      expect(typeof id).toBe('string');
      expect(ID_REGEX.test(id)).toBe(true);
    });

    it('generates unique IDs on each call', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(createRunId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe('parsing', () => {
    it('parses valid RunId', () => {
      const raw = createRunId();
      const parsed = parseRunId(raw);
      expect(parsed).toBe(raw);
    });

    it('parses valid AgentId', () => {
      const raw = createAgentId();
      const parsed = parseAgentId(raw);
      expect(parsed).toBe(raw);
    });

    it('parses valid SessionId', () => {
      const raw = createSessionId();
      const parsed = parseSessionId(raw);
      expect(parsed).toBe(raw);
    });

    it('parses valid TurnId', () => {
      const raw = createTurnId();
      const parsed = parseTurnId(raw);
      expect(parsed).toBe(raw);
    });

    it('parses valid ToolCallId', () => {
      const raw = createToolCallId();
      const parsed = parseToolCallId(raw);
      expect(parsed).toBe(raw);
    });

    it('parses valid EventId', () => {
      const raw = createEventId();
      const parsed = parseEventId(raw);
      expect(parsed).toBe(raw);
    });
  });

  describe('validation', () => {
    it('returns true for valid ULID', () => {
      const id = createRunId();
      expect(isValidId(id)).toBe(true);
    });

    it('returns false for invalid ULID', () => {
      expect(isValidId('not-a-ulid')).toBe(false);
      expect(isValidId('')).toBe(false);
      expect(isValidId('0123456789abcdef')).toBe(false);
    });

    it('isValidIdString matches isValidId', () => {
      const id = createRunId();
      expect(isValidIdString(id)).toBe(true);
      expect(isValidIdString('invalid')).toBe(false);
    });
  });

  describe('zod schemas', () => {
    it('RunIdSchema parses valid ULID', () => {
      const id = createRunId();
      const result = RunIdSchema.safeParse(id);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(id);
      }
    });

    it('RunIdSchema rejects invalid ULID', () => {
      const result = RunIdSchema.safeParse('invalid');
      expect(result.success).toBe(false);
    });

    it('AgentIdSchema parses valid ULID', () => {
      const id = createAgentId();
      const result = AgentIdSchema.safeParse(id);
      expect(result.success).toBe(true);
    });

    it('SessionIdSchema parses valid ULID', () => {
      const id = createSessionId();
      const result = SessionIdSchema.safeParse(id);
      expect(result.success).toBe(true);
    });

    it('TurnIdSchema parses valid ULID', () => {
      const id = createTurnId();
      const result = TurnIdSchema.safeParse(id);
      expect(result.success).toBe(true);
    });

    it('ToolCallIdSchema parses valid ULID', () => {
      const id = createToolCallId();
      const result = ToolCallIdSchema.safeParse(id);
      expect(result.success).toBe(true);
    });

    it('EventIdSchema parses valid ULID', () => {
      const id = createEventId();
      const result = EventIdSchema.safeParse(id);
      expect(result.success).toBe(true);
    });

    it('safeParseRunId returns success for valid', () => {
      const id = createRunId();
      const result = safeParseRunId(id);
      expect(result.success).toBe(true);
    });

    it('safeParseRunId returns failure for invalid', () => {
      const result = safeParseRunId('invalid');
      expect(result.success).toBe(false);
    });

    it('all ID schemas have same regex pattern', () => {
      const schemas = [
        RunIdSchema,
        AgentIdSchema,
        SessionIdSchema,
        TurnIdSchema,
        ToolCallIdSchema,
        EventIdSchema,
      ];
      for (const schema of schemas) {
        expect(schema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAV').success).toBe(true);
        expect(schema.safeParse('invalid').success).toBe(false);
      }
    });
  });

  describe('type distinction', () => {
    it('RunId and AgentId are different types at runtime (same string, different brand)', () => {
      const runId = createRunId();
      const agentId = createAgentId();
      expect(runId).not.toBe(agentId);
    });

    it('IDs can be used as strings', () => {
      const runId = createRunId();
      expect(runId.toUpperCase()).toBe(runId);
      expect(runId.length).toBe(26);
    });
  });
});