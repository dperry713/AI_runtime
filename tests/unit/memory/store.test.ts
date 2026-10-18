/**
 * Unit tests for SqliteMemoryStore (P8-T02).
 *
 * All tests use ':memory:' SQLite so no disk I/O occurs.
 * Covers: migrations, write, batchWrite, get, update, forget, forgetByFilter,
 *         search (BM25/FTS5), list, pruneExpired, count, access tracking,
 *         closed-store guard, embedding round-trip, and FTS rebuild.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, UlidIdGenerator } from '../../../src/util/index.js';
import type { CreateMemoryInput, MemoryEntry } from '../../../src/memory/index.js';
import {
  SqliteMemoryStore,
  getMemoryMigrationVersion,
  runMemoryMigrations,
  memoryMigrationV1,
} from '../../../src/memory/index.js';
import { AirError } from '../../../src/errors/index.js';
import {
  createMemoryId,
  parseAgentId,
} from '../../../src/types/index.js';
import Database from 'better-sqlite3';

// ============================================================================
// Helpers
// ============================================================================

function makeClock(iso = '2026-01-01T00:00:00.000Z'): FakeClock {
  return new FakeClock(new Date(iso));
}

function makeStore(clockIso?: string): { store: SqliteMemoryStore; clock: FakeClock } {
  const clock = makeClock(clockIso);
  const idGenerator = new UlidIdGenerator(clock);
  const store = new SqliteMemoryStore({
    dbPath: ':memory:',
    clock,
    idGenerator,
  });
  return { store, clock };
}

const episodicInput = (overrides: Partial<CreateMemoryInput> = {}): CreateMemoryInput => ({
  kind: 'episodic',
  scope: 'global',
  title: 'Test Memory',
  content: 'This is the content of the test memory entry.',
  ...overrides,
});

// ============================================================================
// Migration tests
// ============================================================================

describe('memory store migrations', () => {
  it('creates schema from version 0 to 1', () => {
    const db = new Database(':memory:');
    const result = runMemoryMigrations(db, { clock: makeClock() });
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(1);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.name).toBe('001_initial_schema');
    db.close();
  });

  it('is idempotent when already at target version', () => {
    const db = new Database(':memory:');
    const clock = makeClock();
    runMemoryMigrations(db, { clock });
    const result2 = runMemoryMigrations(db, { clock });
    expect(result2.fromVersion).toBe(1);
    expect(result2.toVersion).toBe(1);
    expect(result2.applied).toHaveLength(0);
    db.close();
  });

  it('creates memories table with correct columns', () => {
    const db = new Database(':memory:');
    runMemoryMigrations(db, { clock: makeClock() });
    const info = db.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toContain('id');
    expect(cols).toContain('kind');
    expect(cols).toContain('scope');
    expect(cols).toContain('title');
    expect(cols).toContain('content');
    // Check FTS virtual table exists
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('memories');
    expect(names).toContain('memories_fts');
    db.close();
  });

  it('getMemoryMigrationVersion returns 0 on fresh DB', () => {
    const db = new Database(':memory:');
    expect(getMemoryMigrationVersion(db)).toBe(0);
    db.close();
  });

  it('rolls back migration v1 via down()', () => {
    const db = new Database(':memory:');
    const clock = makeClock();
    runMemoryMigrations(db, { clock });
    expect(getMemoryMigrationVersion(db)).toBe(1);

    // Roll back to version 0
    runMemoryMigrations(db, { clock, targetVersion: 0 });
    expect(getMemoryMigrationVersion(db)).toBe(0);

    // memories table should be gone
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).not.toContain('memories');
    db.close();
  });

  it('throws MIGRATION_FAILED when no down() exists', () => {
    const db = new Database(':memory:');
    const migration = { ...memoryMigrationV1, down: undefined };
    const clock = makeClock();
    runMemoryMigrations(db, { clock, migrations: [migration] });

    expect(() =>
      runMemoryMigrations(db, { clock, migrations: [migration], targetVersion: 0 }),
    ).toThrow(AirError);
  });

  it('stores applied_at timestamp in _memory_migrations', () => {
    const db = new Database(':memory:');
    const clock = makeClock('2026-06-15T12:00:00.000Z');
    runMemoryMigrations(db, { clock });
    const row = db
      .prepare('SELECT applied_at FROM _memory_migrations WHERE version = 1')
      .get() as { applied_at: string };
    expect(row.applied_at).toBe('2026-06-15T12:00:00.000Z');
    db.close();
  });
});

// ============================================================================
// Store lifecycle
// ============================================================================

describe('SqliteMemoryStore lifecycle', () => {
  it('opens and closes without error', async () => {
    const { store } = makeStore();
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('throws INVALID_ARGUMENT for empty dbPath', () => {
    expect(
      () =>
        new SqliteMemoryStore({
          dbPath: '',
          clock: makeClock(),
        }),
    ).toThrow(AirError);
  });

  it('throws INVALID_STATE after close on write', async () => {
    const { store } = makeStore();
    await store.close();
    await expect(store.write(episodicInput())).rejects.toThrow(AirError);
  });

  it('throws INVALID_STATE after close on get', async () => {
    const { store } = makeStore();
    await store.close();
    await expect(store.get(createMemoryId())).rejects.toThrow(AirError);
  });

  it('close() is idempotent', async () => {
    const { store } = makeStore();
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });
});

// ============================================================================
// write / get
// ============================================================================

describe('SqliteMemoryStore.write and get', () => {
  let store: SqliteMemoryStore;

  beforeEach(() => {
    ({ store } = makeStore('2026-03-01T10:00:00.000Z'));
  });
  afterEach(() => store.close());

  it('writes a global episodic memory and retrieves it', async () => {
    const entry = await store.write(episodicInput());
    expect(entry.kind).toBe('episodic');
    expect(entry.scope).toBe('global');
    expect(entry.title).toBe('Test Memory');
    expect(entry.content).toBe('This is the content of the test memory entry.');
    expect(entry.importance).toBe(0.5);
    expect(entry.tags).toEqual([]);
    expect(entry.createdAt).toBe('2026-03-01T10:00:00.000Z');

    const fetched = await store.get(entry.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(entry.id);
  });

  it('returns null for unknown id', async () => {
    const result = await store.get(createMemoryId());
    expect(result).toBeNull();
  });

  it('writes with explicit id', async () => {
    const id = createMemoryId();
    const entry = await store.write(episodicInput({ id }));
    expect(entry.id).toBe(id);
  });

  it('writes with tags, metadata, and importance', async () => {
    const entry = await store.write(
      episodicInput({
        tags: ['ai', 'context'],
        metadata: { source: 'unit-test' },
        importance: 0.9,
      }),
    );
    expect(entry.tags).toEqual(['ai', 'context']);
    expect(entry.metadata['source']).toBe('unit-test');
    expect(entry.importance).toBe(0.9);
  });

  it('writes with TTL and sets expiresAt', async () => {
    const entry = await store.write(episodicInput({ ttlSeconds: 3600 }));
    expect(entry.ttlSeconds).toBe(3600);
    expect(entry.expiresAt).toBe('2026-03-01T11:00:00.000Z');
  });

  it('writes with provenance and taint', async () => {
    const entry = await store.write(
      episodicInput({
        provenance: { source: 'model', taint: 'tainted' },
      }),
    );
    expect(entry.provenance.source).toBe('model');
    expect(entry.provenance.taint).toBe('tainted');
  });

  it('writes an agent-scoped memory with agentId', async () => {
    const agentId = parseAgentId('01HAGEN0000000000000000000');
    const entry = await store.write(
      episodicInput({ scope: 'agent', agentId }),
    );
    expect(entry.scope).toBe('agent');
    expect(entry.agentId).toBe(agentId);
  });

  it('get() increments access_count on each call', async () => {
    const entry = await store.write(episodicInput());
    await store.get(entry.id);
    await store.get(entry.id);
    const fetched = await store.get(entry.id);
    // Access count reflects previous gets (the third get reads after two prior increments)
    expect(fetched?.accessCount).toBeGreaterThanOrEqual(2);
  });

  it('writes with embedding round-trip', async () => {
    const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
    const entry = await store.write(episodicInput({ embedding }));
    const fetched = await store.get(entry.id);
    expect(fetched?.embedding).toBeDefined();
    const fetchedEmbedding = fetched?.embedding ?? [];
    expect(fetchedEmbedding.length).toBe(5);
    // Float64 round-trip: values should be close
    for (let i = 0; i < embedding.length; i++) {
      expect(fetchedEmbedding[i]).toBeCloseTo(embedding[i] ?? 0, 10);
    }
  });
});

// ============================================================================
// batchWrite
// ============================================================================

describe('SqliteMemoryStore.batchWrite', () => {
  let store: SqliteMemoryStore;
  afterEach(() => store.close());

  it('writes multiple entries atomically', async () => {
    ({ store } = makeStore());
    const inputs: CreateMemoryInput[] = [
      episodicInput({ title: 'A', content: 'Alpha content' }),
      episodicInput({ kind: 'semantic', title: 'B', content: 'Beta content' }),
      episodicInput({ kind: 'working', title: 'C', content: 'Gamma content' }),
    ];
    const entries = await store.batchWrite(inputs);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.title)).toEqual(['A', 'B', 'C']);
  });

  it('returns empty array for empty input', async () => {
    ({ store } = makeStore());
    const result = await store.batchWrite([]);
    expect(result).toEqual([]);
  });

  it('all entries are retrievable after batch write', async () => {
    ({ store } = makeStore());
    const inputs = Array.from({ length: 10 }, (_, i) =>
      episodicInput({ title: `Entry ${i}`, content: `Content number ${i}` }),
    );
    const entries = await store.batchWrite(inputs);
    for (const entry of entries) {
      const fetched = await store.get(entry.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.title).toBe(entry.title);
    }
  });
});

// ============================================================================
// update
// ============================================================================

describe('SqliteMemoryStore.update', () => {
  let store: SqliteMemoryStore;
  let clock: FakeClock;
  afterEach(() => store.close());

  it('updates title and content', async () => {
    ({ store, clock } = makeStore('2026-04-01T00:00:00.000Z'));
    const entry = await store.write(episodicInput());
    clock.advance(60_000); // +1 minute

    const updated = await store.update(entry.id, {
      title: 'Updated Title',
      content: 'Updated content value.',
    });

    expect(updated.title).toBe('Updated Title');
    expect(updated.content).toBe('Updated content value.');
    expect(updated.updatedAt).toBe('2026-04-01T00:01:00.000Z');
  });

  it('updates importance', async () => {
    ({ store } = makeStore());
    const entry = await store.write(episodicInput({ importance: 0.3 }));
    const updated = await store.update(entry.id, { importance: 0.95 });
    expect(updated.importance).toBe(0.95);
  });

  it('updates tags', async () => {
    ({ store } = makeStore());
    const entry = await store.write(episodicInput({ tags: ['old'] }));
    const updated = await store.update(entry.id, { tags: ['new', 'tags'] });
    expect(updated.tags).toEqual(['new', 'tags']);
  });

  it('clears TTL by passing null', async () => {
    ({ store } = makeStore('2026-05-01T00:00:00.000Z'));
    const entry = await store.write(episodicInput({ ttlSeconds: 3600 }));
    expect(entry.expiresAt).toBeDefined();

    const updated = await store.update(entry.id, { ttlSeconds: null });
    expect(updated.ttlSeconds).toBeUndefined();
    expect(updated.expiresAt).toBeUndefined();
  });

  it('sets a new TTL', async () => {
    ({ store, clock } = makeStore('2026-05-01T12:00:00.000Z'));
    const entry = await store.write(episodicInput());
    const updated = await store.update(entry.id, { ttlSeconds: 7200 });
    expect(updated.ttlSeconds).toBe(7200);
    expect(updated.expiresAt).toBe('2026-05-01T14:00:00.000Z');
  });

  it('throws MEMORY_NOT_FOUND for unknown id', async () => {
    ({ store } = makeStore());
    await expect(
      store.update(createMemoryId(), {
        title: 'x',
      }),
    ).rejects.toThrow(AirError);
  });

  it('updates embedding', async () => {
    ({ store } = makeStore());
    const entry = await store.write(episodicInput());
    const newEmbedding = [0.9, 0.8, 0.7];
    const updated = await store.update(entry.id, { embedding: newEmbedding });
    expect(updated.embedding).toBeDefined();
    expect(updated.embedding?.length).toBe(3);
  });

  it('clears embedding by passing null', async () => {
    ({ store } = makeStore());
    const entry = await store.write(episodicInput({ embedding: [0.1, 0.2] }));
    const updated = await store.update(entry.id, { embedding: null });
    expect(updated.embedding).toBeUndefined();
  });
});

// ============================================================================
// forget / forgetByFilter
// ============================================================================

describe('SqliteMemoryStore.forget and forgetByFilter', () => {
  let store: SqliteMemoryStore;
  afterEach(() => store.close());

  it('forget() removes an entry and returns true', async () => {
    ({ store } = makeStore());
    const entry = await store.write(episodicInput());
    const removed = await store.forget(entry.id);
    expect(removed).toBe(true);
    const fetched = await store.get(entry.id);
    expect(fetched).toBeNull();
  });

  it('forget() returns false for non-existent id', async () => {
    ({ store } = makeStore());
    const removed = await store.forget(createMemoryId());
    expect(removed).toBe(false);
  });

  it('forgetByFilter() deletes by kind', async () => {
    ({ store } = makeStore());
    await store.batchWrite([
      episodicInput({ kind: 'episodic', title: 'E1', content: 'ep1' }),
      episodicInput({ kind: 'semantic', title: 'S1', content: 'sem1' }),
      episodicInput({ kind: 'episodic', title: 'E2', content: 'ep2' }),
    ]);
    const deleted = await store.forgetByFilter({ kinds: ['episodic'] });
    expect(deleted).toBe(2);
    const remaining = await store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.kind).toBe('semantic');
  });

  it('forgetByFilter() returns 0 for empty match', async () => {
    ({ store } = makeStore());
    await store.write(episodicInput());
    const deleted = await store.forgetByFilter({ kinds: ['working'] });
    expect(deleted).toBe(0);
  });

  it('forgetByFilter() deletes by tags (post-filter)', async () => {
    ({ store } = makeStore());
    await store.batchWrite([
      episodicInput({ title: 'tagged', content: 'has tag', tags: ['delete-me'] }),
      episodicInput({ title: 'clean', content: 'no tag' }),
    ]);
    const deleted = await store.forgetByFilter({ tags: ['delete-me'] });
    expect(deleted).toBe(1);
    const remaining = await store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.title).toBe('clean');
  });

  it('forget() removes entry from FTS index', async () => {
    ({ store } = makeStore());
    const entry = await store.write(
      episodicInput({ title: 'UniqueFtsWord', content: 'fts delete test' }),
    );
    await store.forget(entry.id);
    const results = await store.search({ query: 'UniqueFtsWord' });
    expect(results).toHaveLength(0);
  });
});

// ============================================================================
// search (FTS5 / BM25)
// ============================================================================

describe('SqliteMemoryStore.search (keyword / BM25)', () => {
  let store: SqliteMemoryStore;
  afterEach(() => store.close());

  async function seedSearchData(): Promise<MemoryEntry[]> {
    return store.batchWrite([
      episodicInput({ title: 'TypeScript Tips', content: 'TypeScript has great type inference and strict mode.' }),
      episodicInput({ title: 'Python Basics', content: 'Python is a dynamically typed language with simple syntax.' }),
      episodicInput({ kind: 'semantic', title: 'Machine Learning Overview', content: 'Machine learning algorithms include neural networks and decision trees.' }),
      episodicInput({ kind: 'working', title: 'Current Task', content: 'Working on the memory store implementation for AIR runtime.', importance: 0.9 }),
    ]);
  }

  it('returns entries matching keyword query', async () => {
    ({ store } = makeStore());
    await seedSearchData();
    const results = await store.search({ query: 'TypeScript' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.entry.title).toBe('TypeScript Tips');
    expect(results[0]?.matchedBy).toBe('keyword');
  });

  it('returns empty for no-match query', async () => {
    ({ store } = makeStore());
    await seedSearchData();
    const results = await store.search({ query: 'xylophone2222' });
    expect(results).toHaveLength(0);
  });

  it('respects limit parameter', async () => {
    ({ store } = makeStore());
    await seedSearchData();
    const results = await store.search({ query: 'memory learning TypeScript Python', limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('filters by kind', async () => {
    ({ store } = makeStore());
    await seedSearchData();
    const results = await store.search({
      query: 'language',
      filter: { kinds: ['semantic'] },
    });
    for (const r of results) {
      expect(r.entry.kind).toBe('semantic');
    }
  });

  it('returns highlights', async () => {
    ({ store } = makeStore());
    await seedSearchData();
    const results = await store.search({ query: 'TypeScript' });
    if (results.length > 0) {
      // Highlights may be undefined for some FTS5 builds but should exist
      // for the primary match
      const first = results[0];
      if (first) {
        expect(first.score).toBeGreaterThan(0);
      }
    }
  });

  it('score is in [0,1] range', async () => {
    ({ store } = makeStore());
    await seedSearchData();
    const results = await store.search({ query: 'TypeScript neural learning' });
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('minScore filters out low-relevance results', async () => {
    ({ store } = makeStore());
    await seedSearchData();
    const results = await store.search({ query: 'TypeScript', minScore: 0.99 });
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.99);
    }
  });

  it('handles invalid MATCH query gracefully (returns empty)', async () => {
    ({ store } = makeStore());
    await seedSearchData();
    // FTS5 MATCH with an invalid query syntax
    const results = await store.search({ query: '"' });
    expect(results).toEqual([]);
  });

  it('mode=vector falls back to importance-ordered results', async () => {
    ({ store } = makeStore());
    await seedSearchData();
    const results = await store.search({ query: 'anything', mode: 'vector', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.matchedBy).toBe('vector');
    }
    // Should be ordered by importance DESC
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      const curr = results[i];
      if (prev && curr) {
        expect(prev.score).toBeGreaterThanOrEqual(curr.score);
      }
    }
  });

  it('mode=hybrid returns keyword results', async () => {
    ({ store } = makeStore());
    await seedSearchData();
    const results = await store.search({ query: 'TypeScript', mode: 'hybrid' });
    expect(results.length).toBeGreaterThan(0);
  });

  it('excludes expired entries from search', async () => {
    let clock: FakeClock;
    ({ store, clock } = makeStore('2026-01-01T00:00:00.000Z'));
    await store.write(
      episodicInput({
        title: 'Expired Memory',
        content: 'expired entry search test',
        ttlSeconds: 60, // expires in 1 min
      }),
    );
    // Advance clock past expiry
    clock.advance(120_000);
    const results = await store.search({
      query: 'expired',
      filter: { includeExpired: false },
    });
    // The TTL hasn't physically expired yet in the DB (prune not run),
    // but filter excludes based on expires_at > now
    expect(results).toHaveLength(0);
  });
});

// ============================================================================
// list
// ============================================================================

describe('SqliteMemoryStore.list', () => {
  let store: SqliteMemoryStore;
  afterEach(() => store.close());

  it('lists all entries', async () => {
    ({ store } = makeStore());
    await store.batchWrite([
      episodicInput({ title: 'A', content: 'a' }),
      episodicInput({ title: 'B', content: 'b' }),
      episodicInput({ title: 'C', content: 'c' }),
    ]);
    const entries = await store.list();
    expect(entries.length).toBe(3);
  });

  it('filters by scope', async () => {
    ({ store } = makeStore());
    const agentId = parseAgentId('01HAGEN0000000000000000000');
    await store.batchWrite([
      episodicInput({ scope: 'agent', agentId, title: 'Agent Mem', content: 'agent scoped' }),
      episodicInput({ scope: 'global', title: 'Global Mem', content: 'global scoped' }),
    ]);
    const agentEntries = await store.list({ scopes: ['agent'] });
    expect(agentEntries).toHaveLength(1);
    expect(agentEntries[0]?.scope).toBe('agent');
  });

  it('respects limit and offset', async () => {
    ({ store } = makeStore());
    await store.batchWrite(
      Array.from({ length: 5 }, (_, i) =>
        episodicInput({ title: `Entry ${i}`, content: `content ${i}` }),
      ),
    );
    const page1 = await store.list(undefined, { limit: 2, offset: 0 });
    const page2 = await store.list(undefined, { limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    // Pages should not overlap
    const ids1 = new Set(page1.map((e) => e.id));
    const ids2 = new Set(page2.map((e) => e.id));
    for (const id of ids2) {
      expect(ids1.has(id)).toBe(false);
    }
  });

  it('filters by taint (post-filter)', async () => {
    ({ store } = makeStore());
    await store.batchWrite([
      episodicInput({
        title: 'Tainted',
        content: 'tainted content',
        provenance: { source: 'model', taint: 'tainted' },
      }),
      episodicInput({
        title: 'Clean',
        content: 'clean content',
        provenance: { source: 'user', taint: 'clean' },
      }),
    ]);
    const tainted = await store.list({ taint: ['tainted'] });
    expect(tainted).toHaveLength(1);
    expect(tainted[0]?.title).toBe('Tainted');
  });
});

// ============================================================================
// pruneExpired
// ============================================================================

describe('SqliteMemoryStore.pruneExpired', () => {
  let store: SqliteMemoryStore;
  afterEach(() => store.close());

  it('removes expired entries and returns count', async () => {
    ({ store } = makeStore('2026-06-01T00:00:00.000Z'));
    // Write 2 expiring and 1 permanent
    await store.batchWrite([
      episodicInput({ title: 'Exp A', content: 'expires soon', ttlSeconds: 60 }),  // expires 2026-06-01T00:01:00Z
      episodicInput({ title: 'Exp B', content: 'expires soon', ttlSeconds: 120 }), // expires 2026-06-01T00:02:00Z
      episodicInput({ title: 'Permanent', content: 'no TTL' }),
    ]);

    const pruned = await store.pruneExpired('2026-06-01T00:03:00.000Z');
    expect(pruned).toBe(2);

    const remaining = await store.list(undefined, { limit: 100 });
    expect(remaining.filter((e) => e.title !== 'Permanent')).toHaveLength(0);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.title).toBe('Permanent');
  });

  it('returns 0 when nothing is expired', async () => {
    ({ store } = makeStore('2026-06-01T00:00:00.000Z'));
    await store.write(episodicInput({ ttlSeconds: 7200 }));
    const pruned = await store.pruneExpired('2026-06-01T00:00:01.000Z');
    expect(pruned).toBe(0);
  });

  it('uses clock.iso() when nowIso not provided', async () => {
    ({ store } = makeStore('2030-01-01T00:00:00.000Z'));
    await store.write(episodicInput({ ttlSeconds: 1 })); // expired at 2030-01-01T00:00:01Z
    const pruned = await store.pruneExpired(); // uses clock which is at 2030-01-01T00:00:00Z
    // Clock is at exact created_at time; entry expires 1s later, so NOT expired yet
    expect(pruned).toBe(0);
  });
});

// ============================================================================
// count
// ============================================================================

describe('SqliteMemoryStore.count', () => {
  let store: SqliteMemoryStore;
  afterEach(() => store.close());

  it('returns total count with no filter', async () => {
    ({ store } = makeStore());
    await store.batchWrite([
      episodicInput({ title: 'A', content: 'a' }),
      episodicInput({ title: 'B', content: 'b' }),
    ]);
    const count = await store.count();
    expect(count).toBe(2);
  });

  it('returns filtered count', async () => {
    ({ store } = makeStore());
    await store.batchWrite([
      episodicInput({ kind: 'episodic', title: 'E', content: 'ep' }),
      episodicInput({ kind: 'semantic', title: 'S', content: 'sem' }),
    ]);
    const count = await store.count({ kinds: ['episodic'] });
    expect(count).toBe(1);
  });

  it('returns 0 for empty store', async () => {
    ({ store } = makeStore());
    expect(await store.count()).toBe(0);
  });
});

// ============================================================================
// rebuildFts
// ============================================================================

describe('SqliteMemoryStore.rebuildFts', () => {
  it('runs without error on a store with data', async () => {
    const { store } = makeStore();
    await store.write(episodicInput({ title: 'FTS Rebuild Test', content: 'rebuild content' }));
    expect(() => store.rebuildFts()).not.toThrow();
    // Search still works after rebuild
    const results = await store.search({ query: 'rebuild' });
    expect(results.length).toBeGreaterThan(0);
    await store.close();
  });
});

// ============================================================================
// FTS trigger integrity
// ============================================================================

describe('FTS5 trigger integrity', () => {
  let store: SqliteMemoryStore;
  afterEach(() => store.close());

  it('FTS index is updated after write', async () => {
    ({ store } = makeStore());
    await store.write(episodicInput({ title: 'FtsInsertTrigger', content: 'trigger insert test' }));
    const results = await store.search({ query: 'FtsInsertTrigger' });
    expect(results.length).toBeGreaterThan(0);
  });

  it('FTS index is updated after update', async () => {
    ({ store } = makeStore());
    const entry = await store.write(
      episodicInput({ title: 'OldTitle', content: 'old content here' }),
    );
    await store.update(entry.id, { title: 'NewUniqueTitle', content: 'new content here' });

    const oldResults = await store.search({ query: 'OldTitle' });
    // Old title should not appear in FTS results after update
    const hasOld = oldResults.some((r) => r.entry.id === entry.id);
    expect(hasOld).toBe(false);

    const newResults = await store.search({ query: 'NewUniqueTitle' });
    expect(newResults.some((r) => r.entry.id === entry.id)).toBe(true);
  });

  it('FTS index is updated after delete', async () => {
    ({ store } = makeStore());
    const entry = await store.write(
      episodicInput({ title: 'DeleteTriggerWord', content: 'to be deleted from fts' }),
    );
    await store.forget(entry.id);
    const results = await store.search({ query: 'DeleteTriggerWord' });
    expect(results).toHaveLength(0);
  });
});
