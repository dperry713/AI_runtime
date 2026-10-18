/**
 * Unit tests for retrieval and ranking engine (P8-T04).
 */

import { describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import { FakeClock, UlidIdGenerator } from '../../../src/util/index.js';
import {
  calculateRecencyScore,
  blendScores,
  rankSearchResults,
  defaultFormatMemoryEntry,
  retrieveForContext,
} from '../../../src/memory/ranking.js';
import { SqliteMemoryStore } from '../../../src/memory/store.js';
import type { MemorySearchResult, MemoryEntry } from '../../../src/memory/types.js';
import { parseMemoryId } from '../../../src/types/index.js';

// ============================================================================
// Helpers
// ============================================================================

function makeSampleEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: parseMemoryId('01ARZ3NDEKTSV4RRFFQ69G5FAV'),
    kind: 'semantic',
    scope: 'global',
    title: 'Sample Memory',
    content: 'This is the content of the sample memory entry.',
    tags: ['ai', 'runtime'],
    metadata: {},
    importance: 0.8,
    provenance: { source: 'system', taint: 'clean' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    accessCount: 1,
    ...overrides,
  };
}

// ============================================================================
// calculateRecencyScore Tests
// ============================================================================

describe('calculateRecencyScore', () => {
  const baseIso = '2026-01-01T00:00:00.000Z';

  it('returns 1.0 when entry timestamp is identical to current time', () => {
    const entry = makeSampleEntry({ createdAt: baseIso });
    const score = calculateRecencyScore(entry, baseIso);
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('returns 0.5 when elapsed time equals half-life (168 hours = 7 days)', () => {
    const entry = makeSampleEntry({ createdAt: '2026-01-01T00:00:00.000Z' });
    // 7 days later = 2026-01-08T00:00:00.000Z
    const nowIso = '2026-01-08T00:00:00.000Z';
    const score = calculateRecencyScore(entry, nowIso, { halfLifeHours: 168 });
    expect(score).toBeCloseTo(0.5, 4);
  });

  it('returns 0.25 when elapsed time equals two half-lives', () => {
    const entry = makeSampleEntry({ createdAt: '2026-01-01T00:00:00.000Z' });
    // 14 days later
    const nowIso = '2026-01-15T00:00:00.000Z';
    const score = calculateRecencyScore(entry, nowIso, { halfLifeHours: 168 });
    expect(score).toBeCloseTo(0.25, 4);
  });

  it('uses accessedAt when more recent and useAccessedAt is true', () => {
    const entry = makeSampleEntry({
      createdAt: '2026-01-01T00:00:00.000Z',
      accessedAt: '2026-01-07T00:00:00.000Z', // accessed 1 day before now
    });
    const nowIso = '2026-01-08T00:00:00.000Z';

    const scoreWithAccess = calculateRecencyScore(entry, nowIso, {
      halfLifeHours: 168,
      useAccessedAt: true,
    });
    const scoreWithoutAccess = calculateRecencyScore(entry, nowIso, {
      halfLifeHours: 168,
      useAccessedAt: false,
    });

    // With access (1 day old) vs without (7 days old)
    expect(scoreWithAccess).toBeGreaterThan(scoreWithoutAccess);
    expect(scoreWithoutAccess).toBeCloseTo(0.5, 4); // 7 days = 1 half-life
  });

  it('clamps future timestamps to 1.0', () => {
    const entry = makeSampleEntry({ createdAt: '2026-01-10T00:00:00.000Z' });
    const nowIso = '2026-01-01T00:00:00.000Z';
    const score = calculateRecencyScore(entry, nowIso);
    expect(score).toBe(1.0);
  });

  it('throws INVALID_ARGUMENT on invalid date string', () => {
    const entry = makeSampleEntry();
    expect(() => calculateRecencyScore(entry, 'not-a-date')).toThrow(AirError);
    expect(() => calculateRecencyScore({ createdAt: 'invalid' }, '2026-01-01T00:00:00.000Z')).toThrow(AirError);
  });
});

// ============================================================================
// blendScores Tests
// ============================================================================

describe('blendScores', () => {
  it('applies default weights (0.5 rel, 0.3 rec, 0.2 imp)', () => {
    const rel = 0.8;
    const rec = 0.6;
    const imp = 0.9;
    // Expected: 0.5 * 0.8 + 0.3 * 0.6 + 0.2 * 0.9 = 0.40 + 0.18 + 0.18 = 0.76
    const score = blendScores(rel, rec, imp);
    expect(score).toBeCloseTo(0.76, 5);
  });

  it('supports custom weights', () => {
    const score = blendScores(0.8, 0.4, 0.2, {
      relevance: 1.0,
      recency: 0.0,
      importance: 0.0,
    });
    expect(score).toBeCloseTo(0.8, 5);
  });

  it('normalizes weights when sum != 1.0', () => {
    // Weights 5, 3, 2 sum to 10 -> normalized to 0.5, 0.3, 0.2
    const score = blendScores(0.8, 0.6, 0.9, {
      relevance: 5,
      recency: 3,
      importance: 2,
    });
    expect(score).toBeCloseTo(0.76, 5);
  });

  it('defaults to equal thirds when sum of weights is zero', () => {
    const score = blendScores(0.9, 0.6, 0.3, {
      relevance: 0,
      recency: 0,
      importance: 0,
    });
    expect(score).toBeCloseTo((0.9 + 0.6 + 0.3) / 3, 5);
  });

  it('clamps input scores to [0, 1]', () => {
    expect(blendScores(-0.5, 1.5, 0.5)).toBeCloseTo(blendScores(0, 1, 0.5), 5);
  });
});

// ============================================================================
// rankSearchResults Tests
// ============================================================================

describe('rankSearchResults', () => {
  const nowIso = '2026-01-08T00:00:00.000Z';

  const makeResult = (id: string, relScore: number, importance: number, createdAt: string): MemorySearchResult => ({
    entry: makeSampleEntry({
      id: parseMemoryId(id),
      importance,
      createdAt,
    }),
    score: relScore,
    matchedBy: 'keyword',
    highlights: { title: ['hit'] },
  });

  it('sorts search results descending by composite score', () => {
    const results: MemorySearchResult[] = [
      // Low relevance, old, low importance
      makeResult('01ARZ3NDEKTSV4RRFFQ69G5FA1', 0.2, 0.2, '2025-01-01T00:00:00.000Z'),
      // High relevance, fresh, high importance
      makeResult('01ARZ3NDEKTSV4RRFFQ69G5FA2', 0.95, 0.9, '2026-01-08T00:00:00.000Z'),
      // Medium relevance, recent
      makeResult('01ARZ3NDEKTSV4RRFFQ69G5FA3', 0.6, 0.5, '2026-01-07T00:00:00.000Z'),
    ];

    const ranked = rankSearchResults(results, nowIso);
    expect(ranked).toHaveLength(3);
    expect(ranked[0]?.entry.id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FA2');
    expect(ranked[1]?.entry.id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FA3');
    expect(ranked[2]?.entry.id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FA1');

    expect(ranked[0]?.highlights).toEqual({ title: ['hit'] });
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
    expect(ranked[1]?.score).toBeGreaterThan(ranked[2]?.score ?? 0);
  });

  it('respects minScore filter', () => {
    const results: MemorySearchResult[] = [
      makeResult('01ARZ3NDEKTSV4RRFFQ69G5FA1', 0.1, 0.1, '2025-01-01T00:00:00.000Z'),
      makeResult('01ARZ3NDEKTSV4RRFFQ69G5FA2', 0.95, 0.9, nowIso),
    ];

    const ranked = rankSearchResults(results, nowIso, { minScore: 0.5 });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.entry.id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FA2');
  });

  it('respects limit option', () => {
    const results: MemorySearchResult[] = [
      makeResult('01ARZ3NDEKTSV4RRFFQ69G5FA1', 0.9, 0.9, nowIso),
      makeResult('01ARZ3NDEKTSV4RRFFQ69G5FA2', 0.8, 0.8, nowIso),
      makeResult('01ARZ3NDEKTSV4RRFFQ69G5FA3', 0.7, 0.7, nowIso),
    ];

    const ranked = rankSearchResults(results, nowIso, { limit: 2 });
    expect(ranked).toHaveLength(2);
  });
});

// ============================================================================
// defaultFormatMemoryEntry Tests
// ============================================================================

describe('defaultFormatMemoryEntry', () => {
  it('formats title, tags, score percentage, and content into markdown', () => {
    const entry = makeSampleEntry({
      title: 'Design Decisions',
      tags: ['arch', 'p8'],
      content: 'Store memories in SQLite with FTS5.',
    });

    const formatted = defaultFormatMemoryEntry(entry, 0.85);
    expect(formatted).toContain('### Design Decisions [arch, p8] (score: 85%)');
    expect(formatted).toContain('Store memories in SQLite with FTS5.');
  });
});

// ============================================================================
// retrieveForContext High-Level Tests
// ============================================================================

describe('retrieveForContext', () => {
  const clock = new FakeClock(new Date('2026-01-08T00:00:00.000Z'));
  const idGenerator = new UlidIdGenerator(clock);

  async function createSeededStore(): Promise<SqliteMemoryStore> {
    const store = new SqliteMemoryStore({
      dbPath: ':memory:',
      clock,
      idGenerator,
    });

    await store.batchWrite([
      {
        kind: 'semantic',
        scope: 'global',
        title: 'Node.js Architecture',
        content: 'Node.js uses an event-driven, non-blocking I/O model.',
        importance: 0.9,
        tags: ['node', 'arch'],
      },
      {
        kind: 'semantic',
        scope: 'global',
        title: 'TypeScript Strict Mode',
        content: 'TypeScript strict mode enables noImplicitAny, strictNullChecks, and exactOptionalPropertyTypes.',
        importance: 0.8,
        tags: ['typescript', 'strict'],
      },
      {
        kind: 'episodic',
        scope: 'global',
        title: 'Yesterday Discussion',
        content: 'Discussed memory indexing with sqlite-vec versus FTS5 BM25.',
        importance: 0.6,
        tags: ['meeting'],
      },
      {
        kind: 'working',
        scope: 'global',
        title: 'Unrelated Note',
        content: 'Buy groceries after work: milk, bread, and apples.',
        importance: 0.1,
        tags: ['personal'],
      },
    ]);

    return store;
  }

  it('retrieves relevant memories and packs them into token budget', async () => {
    const store = await createSeededStore();

    const result = await retrieveForContext({
      store,
      query: 'TypeScript',
      tokenBudget: 500,
      clock,
    });

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0]?.entry.title).toBe('TypeScript Strict Mode');
    expect(result.formattedContext).toContain('TypeScript Strict Mode');
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.totalTokens).toBeLessThanOrEqual(500);
    expect(result.budgetExceeded).toBe(false);

    await store.close();
  });

  it('marks budgetExceeded when token budget cannot fit all candidates', async () => {
    const store = await createSeededStore();

    // Very small budget that can only fit 1 entry
    const result = await retrieveForContext({
      store,
      query: 'Node.js TypeScript memory',
      tokenBudget: 35,
      clock,
    });

    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    expect(result.totalTokens).toBeLessThanOrEqual(35);
    expect(result.budgetExceeded).toBe(true);

    await store.close();
  });

  it('returns empty formatted context when no memories match query', async () => {
    const store = await createSeededStore();

    const result = await retrieveForContext({
      store,
      query: 'quantum-computing-superconductor-xyz',
      tokenBudget: 500,
      clock,
    });

    expect(result.entries).toHaveLength(0);
    expect(result.formattedContext).toBe('');
    expect(result.totalTokens).toBe(0);
    expect(result.budgetExceeded).toBe(false);

    await store.close();
  });

  it('respects metadata filters passed to search', async () => {
    const store = await createSeededStore();

    const result = await retrieveForContext({
      store,
      query: 'TypeScript',
      filter: { kinds: ['episodic'] }, // 'TypeScript Strict Mode' is semantic, so will be excluded
      tokenBudget: 500,
      clock,
    });

    expect(result.entries.some((e) => e.entry.title === 'TypeScript Strict Mode')).toBe(false);

    await store.close();
  });

  it('throws INVALID_ARGUMENT on zero or negative budget', async () => {
    const store = await createSeededStore();

    await expect(
      retrieveForContext({
        store,
        query: 'test',
        tokenBudget: 0,
        clock,
      }),
    ).rejects.toThrow(AirError);

    await expect(
      retrieveForContext({
        store,
        query: 'test',
        tokenBudget: -10,
        clock,
      }),
    ).rejects.toThrow(AirError);

    await store.close();
  });

  it('throws INVALID_ARGUMENT on empty query', async () => {
    const store = await createSeededStore();

    await expect(
      retrieveForContext({
        store,
        query: '   ',
        tokenBudget: 100,
        clock,
      }),
    ).rejects.toThrow(AirError);

    await store.close();
  });

  it('supports custom tokenizer and formatEntry options', async () => {
    const store = await createSeededStore();

    let customTokenizerCalled = false;
    let customFormatCalled = false;

    const result = await retrieveForContext({
      store,
      query: 'Node.js',
      tokenBudget: 500,
      clock,
      tokenizer: (text: string) => {
        customTokenizerCalled = true;
        return text.split(/\s+/).length;
      },
      formatEntry: (entry: MemoryEntry, score: number) => {
        customFormatCalled = true;
        return `CUSTOM[${(score * 100).toFixed(0)}]: ${entry.title}`;
      },
    });

    expect(customTokenizerCalled).toBe(true);
    expect(customFormatCalled).toBe(true);
    expect(result.formattedContext).toContain('CUSTOM[');

    await store.close();
  });
});
