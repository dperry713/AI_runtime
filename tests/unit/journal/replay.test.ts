import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  createEnvelope,
  createInitialRunState,
  type EventEnvelope,
  FileSnapshotStore,
  foldEvents,
  IndexStore,
  JournalReader,
  MemorySnapshotStore,
  reduceRunState,
  replayStream,
  SegmentWriter,
} from '../../../src/journal/index.js';
import type { EventId, RunId, SessionId } from '../../../src/types/index.js';
import { FakeClock } from '../../../src/util/index.js';

describe('Reader & Replay Engine (P2-T05)', () => {
  let tempDir: string;
  let fakeClock: FakeClock;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-replay-test-'));
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
  // JournalReader: Point Reads, Offsets & Slices
  // ==========================================================================

  describe('JournalReader', () => {
    it('performs point reads by event ID and stream+seq via IndexStore', async () => {
      const journalDir = path.join(tempDir, 'journal');
      const dbPath = path.join(tempDir, 'index.sqlite');

      const writer = new SegmentWriter({ journalDir, clock: fakeClock, fsync: 'never' });
      const indexStore = new IndexStore({ dbPath, clock: fakeClock });
      const reader = new JournalReader({ journalDir, indexStore });

      const streamId = 'run:01J9READER0000000000000001';
      const ev1 = createEnvelope({
        stream: streamId,
        seq: 1,
        type: 'run.created',
        payload: { runId: '01J9READER0000000000000001' },
        clock: fakeClock,
      });
      const ev2 = createEnvelope({
        stream: streamId,
        seq: 2,
        type: 'run.running',
        payload: { runId: '01J9READER0000000000000001' },
        clock: fakeClock,
      });

      const res1 = await writer.append(ev1);
      const res2 = await writer.append(ev2);
      await writer.close();

      indexStore.indexEvent(ev1, res1);
      indexStore.indexEvent(ev2, res2);

      // Read by ID
      const readById = await reader.getEvent(ev1.id);
      expect(readById).not.toBeNull();
      expect(readById?.id).toBe(ev1.id);
      expect(readById?.type).toBe('run.created');

      // Read by stream + seq
      const readBySeq = await reader.getEventByStreamSeq(streamId, 2);
      expect(readBySeq).not.toBeNull();
      expect(readBySeq?.id).toBe(ev2.id);
      expect(readBySeq?.seq).toBe(2);

      // Non-existent lookups
      expect(await reader.getEvent('01J9NONEXIST0000000000000001' as EventId)).toBeNull();
      expect(await reader.getEventByStreamSeq(streamId, 999)).toBeNull();

      indexStore.close();
    });

    it('performs point reads via direct segment scanning when no index is configured', async () => {
      const journalDir = path.join(tempDir, 'journal');
      const writer = new SegmentWriter({ journalDir, clock: fakeClock, fsync: 'never' });
      const reader = new JournalReader({ journalDir });

      const streamId = 'direct:stream';
      const ev1 = createEnvelope({ stream: streamId, seq: 1, type: 'turn.started', payload: {} });
      const ev2 = createEnvelope({ stream: streamId, seq: 2, type: 'turn.completed', payload: {} });

      await writer.append(ev1);
      await writer.append(ev2);
      await writer.close();

      const readById = await reader.getEvent(ev2.id);
      expect(readById).not.toBeNull();
      expect(readById?.id).toBe(ev2.id);

      const readBySeq = await reader.getEventByStreamSeq(streamId, 1);
      expect(readBySeq).not.toBeNull();
      expect(readBySeq?.seq).toBe(1);

      // Nonexistent
      expect(await reader.getEvent('01J9NONEXIST0000000000000001' as EventId)).toBeNull();
      expect(await reader.getEventByStreamSeq(streamId, 999)).toBeNull();
    });

    it('reads exact byte slices and verifies CRC-32 checksums', async () => {
      const journalDir = path.join(tempDir, 'journal');
      const writer = new SegmentWriter({ journalDir, clock: fakeClock, fsync: 'never' });
      const reader = new JournalReader({ journalDir });

      const ev = createEnvelope({ stream: 'crc:test', seq: 1, type: 'test.crc', payload: { ok: true } });
      const appendResult = await writer.append(ev);
      await writer.close();

      const { segmentPath, offset, bytesWritten, crc32 } = appendResult;

      // Successful read
      const readEv = await reader.readEventAt(segmentPath, offset, bytesWritten, crc32);
      expect(readEv.id).toBe(ev.id);

      // Checksum mismatch throws JOURNAL_CORRUPT
      await expect(
        reader.readEventAt(segmentPath, offset, bytesWritten, '00000000'),
      ).rejects.toThrow(AirError);

      // Short read throws JOURNAL_CORRUPT
      await expect(
        reader.readEventAt(segmentPath, offset, bytesWritten + 10000),
      ).rejects.toThrow(AirError);
    });

    it('reads stream slices with fromSeq, toSeq, limit, and asc/desc ordering', async () => {
      const journalDir = path.join(tempDir, 'journal');
      const dbPath = path.join(tempDir, 'index.sqlite');
      const writer = new SegmentWriter({ journalDir, clock: fakeClock, fsync: 'never' });
      const indexStore = new IndexStore({ dbPath, clock: fakeClock });
      const reader = new JournalReader({ journalDir, indexStore });

      const streamId = 'range:stream';
      for (let i = 1; i <= 10; i++) {
        const ev = createEnvelope({ stream: streamId, seq: i, type: 'step', payload: { i } });
        const res = await writer.append(ev);
        indexStore.indexEvent(ev, res);
      }
      await writer.close();

      // Range [3, 7] asc
      const sliceAsc = await reader.readStream(streamId, { fromSeq: 3, toSeq: 7, order: 'asc' });
      expect(sliceAsc.map((e) => e.seq)).toEqual([3, 4, 5, 6, 7]);

      // Range via async iterator
      const iterSeqs: number[] = [];
      for await (const ev of reader.readStreamIter(streamId, { fromSeq: 3, toSeq: 5 })) {
        iterSeqs.push(ev.seq);
      }
      expect(iterSeqs).toEqual([3, 4, 5]);

      // Range [1, 10] desc with limit 3
      const sliceDesc = await reader.readStream(streamId, { limit: 3, order: 'desc' });
      expect(sliceDesc.map((e) => e.seq)).toEqual([10, 9, 8]);

      // Verify readEventAt with relative segment path
      const indexedEvent1 = indexStore.getEventByStreamSeq(streamId, 1);
      expect(indexedEvent1).not.toBeNull();
      if (!indexedEvent1) throw new Error('Expected indexedEvent1 to be defined');
      const relativePath = path.basename(indexedEvent1.segmentPath);
      const readWithRelPath = await reader.readEventAt(
        relativePath,
        indexedEvent1.offset,
        indexedEvent1.bytes,
        indexedEvent1.crc32,
      );
      expect(readWithRelPath.seq).toBe(1);

      // Also verify direct segment scanning without index
      const directReader = new JournalReader({ journalDir });
      const directAsc = await directReader.readStream(streamId, { fromSeq: 4, toSeq: 6 });
      expect(directAsc.map((e) => e.seq)).toEqual([4, 5, 6]);

      const directDesc = await directReader.readStream(streamId, { limit: 2, order: 'desc' });
      expect(directDesc.map((e) => e.seq)).toEqual([10, 9]);

      indexStore.close();
    });

    it('throws INVALID_STATE when calling reader without journalDir or indexStore', async () => {
      const bareReader = new JournalReader({});
      await expect(bareReader.getEvent('01J90000000000000000000001' as EventId)).rejects.toThrow(AirError);
      await expect(bareReader.getEventByStreamSeq('s', 1)).rejects.toThrow(AirError);
      await expect(bareReader.readStream('s')).rejects.toThrow(AirError);
    });
  });

  // ==========================================================================
  // Snapshot Stores: Memory & File
  // ==========================================================================

  describe('Snapshot Stores', () => {
    it('manages snapshots in MemorySnapshotStore', async () => {
      const store = new MemorySnapshotStore<{ count: number }>();

      expect(await store.getLatestSnapshot('s1')).toBeNull();

      await store.saveSnapshot({ streamId: 's1', seq: 10, state: { count: 10 }, createdAt: '2026-10-16T12:00:00Z' });
      await store.saveSnapshot({ streamId: 's1', seq: 20, state: { count: 20 }, createdAt: '2026-10-16T12:01:00Z' });

      const latest = await store.getLatestSnapshot('s1');
      expect(latest?.seq).toBe(20);
      expect(latest?.state.count).toBe(20);

      const all = await store.listSnapshots('s1');
      expect(all).toHaveLength(2);

      store.clear();
      expect(await store.getLatestSnapshot('s1')).toBeNull();
    });

    it('persists and loads snapshots from FileSnapshotStore', async () => {
      const snapshotDir = path.join(tempDir, 'snapshots');
      const store = new FileSnapshotStore<{ val: string }>(snapshotDir);

      expect(await store.getLatestSnapshot('s:file')).toBeNull();

      await store.saveSnapshot({
        streamId: 's:file',
        seq: 5,
        state: { val: 'five' },
        createdAt: '2026-10-16T12:00:00Z',
      });
      await store.saveSnapshot({
        streamId: 's:file',
        seq: 15,
        state: { val: 'fifteen' },
        createdAt: '2026-10-16T12:05:00Z',
      });

      const latest = await store.getLatestSnapshot('s:file');
      expect(latest?.seq).toBe(15);
      expect(latest?.state.val).toBe('fifteen');

      const all = await store.listSnapshots('s:file');
      expect(all).toHaveLength(2);
      expect(all[0]?.seq).toBe(5);
      expect(all[1]?.seq).toBe(15);
    });
  });

  // ==========================================================================
  // Replay Operations & Snapshotting
  // ==========================================================================

  describe('Replay Engine Operations', () => {
    it('folds events with foldEvents synchronously', () => {
      const events = [
        createEnvelope({ stream: 's', seq: 1, type: 'inc', payload: { amount: 5 } }),
        createEnvelope({ stream: 's', seq: 2, type: 'inc', payload: { amount: 10 } }),
      ];

      const sum = foldEvents(
        0,
        events,
        (acc, ev) => acc + (ev.payload as { amount: number }).amount,
      );
      expect(sum).toBe(15);
    });

    it('replays full stream and creates snapshots at designated intervals', async () => {
      const journalDir = path.join(tempDir, 'journal');
      const writer = new SegmentWriter({ journalDir, clock: fakeClock, fsync: 'never' });
      const reader = new JournalReader({ journalDir });
      const snapshotStore = new MemorySnapshotStore<number>();

      const streamId = 'replay:test';
      for (let i = 1; i <= 9; i++) {
        await writer.append(createEnvelope({ stream: streamId, seq: i, type: 'add', payload: { val: 1 } }));
      }
      await writer.close();

      // First replay with snapshotInterval: 3
      const result1 = await replayStream(reader, streamId, {
        initialState: 0,
        reducer: (acc) => acc + 1,
        snapshotStore,
        snapshotInterval: 3,
        clock: fakeClock,
      });

      expect(result1.eventsReplayed).toBe(9);
      expect(result1.state).toBe(9);
      expect(result1.snapshotLoaded).toBe(false);
      expect(result1.snapshotCreated).toBe(true);

      const snapshots = await snapshotStore.listSnapshots(streamId);
      expect(snapshots.map((s) => s.seq)).toEqual([3, 6, 9]);

      // Add 2 more events
      const writer2 = new SegmentWriter({ journalDir, clock: fakeClock, fsync: 'never' });
      await writer2.append(createEnvelope({ stream: streamId, seq: 10, type: 'add', payload: { val: 1 } }));
      await writer2.append(createEnvelope({ stream: streamId, seq: 11, type: 'add', payload: { val: 1 } }));
      await writer2.close();

      // Second replay resumes from latest snapshot (seq 9)
      const result2 = await replayStream(reader, streamId, {
        initialState: 0,
        reducer: (acc) => acc + 1,
        snapshotStore,
        clock: fakeClock,
      });

      expect(result2.snapshotLoaded).toBe(true);
      expect(result2.fromSeq).toBe(10); // Resumed after seq 9
      expect(result2.eventsReplayed).toBe(2);
      expect(result2.state).toBe(11);
    });

    it('rejects replayStream with empty streamId', async () => {
      const reader = new JournalReader({});
      await expect(
        replayStream(reader, '', {
          initialState: {},
          reducer: (s) => s,
        }),
      ).rejects.toThrow(AirError);
    });
  });

  // ==========================================================================
  // Replay Equivalence Property Test: fold(replay(events)) == live projection
  // ==========================================================================

  describe('Replay Equivalence: fold(replay(events)) == live projection', () => {
    it('satisfies replay equivalence across full run lifecycle', async () => {
      const journalDir = path.join(tempDir, 'journal');
      const dbPath = path.join(tempDir, 'index.sqlite');
      const writer = new SegmentWriter({ journalDir, clock: fakeClock, fsync: 'never' });
      const indexStore = new IndexStore({ dbPath, clock: fakeClock });
      const reader = new JournalReader({ journalDir, indexStore });

      const runId = '01J9EQUIV00000000000000001' as RunId;
      const sessionId = '01J9SESS000000000000000001' as SessionId;
      const streamId = `run:${runId}`;

      // Simulate a sequence of 10 lifecycle events
      const events: EventEnvelope<unknown>[] = [
        createEnvelope({
          stream: streamId,
          seq: 1,
          type: 'run.created',
          payload: { runId, sessionId, agentId: 'architect-agent' },
          meta: { runId, sessionId },
          clock: fakeClock,
        }),
        createEnvelope({ stream: streamId, seq: 2, type: 'run.starting', payload: { runId }, clock: fakeClock }),
        createEnvelope({ stream: streamId, seq: 3, type: 'run.running', payload: { runId }, clock: fakeClock }),
        createEnvelope({ stream: streamId, seq: 4, type: 'turn.started', payload: { turnId: 'turn-1' }, clock: fakeClock }),
        createEnvelope({ stream: streamId, seq: 5, type: 'model.requested', payload: { model: 'claude-3-5' }, clock: fakeClock }),
        createEnvelope({ stream: streamId, seq: 6, type: 'tool.requested', payload: { tool: 'fs.read' }, clock: fakeClock }),
        createEnvelope({ stream: streamId, seq: 7, type: 'turn.completed', payload: { turnId: 'turn-1' }, clock: fakeClock }),
        createEnvelope({ stream: streamId, seq: 8, type: 'run.paused', payload: { runId }, clock: fakeClock }),
        createEnvelope({ stream: streamId, seq: 9, type: 'run.resumed', payload: { runId }, clock: fakeClock }),
        createEnvelope({ stream: streamId, seq: 10, type: 'run.completed', payload: { runId }, clock: fakeClock }),
      ];

      // 1. Maintain live projection event-by-event
      let liveProjection = createInitialRunState(runId);
      for (const ev of events) {
        liveProjection = reduceRunState(liveProjection, ev);
        const appendRes = await writer.append(ev);
        indexStore.indexEvent(ev, appendRes);
      }
      await writer.close();

      // 2. Replay all events from storage via reader and fold into new projection
      const replayResult = await replayStream(reader, streamId, {
        initialState: createInitialRunState(runId),
        reducer: reduceRunState,
      });

      // 3. Property assertion: fold(replay(events)) deepEquals live projection
      expect(replayResult.state).toEqual(liveProjection);
      expect(replayResult.eventsReplayed).toBe(10);
      expect(replayResult.state.status).toBe('completed');
      expect(replayResult.state.stepCount).toBe(1);
      expect(replayResult.state.toolCallCount).toBe(1);
      expect(replayResult.state.modelRequestCount).toBe(1);
      expect(replayResult.state.agentId).toBe('architect-agent');
      expect(replayResult.state.sessionId).toBe(sessionId);

      // Verify also matches SQLite live projection from IndexStore
      const sqliteRun = indexStore.getRun(runId);
      expect(sqliteRun?.status).toBe(liveProjection.status);
      expect(sqliteRun?.stepCount).toBe(liveProjection.stepCount);
      expect(sqliteRun?.agentId).toBe(liveProjection.agentId);

      indexStore.close();
    });

    it('satisfies replay equivalence for failed and cancelled runs', () => {
      const runId = '01J9FAILRUN000000000000001';
      const streamId = `run:${runId}`;

      const failEvents: EventEnvelope<unknown>[] = [
        createEnvelope({
          stream: streamId,
          seq: 1,
          type: 'run.created',
          payload: { runId },
          clock: fakeClock,
        }),
        createEnvelope({
          stream: streamId,
          seq: 2,
          type: 'run.failed',
          payload: {
            runId,
            error: { code: 'PROVIDER_RATE_LIMITED', message: 'Rate limit hit 429' },
          },
          clock: fakeClock,
        }),
      ];

      const live = foldEvents(createInitialRunState(runId), failEvents, reduceRunState);
      const replayed = foldEvents(createInitialRunState(runId), [...failEvents], reduceRunState);

      expect(replayed).toEqual(live);
      expect(replayed.status).toBe('failed');
      expect(replayed.errorCode).toBe('PROVIDER_RATE_LIMITED');
      expect(replayed.errorMessage).toBe('Rate limit hit 429');

      // Cancelled run
      const cancelEvents: EventEnvelope<unknown>[] = [
        createEnvelope({ stream: streamId, seq: 1, type: 'run.created', payload: { runId } }),
        createEnvelope({ stream: streamId, seq: 2, type: 'run.waiting_approval', payload: { runId } }),
        createEnvelope({ stream: streamId, seq: 3, type: 'run.waiting_user', payload: { runId } }),
        createEnvelope({ stream: streamId, seq: 4, type: 'run.cancelled', payload: { runId } }),
      ];

      const cancelLive = foldEvents(createInitialRunState(runId), cancelEvents, reduceRunState);
      expect(cancelLive.status).toBe('cancelled');
    });
  });
});
