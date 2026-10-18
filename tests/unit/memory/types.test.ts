import { describe, expect, it } from 'vitest';
import {
  createMemoryId,
  createAgentId,
  createSessionId,
  createRunId,
  createTurnId,
  createToolCallId,
} from '../../../src/types/index.js';
import {
  MemoryKindSchema,
  MemoryScopeSchema,
  MemoryTaintSchema,
  MemorySourceSchema,
  MemoryProvenanceSchema,
  MemoryEntrySchema,
  CreateMemoryInputSchema,
  UpdateMemoryInputSchema,
  MemoryFilterSchema,
  MemorySearchQuerySchema,
  MemorySearchResultSchema,
  calculateExpiresAt,
  isMemoryExpired,
  matchesFilter,
  validateMemoryEntry,
  validateCreateMemoryInput,
} from '../../../src/memory/index.js';
import type { MemoryEntry, MemoryFilter } from '../../../src/memory/index.js';

describe('memory types and schemas', () => {
  const agentId = createAgentId();
  const sessionId = createSessionId();
  const runId = createRunId();
  const turnId = createTurnId();
  const toolCallId = createToolCallId();
  const memoryId = createMemoryId();

  describe('classification schemas', () => {
    it('accepts valid memory kinds and rejects invalid', () => {
      expect(MemoryKindSchema.parse('episodic')).toBe('episodic');
      expect(MemoryKindSchema.parse('semantic')).toBe('semantic');
      expect(MemoryKindSchema.parse('working')).toBe('working');
      expect(() => MemoryKindSchema.parse('invalid')).toThrow();
    });

    it('accepts valid memory scopes and rejects invalid', () => {
      expect(MemoryScopeSchema.parse('agent')).toBe('agent');
      expect(MemoryScopeSchema.parse('session')).toBe('session');
      expect(MemoryScopeSchema.parse('run')).toBe('run');
      expect(MemoryScopeSchema.parse('global')).toBe('global');
      expect(() => MemoryScopeSchema.parse('user')).toThrow();
    });

    it('accepts valid taint levels and sources', () => {
      expect(MemoryTaintSchema.parse('clean')).toBe('clean');
      expect(MemoryTaintSchema.parse('tainted')).toBe('tainted');
      expect(MemoryTaintSchema.parse('untrusted')).toBe('untrusted');
      expect(() => MemoryTaintSchema.parse('dangerous')).toThrow();

      expect(MemorySourceSchema.parse('user')).toBe('user');
      expect(MemorySourceSchema.parse('model')).toBe('model');
      expect(MemorySourceSchema.parse('tool')).toBe('tool');
      expect(MemorySourceSchema.parse('system')).toBe('system');
      expect(MemorySourceSchema.parse('consolidated')).toBe('consolidated');
      expect(() => MemorySourceSchema.parse('external')).toThrow();
    });
  });

  describe('MemoryProvenanceSchema', () => {
    it('defaults taint to clean if omitted', () => {
      const parsed = MemoryProvenanceSchema.parse({
        source: 'user',
      });
      expect(parsed.source).toBe('user');
      expect(parsed.taint).toBe('clean');
    });

    it('accepts complete provenance metadata', () => {
      const provenance = {
        source: 'tool' as const,
        actorId: 'agent-dev',
        runId,
        turnId,
        toolCallId,
        taint: 'tainted' as const,
      };
      const parsed = MemoryProvenanceSchema.parse(provenance);
      expect(parsed.source).toBe('tool');
      expect(parsed.taint).toBe('tainted');
      expect(parsed.runId).toBe(runId);
      expect(parsed.turnId).toBe(turnId);
      expect(parsed.toolCallId).toBe(toolCallId);
    });
  });

  describe('CreateMemoryInputSchema', () => {
    it('validates agent scope requiring agentId', () => {
      const valid = {
        kind: 'semantic' as const,
        scope: 'agent' as const,
        agentId,
        title: 'Project build preference',
        content: 'Prefers npm over pnpm',
      };
      expect(CreateMemoryInputSchema.safeParse(valid).success).toBe(true);

      const invalid = {
        kind: 'semantic' as const,
        scope: 'agent' as const,
        title: 'Project build preference',
        content: 'Missing agentId',
      };
      expect(CreateMemoryInputSchema.safeParse(invalid).success).toBe(false);
    });

    it('validates session scope requiring sessionId', () => {
      const valid = {
        kind: 'working' as const,
        scope: 'session' as const,
        sessionId,
        title: 'Active debugging session state',
        content: 'Investigating sandbox network mock',
      };
      expect(CreateMemoryInputSchema.safeParse(valid).success).toBe(true);

      const invalid = {
        kind: 'working' as const,
        scope: 'session' as const,
        title: 'Active debugging session state',
        content: 'Missing sessionId',
      };
      expect(CreateMemoryInputSchema.safeParse(invalid).success).toBe(false);
    });

    it('validates run scope requiring runId', () => {
      const valid = {
        kind: 'working' as const,
        scope: 'run' as const,
        runId,
        title: 'Current step scratchpad',
        content: 'Completed step 1, moving to step 2',
      };
      expect(CreateMemoryInputSchema.safeParse(valid).success).toBe(true);

      const invalid = {
        kind: 'working' as const,
        scope: 'run' as const,
        title: 'Current step scratchpad',
        content: 'Missing runId',
      };
      expect(CreateMemoryInputSchema.safeParse(invalid).success).toBe(false);
    });

    it('validates global scope without requiring specific IDs', () => {
      const valid = {
        kind: 'semantic' as const,
        scope: 'global' as const,
        title: 'AIR platform guideline',
        content: 'Never log secrets or credentials.',
        tags: ['security', 'guidelines'],
      };
      expect(CreateMemoryInputSchema.safeParse(valid).success).toBe(true);
    });

    it('rejects empty title or content', () => {
      expect(
        CreateMemoryInputSchema.safeParse({
          kind: 'semantic',
          scope: 'global',
          title: '',
          content: 'valid content',
        }).success,
      ).toBe(false);

      expect(
        CreateMemoryInputSchema.safeParse({
          kind: 'semantic',
          scope: 'global',
          title: 'valid title',
          content: '',
        }).success,
      ).toBe(false);
    });
  });

  describe('UpdateMemoryInputSchema', () => {
    it('accepts partial updates and nullable fields for clearing', () => {
      const update = {
        title: 'Updated title',
        importance: 0.9,
        ttlSeconds: null,
        expiresAt: null,
      };
      const parsed = UpdateMemoryInputSchema.parse(update);
      expect(parsed.title).toBe('Updated title');
      expect(parsed.importance).toBe(0.9);
      expect(parsed.ttlSeconds).toBeNull();
      expect(parsed.expiresAt).toBeNull();
    });

    it('rejects invalid importance out of range', () => {
      expect(UpdateMemoryInputSchema.safeParse({ importance: 1.5 }).success).toBe(false);
      expect(UpdateMemoryInputSchema.safeParse({ importance: -0.1 }).success).toBe(false);
    });
  });

  describe('MemoryEntrySchema & validation', () => {
    const validEntry: MemoryEntry = {
      id: memoryId,
      kind: 'episodic',
      scope: 'agent',
      agentId,
      title: 'Resolved compilation failure in helper-client',
      content: 'Added conditional check for mock mode in SandboxHelperClient.run()',
      tags: ['build', 'sandbox', 'rust'],
      metadata: { commit: 'b32b52e', durationMs: 1420 },
      importance: 0.8,
      provenance: {
        source: 'system',
        taint: 'clean',
      },
      createdAt: '2026-10-18T00:00:00.000Z',
      updatedAt: '2026-10-18T00:00:00.000Z',
      accessedAt: '2026-10-18T00:05:00.000Z',
      accessCount: 3,
      ttlSeconds: 86400,
      expiresAt: '2026-10-19T00:00:00.000Z',
      embedding: [0.1, 0.2, 0.3],
    };

    it('parses valid complete memory entry', () => {
      const result = MemoryEntrySchema.parse(validEntry);
      expect(result.id).toBe(memoryId);
      expect(result.kind).toBe('episodic');
      expect(result.scope).toBe('agent');
      expect(result.accessCount).toBe(3);
      expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
    });

    it('validates via validateMemoryEntry helper', () => {
      const parsed = validateMemoryEntry(validEntry);
      expect(parsed.id).toBe(memoryId);
      expect(() => validateMemoryEntry({ ...validEntry, id: 'bad-ulid' })).toThrow();
    });

    it('validates via validateCreateMemoryInput helper', () => {
      const input = {
        kind: 'semantic' as const,
        scope: 'global' as const,
        title: 'Global guideline',
        content: 'Follow RFC specifications.',
      };
      const parsed = validateCreateMemoryInput(input);
      expect(parsed.title).toBe('Global guideline');
      expect(() => validateCreateMemoryInput({ ...input, title: '' })).toThrow();
    });
  });

  describe('Search & Filter schemas', () => {
    it('validates MemoryFilterSchema defaults and properties', () => {
      const filter: MemoryFilter = {
        kinds: ['semantic', 'working'],
        scopes: ['agent', 'global'],
        agentId,
        tags: ['guide'],
        taint: ['clean'],
        minImportance: 0.7,
        includeExpired: false,
      };
      const parsed = MemoryFilterSchema.parse(filter);
      expect(parsed.kinds).toEqual(['semantic', 'working']);
      expect(parsed.minImportance).toBe(0.7);
    });

    it('validates MemorySearchQuerySchema defaults', () => {
      const query = {
        query: 'how to configure network egress',
      };
      const parsed = MemorySearchQuerySchema.parse(query);
      expect(parsed.limit).toBe(10);
      expect(parsed.offset).toBe(0);
      expect(parsed.mode).toBe('keyword');
    });

    it('validates MemorySearchResultSchema', () => {
      const entry: MemoryEntry = {
        id: memoryId,
        kind: 'semantic',
        scope: 'global',
        title: 'Network egress rules',
        content: 'EgressProxy inspects HTTP CONNECT tunnels',
        tags: ['network'],
        metadata: {},
        importance: 0.9,
        provenance: { source: 'system', taint: 'clean' },
        createdAt: '2026-10-18T00:00:00.000Z',
        updatedAt: '2026-10-18T00:00:00.000Z',
        accessCount: 0,
      };

      const result = MemorySearchResultSchema.parse({
        entry,
        score: 0.88,
        matchedBy: 'keyword',
        highlights: {
          title: ['Network <em>egress</em> rules'],
        },
      });
      expect(result.score).toBe(0.88);
      expect(result.matchedBy).toBe('keyword');
      expect(result.highlights?.title).toEqual(['Network <em>egress</em> rules']);
    });
  });

  describe('TTL and expiration utilities', () => {
    it('calculateExpiresAt accurately computes ISO timestamp', () => {
      const createdAt = '2026-10-18T00:00:00.000Z';
      const ttlSeconds = 3600; // 1 hour
      const expiresAt = calculateExpiresAt(createdAt, ttlSeconds);
      expect(expiresAt).toBe('2026-10-18T01:00:00.000Z');
    });

    it('calculateExpiresAt throws on malformed date', () => {
      expect(() => calculateExpiresAt('invalid-date', 3600)).toThrow('Invalid createdAtIso date');
    });

    it('isMemoryExpired returns false when expiresAt or nowIso is missing', () => {
      expect(isMemoryExpired({})).toBe(false);
      expect(isMemoryExpired({ expiresAt: undefined })).toBe(false);
      expect(isMemoryExpired({ expiresAt: '2026-10-18T01:00:00.000Z' })).toBe(false);
      expect(isMemoryExpired({ expiresAt: '2026-10-18T01:00:00.000Z' }, undefined)).toBe(false);
    });

    it('isMemoryExpired accurately detects expired entries', () => {
      const expiresAt = '2026-10-18T01:00:00.000Z';

      // Before expiration
      expect(isMemoryExpired({ expiresAt }, '2026-10-18T00:59:59.000Z')).toBe(false);

      // At expiration
      expect(isMemoryExpired({ expiresAt }, '2026-10-18T01:00:00.000Z')).toBe(true);

      // After expiration
      expect(isMemoryExpired({ expiresAt }, '2026-10-18T01:00:01.000Z')).toBe(true);
    });

    it('isMemoryExpired returns false on malformed date', () => {
      expect(isMemoryExpired({ expiresAt: 'not-a-date' }, '2026-10-18T01:00:00.000Z')).toBe(false);
      expect(isMemoryExpired({ expiresAt: '2026-10-18T01:00:00.000Z' }, 'not-a-date')).toBe(false);
    });
  });

  describe('matchesFilter utility', () => {
    const baseEntry: MemoryEntry = {
      id: memoryId,
      kind: 'semantic',
      scope: 'agent',
      agentId,
      sessionId,
      runId,
      title: 'Rust Toolchain Configuration',
      content: 'Use rustup default stable-x86_64-pc-windows-msvc',
      tags: ['rust', 'toolchain', 'windows'],
      metadata: {},
      importance: 0.75,
      provenance: { source: 'user', taint: 'clean' },
      createdAt: '2026-10-18T00:00:00.000Z',
      updatedAt: '2026-10-18T00:00:00.000Z',
      accessCount: 1,
      expiresAt: undefined,
    };

    it('returns true when filter is empty or undefined', () => {
      expect(matchesFilter(baseEntry)).toBe(true);
      expect(matchesFilter(baseEntry, {})).toBe(true);
    });

    it('filters out expired memory when includeExpired is false', () => {
      const entryWithExpiry: MemoryEntry = {
        ...baseEntry,
        expiresAt: '2026-10-18T02:00:00.000Z',
      };
      const expiredNow = '2026-10-18T03:00:00.000Z';
      expect(matchesFilter(entryWithExpiry, { includeExpired: false }, expiredNow)).toBe(false);
      expect(matchesFilter(entryWithExpiry, { includeExpired: true }, expiredNow)).toBe(true);
    });

    it('filters by kinds', () => {
      expect(matchesFilter(baseEntry, { kinds: ['semantic'] })).toBe(true);
      expect(matchesFilter(baseEntry, { kinds: ['episodic', 'working'] })).toBe(false);
    });

    it('filters by scopes', () => {
      expect(matchesFilter(baseEntry, { scopes: ['agent', 'global'] })).toBe(true);
      expect(matchesFilter(baseEntry, { scopes: ['session', 'run'] })).toBe(false);
    });

    it('filters by agentId, sessionId, and runId', () => {
      expect(matchesFilter(baseEntry, { agentId })).toBe(true);
      expect(matchesFilter(baseEntry, { agentId: createAgentId() })).toBe(false);

      expect(matchesFilter(baseEntry, { sessionId })).toBe(true);
      expect(matchesFilter(baseEntry, { sessionId: createSessionId() })).toBe(false);

      expect(matchesFilter(baseEntry, { runId })).toBe(true);
      expect(matchesFilter(baseEntry, { runId: createRunId() })).toBe(false);
    });

    it('filters by tags requiring all specified tags', () => {
      expect(matchesFilter(baseEntry, { tags: ['rust'] })).toBe(true);
      expect(matchesFilter(baseEntry, { tags: ['rust', 'windows'] })).toBe(true);
      expect(matchesFilter(baseEntry, { tags: ['rust', 'mac'] })).toBe(false);
    });

    it('filters by taint', () => {
      expect(matchesFilter(baseEntry, { taint: ['clean'] })).toBe(true);
      expect(matchesFilter(baseEntry, { taint: ['tainted', 'untrusted'] })).toBe(false);
    });

    it('filters by minImportance', () => {
      expect(matchesFilter(baseEntry, { minImportance: 0.5 })).toBe(true);
      expect(matchesFilter(baseEntry, { minImportance: 0.75 })).toBe(true);
      expect(matchesFilter(baseEntry, { minImportance: 0.8 })).toBe(false);
    });
  });
});
