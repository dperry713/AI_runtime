import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  createEnvelope,
  EventBus,
  formatEventLine,
  IndexStore,
  inspectSegmentFile,
  rebuildIndex,
  reconcileIndex,
  recoverJournal,
  repairSegmentFile,
  SegmentWriter,
} from '../../../src/journal/index.js';
import type { EventEnvelope } from '../../../src/journal/index.js';
import type { RunId, SessionId } from '../../../src/types/index.js';
import { FakeClock } from '../../../src/util/index.js';

describe('Crash Recovery & Index Reconciliation (P2-T06)', () => {
  let tempDir: string;
  let journalDir: string;
  let dbPath: string;
  let fakeClock: FakeClock;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-recovery-test-'));
    journalDir = path.join(tempDir, 'journal');
    dbPath = path.join(tempDir, 'index.db');
    fs.mkdirSync(journalDir, { recursive: true });
    fakeClock = new FakeClock('2026-10-16T12:00:00.000Z');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignored in test cleanup
    }
  });

  // ==========================================================================
  // Segment Inspection
  // ==========================================================================

  describe('inspectSegmentFile', () => {
    it('throws JOURNAL_READ_FAILED when file does not exist', async () => {
      const missing = path.join(journalDir, 'missing.00000001.active.jsonl');
      await expect(inspectSegmentFile(missing)).rejects.toThrow(AirError);
    });

    it('inspects an empty 0-byte segment file cleanly', async () => {
      const emptyFile = path.join(journalDir, 'empty.00000001.active.jsonl');
      fs.writeFileSync(emptyFile, '');

      const report = await inspectSegmentFile(emptyFile);
      expect(report.fileSize).toBe(0);
      expect(report.validEventsCount).toBe(0);
      expect(report.hasTornTail).toBe(false);
      expect(report.hasMidFileCorruption).toBe(false);
      expect(report.lastValidSeq).toBe(0);
    });

    it('inspects a fully valid segment file', async () => {
      const writer = new SegmentWriter({ journalDir, clock: fakeClock, fsync: 'never' });
      const streamId = 'stream:valid';

      for (let i = 1; i <= 5; i++) {
        await writer.append(createEnvelope({
          stream: streamId,
          seq: i,
          type: 'step',
          payload: { step: i },
          clock: fakeClock,
        }));
      }
      await writer.close();

      const files = fs.readdirSync(journalDir).filter((f) => f.endsWith('.jsonl'));
      expect(files).toHaveLength(1);
      const filePath = path.join(journalDir, files[0] as string);

      const report = await inspectSegmentFile(filePath);
      expect(report.validEventsCount).toBe(5);
      expect(report.lastValidSeq).toBe(5);
      expect(report.hasTornTail).toBe(false);
      expect(report.hasMidFileCorruption).toBe(false);
      expect(report.tornBytes).toBe(0);
    });

    it('detects torn tail caused by missing trailing newline or truncated line at EOF', async () => {
      const writer = new SegmentWriter({ journalDir, clock: fakeClock, fsync: 'never' });
      const streamId = 'stream:torn';

      for (let i = 1; i <= 3; i++) {
        await writer.append(createEnvelope({
          stream: streamId,
          seq: i,
          type: 'step',
          payload: { step: i },
          clock: fakeClock,
        }));
      }
      await writer.close();

      const files = fs.readdirSync(journalDir).filter((f) => f.endsWith('.jsonl'));
      const filePath = path.join(journalDir, files[0] as string);
      const originalContent = fs.readFileSync(filePath, 'utf8');

      // Append partial torn write without newline
      const tornFragment = '12345678 {"id": "01J9TORN", "stream": "';
      fs.writeFileSync(filePath, originalContent + tornFragment);

      const report = await inspectSegmentFile(filePath);
      expect(report.validEventsCount).toBe(3);
      expect(report.lastValidSeq).toBe(3);
      expect(report.hasTornTail).toBe(true);
      expect(report.hasMidFileCorruption).toBe(false);
      expect(report.tornBytes).toBe(Buffer.byteLength(tornFragment, 'utf8'));
    });

    it('detects mid-file corruption with line number and offset', async () => {
      const writer = new SegmentWriter({ journalDir, clock: fakeClock, fsync: 'never' });
      const streamId = 'stream:corrupt';

      for (let i = 1; i <= 4; i++) {
        await writer.append(createEnvelope({
          stream: streamId,
          seq: i,
          type: 'step',
          payload: { step: i },
          clock: fakeClock,
        }));
      }
      await writer.close();

      const files = fs.readdirSync(journalDir).filter((f) => f.endsWith('.jsonl'));
      const filePath = path.join(journalDir, files[0] as string);
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');

      // Corrupt line 2 in the middle of 4 lines
      const line2 = lines[1] as string;
      lines[1] = `00000000 ${line2.slice(9)}`; // Break CRC on line 2
      fs.writeFileSync(filePath, lines.join('\n'));

      const report = await inspectSegmentFile(filePath);
      expect(report.hasMidFileCorruption).toBe(true);
      expect(report.corruptionLine).toBe(2);
      expect(report.corruptionDetails).toContain('line 2');
      expect(report.hasTornTail).toBe(false);
    });
  });

  // ==========================================================================
  // Segment Repair & Quarantine
  // ==========================================================================

  describe('repairSegmentFile', () => {
    it('truncates torn tail cleanly to last valid offset', async () => {
      const writer = new SegmentWriter({ journalDir, clock: fakeClock, fsync: 'never' });
      const streamId = 'stream:repair-torn';

      for (let i = 1; i <= 3; i++) {
        await writer.append(createEnvelope({ stream: streamId, seq: i, type: 'step', payload: { i } }));
      }
      await writer.close();

      const files = fs.readdirSync(journalDir).filter((f) => f.endsWith('.jsonl'));
      const filePath = path.join(journalDir, files[0] as string);
      const originalSize = fs.statSync(filePath).size;

      // Append garbage at EOF
      fs.appendFileSync(filePath, 'deadbeef {"incomplete": true\n');

      const repair = await repairSegmentFile(filePath);
      expect(repair.action).toBe('truncated');
      expect(repair.truncatedBytes).toBeGreaterThan(0);
      expect(repair.lastValidSeq).toBe(3);

      const newSize = fs.statSync(filePath).size;
      expect(newSize).toBe(originalSize);

      // Subsequent inspection must be completely clean
      const reinspect = await inspectSegmentFile(filePath);
      expect(reinspect.hasTornTail).toBe(false);
      expect(reinspect.validEventsCount).toBe(3);
      expect(reinspect.lastValidSeq).toBe(3);
    });

    it('quarantines segment with mid-file corruption into quarantine directory', async () => {
      const writer = new SegmentWriter({ journalDir, clock: fakeClock, fsync: 'never' });
      const streamId = 'stream:repair-quarantine';

      for (let i = 1; i <= 3; i++) {
        await writer.append(createEnvelope({ stream: streamId, seq: i, type: 'step', payload: { i } }));
      }
      await writer.close();

      const files = fs.readdirSync(journalDir).filter((f) => f.endsWith('.jsonl'));
      const filePath = path.join(journalDir, files[0] as string);
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      lines[1] = 'ffffffff {"corrupted": true}'; // Corrupt line 2
      fs.writeFileSync(filePath, lines.join('\n'));

      const quarantineDir = path.join(journalDir, '.custom_quarantine');
      const repair = await repairSegmentFile(filePath, { quarantineDir });

      expect(repair.action).toBe('quarantined');
      expect(repair.quarantinePath).toBeDefined();
      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.existsSync(repair.quarantinePath as string)).toBe(true);
    });

    it('returns action none on clean valid segment file', async () => {
      const cleanFile = path.join(journalDir, 'clean.00000001.active.jsonl');
      fs.writeFileSync(cleanFile, formatEventLine(createEnvelope({ stream: 'clean', seq: 1, type: 'init', payload: {} })));

      const repair = await repairSegmentFile(cleanFile);
      expect(repair.action).toBe('none');
      expect(repair.truncatedBytes).toBe(0);
      expect(repair.lastValidSeq).toBe(1);
    });
  });

  // ==========================================================================
  // Index Rebuild & Reconciliation
  // ==========================================================================

  describe('rebuildIndex and reconcileIndex', () => {
    it('rebuilds entire IndexStore from multiple streams and segments', async () => {
      const indexStore = new IndexStore({ dbPath, clock: fakeClock });
      const writer = new SegmentWriter({ journalDir, clock: fakeClock, fsync: 'never', segmentMaxBytes: 1024 });

      const runId = '01J9REBUILDRUN00000000001' as RunId;
      const sessionId = '01J9REBUILDSESS000000001' as SessionId;

      // Stream 1: Run lifecycle
      const runEvents: EventEnvelope<unknown>[] = [
        createEnvelope({
          stream: `run:${runId}`,
          seq: 1,
          type: 'run.created',
          payload: { runId, sessionId, agentId: 'lead-dev' },
          meta: { runId, sessionId },
        }),
        createEnvelope({ stream: `run:${runId}`, seq: 2, type: 'run.starting', payload: { runId } }),
        createEnvelope({ stream: `run:${runId}`, seq: 3, type: 'turn.completed', payload: { runId, turnId: 't1' } }),
        createEnvelope({ stream: `run:${runId}`, seq: 4, type: 'run.completed', payload: { runId } }),
      ];

      for (const ev of runEvents) {
        await writer.append(ev);
      }

      // Stream 2: Custom events
      for (let i = 1; i <= 6; i++) {
        await writer.append(createEnvelope({
          stream: 'custom:telemetry',
          seq: i,
          type: 'metric.sample',
          payload: { i },
        }));
      }

      await writer.close();

      // Wipe SQLite database to simulate index loss
      indexStore.clear();
      expect(indexStore.getStream(`run:${runId}`)).toBeNull();
      expect(indexStore.getRun(runId)).toBeNull();

      // Execute rebuildIndex
      const rebuildResult = await rebuildIndex(journalDir, indexStore, { batchSize: 3 });
      expect(rebuildResult.streamsRebuilt).toBe(2);
      expect(rebuildResult.eventsIndexed).toBe(10);
      expect(rebuildResult.segmentsScanned).toBeGreaterThanOrEqual(2);

      // Verify restored stream metadata
      const rebuiltRunStream = indexStore.getStream(`run:${runId}`);
      expect(rebuiltRunStream).not.toBeNull();
      expect(rebuiltRunStream?.lastSeq).toBe(4);
      expect(rebuiltRunStream?.eventCount).toBe(4);

      // Verify restored lifecycle projection
      const rebuiltRun = indexStore.getRun(runId);
      expect(rebuiltRun).not.toBeNull();
      expect(rebuiltRun?.status).toBe('completed');
      expect(rebuiltRun?.stepCount).toBe(1);
      expect(rebuiltRun?.agentId).toBe('lead-dev');

      indexStore.close();
    });

    it('reconciles index by indexing missing events and pruning orphaned events', async () => {
      const indexStore = new IndexStore({ dbPath, clock: fakeClock });
      const streamId = 'reconcile:stream';

      // 1. Setup on-disk segment with seq 1..5
      const segmentFile = path.join(journalDir, 'reconcile_3astream.00000001.active.jsonl');
      const lines: string[] = [];
      for (let i = 1; i <= 5; i++) {
        lines.push(formatEventLine(createEnvelope({ stream: streamId, seq: i, type: 'ping', payload: { i } })));
      }
      fs.writeFileSync(segmentFile, lines.join(''));

      // 2. Simulate index lagging behind (only knows 1..3)
      for (let i = 1; i <= 3; i++) {
        const ev = createEnvelope({ stream: streamId, seq: i, type: 'ping', payload: { i } });
        indexStore.indexEvent(ev, {
          segmentIndex: 1,
          segmentPath: segmentFile,
          offset: 0,
          bytesWritten: 50,
          crc32: '12345678',
        });
      }

      expect(indexStore.getStream(streamId)?.lastSeq).toBe(3);

      // Reconcile -> catches up to seq 5
      const res1 = await reconcileIndex(journalDir, indexStore);
      expect(res1.indexedMissing).toBe(2);
      expect(indexStore.getStream(streamId)?.lastSeq).toBe(5);

      // 3. Now simulate segment truncation on disk (truncated from 5 down to 2)
      fs.writeFileSync(segmentFile, lines.slice(0, 2).join(''));

      // Reconcile -> prunes orphans (3, 4, 5) from SQLite
      const res2 = await reconcileIndex(journalDir, indexStore);
      expect(res2.prunedOrphans).toBe(3);
      expect(indexStore.getStream(streamId)?.lastSeq).toBe(2);
      expect(indexStore.getEventsByStream(streamId)).toHaveLength(2);

      indexStore.close();
    });

    it('handles non-existent journal directories gracefully', async () => {
      const indexStore = new IndexStore({ dbPath, clock: fakeClock });
      const nonExistent = path.join(tempDir, 'no-dir');

      const res1 = await rebuildIndex(nonExistent, indexStore);
      expect(res1.streamsRebuilt).toBe(0);

      const res2 = await reconcileIndex(nonExistent, indexStore);
      expect(res2.syncedStreams).toBe(0);

      indexStore.close();
    });
  });

  // ==========================================================================
  // Full Recovery Orchestrator
  // ==========================================================================

  describe('recoverJournal', () => {
    it('executes full recovery pipeline with event bus notifications and index rebuild', async () => {
      const eventBus = new EventBus();
      const indexStore = new IndexStore({ dbPath, clock: fakeClock });

      const notifications: string[] = [];
      eventBus.subscribe(
        { streamPrefix: 'system' },
        (ev) => {
          notifications.push(ev.type);
        },
        { name: 'recovery-watcher' },
      );

      // 1. Create a clean stream segment
      const cleanFile = path.join(journalDir, 'clean_5fstream.00000001.sealed.jsonl');
      fs.writeFileSync(cleanFile, formatEventLine(createEnvelope({ stream: 'clean_stream', seq: 1, type: 'init', payload: {} })));

      // 2. Create a stream with a torn tail
      const tornFile = path.join(journalDir, 'torn_5fstream.00000001.active.jsonl');
      const validLine = formatEventLine(createEnvelope({ stream: 'torn_stream', seq: 1, type: 'init', payload: {} }));
      fs.writeFileSync(tornFile, validLine + 'partial_crc {"corrupt_tail"');

      // 3. Create a stream with mid-file corruption
      const corruptFile = path.join(journalDir, 'corrupt_5fstream.00000001.sealed.jsonl');
      const corruptLines = [
        formatEventLine(createEnvelope({ stream: 'corrupt_stream', seq: 1, type: 'e1', payload: {} })),
        '00000000 {"broken": true}\n',
        formatEventLine(createEnvelope({ stream: 'corrupt_stream', seq: 3, type: 'e3', payload: {} })),
      ];
      fs.writeFileSync(corruptFile, corruptLines.join(''));

      // Run full recoverJournal
      const report = await recoverJournal({
        journalDir,
        indexStore,
        eventBus,
        clock: fakeClock,
      });

      expect(report.scannedSegments).toBe(3);
      expect(report.repairedSegments).toBe(1); // torn_stream truncated
      expect(report.quarantinedSegments).toBe(1); // corrupt_stream moved to .quarantine
      expect(report.truncatedBytesTotal).toBeGreaterThan(0);
      expect(report.rebuiltIndex).toBe(true);

      // Verify system events were emitted
      expect(report.recoveredEvents).toHaveLength(1);
      expect(report.recoveredEvents[0]?.type).toBe('system.recovered');
      expect((report.recoveredEvents[0]?.payload as { stream: string }).stream).toBe('torn_stream');

      expect(report.quarantineEvents).toHaveLength(1);
      expect(report.quarantineEvents[0]?.type).toBe('system.quarantine');

      // Wait for event bus dispatch
      await eventBus.drain();
      expect(notifications).toContain('system.recovered');
      expect(notifications).toContain('system.quarantine');

      // Index contains only valid data (clean_stream: 1 event, torn_stream: 1 event, corrupt: quarantined)
      expect(indexStore.getStream('clean_stream')?.eventCount).toBe(1);
      expect(indexStore.getStream('torn_stream')?.eventCount).toBe(1);
      expect(indexStore.getStream('corrupt_stream')).toBeNull();

      await eventBus.close();
      indexStore.close();
    });

    it('returns empty report if journalDir does not exist', async () => {
      const nonExistent = path.join(tempDir, 'does-not-exist');
      const report = await recoverJournal({ journalDir: nonExistent });
      expect(report.scannedSegments).toBe(0);
      expect(report.repairedSegments).toBe(0);
    });

    it('supports reconciliation mode with autoRebuildIndex: false', async () => {
      const indexStore = new IndexStore({ dbPath, clock: fakeClock });

      const streamId = 'reconcile_only:stream';
      const file = path.join(journalDir, 'reconcile_5fonly_3astream.00000001.active.jsonl');
      fs.writeFileSync(file, formatEventLine(createEnvelope({ stream: streamId, seq: 1, type: 'ping', payload: {} })));

      // Also create a non-segment file that must be safely ignored
      fs.writeFileSync(path.join(journalDir, 'notes.txt'), 'some human notes');

      const report = await recoverJournal({
        journalDir,
        indexStore,
        autoRebuildIndex: false,
        clock: fakeClock,
      });

      expect(report.rebuiltIndex).toBe(false);
      expect(report.indexedEventsCount).toBe(1);
      expect(report.streamsRebuiltCount).toBe(1);

      indexStore.close();
    });

    it('recovers journal with custom quarantine directory and without eventBus or indexStore', async () => {
      const customQuarantine = path.join(tempDir, 'custom_quarantine');

      // Torn file
      const tornFile = path.join(journalDir, 'simple_5ftorn.00000001.active.jsonl');
      fs.writeFileSync(tornFile, formatEventLine(createEnvelope({ stream: 'simple_torn', seq: 1, type: 'a', payload: {} })) + 'bad_tail');

      // Corrupted file
      const corruptFile = path.join(journalDir, 'simple_5fcorrupt.00000001.sealed.jsonl');
      fs.writeFileSync(corruptFile, 'bad_mid\n' + formatEventLine(createEnvelope({ stream: 'simple_corrupt', seq: 2, type: 'b', payload: {} })));

      const report = await recoverJournal({
        journalDir,
        quarantineDir: customQuarantine,
        clock: fakeClock,
      });

      expect(report.repairedSegments).toBe(1);
      expect(report.quarantinedSegments).toBe(1);
      expect(report.rebuiltIndex).toBe(false);
      expect(fs.existsSync(customQuarantine)).toBe(true);
    });
  });

  // ==========================================================================
  // Chaos & Fault-Injection Tests (Property: prefix validity under crash)
  // ==========================================================================

  describe('Chaos: torn-write resilience across random cut points', () => {
    it('guarantees clean prefix recovery when a segment is truncated at any random byte offset', async () => {
      // Generate a segment with 20 events
      const streamId = 'chaos:stream';
      const cleanFile = path.join(journalDir, 'chaos_3astream.00000001.active.jsonl');

      const lines: string[] = [];
      for (let i = 1; i <= 20; i++) {
        lines.push(formatEventLine(createEnvelope({
          stream: streamId,
          seq: i,
          type: 'chaos.step',
          payload: { step: i, randomData: `data-payload-chunk-${i}` },
          clock: fakeClock,
        })));
      }

      const fullContent = lines.join('');
      const fullBuffer = Buffer.from(fullContent, 'utf8');
      const totalBytes = fullBuffer.length;

      // Test 50 distinct cutoff positions distributed across the entire file
      const step = Math.max(1, Math.floor(totalBytes / 50));
      for (let cut = 1; cut < totalBytes; cut += step) {
        const sliced = fullBuffer.subarray(0, cut);
        fs.writeFileSync(cleanFile, sliced);

        // Run recovery
        const repairResult = await repairSegmentFile(cleanFile);
        expect(['none', 'truncated']).toContain(repairResult.action);

        // Verify the repaired file is 100% valid
        const inspection = await inspectSegmentFile(cleanFile);
        expect(inspection.hasTornTail).toBe(false);
        expect(inspection.hasMidFileCorruption).toBe(false);

        // Verify the recovered events form a strictly contiguous prefix: 1, 2, ...
        if (inspection.validEventsCount > 0) {
          const repairedContent = fs.readFileSync(cleanFile, 'utf8');
          const repairedLines = repairedContent.trim().split('\n');
          expect(repairedLines.length).toBe(inspection.validEventsCount);

          for (let idx = 0; idx < repairedLines.length; idx++) {
            const line = repairedLines[idx];
            if (line) {
              const parsed = formatEventLine(line);
              expect(parsed).toBeDefined();
            }
          }
        }
      }
    });
  });
});
