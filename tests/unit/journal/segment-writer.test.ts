import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  computeCrc32Hex,
  createEnvelope,
  desanitizeStream,
  formatEventLine,
  formatSegmentFileName,
  parseEventLine,
  parseSegmentFileName,
  readSegmentEvents,
  sanitizeStream,
  SegmentWriter,
  verifyLineChecksum,
} from '../../../src/journal/index.js';
import { FakeClock } from '../../../src/util/index.js';

describe('Journal Segment Writer (P2-T02)', () => {
  let tempDir: string;
  let fakeClock: FakeClock;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-journal-test-'));
    fakeClock = new FakeClock('2026-10-16T12:00:00.000Z');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error on Windows lock
    }
  });

  // ==========================================================================
  // Framing & CRC-32 Tests
  // ==========================================================================

  describe('Framing & CRC-32 Checksumming', () => {
    it('computes consistent 8-character hex CRC-32', () => {
      const hex1 = computeCrc32Hex('hello world');
      expect(hex1).toHaveLength(8);
      expect(hex1).toMatch(/^[0-9a-f]{8}$/);

      const hex2 = computeCrc32Hex(Buffer.from('hello world', 'utf8'));
      expect(hex2).toBe(hex1);
    });

    it('formats event line as <crc32> <json>\\n', () => {
      const envelope = createEnvelope({
        stream: 'test-stream',
        seq: 1,
        type: 'run.created',
        payload: { runId: '01H00000000000000000000001', agentId: 'default' },
        clock: fakeClock,
      });

      const line = formatEventLine(envelope);
      expect(line.endsWith('\n')).toBe(true);
      expect(line.charAt(8)).toBe(' ');

      const crc = line.slice(0, 8);
      const json = line.slice(9, -1);
      expect(computeCrc32Hex(json)).toBe(crc);
    });

    it('verifies valid framed lines successfully', () => {
      const envelope = createEnvelope({
        stream: 'stream-1',
        seq: 1,
        type: 'system.started',
        payload: { version: '0.1.0' },
        clock: fakeClock,
      });
      const line = formatEventLine(envelope);
      const result = verifyLineChecksum(line);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.expectedCrc).toBe(result.actualCrc);
      expect(result.rawJson).toBe(JSON.stringify(envelope));
    });

    it('detects corrupted payload / checksum mismatch', () => {
      const envelope = createEnvelope({
        stream: 'stream-1',
        seq: 1,
        type: 'system.started',
        payload: { version: '0.1.0' },
        clock: fakeClock,
      });
      const line = formatEventLine(envelope);
      // Tamper with a byte in the payload
      const tampered = line.replace('0.1.0', '0.2.0');

      const result = verifyLineChecksum(tampered);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('CRC32 checksum mismatch');
    });

    it('rejects lines that are too short or missing framing space', () => {
      expect(verifyLineChecksum('abc').valid).toBe(false);
      expect(verifyLineChecksum('12345678x{"foo":"bar"}').valid).toBe(false);
      expect(verifyLineChecksum('zzzzzzzz {"foo":"bar"}').valid).toBe(false);
    });

    it('parses valid event envelope from framed line', () => {
      const envelope = createEnvelope({
        stream: 'stream-1',
        seq: 1,
        type: 'system.started',
        payload: { version: '1.0.0' },
        clock: fakeClock,
      });
      const line = formatEventLine(envelope);
      const parseRes = parseEventLine(line);

      expect(parseRes.valid).toBe(true);
      expect(parseRes.envelope?.id).toBe(envelope.id);
      expect(parseRes.envelope?.seq).toBe(1);
    });

    it('reports error when framed JSON is malformed', () => {
      const malformedJson = '{not valid json';
      const crc = computeCrc32Hex(malformedJson);
      const line = `${crc} ${malformedJson}\n`;

      const parseRes = parseEventLine(line);
      expect(parseRes.valid).toBe(false);
      expect(parseRes.error).toContain('JSON parse error');
    });
  });

  // ==========================================================================
  // Stream Sanitization & Filename Tests
  // ==========================================================================

  describe('Stream Sanitization & File Naming', () => {
    it('sanitizes and desanitizes stream identifiers bijectively', () => {
      const testCases = [
        'run:01J9ABCDEF1234567890',
        'session:user_session_1',
        'system',
        'alpha-bravo',
        'deep/path:escape?danger*',
      ];

      for (const tc of testCases) {
        const sanitized = sanitizeStream(tc);
        // Must contain only safe characters for Windows NTFS
        expect(sanitized).toMatch(/^[a-zA-Z0-9_-]+$/);
        const restored = desanitizeStream(sanitized);
        expect(restored).toBe(tc);
      }
    });

    it('throws on empty stream name', () => {
      expect(() => sanitizeStream('')).toThrow(AirError);
      expect(() => sanitizeStream('   ')).toThrow(AirError);
    });

    it('formats and parses segment file names', () => {
      const activeName = formatSegmentFileName('run:123', 0, 'active');
      expect(activeName).toMatch(/^run_3a123\.00000000\.active\.jsonl$/);

      const parsedActive = parseSegmentFileName(activeName);
      expect(parsedActive).not.toBeNull();
      expect(parsedActive?.stream).toBe('run:123');
      expect(parsedActive?.segmentIndex).toBe(0);
      expect(parsedActive?.status).toBe('active');

      const sealedName = formatSegmentFileName('run:123', 5, 'sealed');
      const parsedSealed = parseSegmentFileName(sealedName);
      expect(parsedSealed?.stream).toBe('run:123');
      expect(parsedSealed?.segmentIndex).toBe(5);
      expect(parsedSealed?.status).toBe('sealed');

      expect(parseSegmentFileName('not-a-segment.txt')).toBeNull();
      expect(parseSegmentFileName('run_3a123.active.jsonl')).toBeNull();
    });
  });

  // ==========================================================================
  // SegmentWriter Core Functionality Tests
  // ==========================================================================

  describe('SegmentWriter Writing & Queue Serialization', () => {
    it('appends events sequentially and verifies file content', async () => {
      const writer = new SegmentWriter({
        journalDir: tempDir,
        fsync: 'always',
        clock: fakeClock,
      });

      const e1 = createEnvelope({ stream: 'stream:1', seq: 1, type: 'run.created', payload: {}, clock: fakeClock });
      const e2 = createEnvelope({ stream: 'stream:1', seq: 2, type: 'turn.started', payload: {}, clock: fakeClock });

      const res1 = await writer.append(e1);
      expect(res1.stream).toBe('stream:1');
      expect(res1.seq).toBe(1);
      expect(res1.offset).toBe(0);
      expect(res1.bytesWritten).toBeGreaterThan(0);

      const res2 = await writer.append(e2);
      expect(res2.stream).toBe('stream:1');
      expect(res2.seq).toBe(2);
      expect(res2.offset).toBe(res1.bytesWritten);

      await writer.close();

      const events = await readSegmentEvents(res1.segmentPath);
      expect(events.totalLines).toBe(2);
      expect(events.validEvents).toHaveLength(2);
      expect(events.corruptLines).toHaveLength(0);
      expect(events.validEvents[0]?.seq).toBe(1);
      expect(events.validEvents[1]?.seq).toBe(2);
    });

    it('enforces monotonic sequence numbers per stream', async () => {
      const writer = new SegmentWriter({ journalDir: tempDir });

      const e1 = createEnvelope({ stream: 's1', seq: 1, type: 'e', payload: {} });
      await writer.append(e1);

      // Attempt non-monotonic seq (3 instead of 2)
      const e3 = createEnvelope({ stream: 's1', seq: 3, type: 'e', payload: {} });
      await expect(writer.append(e3)).rejects.toThrow(/Non-monotonic sequence number/);

      // Subsequent valid append (seq 2) succeeds
      const e2 = createEnvelope({ stream: 's1', seq: 2, type: 'e', payload: {} });
      const res = await writer.append(e2);
      expect(res.seq).toBe(2);

      await writer.close();
    });

    it('serializes concurrent appends without race conditions', async () => {
      const writer = new SegmentWriter({ journalDir: tempDir, fsync: 'never' });

      const count = 20;
      const envelopes = Array.from({ length: count }, (_, i) =>
        createEnvelope({
          stream: 'concurrent-stream',
          seq: i + 1,
          type: 'turn.completed',
          payload: { index: i + 1 },
          clock: fakeClock,
        }),
      );

      // Launch all appends concurrently
      const results = await Promise.all(envelopes.map((ev) => writer.append(ev)));
      expect(results).toHaveLength(count);

      // Verify offsets are strictly monotonic
      for (let i = 1; i < count; i++) {
        const prev = results[i - 1];
        const curr = results[i];
        expect(curr?.offset).toBe((prev?.offset ?? 0) + (prev?.bytesWritten ?? 0));
        expect(curr?.seq).toBe(i + 1);
      }

      await writer.close();

      const info = await writer.getStreamInfo('concurrent-stream');
      expect(info.lastSeq).toBe(count);

      const segmentPath = results[0]?.segmentPath;
      expect(segmentPath).toBeDefined();
      if (segmentPath) {
        const readResult = await readSegmentEvents(segmentPath);
        expect(readResult.validEvents).toHaveLength(count);
        expect(readResult.corruptLines).toHaveLength(0);
      }
    });

    it('handles multiple distinct streams in parallel', async () => {
      const writer = new SegmentWriter({ journalDir: tempDir });

      const p1 = writer.append(createEnvelope({ stream: 'stream:A', seq: 1, type: 'e', payload: {} }));
      const p2 = writer.append(createEnvelope({ stream: 'stream:B', seq: 1, type: 'e', payload: {} }));

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.stream).toBe('stream:A');
      expect(r2.stream).toBe('stream:B');
      expect(r1.segmentPath).not.toBe(r2.segmentPath);

      await writer.close();
    });
  });

  // ==========================================================================
  // Segment Rotation & Atomic Sealing Tests
  // ==========================================================================

  describe('Rotation & Sealing', () => {
    it('rotates segment when size threshold is reached and seals old segment', async () => {
      // Set small segment threshold so rotation triggers after ~2 events
      const smallMaxBytes = 350;
      const writer = new SegmentWriter({
        journalDir: tempDir,
        segmentMaxBytes: smallMaxBytes,
        fsync: 'always',
      });

      const e1 = createEnvelope({ stream: 'rot-stream', seq: 1, type: 'run.created', payload: { a: 1 } });
      const e2 = createEnvelope({ stream: 'rot-stream', seq: 2, type: 'turn.started', payload: { b: 2 } });
      const e3 = createEnvelope({ stream: 'rot-stream', seq: 3, type: 'turn.completed', payload: { c: 3 } });

      const r1 = await writer.append(e1);
      const r2 = await writer.append(e2);
      const r3 = await writer.append(e3);

      expect(r1.segmentIndex).toBe(0);
      expect(r2.seq).toBe(2);
      // e2 or e3 will trigger rotation
      expect(r3.segmentIndex).toBeGreaterThan(0);

      const info = await writer.getStreamInfo('rot-stream');
      expect(info.sealedSegments.length).toBeGreaterThan(0);

      // Verify sealed segment file exists on disk and is readable
      const sealedFile = info.sealedSegments[0];
      expect(sealedFile).toBeDefined();
      if (sealedFile) {
        expect(fs.existsSync(sealedFile)).toBe(true);
        expect(sealedFile).toContain('.sealed.jsonl');

        const sealedEvents = await readSegmentEvents(sealedFile);
        expect(sealedEvents.validEvents.length).toBeGreaterThan(0);
        expect(sealedEvents.corruptLines).toHaveLength(0);
      }

      await writer.close();
    });

    it('atomically seals active segment via sealStream', async () => {
      const writer = new SegmentWriter({ journalDir: tempDir });

      await writer.append(createEnvelope({ stream: 'to-seal', seq: 1, type: 'e', payload: {} }));
      await writer.append(createEnvelope({ stream: 'to-seal', seq: 2, type: 'e', payload: {} }));

      const sealedPath = await writer.sealStream('to-seal');
      expect(sealedPath).toBeDefined();
      if (sealedPath) {
        expect(sealedPath).toContain('.00000000.sealed.jsonl');
        expect(fs.existsSync(sealedPath)).toBe(true);
      }

      const info = await writer.getStreamInfo('to-seal');
      expect(info.sealedSegments).toContain(sealedPath);
      expect(info.activeSegmentPath).toBeUndefined();

      // Appending to the same stream after seal creates next active segment (index 1)
      const r3 = await writer.append(createEnvelope({ stream: 'to-seal', seq: 3, type: 'e', payload: {} }));
      expect(r3.segmentIndex).toBe(1);

      await writer.close();
    });

    it('removes 0-byte active segment when sealed rather than leaving empty file', async () => {
      const writer = new SegmentWriter({ journalDir: tempDir });
      // Initialize stream without writing events
      const info = await writer.getStreamInfo('empty-stream');
      expect(info.activeSegmentPath).toBeDefined();
      const activePath = info.activeSegmentPath;
      if (activePath) {
        expect(fs.existsSync(activePath)).toBe(true);
        const sealed = await writer.sealStream('empty-stream');
        expect(sealed).toBeUndefined();
        expect(fs.existsSync(activePath)).toBe(false);
      }

      await writer.close();
    });

    it('seals all active streams via sealAll', async () => {
      const writer = new SegmentWriter({ journalDir: tempDir });
      await writer.append(createEnvelope({ stream: 's1', seq: 1, type: 'e', payload: {} }));
      await writer.append(createEnvelope({ stream: 's2', seq: 1, type: 'e', payload: {} }));

      const sealed = await writer.sealAll();
      expect(sealed).toHaveLength(2);
      for (const p of sealed) {
        expect(p).toContain('.sealed.jsonl');
        expect(fs.existsSync(p)).toBe(true);
      }

      await writer.close();
    });
  });

  // ==========================================================================
  // Resumption & Discovery across Restarts
  // ==========================================================================

  describe('Resumption & Existing Segment Discovery', () => {
    it('discovers existing active and sealed segments across restarts', async () => {
      // Session 1: Write and seal segment 0, write active segment 1
      const writer1 = new SegmentWriter({
        journalDir: tempDir,
        segmentMaxBytes: 300,
      });

      await writer1.append(createEnvelope({ stream: 'resume-stream', seq: 1, type: 'e1', payload: {} }));
      await writer1.append(createEnvelope({ stream: 'resume-stream', seq: 2, type: 'e2', payload: {} }));
      await writer1.append(createEnvelope({ stream: 'resume-stream', seq: 3, type: 'e3', payload: {} }));
      await writer1.close();

      // Session 2: Fresh writer instance on the same directory
      const writer2 = new SegmentWriter({
        journalDir: tempDir,
      });

      const info = await writer2.getStreamInfo('resume-stream');
      expect(info.lastSeq).toBe(3);

      // Append next sequential event (seq 4)
      const res = await writer2.append(
        createEnvelope({ stream: 'resume-stream', seq: 4, type: 'e4', payload: {} }),
      );
      expect(res.seq).toBe(4);

      await writer2.close();
    });
  });

  // ==========================================================================
  // Fsync Policies & Batch Modes
  // ==========================================================================

  describe('Fsync Policies', () => {
    it('supports batch fsync policy with batch append and flush', async () => {
      const writer = new SegmentWriter({
        journalDir: tempDir,
        fsync: 'batch',
        batchMaxUnsynced: 2,
        batchSyncIntervalMs: 20,
      });

      const envelopes = [
        createEnvelope({ stream: 'batch-stream', seq: 1, type: 'e', payload: {} }),
        createEnvelope({ stream: 'batch-stream', seq: 2, type: 'e', payload: {} }),
        createEnvelope({ stream: 'batch-stream', seq: 3, type: 'e', payload: {} }),
      ];

      const results = await writer.appendBatch(envelopes);
      expect(results).toHaveLength(3);

      await writer.flush();
      await writer.close();
    });

    it('supports never fsync policy', async () => {
      const writer = new SegmentWriter({
        journalDir: tempDir,
        fsync: 'never',
      });

      await writer.append(createEnvelope({ stream: 'never-stream', seq: 1, type: 'e', payload: {} }));
      await writer.flushStream('never-stream');
      await writer.close();
    });
  });

  // ==========================================================================
  // StreamSegmentWriter Proxy & Validation
  // ==========================================================================

  describe('StreamSegmentWriter Proxy & Guardrails', () => {
    it('proxies appends for a pre-bound stream', async () => {
      const parent = new SegmentWriter({ journalDir: tempDir });
      const streamWriter = parent.forStream('bound-stream');

      expect(streamWriter.stream).toBe('bound-stream');

      const ev1 = createEnvelope({ stream: 'bound-stream', seq: 1, type: 'e', payload: {} });
      const ev2 = createEnvelope({ stream: 'bound-stream', seq: 2, type: 'e', payload: {} });

      await streamWriter.append(ev1);
      await streamWriter.appendBatch([ev2]);

      const info = await streamWriter.getInfo();
      expect(info.lastSeq).toBe(2);

      await streamWriter.flush();
      const sealed = await streamWriter.seal();
      expect(sealed).toBeDefined();

      await parent.close();
    });

    it('rejects events with mismatched stream ID', async () => {
      const parent = new SegmentWriter({ journalDir: tempDir });
      const streamWriter = parent.forStream('stream-A');

      const wrongEvent = createEnvelope({ stream: 'stream-B', seq: 1, type: 'e', payload: {} });
      await expect(streamWriter.append(wrongEvent)).rejects.toThrow(/does not match bound stream/);
      await expect(streamWriter.appendBatch([wrongEvent])).rejects.toThrow(/does not match bound stream/);

      await parent.close();
    });

    it('enforces defaultStream binding on parent writer if specified', async () => {
      const writer = new SegmentWriter({ journalDir: tempDir, defaultStream: 'only-this' });

      const allowed = createEnvelope({ stream: 'only-this', seq: 1, type: 'e', payload: {} });
      await writer.append(allowed);

      const forbidden = createEnvelope({ stream: 'other', seq: 1, type: 'e', payload: {} });
      await expect(writer.append(forbidden)).rejects.toThrow(/does not match writer default stream/);

      await writer.close();
    });

    it('rejects appends after close()', async () => {
      const writer = new SegmentWriter({ journalDir: tempDir });
      await writer.append(createEnvelope({ stream: 's', seq: 1, type: 'e', payload: {} }));
      await writer.close({ seal: true });

      const ev2 = createEnvelope({ stream: 's', seq: 2, type: 'e', payload: {} });
      await expect(writer.append(ev2)).rejects.toThrow(/SegmentWriter is closed/);
    });

    it('rejects empty journalDir in constructor', () => {
      expect(() => new SegmentWriter({ journalDir: '' })).toThrow(/journalDir cannot be empty/);
      expect(() => new SegmentWriter({ journalDir: '   ' })).toThrow(/journalDir cannot be empty/);
    });
  });

  // ==========================================================================
  // Corrupt Line Detection via readSegmentEvents
  // ==========================================================================

  describe('Corrupt Line Detection', () => {
    it('detects corrupted lines in segment file and reports line numbers', async () => {
      const segFile = path.join(tempDir, 'test.00000000.active.jsonl');
      const ev1 = createEnvelope({ stream: 's', seq: 1, type: 'e', payload: { ok: true } });
      const ev2 = createEnvelope({ stream: 's', seq: 2, type: 'e', payload: { ok: true } });

      const line1 = formatEventLine(ev1);
      const line2 = 'badcrc00 {"seq":2}\n'; // Corrupt CRC
      const line3 = formatEventLine(ev2);
      const line4 = '   \n'; // Empty whitespace line

      await fs.promises.writeFile(segFile, line1 + line2 + line3 + line4, 'utf8');

      const result = await readSegmentEvents(segFile);
      expect(result.validEvents).toHaveLength(2);
      expect(result.corruptLines.length).toBeGreaterThanOrEqual(2);

      const corruptLineNumbers = result.corruptLines.map((c) => c.lineNumber);
      expect(corruptLineNumbers).toContain(2);
      expect(corruptLineNumbers).toContain(4);
    });

    it('reads segment file without trailing newline cleanly', async () => {
      const segFile = path.join(tempDir, 'no-trailing-newline.jsonl');
      const ev = createEnvelope({ stream: 's', seq: 1, type: 'e', payload: {} });
      const lineWithoutNewline = formatEventLine(ev).trimEnd();

      await fs.promises.writeFile(segFile, lineWithoutNewline, 'utf8');
      const result = await readSegmentEvents(segFile);
      expect(result.validEvents).toHaveLength(1);
      expect(result.totalLines).toBe(1);
    });
  });

  // ==========================================================================
  // Edge Cases & Branch Coverage
  // ==========================================================================

  describe('Edge Cases & Recovery Variations', () => {
    it('resumes stream when only sealed segments exist and no active segment exists', async () => {
      const writer1 = new SegmentWriter({ journalDir: tempDir });
      await writer1.append(createEnvelope({ stream: 'all-sealed', seq: 1, type: 'e', payload: {} }));
      await writer1.sealStream('all-sealed');
      await writer1.close();

      // At this point, only all-sealed.00000000.sealed.jsonl exists
      const writer2 = new SegmentWriter({ journalDir: tempDir });
      const info = await writer2.getStreamInfo('all-sealed');
      expect(info.lastSeq).toBe(1);
      expect(info.activeSegmentIndex).toBe(1);

      const res = await writer2.append(
        createEnvelope({ stream: 'all-sealed', seq: 2, type: 'e', payload: {} }),
      );
      expect(res.seq).toBe(2);
      expect(res.segmentIndex).toBe(1);

      await writer2.close();
    });

    it('resumes stream when empty active segment and prior sealed segment exist', async () => {
      const writer1 = new SegmentWriter({ journalDir: tempDir });
      await writer1.append(createEnvelope({ stream: 'empty-active-recovery', seq: 1, type: 'e', payload: {} }));
      await writer1.sealStream('empty-active-recovery');

      // Create an empty active segment 1 file manually
      const emptyActive = path.join(tempDir, formatSegmentFileName('empty-active-recovery', 1, 'active'));
      await fs.promises.writeFile(emptyActive, '', 'utf8');
      await writer1.close();

      const writer2 = new SegmentWriter({ journalDir: tempDir });
      const info = await writer2.getStreamInfo('empty-active-recovery');
      expect(info.lastSeq).toBe(1);

      const res = await writer2.append(
        createEnvelope({ stream: 'empty-active-recovery', seq: 2, type: 'e', payload: {} }),
      );
      expect(res.seq).toBe(2);
      await writer2.close();
    });

    it('rejects events with seq <= 0', async () => {
      const writer = new SegmentWriter({ journalDir: tempDir });
      const validEnvelope = createEnvelope({ stream: 'test-zero-seq', seq: 1, type: 'e', payload: {} });
      const invalidEvent = { ...validEnvelope, seq: 0 };

      await expect(writer.append(invalidEvent)).rejects.toThrow(
        /Event sequence number must be a positive integer/,
      );
      await writer.close();
    });

    it('handles flushStream on unknown stream gracefully', async () => {
      const writer = new SegmentWriter({ journalDir: tempDir });
      await expect(writer.flushStream('unknown-stream')).resolves.toBeUndefined();
      await writer.close();
    });

    it('handles sealStream when active segment file does not exist', async () => {
      const writer = new SegmentWriter({ journalDir: tempDir });
      const info = await writer.getStreamInfo('ghost-stream');
      // Delete the active file behind writer's back
      if (info.activeSegmentPath) {
        await fs.promises.unlink(info.activeSegmentPath).catch(() => {});
      }

      const result = await writer.sealStream('ghost-stream');
      expect(result).toBeUndefined();
      await writer.close();
    });

    it('triggers batch timer and automatic flush without manual flush call', async () => {
      const writer = new SegmentWriter({
        journalDir: tempDir,
        fsync: 'batch',
        batchSyncIntervalMs: 15,
        batchMaxUnsynced: 100, // Large so timer triggers sync
      });

      await writer.append(createEnvelope({ stream: 'timer-stream', seq: 1, type: 'e', payload: {} }));
      // Wait for batchTimer to fire
      await new Promise((resolve) => setTimeout(resolve, 35));

      // Close cleanly
      await writer.close();
    });

    it('clears batchTimer on manual flush or close', async () => {
      const writer = new SegmentWriter({
        journalDir: tempDir,
        fsync: 'batch',
        batchSyncIntervalMs: 500,
        batchMaxUnsynced: 100,
      });

      await writer.append(createEnvelope({ stream: 'cancel-timer', seq: 1, type: 'e', payload: {} }));
      // flush should cancel batchTimer
      await writer.flush();

      await writer.append(createEnvelope({ stream: 'cancel-timer', seq: 2, type: 'e', payload: {} }));
      // close should also cancel batchTimer
      await writer.close();
    });

    interface TestStreamState {
      queue: Promise<unknown>;
      activeHandle?: { close: () => Promise<void>; datasync: () => Promise<void> } | undefined;
    }
    interface TestSegmentWriter {
      streams: Map<string, TestStreamState>;
      getOrCreateStreamState: (stream: string) => TestStreamState;
    }

    it('handles write failure with typed AirError JOURNAL_WRITE_FAILED', async () => {
      const writer = new SegmentWriter({ journalDir: tempDir, fsync: 'always' });
      await writer.append(createEnvelope({ stream: 'fail-stream', seq: 1, type: 'e', payload: {} }));

      // Obtain handle via typed internals and close it to trigger write failure on next append
      const internals = writer as unknown as TestSegmentWriter;
      const state = internals.streams.get('fail-stream');
      if (state?.activeHandle) {
        await state.activeHandle.close();
      }

      await expect(
        writer.append(createEnvelope({ stream: 'fail-stream', seq: 2, type: 'e', payload: {} })),
      ).rejects.toThrow(AirError);

      await writer.close().catch(() => {});
    });

    it('handles fsync failure with typed AirError JOURNAL_WRITE_FAILED', async () => {
      const writer = new SegmentWriter({ journalDir: tempDir, fsync: 'always' });
      await writer.append(createEnvelope({ stream: 'sync-fail', seq: 1, type: 'e', payload: {} }));

      const internals = writer as unknown as TestSegmentWriter;
      const state = internals.streams.get('sync-fail');
      if (state?.activeHandle) {
        state.activeHandle.datasync = () => Promise.reject(new Error('EIO: disk failure'));
      }

      await expect(
        writer.append(createEnvelope({ stream: 'sync-fail', seq: 2, type: 'e', payload: {} })),
      ).rejects.toThrow(AirError);

      await writer.close().catch(() => {});
    });

    it('rejects pending append if writer is closed while in queue', async () => {
      const writer = new SegmentWriter({ journalDir: tempDir });
      const internals = writer as unknown as TestSegmentWriter;
      const state = internals.getOrCreateStreamState('queued-close');
      let unblock: (() => void) | undefined;
      state.queue = new Promise<void>((r) => {
        unblock = r;
      });

      const appendPromise = writer.append(createEnvelope({ stream: 'queued-close', seq: 1, type: 'e', payload: {} }));
      const closePromise = writer.close();
      unblock?.();
      await closePromise;
      await expect(appendPromise).rejects.toThrow(/SegmentWriter is closed/);
    });

    it('handles repeated sealStream calls cleanly when handle is already closed', async () => {
      const writer = new SegmentWriter({ journalDir: tempDir });
      await writer.append(createEnvelope({ stream: 'repeat-seal', seq: 1, type: 'e', payload: {} }));

      const firstSeal = await writer.sealStream('repeat-seal');
      expect(firstSeal).toBeDefined();

      // Second seal call when active segment is already sealed / deleted
      const secondSeal = await writer.sealStream('repeat-seal');
      expect(secondSeal).toBeUndefined();

      await writer.close();
    });

    it('ignores foreign files from different streams in journalDir during initialization', async () => {
      // Put foreign files in directory
      await fs.promises.writeFile(path.join(tempDir, 'other_3astream.00000000.sealed.jsonl'), '', 'utf8');
      await fs.promises.writeFile(path.join(tempDir, 'random-notes.txt'), 'hello', 'utf8');

      const writer = new SegmentWriter({ journalDir: tempDir });
      await writer.append(createEnvelope({ stream: 'my-stream', seq: 1, type: 'e', payload: {} }));
      const info = await writer.getStreamInfo('my-stream');
      expect(info.lastSeq).toBe(1);
      expect(info.activeSegmentIndex).toBe(0);

      await writer.close();
    });
  });
});


