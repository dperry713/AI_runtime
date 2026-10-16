/**
 * SQLite Index Store for AIR Journal (P2-T03).
 *
 * Implements:
 * - SQLite storage via better-sqlite3 with WAL mode and foreign key constraints.
 * - Configurable PRAGMA synchronous (FULL, NORMAL, OFF) mapped from FsyncPolicy.
 * - Point and range indexing of journal events (with segment path, byte offset, and CRC-32).
 * - Lifecycle projections for streams, runs, and sessions.
 * - Batch indexing inside atomic transactions for high throughput.
 * - Schema migrations from v0.
 * - Injected Clock for determinism (Rule R6).
 */

import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { FsyncPolicy } from '../config/index.js';
import { AirError } from '../errors/index.js';
import type { AgentId, EventId, RunId, SessionId, ToolCallId, TurnId } from '../types/index.js';
import { canonicalize, type Clock, SystemClock } from '../util/index.js';
import type { EventEnvelope } from './envelope.js';
import { runMigrations } from './migrations.js';

// ============================================================================
// Types & Models
// ============================================================================

export interface EventLocation {
  segmentIndex: number;
  segmentPath: string;
  offset: number;
  bytesWritten: number;
  crc32: string;
}

export interface IndexedEvent {
  id: EventId;
  streamId: string;
  seq: number;
  type: string;
  ts: string;
  segmentIndex: number;
  segmentPath: string;
  offset: number;
  bytes: number;
  crc32: string;
  sessionId?: SessionId | undefined;
  runId?: RunId | undefined;
  turnId?: TurnId | undefined;
  toolCallId?: ToolCallId | undefined;
  traceId?: string | undefined;
  causationId?: EventId | undefined;
  correlationId?: string | undefined;
}

export interface StreamRecord {
  streamId: string;
  streamType: string;
  firstSeq: number;
  lastSeq: number;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  runId: RunId;
  sessionId?: SessionId | undefined;
  agentId: AgentId;
  status: string;
  streamId: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  tokenUsagePrompt: number;
  tokenUsageCompletion: number;
  costUsd: number;
  stepCount: number;
}

export interface SessionRecord {
  sessionId: SessionId;
  title?: string | undefined;
  status: string;
  streamId: string;
  createdAt: string;
  updatedAt: string;
  runCount: number;
}

export interface IndexStats {
  totalStreams: number;
  totalEvents: number;
  totalRuns: number;
  totalSessions: number;
  schemaVersion: number;
}

export interface StreamQueryOptions {
  fromSeq?: number | undefined;
  toSeq?: number | undefined;
  order?: 'asc' | 'desc' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface RunQueryOptions {
  sessionId?: SessionId | undefined;
  status?: string | undefined;
  agentId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface SessionQueryOptions {
  status?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface CreateSessionOptions {
  sessionId: SessionId;
  title?: string | undefined;
  streamId?: string | undefined;
}

export interface IndexStoreOptions {
  /** Database path (e.g. `%LOCALAPPDATA%\AIR\journal\index.sqlite`) or `':memory:'` */
  dbPath: string;
  /** Fsync policy mapping to PRAGMA synchronous ('always' -> FULL, 'batch' -> NORMAL, 'never' -> OFF) */
  fsync?: FsyncPolicy | undefined;
  /** SQLite busy timeout in milliseconds. Defaults to 5000 */
  busyTimeoutMs?: number | undefined;
  /** Injected clock for determinism (Rule R6) */
  clock?: Clock | undefined;
  /** Whether to run migrations automatically on open. Defaults to true */
  autoMigrate?: boolean | undefined;
}

// Raw SQLite Row Shapes
interface RawEventRow {
  id: string;
  stream_id: string;
  seq: number;
  type: string;
  ts: string;
  segment_index: number;
  segment_path: string;
  offset: number;
  bytes: number;
  crc32: string;
  session_id: string | null;
  run_id: string | null;
  turn_id: string | null;
  tool_call_id: string | null;
  trace_id: string | null;
  causation_id: string | null;
  correlation_id: string | null;
}

interface RawStreamRow {
  stream_id: string;
  stream_type: string;
  first_seq: number;
  last_seq: number;
  event_count: number;
  created_at: string;
  updated_at: string;
}

interface RawRunRow {
  run_id: string;
  session_id: string | null;
  agent_id: string;
  status: string;
  stream_id: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  token_usage_prompt: number;
  token_usage_completion: number;
  cost_usd: number;
  step_count: number;
}

interface RawSessionRow {
  session_id: string;
  title: string | null;
  status: string;
  stream_id: string;
  created_at: string;
  updated_at: string;
  run_count: number;
}

// ============================================================================
// Index Store Implementation
// ============================================================================

export class IndexStore {
  readonly dbPath: string;
  readonly isMemory: boolean;
  readonly fsync: FsyncPolicy;
  readonly busyTimeoutMs: number;
  readonly clock: Clock;

  private db: DatabaseType;
  private closed = false;

  // Cached Prepared Statements
  private insertEventStmt: Statement;
  private upsertStreamStmt: Statement;
  private getEventByIdStmt: Statement;
  private getEventByStreamSeqStmt: Statement;
  private getStreamByIdStmt: Statement;
  private listStreamsStmt: Statement;
  private getRunByIdStmt: Statement;
  private getSessionByIdStmt: Statement;
  private listSessionsStmt: Statement;
  private upsertSessionStmt: Statement;

  constructor(options: IndexStoreOptions) {
    if (!options.dbPath || options.dbPath.trim().length === 0) {
      throw new AirError('INVALID_ARGUMENT', 'dbPath cannot be empty');
    }

    this.isMemory = options.dbPath === ':memory:';
    this.fsync = options.fsync ?? 'batch';
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    this.clock = options.clock ?? new SystemClock();

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
        'INDEX_WRITE_FAILED',
        `Failed to open SQLite database at "${this.dbPath}": ${String(err)}`,
        { cause },
      );
    }

    this.configurePragmas();

    if (options.autoMigrate !== false) {
      runMigrations(this.db, { clock: this.clock });
    }

    this.insertEventStmt = this.db.prepare(`
      INSERT INTO events (
        id, stream_id, seq, type, ts, segment_index, segment_path, offset, bytes, crc32,
        session_id, run_id, turn_id, tool_call_id, trace_id, causation_id, correlation_id
      ) VALUES (
        @id, @stream_id, @seq, @type, @ts, @segment_index, @segment_path, @offset, @bytes, @crc32,
        @session_id, @run_id, @turn_id, @tool_call_id, @trace_id, @causation_id, @correlation_id
      )
    `);

    this.upsertStreamStmt = this.db.prepare(`
      INSERT INTO streams (
        stream_id, stream_type, first_seq, last_seq, event_count, created_at, updated_at
      ) VALUES (
        @stream_id, @stream_type, @seq, @seq, 1, @ts, @ts
      ) ON CONFLICT(stream_id) DO UPDATE SET
        last_seq = MAX(streams.last_seq, excluded.last_seq),
        event_count = streams.event_count + 1,
        updated_at = excluded.updated_at
    `);

    this.getEventByIdStmt = this.db.prepare('SELECT * FROM events WHERE id = ?');
    this.getEventByStreamSeqStmt = this.db.prepare('SELECT * FROM events WHERE stream_id = ? AND seq = ?');
    this.getStreamByIdStmt = this.db.prepare('SELECT * FROM streams WHERE stream_id = ?');
    this.listStreamsStmt = this.db.prepare('SELECT * FROM streams ORDER BY updated_at DESC LIMIT ? OFFSET ?');
    this.getRunByIdStmt = this.db.prepare('SELECT * FROM runs WHERE run_id = ?');
    this.getSessionByIdStmt = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?');
    this.listSessionsStmt = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?');
    this.upsertSessionStmt = this.db.prepare(`
      INSERT INTO sessions (
        session_id, title, status, stream_id, created_at, updated_at, run_count
      ) VALUES (
        @session_id, @title, @status, @stream_id, @created_at, @updated_at, 0
      ) ON CONFLICT(session_id) DO UPDATE SET
        title = COALESCE(excluded.title, sessions.title),
        status = excluded.status,
        updated_at = excluded.updated_at
    `);
  }

  private configurePragmas(): void {
    this.db.pragma('foreign_keys = ON');
    this.db.pragma(`busy_timeout = ${this.busyTimeoutMs}`);
    this.db.pragma('temp_store = MEMORY');

    if (!this.isMemory) {
      this.db.pragma('journal_mode = WAL');
    }

    if (this.fsync === 'always') {
      this.db.pragma('synchronous = FULL');
    } else if (this.fsync === 'batch') {
      this.db.pragma('synchronous = NORMAL');
    } else {
      this.db.pragma('synchronous = OFF');
    }
  }

  get database(): DatabaseType {
    if (this.closed) {
      throw new AirError('INVALID_STATE', 'IndexStore is closed');
    }
    return this.db;
  }

  // ==========================================================================
  // Event Indexing
  // ==========================================================================

  /**
   * Indexes a single event and updates stream and lifecycle projections.
   */
  indexEvent<T>(event: EventEnvelope<T>, location: EventLocation): void {
    if (this.closed) {
      throw new AirError('INVALID_STATE', 'IndexStore is closed');
    }

    const streamType = this.deriveStreamType(event.stream);
    const meta = event.meta;
    const payload = event.payload as Record<string, unknown> | undefined;

    const sessionId = meta?.sessionId ?? (payload && typeof payload['sessionId'] === 'string' ? payload['sessionId'] : (event.stream.startsWith('session:') ? event.stream.slice(8) : null));
    const runId = meta?.runId ?? (payload && typeof payload['runId'] === 'string' ? payload['runId'] : (event.stream.startsWith('run:') ? event.stream.slice(4) : null));
    const turnId = meta?.turnId ?? (payload && typeof payload['turnId'] === 'string' ? payload['turnId'] : null);
    const toolCallId = meta?.toolCallId ?? (payload && typeof payload['toolCallId'] === 'string' ? payload['toolCallId'] : null);

    try {
      const tx = this.db.transaction(() => {
        // Upsert stream
        this.upsertStreamStmt.run({
          stream_id: event.stream,
          stream_type: streamType,
          seq: event.seq,
          ts: event.ts,
        });

        // Insert event
        this.insertEventStmt.run({
          id: event.id,
          stream_id: event.stream,
          seq: event.seq,
          type: event.type,
          ts: event.ts,
          segment_index: location.segmentIndex,
          segment_path: location.segmentPath,
          offset: location.offset,
          bytes: location.bytesWritten,
          crc32: location.crc32,
          session_id: sessionId,
          run_id: runId,
          turn_id: turnId,
          tool_call_id: toolCallId,
          trace_id: meta?.traceId ?? null,
          causation_id: meta?.causationId ?? null,
          correlation_id: meta?.correlationId ?? null,
        });

        // Update projections
        this.updateProjections(event, runId, sessionId);
      });

      tx();
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw new AirError(
        'INDEX_WRITE_FAILED',
        `Failed to index event "${event.id}" in stream "${event.stream}": ${String(err)}`,
        { cause },
      );
    }
  }

  /**
   * Indexes multiple events inside a single transaction for maximum throughput.
   */
  indexEventsBatch(batch: Array<{ event: EventEnvelope; location: EventLocation }>): void {
    if (this.closed) {
      throw new AirError('INVALID_STATE', 'IndexStore is closed');
    }
    if (batch.length === 0) return;

    try {
      const tx = this.db.transaction(() => {
        for (const item of batch) {
          this.indexEventInternal(item.event, item.location);
        }
      });
      tx();
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw new AirError(
        'INDEX_WRITE_FAILED',
        `Failed to index batch of ${batch.length} events: ${String(err)}`,
        { cause },
      );
    }
  }

  private indexEventInternal<T>(event: EventEnvelope<T>, location: EventLocation): void {
    const streamType = this.deriveStreamType(event.stream);
    const meta = event.meta;
    const payload = event.payload as Record<string, unknown> | undefined;

    const sessionId = meta?.sessionId ?? (payload && typeof payload['sessionId'] === 'string' ? payload['sessionId'] : (event.stream.startsWith('session:') ? event.stream.slice(8) : null));
    const runId = meta?.runId ?? (payload && typeof payload['runId'] === 'string' ? payload['runId'] : (event.stream.startsWith('run:') ? event.stream.slice(4) : null));
    const turnId = meta?.turnId ?? (payload && typeof payload['turnId'] === 'string' ? payload['turnId'] : null);
    const toolCallId = meta?.toolCallId ?? (payload && typeof payload['toolCallId'] === 'string' ? payload['toolCallId'] : null);

    this.upsertStreamStmt.run({
      stream_id: event.stream,
      stream_type: streamType,
      seq: event.seq,
      ts: event.ts,
    });

    this.insertEventStmt.run({
      id: event.id,
      stream_id: event.stream,
      seq: event.seq,
      type: event.type,
      ts: event.ts,
      segment_index: location.segmentIndex,
      segment_path: location.segmentPath,
      offset: location.offset,
      bytes: location.bytesWritten,
      crc32: location.crc32,
      session_id: sessionId,
      run_id: runId,
      turn_id: turnId,
      tool_call_id: toolCallId,
      trace_id: meta?.traceId ?? null,
      causation_id: meta?.causationId ?? null,
      correlation_id: meta?.correlationId ?? null,
    });

    this.updateProjections(event, runId, sessionId);
  }

  private deriveStreamType(stream: string): string {
    if (stream.startsWith('run:')) return 'run';
    if (stream.startsWith('session:')) return 'session';
    if (stream === 'system') return 'system';
    return 'custom';
  }

  private updateProjections(event: EventEnvelope, runId: string | null, sessionId: string | null): void {
    const payload = event.payload as Record<string, unknown> | undefined;
    const targetRunId = runId ?? (payload && typeof payload['runId'] === 'string' ? payload['runId'] : null);

    if (sessionId) {
      this.updateSessionProjection(event, sessionId);
    }

    if (targetRunId) {
      this.updateRunProjection(event, targetRunId, sessionId);
    }
  }

  private updateRunProjection(event: EventEnvelope, runId: string, sessionId: string | null): void {
    const payload = event.payload as Record<string, unknown> | undefined;

    if (event.type === 'run.created') {
      const agentId = typeof payload?.['agentId'] === 'string' ? payload['agentId'] : 'default';
      this.db.prepare(`
        INSERT INTO runs (
          run_id, session_id, agent_id, status, stream_id, created_at, updated_at
        ) VALUES (
          ?, ?, ?, 'created', ?, ?, ?
        ) ON CONFLICT(run_id) DO UPDATE SET
          session_id = COALESCE(excluded.session_id, runs.session_id),
          agent_id = excluded.agent_id,
          status = excluded.status,
          updated_at = excluded.updated_at
      `).run(runId, sessionId, agentId, event.stream, event.ts, event.ts);

      if (sessionId) {
        this.db.prepare(`
          UPDATE sessions SET run_count = run_count + 1, updated_at = ? WHERE session_id = ?
        `).run(event.ts, sessionId);
      }
    } else if (event.type === 'run.starting' || event.type === 'run.running') {
      this.db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?').run('running', event.ts, runId);
    } else if (event.type === 'run.paused') {
      this.db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?').run('paused', event.ts, runId);
    } else if (event.type === 'run.resumed') {
      this.db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?').run('running', event.ts, runId);
    } else if (event.type === 'run.waiting_approval') {
      this.db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?').run('waiting_approval', event.ts, runId);
    } else if (event.type === 'run.waiting_user') {
      this.db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?').run('waiting_user', event.ts, runId);
    } else if (event.type === 'run.completed') {
      this.db.prepare('UPDATE runs SET status = ?, completed_at = ?, updated_at = ? WHERE run_id = ?').run('completed', event.ts, event.ts, runId);
    } else if (event.type === 'run.failed') {
      const errObj = payload?.['error'] as Record<string, unknown> | undefined;
      const errCode = typeof errObj?.['code'] === 'string' ? errObj['code'] : 'RUN_FAILED';
      const errMsg = typeof errObj?.['message'] === 'string' ? errObj['message'] : 'Run failed';
      this.db.prepare('UPDATE runs SET status = ?, error_code = ?, error_message = ?, completed_at = ?, updated_at = ? WHERE run_id = ?').run('failed', errCode, errMsg, event.ts, event.ts, runId);
    } else if (event.type === 'run.cancelled') {
      this.db.prepare('UPDATE runs SET status = ?, completed_at = ?, updated_at = ? WHERE run_id = ?').run('cancelled', event.ts, event.ts, runId);
    } else if (event.type === 'turn.completed') {
      this.db.prepare('UPDATE runs SET step_count = step_count + 1, updated_at = ? WHERE run_id = ?').run(event.ts, runId);
    }
  }

  private updateSessionProjection(event: EventEnvelope, sessionId: string): void {
    this.upsertSessionStmt.run({
      session_id: sessionId,
      title: null,
      status: 'active',
      stream_id: event.stream,
      created_at: event.ts,
      updated_at: event.ts,
    });
  }

  // ==========================================================================
  // Queries
  // ==========================================================================

  getEvent(id: EventId): IndexedEvent | null {
    if (this.closed) throw new AirError('INVALID_STATE', 'IndexStore is closed');
    const row = this.getEventByIdStmt.get(id) as RawEventRow | undefined;
    return row ? this.mapEventRow(row) : null;
  }

  getEventByStreamSeq(streamId: string, seq: number): IndexedEvent | null {
    if (this.closed) throw new AirError('INVALID_STATE', 'IndexStore is closed');
    const row = this.getEventByStreamSeqStmt.get(streamId, seq) as RawEventRow | undefined;
    return row ? this.mapEventRow(row) : null;
  }

  getEventsByStream(streamId: string, options?: StreamQueryOptions): IndexedEvent[] {
    if (this.closed) throw new AirError('INVALID_STATE', 'IndexStore is closed');
    const fromSeq = options?.fromSeq ?? 1;
    const toSeq = options?.toSeq ?? Number.MAX_SAFE_INTEGER;
    const limit = options?.limit ?? 1000;
    const offset = options?.offset ?? 0;
    const order = options?.order ?? 'asc';

    const sql = `
      SELECT * FROM events
      WHERE stream_id = ? AND seq >= ? AND seq <= ?
      ORDER BY seq ${order === 'desc' ? 'DESC' : 'ASC'}
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(sql).all(streamId, fromSeq, toSeq, limit, offset) as RawEventRow[];
    return rows.map((r) => this.mapEventRow(r));
  }

  getEventsByRun(runId: RunId, options?: { limit?: number; offset?: number }): IndexedEvent[] {
    if (this.closed) throw new AirError('INVALID_STATE', 'IndexStore is closed');
    const limit = options?.limit ?? 1000;
    const offset = options?.offset ?? 0;

    const rows = this.db.prepare(`
      SELECT * FROM events
      WHERE run_id = ?
      ORDER BY seq ASC
      LIMIT ? OFFSET ?
    `).all(runId, limit, offset) as RawEventRow[];

    return rows.map((r) => this.mapEventRow(r));
  }

  getEventsBySession(sessionId: SessionId, options?: { limit?: number; offset?: number }): IndexedEvent[] {
    if (this.closed) throw new AirError('INVALID_STATE', 'IndexStore is closed');
    const limit = options?.limit ?? 1000;
    const offset = options?.offset ?? 0;

    const rows = this.db.prepare(`
      SELECT * FROM events
      WHERE session_id = ?
      ORDER BY ts ASC
      LIMIT ? OFFSET ?
    `).all(sessionId, limit, offset) as RawEventRow[];

    return rows.map((r) => this.mapEventRow(r));
  }

  getStream(streamId: string): StreamRecord | null {
    if (this.closed) throw new AirError('INVALID_STATE', 'IndexStore is closed');
    const row = this.getStreamByIdStmt.get(streamId) as RawStreamRow | undefined;
    return row ? this.mapStreamRow(row) : null;
  }

  listStreams(options?: { type?: string; limit?: number; offset?: number }): StreamRecord[] {
    if (this.closed) throw new AirError('INVALID_STATE', 'IndexStore is closed');
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    let rows: RawStreamRow[];
    if (options?.type) {
      rows = this.db.prepare('SELECT * FROM streams WHERE stream_type = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?')
        .all(options.type, limit, offset) as RawStreamRow[];
    } else {
      rows = this.listStreamsStmt.all(limit, offset) as RawStreamRow[];
    }
    return rows.map((r) => this.mapStreamRow(r));
  }

  getRun(runId: RunId): RunRecord | null {
    if (this.closed) throw new AirError('INVALID_STATE', 'IndexStore is closed');
    const row = this.getRunByIdStmt.get(runId) as RawRunRow | undefined;
    return row ? this.mapRunRow(row) : null;
  }

  listRuns(options?: RunQueryOptions): RunRecord[] {
    if (this.closed) throw new AirError('INVALID_STATE', 'IndexStore is closed');
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options?.sessionId) {
      clauses.push('session_id = ?');
      params.push(options.sessionId);
    }
    if (options?.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    if (options?.agentId) {
      clauses.push('agent_id = ?');
      params.push(options.agentId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT * FROM runs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as RawRunRow[];
    return rows.map((r) => this.mapRunRow(r));
  }

  getSession(sessionId: SessionId): SessionRecord | null {
    if (this.closed) throw new AirError('INVALID_STATE', 'IndexStore is closed');
    const row = this.getSessionByIdStmt.get(sessionId) as RawSessionRow | undefined;
    return row ? this.mapSessionRow(row) : null;
  }

  listSessions(options?: SessionQueryOptions): SessionRecord[] {
    if (this.closed) throw new AirError('INVALID_STATE', 'IndexStore is closed');
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    let rows: RawSessionRow[];
    if (options?.status) {
      rows = this.db.prepare('SELECT * FROM sessions WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?')
        .all(options.status, limit, offset) as RawSessionRow[];
    } else {
      rows = this.listSessionsStmt.all(limit, offset) as RawSessionRow[];
    }
    return rows.map((r) => this.mapSessionRow(r));
  }

  createSession(options: CreateSessionOptions): SessionRecord {
    if (this.closed) throw new AirError('INVALID_STATE', 'IndexStore is closed');
    const streamId = options.streamId ?? `session:${options.sessionId}`;
    const ts = this.clock.iso();

    this.upsertSessionStmt.run({
      session_id: options.sessionId,
      title: options.title ?? null,
      status: 'active',
      stream_id: streamId,
      created_at: ts,
      updated_at: ts,
    });

    const created = this.getSession(options.sessionId);
    if (!created) {
      throw new AirError('INDEX_WRITE_FAILED', `Failed to create session record for "${options.sessionId}"`);
    }
    return created;
  }

  getStats(): IndexStats {
    if (this.closed) throw new AirError('INVALID_STATE', 'IndexStore is closed');

    const streamsCount = (this.db.prepare('SELECT COUNT(*) as count FROM streams').get() as { count: number }).count;
    const eventsCount = (this.db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number }).count;
    const runsCount = (this.db.prepare('SELECT COUNT(*) as count FROM runs').get() as { count: number }).count;
    const sessionsCount = (this.db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }).count;
    const versionRow = this.db.prepare('SELECT MAX(version) as version FROM _migrations').get() as { version: number | null };

    return {
      totalStreams: streamsCount,
      totalEvents: eventsCount,
      totalRuns: runsCount,
      totalSessions: sessionsCount,
      schemaVersion: versionRow?.version ?? 0,
    };
  }

  /**
   * Clears all indexed events and projections while preserving schema and migrations.
   * Useful for full index rebuild from JSONL segments (P2-T06).
   */
  clearIndex(): void {
    if (this.closed) throw new AirError('INVALID_STATE', 'IndexStore is closed');

    const tx = this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM events;
        DELETE FROM runs;
        DELETE FROM sessions;
        DELETE FROM streams;
      `);
    });
    tx();
  }

  /**
   * Closes the database connection.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // Ignore cleanup error on close
    }
  }

  // ==========================================================================
  // Row Mappers
  // ==========================================================================

  private mapEventRow(row: RawEventRow): IndexedEvent {
    return {
      id: row.id as EventId,
      streamId: row.stream_id,
      seq: row.seq,
      type: row.type,
      ts: row.ts,
      segmentIndex: row.segment_index,
      segmentPath: row.segment_path,
      offset: row.offset,
      bytes: row.bytes,
      crc32: row.crc32,
      sessionId: row.session_id ? (row.session_id as SessionId) : undefined,
      runId: row.run_id ? (row.run_id as RunId) : undefined,
      turnId: row.turn_id ? (row.turn_id as TurnId) : undefined,
      toolCallId: row.tool_call_id ? (row.tool_call_id as ToolCallId) : undefined,
      traceId: row.trace_id ?? undefined,
      causationId: row.causation_id ? (row.causation_id as EventId) : undefined,
      correlationId: row.correlation_id ?? undefined,
    };
  }

  private mapStreamRow(row: RawStreamRow): StreamRecord {
    return {
      streamId: row.stream_id,
      streamType: row.stream_type,
      firstSeq: row.first_seq,
      lastSeq: row.last_seq,
      eventCount: row.event_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRunRow(row: RawRunRow): RunRecord {
    return {
      runId: row.run_id as RunId,
      sessionId: row.session_id ? (row.session_id as SessionId) : undefined,
      agentId: row.agent_id as AgentId,
      status: row.status,
      streamId: row.stream_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined,
      errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined,
      tokenUsagePrompt: row.token_usage_prompt,
      tokenUsageCompletion: row.token_usage_completion,
      costUsd: row.cost_usd,
      stepCount: row.step_count,
    };
  }

  private mapSessionRow(row: RawSessionRow): SessionRecord {
    return {
      sessionId: row.session_id as SessionId,
      title: row.title ?? undefined,
      status: row.status,
      streamId: row.stream_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      runCount: row.run_count,
    };
  }
}
