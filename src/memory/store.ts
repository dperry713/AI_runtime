/**
 * SQLite + FTS5 Memory Store for AIR (P8-T02).
 *
 * Implements the MemoryStore interface with:
 * - better-sqlite3 backing store at %LOCALAPPDATA%\AIR\memory.db (Rule R10).
 * - WAL mode, configurable PRAGMA synchronous, foreign-key enforcement.
 * - FTS5 virtual table with BM25 ranking for keyword search.
 * - TTL pruning via pruneExpired().
 * - batchWrite() inside a single transaction for throughput.
 * - Injected Clock and IdGenerator for deterministic behaviour (Rule R6).
 * - node:fs usage is scoped to directory creation only (Rule R2 intent preserved).
 */

import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { AirError } from '../errors/index.js';
import type { MemoryId } from '../types/index.js';
import { parseMemoryId } from '../types/index.js';
import {
  canonicalize,
  type Clock,
  type IdGenerator,
  SystemClock,
  UlidIdGenerator,
} from '../util/index.js';
import {
  type CreateMemoryInput,
  type MemoryEntry,
  type MemoryFilter,
  type MemorySearchQuery,
  type MemorySearchResult,
  type MemoryStore,
  type UpdateMemoryInput,
  calculateExpiresAt,
  matchesFilter,
  MemoryEntrySchema,
} from './types.js';
import { ALL_MEMORY_MIGRATIONS, runMemoryMigrations } from './store-migrations.js';
import type { EmbeddingProvider } from './embeddings.js';
import { rankByVector } from './embeddings.js';
import type { MemoryWritePolicy } from './write-policy.js';

// ============================================================================
// Options
// ============================================================================

export interface SqliteMemoryStoreOptions {
  /** Absolute path to the SQLite file, or ':memory:' for in-process testing. */
  dbPath: string;
  /** SQLite busy timeout in milliseconds. Defaults to 5000. */
  busyTimeoutMs?: number | undefined;
  /** Whether to use WAL journal_mode (ignored for :memory:). Defaults to true. */
  wal?: boolean | undefined;
  /** PRAGMA synchronous value. Defaults to 'NORMAL'. */
  synchronous?: 'OFF' | 'NORMAL' | 'FULL' | undefined;
  /** Injected clock for deterministic timestamps (Rule R6). */
  clock?: Clock | undefined;
  /** Injected ID generator (Rule R6). */
  idGenerator?: IdGenerator | undefined;
  /** Whether to run migrations automatically on open. Defaults to true. */
  autoMigrate?: boolean | undefined;
  /** Optional embedding provider for vector and hybrid search. */
  embeddingProvider?: EmbeddingProvider | undefined;
  /** Whether to automatically embed new entries on write if embedding is not provided. */
  autoEmbed?: boolean | undefined;
  /** Optional memory write policy for enforcing allow/deny rules, secret/PII scrub, and taint tracking. */
  writePolicy?: MemoryWritePolicy | undefined;
}

// ============================================================================
// Raw SQLite row shapes (snake_case from SQLite → camelCase domain types)
// ============================================================================

interface RawMemoryRow {
  id: string;
  kind: string;
  scope: string;
  agent_id: string | null;
  session_id: string | null;
  run_id: string | null;
  title: string;
  content: string;
  tags: string;       // JSON array
  metadata: string;   // JSON object
  importance: number;
  provenance: string; // JSON object
  created_at: string;
  updated_at: string;
  accessed_at: string | null;
  access_count: number;
  ttl_seconds: number | null;
  expires_at: string | null;
  embedding: Buffer | null;
}

interface FtsExtras {
  bm25_score: number;
  title_snippet: string;
  content_snippet: string;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new AirError('INTERNAL', String(err));
}

// ============================================================================
// Row mapper
// ============================================================================

function rowToEntry(row: RawMemoryRow): MemoryEntry {
  const raw = {
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    agentId: row.agent_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    runId: row.run_id ?? undefined,
    title: row.title,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    importance: row.importance,
    provenance: JSON.parse(row.provenance) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessedAt: row.accessed_at ?? undefined,
    accessCount: row.access_count,
    ttlSeconds: row.ttl_seconds ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    embedding:
      row.embedding != null
        ? Array.from(
            new Float64Array(
              row.embedding.buffer,
              row.embedding.byteOffset,
              row.embedding.byteLength / 8,
            ),
          )
        : undefined,
  };
  return MemoryEntrySchema.parse(raw) as unknown as MemoryEntry;
}

// ============================================================================
// Filter → SQL helpers
// ============================================================================

interface WhereClause {
  where: string;
  params: unknown[];
}

/**
 * Builds a SQL WHERE clause + params array from a MemoryFilter.
 * Tags and taint are checked post-query (stored as JSON).
 */
function buildFilterWhere(filter?: MemoryFilter, nowIso?: string): WhereClause {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter?.kinds && filter.kinds.length > 0) {
    clauses.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
    params.push(...filter.kinds);
  }
  if (filter?.scopes && filter.scopes.length > 0) {
    clauses.push(`scope IN (${filter.scopes.map(() => '?').join(',')})`);
    params.push(...filter.scopes);
  }
  if (filter?.agentId) {
    clauses.push('agent_id = ?');
    params.push(filter.agentId);
  }
  if (filter?.sessionId) {
    clauses.push('session_id = ?');
    params.push(filter.sessionId);
  }
  if (filter?.runId) {
    clauses.push('run_id = ?');
    params.push(filter.runId);
  }
  if (filter?.minImportance !== undefined) {
    clauses.push('importance >= ?');
    params.push(filter.minImportance);
  }

  // Expiry: exclude expired unless includeExpired is explicitly true
  const includeExpired = filter?.includeExpired ?? false;
  if (!includeExpired && nowIso) {
    clauses.push('(expires_at IS NULL OR expires_at > ?)');
    params.push(nowIso);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

// ============================================================================
// SqliteMemoryStore
// ============================================================================

export class SqliteMemoryStore implements MemoryStore {
  readonly dbPath: string;
  readonly isMemory: boolean;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly busyTimeoutMs: number;
  readonly embeddingProvider?: EmbeddingProvider | undefined;
  readonly autoEmbed: boolean;
  readonly writePolicy?: MemoryWritePolicy | undefined;

  private db: DatabaseType;
  private closed = false;

  // Cached prepared statements
  private insertStmt: Statement;
  private getByIdStmt: Statement;
  private deleteStmt: Statement;
  private accessStmt: Statement;

  constructor(options: SqliteMemoryStoreOptions) {
    if (!options.dbPath || options.dbPath.trim().length === 0) {
      throw new AirError('INVALID_ARGUMENT', 'dbPath cannot be empty');
    }

    this.isMemory = options.dbPath === ':memory:';
    this.clock = options.clock ?? new SystemClock();
    this.idGenerator = options.idGenerator ?? new UlidIdGenerator();
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    this.embeddingProvider = options.embeddingProvider;
    this.autoEmbed = options.autoEmbed ?? false;
    this.writePolicy = options.writePolicy;

    if (this.isMemory) {
      this.dbPath = ':memory:';
    } else {
      const canonical = canonicalize(options.dbPath);
      const parentDir = path.dirname(canonical);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      this.dbPath = canonical;
    }

    try {
      this.db = new Database(this.dbPath);
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw new AirError(
        'MEMORY_NOT_FOUND',
        `Failed to open memory database at "${this.dbPath}": ${String(err)}`,
        { cause },
      );
    }

    this.configurePragmas(options);

    if (options.autoMigrate !== false) {
      runMemoryMigrations(this.db, {
        migrations: ALL_MEMORY_MIGRATIONS,
        clock: this.clock,
      });
    }

    // Prepare statements
    this.insertStmt = this.db.prepare(`
      INSERT INTO memories (
        id, kind, scope, agent_id, session_id, run_id,
        title, content, tags, metadata, importance, provenance,
        created_at, updated_at, accessed_at, access_count,
        ttl_seconds, expires_at, embedding
      ) VALUES (
        @id, @kind, @scope, @agent_id, @session_id, @run_id,
        @title, @content, @tags, @metadata, @importance, @provenance,
        @created_at, @updated_at, @accessed_at, @access_count,
        @ttl_seconds, @expires_at, @embedding
      )
    `);

    this.getByIdStmt = this.db.prepare('SELECT * FROM memories WHERE id = ?');

    this.deleteStmt = this.db.prepare('DELETE FROM memories WHERE id = ?');

    this.accessStmt = this.db.prepare(`
      UPDATE memories
      SET access_count = access_count + 1,
          accessed_at  = @accessed_at
      WHERE id = @id
    `);
  }

  private configurePragmas(options: SqliteMemoryStoreOptions): void {
    this.db.pragma(`busy_timeout = ${this.busyTimeoutMs}`);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('temp_store = MEMORY');

    if (!this.isMemory && options.wal !== false) {
      this.db.pragma('journal_mode = WAL');
    }

    const sync = options.synchronous ?? 'NORMAL';
    this.db.pragma(`synchronous = ${sync}`);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AirError('INVALID_STATE', 'SqliteMemoryStore is closed');
    }
  }

  private buildInsertRow(input: CreateMemoryInput, now: string, id: MemoryId) {
    const provenance = input.provenance ?? { source: 'system' as const, taint: 'clean' as const };
    const expiresAt =
      input.ttlSeconds != null ? calculateExpiresAt(now, input.ttlSeconds) : undefined;
    const embeddingBuf =
      input.embedding != null ? Buffer.from(new Float64Array(input.embedding).buffer) : null;

    return {
      id,
      kind: input.kind,
      scope: input.scope,
      agent_id: input.agentId ?? null,
      session_id: input.sessionId ?? null,
      run_id: input.runId ?? null,
      title: input.title,
      content: input.content,
      tags: JSON.stringify(input.tags ?? []),
      metadata: JSON.stringify(input.metadata ?? {}),
      importance: input.importance ?? 0.5,
      provenance: JSON.stringify(provenance),
      created_at: now,
      updated_at: now,
      accessed_at: null,
      access_count: 0,
      ttl_seconds: input.ttlSeconds ?? null,
      expires_at: expiresAt ?? null,
      embedding: embeddingBuf,
    };
  }

  // --------------------------------------------------------------------------
  // write
  // --------------------------------------------------------------------------

  async write(input: CreateMemoryInput): Promise<MemoryEntry> {
    this.assertOpen();
    const validatedInput = this.writePolicy
      ? this.writePolicy.assertAllowed(input)
      : input;

    let embedding = validatedInput.embedding;
    if (embedding === undefined && this.autoEmbed && this.embeddingProvider) {
      try {
        embedding = await this.embeddingProvider.embed(`${validatedInput.title}\n${validatedInput.content}`);
      } catch {
        // Silently continue without embedding if auto-embed fails
      }
    }
    const finalInput = embedding !== undefined ? { ...validatedInput, embedding } : validatedInput;

    const now = this.clock.iso();
    const id = finalInput.id ?? parseMemoryId(this.idGenerator.next());
    const row = this.buildInsertRow(finalInput, now, id);

    try {
      this.insertStmt.run(row);
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw new AirError(
        'MEMORY_NOT_FOUND',
        `Failed to write memory "${id}": ${String(err)}`,
        { cause },
      );
    }

    const raw = this.getByIdStmt.get(id) as RawMemoryRow | undefined;
    if (!raw) {
      throw new AirError('MEMORY_NOT_FOUND', `Memory "${id}" not found after write`);
    }
    return rowToEntry(raw);
  }

  // --------------------------------------------------------------------------
  // batchWrite
  // --------------------------------------------------------------------------

  async batchWrite(inputs: CreateMemoryInput[]): Promise<MemoryEntry[]> {
    this.assertOpen();
    if (inputs.length === 0) return [];

    const validatedInputs = this.writePolicy
      ? this.writePolicy.enforceOnBatch(inputs)
      : inputs;

    let processedInputs = validatedInputs;
    if (this.autoEmbed && this.embeddingProvider) {
      const needsEmbed: { index: number; text: string }[] = [];
      validatedInputs.forEach((input, index) => {
        if (input.embedding === undefined) {
          needsEmbed.push({ index, text: `${input.title}\n${input.content}` });
        }
      });

      if (needsEmbed.length > 0) {
        try {
          const vectors = await this.embeddingProvider.embedBatch(
            needsEmbed.map((item) => item.text),
          );
          processedInputs = inputs.map((input, index) => {
            const matchIndex = needsEmbed.findIndex((item) => item.index === index);
            if (matchIndex >= 0 && vectors[matchIndex]) {
              return { ...input, embedding: vectors[matchIndex] };
            }
            return input;
          });
        } catch {
          // If auto-embed fails, continue with original inputs
        }
      }
    }

    const ids: MemoryId[] = processedInputs.map((input) =>
      input.id ?? parseMemoryId(this.idGenerator.next()),
    );

    try {
      const tx = this.db.transaction(() => {
        for (const [i, input] of processedInputs.entries()) {
          const id = ids[i];
          if (!id) continue;
          const now = this.clock.iso();
          this.insertStmt.run(this.buildInsertRow(input, now, id));
        }
      });
      tx();
    } catch (err) {
      if (err instanceof AirError) throw err;
      const cause = err instanceof Error ? err : undefined;
      throw new AirError(
        'MEMORY_NOT_FOUND',
        `Batch write failed for ${processedInputs.length} items: ${String(err)}`,
        { cause },
      );
    }

    const entries = ids.map((id) => {
      const raw = this.getByIdStmt.get(id) as RawMemoryRow | undefined;
      if (!raw) {
        throw new AirError('MEMORY_NOT_FOUND', `Memory "${id}" not found after batch write`);
      }
      return rowToEntry(raw);
    });
    return entries;
  }

  // --------------------------------------------------------------------------
  // get
  // --------------------------------------------------------------------------

  get(id: MemoryId): Promise<MemoryEntry | null> {
    try {
      this.assertOpen();
      const raw = this.getByIdStmt.get(id) as RawMemoryRow | undefined;
      if (!raw) return Promise.resolve(null);

      // Record access (best-effort; ignore failure)
      try {
        this.accessStmt.run({ id, accessed_at: this.clock.iso() });
      } catch {
        // Intentionally ignored
      }

      return Promise.resolve(rowToEntry(raw));
    } catch (err) {
      return Promise.reject(toError(err));
    }
  }

  // --------------------------------------------------------------------------
  // update
  // --------------------------------------------------------------------------

  update(id: MemoryId, input: UpdateMemoryInput): Promise<MemoryEntry> {
    try {
      this.assertOpen();
      const validatedInput = this.writePolicy
        ? this.writePolicy.sanitizeUpdate(input)
        : input;
      const now = this.clock.iso();

      // Fetch current entry to resolve TTL / expiresAt delta
      const current = this.getByIdStmt.get(id) as RawMemoryRow | undefined;
      if (!current) {
        throw new AirError('MEMORY_NOT_FOUND', `Memory "${id}" not found for update`);
      }

      // Resolve expires_at
      let newExpiresAt: string | null = current.expires_at;
      let newTtlSeconds: number | null = current.ttl_seconds;
      if (validatedInput.ttlSeconds !== undefined) {
        if (validatedInput.ttlSeconds === null) {
          newTtlSeconds = null;
          newExpiresAt = null;
        } else {
          newTtlSeconds = validatedInput.ttlSeconds;
          newExpiresAt = calculateExpiresAt(now, validatedInput.ttlSeconds);
        }
      } else if (validatedInput.expiresAt !== undefined) {
        newExpiresAt = validatedInput.expiresAt;
      }

      // Resolve embedding
      let embeddingBuf: Buffer | null = current.embedding;
      if (validatedInput.embedding !== undefined) {
        embeddingBuf =
          validatedInput.embedding != null ? Buffer.from(new Float64Array(validatedInput.embedding).buffer) : null;
      }

      const updateStmt = this.db.prepare(`
        UPDATE memories SET
          title       = @title,
          content     = @content,
          tags        = @tags,
          metadata    = @metadata,
          importance  = @importance,
          ttl_seconds = @ttl_seconds,
          expires_at  = @expires_at,
          embedding   = @embedding,
          updated_at  = @updated_at
        WHERE id = @id
      `);

      const params = {
        id,
        title: validatedInput.title ?? current.title,
        content: validatedInput.content ?? current.content,
        tags: validatedInput.tags != null ? JSON.stringify(validatedInput.tags) : current.tags,
        metadata: validatedInput.metadata != null ? JSON.stringify(validatedInput.metadata) : current.metadata,
        importance: validatedInput.importance ?? current.importance,
        ttl_seconds: newTtlSeconds,
        expires_at: newExpiresAt,
        embedding: embeddingBuf,
        updated_at: now,
      };

      try {
        const info = updateStmt.run(params);
        if (info.changes === 0) {
          throw new AirError('MEMORY_NOT_FOUND', `Memory "${id}" not found for update`);
        }
      } catch (err) {
        if (err instanceof AirError) throw err;
        const cause = err instanceof Error ? err : undefined;
        throw new AirError(
          'MEMORY_NOT_FOUND',
          `Failed to update memory "${id}": ${String(err)}`,
          { cause },
        );
      }

      const raw = this.getByIdStmt.get(id) as RawMemoryRow | undefined;
      if (!raw) {
        throw new AirError('MEMORY_NOT_FOUND', `Memory "${id}" not found after update`);
      }
      return Promise.resolve(rowToEntry(raw));
    } catch (err) {
      return Promise.reject(toError(err));
    }
  }

  // --------------------------------------------------------------------------
  // forget
  // --------------------------------------------------------------------------

  forget(id: MemoryId): Promise<boolean> {
    try {
      this.assertOpen();
      const info = this.deleteStmt.run(id);
      return Promise.resolve(info.changes > 0);
    } catch (err) {
      if (err instanceof AirError) return Promise.reject(err);
      const cause = err instanceof Error ? err : undefined;
      return Promise.reject(
        new AirError(
          'MEMORY_NOT_FOUND',
          `Failed to delete memory "${id}": ${String(err)}`,
          { cause },
        ),
      );
    }
  }

  // --------------------------------------------------------------------------
  // forgetByFilter
  // --------------------------------------------------------------------------

  forgetByFilter(filter: MemoryFilter): Promise<number> {
    try {
      this.assertOpen();
      const nowIso = this.clock.iso();
      const { where, params } = buildFilterWhere(filter, nowIso);

      // Fetch candidates for post-filter (tags/taint stored as JSON)
      const rows = this.db.prepare(`SELECT * FROM memories ${where}`).all(...params) as RawMemoryRow[];

      const toDelete: string[] = [];
      for (const row of rows) {
        const entry = rowToEntry(row);
        if (matchesFilter(entry, filter, nowIso)) {
          toDelete.push(entry.id);
        }
      }

      if (toDelete.length === 0) return Promise.resolve(0);

      try {
        const tx = this.db.transaction(() => {
          const stmt = this.db.prepare(
            `DELETE FROM memories WHERE id IN (${toDelete.map(() => '?').join(',')})`,
          );
          return stmt.run(...toDelete).changes;
        });
        return Promise.resolve(tx());
      } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        throw new AirError(
          'MEMORY_NOT_FOUND',
          `forgetByFilter failed: ${String(err)}`,
          { cause },
        );
      }
    } catch (err) {
      return Promise.reject(toError(err));
    }
  }

  // --------------------------------------------------------------------------
  // search
  // --------------------------------------------------------------------------

  search(query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    try {
      this.assertOpen();
      const nowIso = this.clock.iso();
      const limit = query.limit ?? 10;
      const offset = query.offset ?? 0;
      const mode = query.mode ?? 'keyword';

      if (mode === 'vector') {
        return this.vectorSearch(query, nowIso, limit, offset);
      }

      if (mode === 'hybrid') {
        return this.hybridSearch(query, nowIso, limit, offset);
      }

      const kw = this.keywordSearch(query, nowIso, limit + offset);
      return Promise.resolve(kw.slice(offset, offset + limit));
    } catch (err) {
      return Promise.reject(toError(err));
    }
  }

  private keywordSearch(
    query: MemorySearchQuery,
    nowIso: string,
    fetchLimit: number,
  ): MemorySearchResult[] {
    const { filter } = query;
    const tokens = query.query
      .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (tokens.length === 0) {
      return [];
    }
    const ftsQuery = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');

    // Build additional filter clauses for the JOIN condition
    const { where: filterWhere, params: filterParams } = buildFilterWhere(filter, nowIso);
    // Convert the WHERE clause to AND conditions on the aliased table 'm'
    const andConditions = filterWhere
      ? filterWhere
          .replace(/^WHERE\s+/i, '')
          .replace(
            /\b(kind|scope|agent_id|session_id|run_id|importance|expires_at)\b/g,
            (col) => `m.${col}`,
          )
      : '';
    const andClause = andConditions ? `AND ${andConditions}` : '';

    const sql = `
      SELECT
        m.*,
        bm25(memories_fts) AS bm25_score,
        snippet(memories_fts, 0, '<b>', '</b>', '...', 10) AS title_snippet,
        snippet(memories_fts, 1, '<b>', '</b>', '...', 20) AS content_snippet
      FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ?
        ${andClause}
      ORDER BY bm25(memories_fts)
      LIMIT ?
    `;

    let rawRows: (RawMemoryRow & FtsExtras)[];
    try {
      rawRows = this.db.prepare(sql).all(ftsQuery, ...filterParams, fetchLimit) as (RawMemoryRow &
        FtsExtras)[];
    } catch {
      // FTS5 MATCH syntax error or no FTS table yet — return empty
      return [];
    }

    const results: MemorySearchResult[] = [];
    const minScore = query.minScore;

    for (const row of rawRows) {
      const entry = rowToEntry(row);

      // Post-filter for tags, taint, expiry
      if (!matchesFilter(entry, filter, nowIso)) continue;

      // BM25 scores from SQLite are negative (more negative = better match).
      // Normalise to [0,1]: score = |bm25| / (|bm25| + 10)
      const rawScore = Math.abs(row.bm25_score);
      const score = rawScore / (rawScore + 10);

      if (minScore !== undefined && score < minScore) continue;

      results.push({
        entry,
        score,
        matchedBy: 'keyword',
        highlights: {
          title: row.title_snippet ? [row.title_snippet] : undefined,
          content: row.content_snippet ? [row.content_snippet] : undefined,
        },
      });
    }

    return results;
  }

  private async vectorSearch(
    query: MemorySearchQuery,
    nowIso: string,
    limit: number,
    offset: number,
  ): Promise<MemorySearchResult[]> {
    let targetVector = query.vector;
    if (!targetVector && this.embeddingProvider) {
      try {
        targetVector = await this.embeddingProvider.embed(query.query);
      } catch {
        targetVector = undefined;
      }
    }

    if (!targetVector) {
      return this.vectorSearchFallback(query, nowIso, limit, offset);
    }

    const { where, params } = buildFilterWhere(query.filter, nowIso);
    const embeddingClause = where
      ? `${where} AND embedding IS NOT NULL`
      : 'WHERE embedding IS NOT NULL';
    const sql = `SELECT * FROM memories ${embeddingClause}`;
    const rows = this.db.prepare(sql).all(...params) as RawMemoryRow[];

    const candidates: MemoryEntry[] = [];
    for (const row of rows) {
      const entry = rowToEntry(row);
      if (matchesFilter(entry, query.filter, nowIso)) {
        candidates.push(entry);
      }
    }

    const ranked = rankByVector(targetVector, candidates, {
      limit: limit + offset,
      minSimilarity: query.minScore,
    });

    const sliced = ranked.slice(offset, offset + limit);
    return sliced.map(({ item, similarity }) => ({
      entry: item,
      score: similarity,
      matchedBy: 'vector' as const,
      highlights: undefined,
    }));
  }

  private async hybridSearch(
    query: MemorySearchQuery,
    nowIso: string,
    limit: number,
    offset: number,
  ): Promise<MemorySearchResult[]> {
    const fetchLimit = (limit + offset) * 3;
    const kwResults = this.keywordSearch(query, nowIso, fetchLimit);

    let vecResults: MemorySearchResult[] = [];
    if (query.vector || this.embeddingProvider) {
      try {
        vecResults = await this.vectorSearch(query, nowIso, fetchLimit, 0);
      } catch {
        vecResults = [];
      }
    }

    if (vecResults.length === 0) {
      return kwResults.slice(offset, offset + limit);
    }

    // Reciprocal Rank Fusion (RRF) with constant k = 60
    const k = 60;
    const fused = new Map<
      string,
      {
        entry: MemoryEntry;
        score: number;
        highlights?:
          | {
              title?: string[] | undefined;
              content?: string[] | undefined;
            }
          | undefined;
      }
    >();

    kwResults.forEach((res, rank) => {
      const rrf = 1 / (k + rank + 1);
      const existing = fused.get(res.entry.id);
      if (existing) {
        existing.score += rrf;
        if (res.highlights) existing.highlights = res.highlights;
      } else {
        fused.set(res.entry.id, {
          entry: res.entry,
          score: rrf,
          highlights: res.highlights,
        });
      }
    });

    vecResults.forEach((res, rank) => {
      const rrf = 1 / (k + rank + 1);
      const existing = fused.get(res.entry.id);
      if (existing) {
        existing.score += rrf;
      } else {
        fused.set(res.entry.id, {
          entry: res.entry,
          score: rrf,
          highlights: undefined,
        });
      }
    });

    const combined = Array.from(fused.values());
    combined.sort((a, b) => b.score - a.score);

    const minScore = query.minScore;
    const filtered =
      minScore !== undefined ? combined.filter((c) => c.score >= minScore) : combined;

    return filtered.slice(offset, offset + limit).map((c) => ({
      entry: c.entry,
      score: c.score,
      matchedBy: 'hybrid' as const,
      highlights: c.highlights,
    }));
  }

  private vectorSearchFallback(
    query: MemorySearchQuery,
    nowIso: string,
    limit: number,
    offset: number,
  ): MemorySearchResult[] {
    // Placeholder until real vector search.
    // Returns results ordered by importance (proxy for relevance).
    const { where, params } = buildFilterWhere(query.filter, nowIso);
    const sql = `SELECT * FROM memories ${where} ORDER BY importance DESC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params, limit, offset) as RawMemoryRow[];

    const results: MemorySearchResult[] = [];
    for (const row of rows) {
      const entry = rowToEntry(row);
      if (!matchesFilter(entry, query.filter, nowIso)) continue;
      results.push({
        entry,
        score: entry.importance,
        matchedBy: 'vector',
        highlights: undefined,
      });
    }
    return results;
  }

  // --------------------------------------------------------------------------
  // list
  // --------------------------------------------------------------------------

  list(
    filter?: MemoryFilter,
    options?: { limit?: number; offset?: number },
  ): Promise<MemoryEntry[]> {
    try {
      this.assertOpen();
      const nowIso = this.clock.iso();
      const limit = options?.limit ?? 100;
      const offset = options?.offset ?? 0;

      const { where, params } = buildFilterWhere(filter, nowIso);
      const rows = this.db
        .prepare(`SELECT * FROM memories ${where} ORDER BY importance DESC, created_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as RawMemoryRow[];

      const results: MemoryEntry[] = [];
      for (const row of rows) {
        const entry = rowToEntry(row);
        if (!matchesFilter(entry, filter, nowIso)) continue;
        results.push(entry);
      }
      return Promise.resolve(results);
    } catch (err) {
      return Promise.reject(toError(err));
    }
  }

  // --------------------------------------------------------------------------
  // pruneExpired
  // --------------------------------------------------------------------------

  pruneExpired(nowIso?: string): Promise<number> {
    try {
      this.assertOpen();
      const ts = nowIso ?? this.clock.iso();
      try {
        const info = this.db
          .prepare('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?')
          .run(ts);
        return Promise.resolve(info.changes);
      } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        throw new AirError('MEMORY_NOT_FOUND', `pruneExpired failed: ${String(err)}`, { cause });
      }
    } catch (err) {
      return Promise.reject(toError(err));
    }
  }

  // --------------------------------------------------------------------------
  // count
  // --------------------------------------------------------------------------

  count(filter?: MemoryFilter): Promise<number> {
    try {
      this.assertOpen();
      const nowIso = this.clock.iso();
      const { where, params } = buildFilterWhere(filter, nowIso);
      const row = this.db
        .prepare(`SELECT COUNT(*) as cnt FROM memories ${where}`)
        .get(...params) as { cnt: number };
      return Promise.resolve(row.cnt);
    } catch (err) {
      return Promise.reject(toError(err));
    }
  }

  // --------------------------------------------------------------------------
  // close
  // --------------------------------------------------------------------------

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // Ignore cleanup errors on close
    }
    return Promise.resolve();
  }

  // --------------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------------

  /**
   * Rebuilds the FTS5 index from the memories table content.
   * Useful after bulk imports or suspected index corruption.
   */
  rebuildFts(): void {
    this.assertOpen();
    this.db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
  }

  /** Exposes the raw Database for migration tests. @internal */
  get database(): DatabaseType {
    this.assertOpen();
    return this.db;
  }
}
