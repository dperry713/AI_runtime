import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEnvelope,
  formatEventLine,
  inspectSegmentFile,
  recoverJournal,
  repairSegmentFile,
  SegmentWriter,
} from '../../src/journal/index.js';
import { FakeClock } from '../../src/util/index.js';

describe('Chaos & Fault-Injection: Journal Crash Recovery', () => {
  let tempDir: string;
  let journalDir: string;
  let fakeClock: FakeClock;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-chaos-recovery-'));
    journalDir = path.join(tempDir, 'journal');
    fs.mkdirSync(journalDir, { recursive: true });
    fakeClock = new FakeClock('2026-10-16T12:00:00.000Z');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  it('guarantees clean valid prefix when truncated at arbitrary cut offsets across 100 runs', async () => {
    const streamId = 'chaos:stream';
    const segmentFile = path.join(journalDir, 'chaos_3astream.00000001.active.jsonl');

    // Create a segment with 30 events
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) {
      lines.push(formatEventLine(createEnvelope({
        stream: streamId,
        seq: i,
        type: 'chaos.record',
        payload: {
          step: i,
          entropy: `random-entropy-string-value-${i}-${'x'.repeat(i % 10)}`,
        },
        clock: fakeClock,
      })));
    }

    const fullContent = lines.join('');
    const fullBuffer = Buffer.from(fullContent, 'utf8');
    const totalBytes = fullBuffer.length;

    // Test 100 cut points distributed through the file
    const sampleStep = Math.max(1, Math.floor(totalBytes / 100));

    for (let cut = 1; cut < totalBytes; cut += sampleStep) {
      const sliced = fullBuffer.subarray(0, cut);
      fs.writeFileSync(segmentFile, sliced);

      // Repair
      const res = await repairSegmentFile(segmentFile);
      expect(['none', 'truncated']).toContain(res.action);

      // Inspect
      const insp = await inspectSegmentFile(segmentFile);
      expect(insp.hasTornTail).toBe(false);
      expect(insp.hasMidFileCorruption).toBe(false);

      // Verify sequence monotonicity and framing
      if (insp.validEventsCount > 0) {
        expect(insp.lastValidSeq).toBe(insp.validEventsCount);
      }
    }
  });

  it('quarantines files with bit flips at arbitrary middle byte positions', async () => {
    const streamId = 'chaos:corrupt';
    const segmentFile = path.join(journalDir, 'chaos_3acorrupt.00000001.sealed.jsonl');

    // Generate 10 events
    const lines: string[] = [];
    for (let i = 1; i <= 10; i++) {
      lines.push(formatEventLine(createEnvelope({
        stream: streamId,
        seq: i,
        type: 'step',
        payload: { i },
        clock: fakeClock,
      })));
    }

    const originalContent = lines.join('');
    const originalBuffer = Buffer.from(originalContent, 'utf8');

    // Pick 20 byte positions strictly in the middle (between event 2 and event 8)
    const startOffset = Buffer.byteLength(lines.slice(0, 2).join(''), 'utf8');
    const endOffset = Buffer.byteLength(lines.slice(0, 8).join(''), 'utf8');

    const step = Math.max(1, Math.floor((endOffset - startOffset) / 20));

    for (let pos = startOffset; pos < endOffset; pos += step) {
      const corruptedBuf = Buffer.from(originalBuffer);
      // Flip a bit
      const currentByte = corruptedBuf[pos];
      if (currentByte !== undefined) {
        corruptedBuf[pos] = currentByte ^ 0xff;
      }
      fs.writeFileSync(segmentFile, corruptedBuf);

      const insp = await inspectSegmentFile(segmentFile);
      // Bit flip in the middle must be detected as mid-file corruption
      expect(insp.hasMidFileCorruption).toBe(true);

      const quarantineDir = path.join(journalDir, '.chaos_quarantine');
      const rep = await repairSegmentFile(segmentFile, { quarantineDir });
      expect(rep.action).toBe('quarantined');
      expect(fs.existsSync(segmentFile)).toBe(false);

      // Clean up quarantine dir for next iteration
      fs.rmSync(quarantineDir, { recursive: true, force: true });
    }
  });

  it('resumes writing seamlessly after crash recovery truncation', async () => {
    const streamId = 'crash:resume';
    const writer1 = new SegmentWriter({ journalDir, clock: fakeClock, fsync: 'never' });

    for (let i = 1; i <= 5; i++) {
      await writer1.append(createEnvelope({ stream: streamId, seq: i, type: 'init', payload: { i } }));
    }
    await writer1.close();

    const files = fs.readdirSync(journalDir).filter((f) => f.endsWith('.jsonl'));
    const segmentFile = path.join(journalDir, files[0] as string);

    // Simulate crash in the middle of writing event 6
    fs.appendFileSync(segmentFile, '99999999 {"stream": "crash:resume", "seq": 6, "type": "crashed');

    // Run recoverJournal
    const report = await recoverJournal({ journalDir, clock: fakeClock });
    expect(report.repairedSegments).toBe(1);
    expect(report.truncatedBytesTotal).toBeGreaterThan(0);

    // Now instantiate a new SegmentWriter on the same journal directory
    const writer2 = new SegmentWriter({ journalDir, clock: fakeClock, fsync: 'never' });

    // Writer should resume from seq 6 smoothly
    const app6 = await writer2.append(createEnvelope({ stream: streamId, seq: 6, type: 'resumed', payload: { ok: true } }));
    expect(app6.seq).toBe(6);

    const app7 = await writer2.append(createEnvelope({ stream: streamId, seq: 7, type: 'next', payload: { ok: true } }));
    expect(app7.seq).toBe(7);

    await writer2.close();

    // Verify all 7 events are valid and contiguous
    const finalInspection = await inspectSegmentFile(segmentFile);
    expect(finalInspection.validEventsCount).toBe(7);
    expect(finalInspection.lastValidSeq).toBe(7);
    expect(finalInspection.hasTornTail).toBe(false);
  });
});
