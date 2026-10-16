import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  createEnvelope,
  type EventLocation,
  getAppliedMigrations,
  getCurrentMigrationVersion,
  IndexStore,
  type Migration,
  migrationV1,
  runMigrations,
} from '../../../src/journal/index.js';
import type { EventId, RunId, SessionId } from '../../../src/types/index.js';
import { FakeClock } from '../../../src/util/index.js';

describe('SQLite Index Store & Migrations (P2-T03)', () => {
  let tempDir: string;
  let fakeClock: FakeClock;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-index-test-'));
    fakeClock = new FakeClock('2026-10-16T12:00:00.000Z');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore lock error on Windows cleanup
    }
  });

  // ==========================================================================
  // Migration Runner Tests
  // ==========================================================================

  describe('Migrations from v0', () => {
    it('starts at v0 on a fresh database', () => {
      const db = new Database(':memory:');
      const version = getCurrentMigrationVersion(db);
      expect(version).toBe(0);
      db.close();
    });

    it('migrates from v0 to v1 successfully', () => {
      const db = new Database(':memory:');
      const result = runMigrations(db, { clock: fakeClock });

      expect(result.fromVersion).toBe(0);
      expect(result.toVersion).toBe(1);
      expect(result.applied).toHaveLength(1);
      expect(result.applied[0]?.name).toBe('001_initial_schema');
      expect(result.applied[0]?.appliedAt).toBe('2026-10-16T12:00:00.000Z');

      const applied = getAppliedMigrations(db);
      expect(applied).toHaveLength(1);
      expect(applied[0]?.version).toBe(1);

      // Verify tables exist
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      const names = tables.map((t) => t.name);
      expect(names).toContain('_migrations');
      expect(names).toContain('streams');
      expect(names).toContain('sessions');
      expect(names).toContain('runs');
      expect(names).toContain('events');

      db.close();
    });

    it('is idempotent when re-running migrations at latest version', () => {
      const db = new Database(':memory:');
      runMigrations(db, { clock: fakeClock });

      // Re-run
      const secondRun = runMigrations(db, { clock: fakeClock });
      expect(secondRun.fromVersion).toBe(1);
      expect(secondRun.toVersion).toBe(1);
      expect(secondRun.applied).toHaveLength(0);

      db.close();
    });

    it('supports rolling back migrations with down step', () => {
      const db = new Database(':memory:');
      runMigrations(db, { clock: fakeClock });
      expect(getCurrentMigrationVersion(db)).toBe(1);

      // Rollback to v0
      const rollbackResult = runMigrations(db, { targetVersion: 0 });
      expect(rollbackResult.fromVersion).toBe(1);
      expect(rollbackResult.toVersion).toBe(0);

      // Tables should be dropped
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      const names = tables.map((t) => t.name);
      expect(names).not.toContain('events');
      expect(names).not.toContain('runs');

      db.close();
    });

    it('fails atomically when a migration encounters an error', () => {
      const db = new Database(':memory:');
      const badMigration: Migration = {
        version: 2,
        name: '002_broken',
        up: (database) => {
          database.exec('INVALID SQL SYNTAX HERE;');
        },
      };

      expect(() =>
        runMigrations(db, {
          migrations: [migrationV1, badMigration],
          targetVersion: 2,
        }),
      ).toThrow(AirError);

      // Database should stay at version 1 (or 0) because bad migration failed
      expect(getCurrentMigrationVersion(db)).toBe(1);
      db.close();
    });

    it('throws error when trying to rollback a migration without down() definition', () => {
      const db = new Database(':memory:');
      const noDownMigration: Migration = {
        version: 1,
        name: '001_no_down',
        up: (d) => {
          d.exec('CREATE TABLE test_no_down (id INT);');
        },
      };

      runMigrations(db, { migrations: [noDownMigration], targetVersion: 1 });
      expect(getCurrentMigrationVersion(db)).toBe(1);

      expect(() =>
        runMigrations(db, { migrations: [noDownMigration], targetVersion: 0 }),
      ).toThrow(/no down\(\) step defined/);

      db.close();
    });
  });

  // ==========================================================================
  // Configuration & Pragmas
  // ==========================================================================

  describe('Configuration & Pragmas', () => {
    it('applies WAL mode and foreign keys on file-based databases', () => {
      const dbFile = path.join(tempDir, 'index.sqlite');
      const store = new IndexStore({ dbPath: dbFile, clock: fakeClock });

      const foreignKeys = store.database.pragma('foreign_keys', { simple: true });
      expect(foreignKeys).toBe(1);

      const journalMode = store.database.pragma('journal_mode', { simple: true });
      expect(journalMode).toBe('wal');

      store.close();
    });

    it('maps fsync policies to PRAGMA synchronous properly', () => {
      const alwaysFile = path.join(tempDir, 'always.sqlite');
      const alwaysStore = new IndexStore({ dbPath: alwaysFile, fsync: 'always' });
      expect(alwaysStore.database.pragma('synchronous', { simple: true })).toBe(2); // FULL
      alwaysStore.close();

      const batchFile = path.join(tempDir, 'batch.sqlite');
      const batchStore = new IndexStore({ dbPath: batchFile, fsync: 'batch' });
      expect(batchStore.database.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
      batchStore.close();

      const neverFile = path.join(tempDir, 'never.sqlite');
      const neverStore = new IndexStore({ dbPath: neverFile, fsync: 'never' });
      expect(neverStore.database.pragma('synchronous', { simple: true })).toBe(0); // OFF
      neverStore.close();
    });

    it('rejects empty dbPath in constructor', () => {
      expect(() => new IndexStore({ dbPath: '' })).toThrow(/dbPath cannot be empty/);
      expect(() => new IndexStore({ dbPath: '   ' })).toThrow(/dbPath cannot be empty/);
    });
  });

  // ==========================================================================
  // Event Indexing & Point / Range Queries
  // ==========================================================================

  describe('Event Indexing & Queries', () => {
    it('indexes single event and queries by ID and stream+seq', () => {
      const store = new IndexStore({ dbPath: ':memory:', clock: fakeClock });

      const event = createEnvelope({
        stream: 'run:01J9TEST000000000000000001',
        seq: 1,
        type: 'turn.started',
        payload: { turnId: '01J9TURN000000000000000001' },
        meta: {
          runId: '01J9TEST000000000000000001',
          traceId: 'trace-123',
        },
        clock: fakeClock,
      });

      const location: EventLocation = {
        segmentIndex: 0,
        segmentPath: 'run_3a01J9...00000000.active.jsonl',
        offset: 0,
        bytesWritten: 120,
        crc32: 'abcd1234',
      };

      store.indexEvent(event, location);

      const retrieved = store.getEvent(event.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(event.id);
      expect(retrieved?.streamId).toBe('run:01J9TEST000000000000000001');
      expect(retrieved?.seq).toBe(1);
      expect(retrieved?.type).toBe('turn.started');
      expect(retrieved?.segmentIndex).toBe(0);
      expect(retrieved?.offset).toBe(0);
      expect(retrieved?.bytes).toBe(120);
      expect(retrieved?.crc32).toBe('abcd1234');
      expect(retrieved?.runId).toBe('01J9TEST000000000000000001');
      expect(retrieved?.traceId).toBe('trace-123');

      // Query by stream and seq
      const byStreamSeq = store.getEventByStreamSeq('run:01J9TEST000000000000000001', 1);
      expect(byStreamSeq?.id).toBe(event.id);

      // Stream record updated
      const streamRec = store.getStream('run:01J9TEST000000000000000001');
      expect(streamRec).not.toBeNull();
      expect(streamRec?.eventCount).toBe(1);
      expect(streamRec?.lastSeq).toBe(1);
      expect(streamRec?.streamType).toBe('run');

      store.close();
    });

    it('queries events by stream range and order', () => {
      const store = new IndexStore({ dbPath: ':memory:', clock: fakeClock });
      const streamId = 'stream:range-test';

      for (let i = 1; i <= 5; i++) {
        const ev = createEnvelope({
          stream: streamId,
          seq: i,
          type: 'turn.completed',
          payload: { i },
          clock: fakeClock,
        });
        store.indexEvent(ev, {
          segmentIndex: 0,
          segmentPath: 'seg.jsonl',
          offset: (i - 1) * 100,
          bytesWritten: 100,
          crc32: '12345678',
        });
      }

      // Query slice [2, 4] ascending
      const sliceAsc = store.getEventsByStream(streamId, { fromSeq: 2, toSeq: 4, order: 'asc' });
      expect(sliceAsc).toHaveLength(3);
      expect(sliceAsc.map((e) => e.seq)).toEqual([2, 3, 4]);

      // Query descending with limit
      const sliceDesc = store.getEventsByStream(streamId, { limit: 2, order: 'desc' });
      expect(sliceDesc).toHaveLength(2);
      expect(sliceDesc.map((e) => e.seq)).toEqual([5, 4]);

      store.close();
    });

    it('enforces unique (stream_id, seq) constraint', () => {
      const store = new IndexStore({ dbPath: ':memory:', clock: fakeClock });
      const ev1 = createEnvelope({ stream: 's1', seq: 1, type: 'e', payload: {} });
      const ev2 = createEnvelope({ stream: 's1', seq: 1, type: 'e', payload: {} });

      const loc: EventLocation = { segmentIndex: 0, segmentPath: 'a.jsonl', offset: 0, bytesWritten: 50, crc32: '1' };

      store.indexEvent(ev1, loc);
      expect(() => store.indexEvent(ev2, loc)).toThrow(AirError);

      store.close();
    });

    it('indexes batch of events inside a single transaction', () => {
      const store = new IndexStore({ dbPath: ':memory:', clock: fakeClock });
      const streamId = 'batch-stream';

      const batch = Array.from({ length: 25 }, (_, i) => {
        const ev = createEnvelope({
          stream: streamId,
          seq: i + 1,
          type: 'turn.completed',
          payload: { idx: i + 1 },
          clock: fakeClock,
        });
        return {
          event: ev,
          location: {
            segmentIndex: 0,
            segmentPath: 'batch.jsonl',
            offset: i * 80,
            bytesWritten: 80,
            crc32: 'crc00000',
          },
        };
      });

      store.indexEventsBatch(batch);

      const all = store.getEventsByStream(streamId);
      expect(all).toHaveLength(25);

      const streamInfo = store.getStream(streamId);
      expect(streamInfo?.eventCount).toBe(25);
      expect(streamInfo?.lastSeq).toBe(25);

      store.close();
    });
  });

  // ==========================================================================
  // Projections: Runs, Sessions, Streams
  // ==========================================================================

  describe('Lifecycle Projections', () => {
    it('maintains run projection through full lifecycle', () => {
      const store = new IndexStore({ dbPath: ':memory:', clock: fakeClock });
      const runId = '01J9RUN0000000000000000001' as RunId;
      const sessionId = '01J9SESS000000000000000001' as SessionId;
      const streamId = `run:${runId}`;

      // 1. run.created
      store.indexEvent(
        createEnvelope({
          stream: streamId,
          seq: 1,
          type: 'run.created',
          payload: { runId, sessionId, agentId: 'test-agent' },
          meta: { runId, sessionId },
          clock: fakeClock,
        }),
        { segmentIndex: 0, segmentPath: 'seg.jsonl', offset: 0, bytesWritten: 100, crc32: '1' },
      );

      let run = store.getRun(runId);
      expect(run).not.toBeNull();
      expect(run?.status).toBe('created');
      expect(run?.agentId).toBe('test-agent');
      expect(run?.sessionId).toBe(sessionId);

      // Session projection updated runCount
      const session = store.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session?.runCount).toBe(1);

      // 2. run.running
      store.indexEvent(
        createEnvelope({
          stream: streamId,
          seq: 2,
          type: 'run.running',
          payload: { runId },
          meta: { runId },
          clock: fakeClock,
        }),
        { segmentIndex: 0, segmentPath: 'seg.jsonl', offset: 100, bytesWritten: 100, crc32: '2' },
      );
      run = store.getRun(runId);
      expect(run?.status).toBe('running');

      // 3. turn.completed (increments step_count)
      store.indexEvent(
        createEnvelope({
          stream: streamId,
          seq: 3,
          type: 'turn.completed',
          payload: { runId },
          meta: { runId },
          clock: fakeClock,
        }),
        { segmentIndex: 0, segmentPath: 'seg.jsonl', offset: 200, bytesWritten: 100, crc32: '3' },
      );
      run = store.getRun(runId);
      expect(run?.stepCount).toBe(1);

      // 4. run.paused
      store.indexEvent(
        createEnvelope({
          stream: streamId,
          seq: 4,
          type: 'run.paused',
          payload: { runId },
          meta: { runId },
          clock: fakeClock,
        }),
        { segmentIndex: 0, segmentPath: 'seg.jsonl', offset: 300, bytesWritten: 100, crc32: '4' },
      );
      expect(store.getRun(runId)?.status).toBe('paused');

      // 5. run.resumed
      store.indexEvent(
        createEnvelope({
          stream: streamId,
          seq: 5,
          type: 'run.resumed',
          payload: { runId },
          meta: { runId },
          clock: fakeClock,
        }),
        { segmentIndex: 0, segmentPath: 'seg.jsonl', offset: 400, bytesWritten: 100, crc32: '5' },
      );
      expect(store.getRun(runId)?.status).toBe('running');

      // 6. run.waiting_approval & run.waiting_user
      store.indexEvent(
        createEnvelope({ stream: streamId, seq: 6, type: 'run.waiting_approval', payload: { runId }, meta: { runId } }),
        { segmentIndex: 0, segmentPath: 'seg.jsonl', offset: 500, bytesWritten: 100, crc32: '6' },
      );
      expect(store.getRun(runId)?.status).toBe('waiting_approval');

      store.indexEvent(
        createEnvelope({ stream: streamId, seq: 7, type: 'run.waiting_user', payload: { runId }, meta: { runId } }),
        { segmentIndex: 0, segmentPath: 'seg.jsonl', offset: 600, bytesWritten: 100, crc32: '7' },
      );
      expect(store.getRun(runId)?.status).toBe('waiting_user');

      // 7. run.completed
      store.indexEvent(
        createEnvelope({
          stream: streamId,
          seq: 8,
          type: 'run.completed',
          payload: { runId },
          meta: { runId },
          clock: fakeClock,
        }),
        { segmentIndex: 0, segmentPath: 'seg.jsonl', offset: 700, bytesWritten: 100, crc32: '8' },
      );
      run = store.getRun(runId);
      expect(run?.status).toBe('completed');
      expect(run?.completedAt).toBeDefined();

      // Query events by run
      const runEvents = store.getEventsByRun(runId);
      expect(runEvents).toHaveLength(8);

      // Query events by session
      const sessionEvents = store.getEventsBySession(sessionId);
      expect(sessionEvents).toHaveLength(1);

      store.close();
    });

    it('records run.failed with error codes and message', () => {
      const store = new IndexStore({ dbPath: ':memory:', clock: fakeClock });
      const runId = '01J9FAIL0000000000000000001' as RunId;
      const streamId = `run:${runId}`;

      store.indexEvent(
        createEnvelope({
          stream: streamId,
          seq: 1,
          type: 'run.created',
          payload: { runId, agentId: 'agent-fail' },
          meta: { runId },
          clock: fakeClock,
        }),
        { segmentIndex: 0, segmentPath: 's.jsonl', offset: 0, bytesWritten: 50, crc32: '1' },
      );

      store.indexEvent(
        createEnvelope({
          stream: streamId,
          seq: 2,
          type: 'run.failed',
          payload: { runId, error: { code: 'TOOL_EXECUTION_FAILED', message: 'Command crashed' } },
          meta: { runId },
          clock: fakeClock,
        }),
        { segmentIndex: 0, segmentPath: 's.jsonl', offset: 50, bytesWritten: 50, crc32: '2' },
      );

      const run = store.getRun(runId);
      expect(run?.status).toBe('failed');
      expect(run?.errorCode).toBe('TOOL_EXECUTION_FAILED');
      expect(run?.errorMessage).toBe('Command crashed');
      expect(run?.completedAt).toBeDefined();

      store.close();
    });

    it('records run.cancelled properly', () => {
      const store = new IndexStore({ dbPath: ':memory:', clock: fakeClock });
      const runId = '01J9CANCEL00000000000000001' as RunId;
      const streamId = `run:${runId}`;

      store.indexEvent(
        createEnvelope({ stream: streamId, seq: 1, type: 'run.created', payload: { runId } }),
        { segmentIndex: 0, segmentPath: 's.jsonl', offset: 0, bytesWritten: 50, crc32: '1' },
      );

      store.indexEvent(
        createEnvelope({ stream: streamId, seq: 2, type: 'run.cancelled', payload: { runId } }),
        { segmentIndex: 0, segmentPath: 's.jsonl', offset: 50, bytesWritten: 50, crc32: '2' },
      );

      const run = store.getRun(runId);
      expect(run?.status).toBe('cancelled');
      expect(run?.completedAt).toBeDefined();

      store.close();
    });

    it('filters runs and sessions by query criteria', () => {
      const store = new IndexStore({ dbPath: ':memory:', clock: fakeClock });

      const sess1 = store.createSession({ sessionId: '01J9S1000000000000000000001' as SessionId, title: 'Session 1' });
      expect(sess1.title).toBe('Session 1');

      store.createSession({ sessionId: '01J9S2000000000000000000002' as SessionId, title: 'Session 2' });

      const allSessions = store.listSessions();
      expect(allSessions).toHaveLength(2);

      const activeSessions = store.listSessions({ status: 'active' });
      expect(activeSessions).toHaveLength(2);

      // Create runs
      const r1 = '01J9R1000000000000000000001' as RunId;
      const r2 = '01J9R2000000000000000000002' as RunId;

      store.indexEvent(
        createEnvelope({ stream: `run:${r1}`, seq: 1, type: 'run.created', payload: { runId: r1, sessionId: sess1.sessionId, agentId: 'agent-A' } }),
        { segmentIndex: 0, segmentPath: 's.jsonl', offset: 0, bytesWritten: 50, crc32: '1' },
      );
      store.indexEvent(
        createEnvelope({ stream: `run:${r2}`, seq: 1, type: 'run.created', payload: { runId: r2, agentId: 'agent-B' } }),
        { segmentIndex: 0, segmentPath: 's.jsonl', offset: 0, bytesWritten: 50, crc32: '2' },
      );

      const filteredBySession = store.listRuns({ sessionId: sess1.sessionId });
      expect(filteredBySession).toHaveLength(1);
      expect(filteredBySession[0]?.runId).toBe(r1);

      const filteredByAgent = store.listRuns({ agentId: 'agent-B' });
      expect(filteredByAgent).toHaveLength(1);
      expect(filteredByAgent[0]?.runId).toBe(r2);

      const filteredByStatus = store.listRuns({ status: 'created' });
      expect(filteredByStatus).toHaveLength(2);

      // Streams listing
      const streams = store.listStreams({ type: 'run' });
      expect(streams).toHaveLength(2);

      store.close();
    });
  });

  // ==========================================================================
  // Statistics, Clear & Cleanup
  // ==========================================================================

  describe('Stats & Clear Operations', () => {
    it('returns accurate statistics and clears index cleanly', () => {
      const store = new IndexStore({ dbPath: ':memory:', clock: fakeClock });

      const runId = '01J9STAT0000000000000000001' as RunId;
      store.indexEvent(
        createEnvelope({ stream: `run:${runId}`, seq: 1, type: 'run.created', payload: { runId } }),
        { segmentIndex: 0, segmentPath: 's.jsonl', offset: 0, bytesWritten: 50, crc32: '1' },
      );

      const stats = store.getStats();
      expect(stats.totalStreams).toBe(1);
      expect(stats.totalEvents).toBe(1);
      expect(stats.totalRuns).toBe(1);
      expect(stats.schemaVersion).toBe(1);

      // Clear index
      store.clearIndex();

      const clearedStats = store.getStats();
      expect(clearedStats.totalStreams).toBe(0);
      expect(clearedStats.totalEvents).toBe(0);
      expect(clearedStats.totalRuns).toBe(0);
      expect(clearedStats.schemaVersion).toBe(1); // Migrations preserved

      store.close();
    });

    it('rejects calls after close()', () => {
      const store = new IndexStore({ dbPath: ':memory:', clock: fakeClock });
      store.close();

      expect(() => store.getStats()).toThrow(/IndexStore is closed/);
      expect(() => store.getEvent('01H00000000000000000000001' as EventId)).toThrow(/IndexStore is closed/);
      expect(() => store.getEventByStreamSeq('s', 1)).toThrow(/IndexStore is closed/);
      expect(() => store.getEventsByStream('s')).toThrow(/IndexStore is closed/);
      expect(() => store.getEventsByRun('01H00000000000000000000001' as RunId)).toThrow(/IndexStore is closed/);
      expect(() => store.getEventsBySession('01H00000000000000000000001' as SessionId)).toThrow(/IndexStore is closed/);
      expect(() => store.getStream('s')).toThrow(/IndexStore is closed/);
      expect(() => store.listStreams()).toThrow(/IndexStore is closed/);
      expect(() => store.getRun('01H00000000000000000000001' as RunId)).toThrow(/IndexStore is closed/);
      expect(() => store.listRuns()).toThrow(/IndexStore is closed/);
      expect(() => store.getSession('01H00000000000000000000001' as SessionId)).toThrow(/IndexStore is closed/);
      expect(() => store.listSessions()).toThrow(/IndexStore is closed/);
      expect(() => store.createSession({ sessionId: '01H00000000000000000000001' as SessionId })).toThrow(/IndexStore is closed/);
      expect(() => store.clearIndex()).toThrow(/IndexStore is closed/);
      expect(() => store.database).toThrow(/IndexStore is closed/);
    });

    it('handles idempotent close calls', () => {
      const store = new IndexStore({ dbPath: ':memory:', clock: fakeClock });
      store.close();
      expect(() => store.close()).not.toThrow();
    });
  });

  // ==========================================================================
  // Edge Cases & Branch Coverage
  // ==========================================================================

  describe('Edge Cases & Branch Coverage', () => {
    it('handles empty migrations array and no-op targetVersion', () => {
      const db = new Database(':memory:');
      const res = runMigrations(db, { migrations: [] });
      expect(res.fromVersion).toBe(0);
      expect(res.toVersion).toBe(0);
      expect(res.applied).toHaveLength(0);
      db.close();
    });

    it('fails atomically when rollback down() throws', () => {
      const db = new Database(':memory:');
      const badRollback: Migration = {
        version: 2,
        name: '002_bad_rollback',
        up: (d) => {
          d.exec('CREATE TABLE test_bad_down (id INT);');
        },
        down: (d) => {
          d.exec('THIS IS SYNTACTICALLY INVALID SQL;');
        },
      };

      runMigrations(db, { migrations: [migrationV1, badRollback], targetVersion: 2 });
      expect(getCurrentMigrationVersion(db)).toBe(2);

      expect(() =>
        runMigrations(db, { migrations: [migrationV1, badRollback], targetVersion: 1 }),
      ).toThrow(AirError);

      db.close();
    });

    it('creates nested directories automatically for file-based database', () => {
      const deepPath = path.join(tempDir, 'nested', 'deep', 'dir', 'index.sqlite');
      const store = new IndexStore({ dbPath: deepPath, clock: fakeClock });
      expect(fs.existsSync(deepPath)).toBe(true);
      store.close();
    });

    it('handles empty batch indexing gracefully', () => {
      const store = new IndexStore({ dbPath: ':memory:', clock: fakeClock });
      expect(() => store.indexEventsBatch([])).not.toThrow();
      const stats = store.getStats();
      expect(stats.totalEvents).toBe(0);
      store.close();
    });

    it('throws INDEX_WRITE_FAILED when batch contains constraint violation', () => {
      const store = new IndexStore({ dbPath: ':memory:', clock: fakeClock });
      const ev = createEnvelope({ stream: 's_batch_fail', seq: 1, type: 't', payload: {} });
      const loc: EventLocation = { segmentIndex: 0, segmentPath: 'a.jsonl', offset: 0, bytesWritten: 10, crc32: '1' };

      expect(() =>
        store.indexEventsBatch([
          { event: ev, location: loc },
          { event: ev, location: loc }, // Duplicate seq
        ]),
      ).toThrow(AirError);

      store.close();
    });

    it('indexes full metadata and multiple stream types (session, system, custom)', () => {
      const store = new IndexStore({ dbPath: ':memory:', clock: fakeClock });

      // Session stream
      const sessionEvent = createEnvelope({
        stream: 'session:01J9SESS000000000000000001',
        seq: 1,
        type: 'session.started',
        payload: { sessionId: '01J9SESS000000000000000001' },
        meta: {
          sessionId: '01J9SESS000000000000000001',
          turnId: 'turn-123',
          toolCallId: 'tool-456',
          traceId: 'trace-789',
          causationId: '01J9CAUSE000000000000000001',
          correlationId: '01J9CORR0000000000000000001',
        },
        clock: fakeClock,
      });

      store.indexEvent(sessionEvent, {
        segmentIndex: 0,
        segmentPath: 'sess.jsonl',
        offset: 0,
        bytesWritten: 100,
        crc32: '11111111',
      });

      const retrievedSessEvent = store.getEvent(sessionEvent.id);
      expect(retrievedSessEvent?.turnId).toBe('turn-123');
      expect(retrievedSessEvent?.toolCallId).toBe('tool-456');
      expect(retrievedSessEvent?.traceId).toBe('trace-789');
      expect(retrievedSessEvent?.causationId).toBe('01J9CAUSE000000000000000001');
      expect(retrievedSessEvent?.correlationId).toBe('01J9CORR0000000000000000001');

      const sessStream = store.getStream('session:01J9SESS000000000000000001');
      expect(sessStream?.streamType).toBe('session');

      // System stream
      const sysEvent = createEnvelope({
        stream: 'system',
        seq: 1,
        type: 'system.boot',
        payload: {},
        clock: fakeClock,
      });
      store.indexEvent(sysEvent, {
        segmentIndex: 0,
        segmentPath: 'sys.jsonl',
        offset: 0,
        bytesWritten: 50,
        crc32: '22222222',
      });

      const sysStream = store.getStream('system');
      expect(sysStream?.streamType).toBe('system');

      // Custom stream
      const customEvent = createEnvelope({
        stream: 'custom:audit',
        seq: 1,
        type: 'audit.log',
        payload: {},
        clock: fakeClock,
      });
      store.indexEvent(customEvent, {
        segmentIndex: 0,
        segmentPath: 'custom.jsonl',
        offset: 0,
        bytesWritten: 50,
        crc32: '33333333',
      });

      const customStream = store.getStream('custom:audit');
      expect(customStream?.streamType).toBe('custom');

      store.close();
    });

    it('returns null when querying nonexistent records', () => {
      const store = new IndexStore({ dbPath: ':memory:', clock: fakeClock });

      expect(store.getEvent('01J9NONEXIST0000000000000001' as EventId)).toBeNull();
      expect(store.getEventByStreamSeq('nonexistent', 999)).toBeNull();
      expect(store.getStream('nonexistent')).toBeNull();
      expect(store.getRun('01J9NONEXIST0000000000000001' as RunId)).toBeNull();
      expect(store.getSession('01J9NONEXIST0000000000000001' as SessionId)).toBeNull();

      store.close();
    });

    it('lists streams and runs without any filtering options', () => {
      const store = new IndexStore({ dbPath: ':memory:', clock: fakeClock });

      const r1 = '01J9R1000000000000000000001' as RunId;
      store.indexEvent(
        createEnvelope({ stream: `run:${r1}`, seq: 1, type: 'run.created', payload: { runId: r1 } }),
        { segmentIndex: 0, segmentPath: 's.jsonl', offset: 0, bytesWritten: 50, crc32: '1' },
      );

      // listStreams with no options
      const streams = store.listStreams();
      expect(streams.length).toBeGreaterThan(0);

      // listRuns with no options
      const runs = store.listRuns();
      expect(runs.length).toBeGreaterThan(0);

      store.close();
    });
  });
});
