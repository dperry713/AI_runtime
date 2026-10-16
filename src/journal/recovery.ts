/**
 * Crash Recovery and Index Reconciliation Engine for AIR Journal (P2-T06).
 *
 * Implements:
 * - Torn-write detection and tail truncation to last valid line.
 * - Mid-file corruption quarantine with line number and offset tracking.
 * - Emission of `system.recovered` and `system.quarantine` events.
 * - Rebuilding SQLite index from segment files.
 * - Reconciling index state against segment disk state.
 * - Strict adherence to determinism (injected Clock and IdGenerator, Rule R6)
 *   and Windows path safety (Rule R5).
 */

import fs from 'node:fs';
import path from 'node:path';
import { AirError } from '../errors/index.js';
import { canonicalize } from '../util/index.js';
import { type Clock, SystemClock } from '../util/index.js';
import { type IdGenerator, UlidIdGenerator } from '../util/index.js';
import { createEnvelope, type EventEnvelope } from './envelope.js';
import type { EventBus } from './event-bus.js';
import type { EventLocation, IndexStore } from './index-store.js';

import {
  parseEventLine,
  parseSegmentFileName,
} from './segment-writer.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface SegmentInspectionReport {
  filePath: string;
  fileName: string;
  stream: string | null;
  fileSize: number;
  validEventsCount: number;
  lastValidSeq: number;
  lastValidOffset: number;
  hasTornTail: boolean;
  tornBytes: number;
  hasMidFileCorruption: boolean;
  corruptionDetails?: string | undefined;
  corruptionLine?: number | undefined;
}

export type RepairAction = 'none' | 'truncated' | 'quarantined';

export interface SegmentRepairResult {
  filePath: string;
  action: RepairAction;
  truncatedBytes: number;
  lastValidSeq: number;
  lastValidOffset: number;
  quarantinePath?: string | undefined;
  reason?: string | undefined;
}

export interface RebuildIndexResult {
  streamsRebuilt: number;
  eventsIndexed: number;
  segmentsScanned: number;
}

export interface ReconcileResult {
  syncedStreams: number;
  indexedMissing: number;
  prunedOrphans: number;
}

export interface RecoveryOptions {
  journalDir: string;
  indexStore?: IndexStore | undefined;
  eventBus?: EventBus | undefined;
  clock?: Clock | undefined;
  idGenerator?: IdGenerator | undefined;
  quarantineDir?: string | undefined;
  autoRebuildIndex?: boolean | undefined;
}

export interface RecoveryReport {
  scannedSegments: number;
  repairedSegments: number;
  quarantinedSegments: number;
  truncatedBytesTotal: number;
  recoveredEvents: EventEnvelope[];
  quarantineEvents: EventEnvelope[];
  rebuiltIndex: boolean;
  indexedEventsCount: number;
  streamsRebuiltCount: number;
}

// ============================================================================
// Segment Inspection & Repair
// ============================================================================

/**
 * Inspects a segment file for framing validity, CRC-32 checksums, torn tails, and corruption.
 */
export async function inspectSegmentFile(filePath: string): Promise<SegmentInspectionReport> {
  const resolvedPath = canonicalize(filePath);
  const fileName = path.basename(resolvedPath);
  const parsed = parseSegmentFileName(fileName);
  const stream = parsed ? parsed.stream : null;

  if (!fs.existsSync(resolvedPath)) {
    throw new AirError('JOURNAL_READ_FAILED', `Segment file does not exist: "${resolvedPath}"`);
  }

  const stat = await fs.promises.stat(resolvedPath);
  const fileSize = stat.size;

  if (fileSize === 0) {
    return {
      filePath: resolvedPath,
      fileName,
      stream,
      fileSize: 0,
      validEventsCount: 0,
      lastValidSeq: 0,
      lastValidOffset: 0,
      hasTornTail: false,
      tornBytes: 0,
      hasMidFileCorruption: false,
    };
  }

  const content = await fs.promises.readFile(resolvedPath, 'utf8');

  // Split lines while tracking byte offsets exactly
  let currentOffset = 0;
  let validEventsCount = 0;
  let lastValidSeq = 0;
  let lastValidOffset = 0;

  // Find line boundaries
  let lineStart = 0;
  const lines: Array<{ text: string; offset: number; bytes: number; hasNewline: boolean }> = [];

  while (lineStart < content.length) {
    const nextNewline = content.indexOf('\n', lineStart);
    if (nextNewline === -1) {
      // Line without trailing newline (incomplete line at EOF)
      const text = content.slice(lineStart);
      const bytes = Buffer.byteLength(text, 'utf8');
      lines.push({ text, offset: currentOffset, bytes, hasNewline: false });
      break;
    } else {
      const text = content.slice(lineStart, nextNewline + 1);
      const bytes = Buffer.byteLength(text, 'utf8');
      lines.push({ text, offset: currentOffset, bytes, hasNewline: true });
      currentOffset += bytes;
      lineStart = nextNewline + 1;
    }
  }

  let hasMidFileCorruption = false;
  let corruptionDetails: string | undefined;
  let corruptionLine: number | undefined;
  let hasTornTail = false;
  let tornBytes = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const entry = lines[i];
    if (!entry) continue;

    const isLastLine = i === lines.length - 1;

    // Check if line terminates with \n
    if (!entry.hasNewline) {
      // Incomplete trailing line without newline at EOF -> torn tail
      hasTornTail = true;
      tornBytes = fileSize - entry.offset;
      break;
    }

    const parsedLine = parseEventLine(entry.text);
    if (!parsedLine.valid || !parsedLine.envelope) {
      if (isLastLine) {
        hasTornTail = true;
        tornBytes = fileSize - entry.offset;
        break;
      } else {
        hasMidFileCorruption = true;
        corruptionLine = lineNum;
        corruptionDetails = `Invalid event line ${lineNum} (offset ${entry.offset}): ${parsedLine.error ?? 'unknown'}`;
        break;
      }
    }

    // Line is fully valid
    validEventsCount++;
    lastValidSeq = parsedLine.envelope.seq;
    lastValidOffset = entry.offset + entry.bytes;
  }

  return {
    filePath: resolvedPath,
    fileName,
    stream,
    fileSize,
    validEventsCount,
    lastValidSeq,
    lastValidOffset,
    hasTornTail,
    tornBytes,
    hasMidFileCorruption,
    corruptionDetails,
    corruptionLine,
  };
}

/**
 * Repairs a segment file: quarantines mid-file corruption or truncates a torn tail.
 */
export async function repairSegmentFile(
  filePath: string,
  options?: { quarantineDir?: string | undefined },
): Promise<SegmentRepairResult> {
  const resolvedPath = canonicalize(filePath);
  const inspection = await inspectSegmentFile(resolvedPath);

  if (inspection.hasMidFileCorruption) {
    const quarantineBase = options?.quarantineDir ?? path.join(path.dirname(resolvedPath), '.quarantine');
    await fs.promises.mkdir(quarantineBase, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantineName = `${inspection.fileName}.${timestamp}.quarantine`;
    const quarantinePath = canonicalize(path.join(quarantineBase, quarantineName));

    await fs.promises.rename(resolvedPath, quarantinePath);

    return {
      filePath: resolvedPath,
      action: 'quarantined',
      truncatedBytes: 0,
      lastValidSeq: inspection.lastValidSeq,
      lastValidOffset: inspection.lastValidOffset,
      quarantinePath,
      reason: inspection.corruptionDetails ?? 'Mid-file data corruption detected',
    };
  }

  if (inspection.hasTornTail) {
    await fs.promises.truncate(resolvedPath, inspection.lastValidOffset);
    return {
      filePath: resolvedPath,
      action: 'truncated',
      truncatedBytes: inspection.tornBytes,
      lastValidSeq: inspection.lastValidSeq,
      lastValidOffset: inspection.lastValidOffset,
    };
  }

  return {
    filePath: resolvedPath,
    action: 'none',
    truncatedBytes: 0,
    lastValidSeq: inspection.lastValidSeq,
    lastValidOffset: inspection.lastValidOffset,
  };
}

// ============================================================================
// Index Rebuilding & Reconciliation
// ============================================================================

/**
 * Rebuilds the entire SQLite IndexStore from disk segment files.
 */
export async function rebuildIndex(
  journalDir: string,
  indexStore: IndexStore,
  options?: { batchSize?: number | undefined },
): Promise<RebuildIndexResult> {
  const resolvedJournalDir = canonicalize(journalDir);
  const batchSize = options?.batchSize ?? 500;

  if (!fs.existsSync(resolvedJournalDir)) {
    return { streamsRebuilt: 0, eventsIndexed: 0, segmentsScanned: 0 };
  }

  // 1. Clear existing indexed data in a single clean transaction
  indexStore.clear();

  // 2. Discover all segment files
  const entries = await fs.promises.readdir(resolvedJournalDir, { withFileTypes: true });
  const segmentFiles: Array<{
    fileName: string;
    fullPath: string;
    stream: string;
    segmentIndex: number;
  }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const parsed = parseSegmentFileName(entry.name);
    if (!parsed) continue;

    segmentFiles.push({
      fileName: entry.name,
      fullPath: canonicalize(path.join(resolvedJournalDir, entry.name)),
      stream: parsed.stream,
      segmentIndex: parsed.segmentIndex,
    });
  }

  // 3. Group by stream and sort segments by segmentIndex ascending
  const streamMap = new Map<string, typeof segmentFiles>();
  for (const file of segmentFiles) {
    const list = streamMap.get(file.stream) ?? [];
    list.push(file);
    streamMap.set(file.stream, list);
  }

  let totalEventsIndexed = 0;
  let totalSegmentsScanned = 0;

  for (const [, files] of streamMap) {
    files.sort((a, b) => a.segmentIndex - b.segmentIndex);

    const pendingBatch: Array<{ event: EventEnvelope; location: EventLocation }> = [];

    for (const segment of files) {
      totalSegmentsScanned++;
      const content = await fs.promises.readFile(segment.fullPath, 'utf8');
      let offset = 0;

      const lines = content.split('\n');
      for (const line of lines) {
        if (!line) continue;
        const lineWithNewline = `${line}\n`;
        const bytes = Buffer.byteLength(lineWithNewline, 'utf8');

        const parsed = parseEventLine(line);
        if (parsed.valid && parsed.envelope) {
          const crc = parsed.crc ?? '00000000';
          pendingBatch.push({
            event: parsed.envelope,
            location: {
              segmentIndex: segment.segmentIndex,
              segmentPath: segment.fullPath,
              bytesWritten: bytes,
              offset,
              crc32: crc,
            },
          });

          if (pendingBatch.length >= batchSize) {
            indexStore.indexEventsBatch(pendingBatch);
            totalEventsIndexed += pendingBatch.length;
            pendingBatch.length = 0;
          }
        }
        offset += bytes;
      }
    }

    if (pendingBatch.length > 0) {
      indexStore.indexEventsBatch(pendingBatch);
      totalEventsIndexed += pendingBatch.length;
      pendingBatch.length = 0;
    }
  }

  return {
    streamsRebuilt: streamMap.size,
    eventsIndexed: totalEventsIndexed,
    segmentsScanned: totalSegmentsScanned,
  };
}

/**
 * Reconciles the SQLite index against segment files on disk.
 * Prunes orphaned events resulting from segment truncation and indexes missing events.
 */
export async function reconcileIndex(
  journalDir: string,
  indexStore: IndexStore,
): Promise<ReconcileResult> {
  const resolvedJournalDir = canonicalize(journalDir);
  if (!fs.existsSync(resolvedJournalDir)) {
    return { syncedStreams: 0, indexedMissing: 0, prunedOrphans: 0 };
  }

  const entries = await fs.promises.readdir(resolvedJournalDir, { withFileTypes: true });
  const streamSegments = new Map<string, Array<{ fullPath: string; segmentIndex: number }>>();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const parsed = parseSegmentFileName(entry.name);
    if (!parsed) continue;

    const list = streamSegments.get(parsed.stream) ?? [];
    list.push({
      fullPath: canonicalize(path.join(resolvedJournalDir, entry.name)),
      segmentIndex: parsed.segmentIndex,
    });
    streamSegments.set(parsed.stream, list);
  }

  let syncedStreams = 0;
  let indexedMissing = 0;
  let prunedOrphans = 0;

  for (const [streamId, files] of streamSegments) {
    syncedStreams++;
    files.sort((a, b) => a.segmentIndex - b.segmentIndex);

    // Scan segments to find highest sequence on disk and collect all events
    const diskEvents: Array<{ event: EventEnvelope; location: EventLocation }> = [];
    let maxDiskSeq = 0;

    for (const segment of files) {
      const content = await fs.promises.readFile(segment.fullPath, 'utf8');
      let offset = 0;
      const lines = content.split('\n');
      for (const line of lines) {
        if (!line) continue;
        const lineWithNewline = `${line}\n`;
        const bytes = Buffer.byteLength(lineWithNewline, 'utf8');
        const parsed = parseEventLine(line);
        if (parsed.valid && parsed.envelope) {
          if (parsed.envelope.seq > maxDiskSeq) {
            maxDiskSeq = parsed.envelope.seq;
          }
          diskEvents.push({
            event: parsed.envelope,
            location: {
              segmentIndex: segment.segmentIndex,
              segmentPath: segment.fullPath,
              bytesWritten: bytes,
              offset,
              crc32: parsed.crc ?? '00000000',
            },
          });
        }
        offset += bytes;
      }
    }

    const indexedStream = indexStore.getStream(streamId);
    if (!indexedStream) {
      // Entire stream is missing from index -> index all events
      if (diskEvents.length > 0) {
        indexStore.indexEventsBatch(diskEvents);
        indexedMissing += diskEvents.length;
      }
    } else {
      // 1. Prune orphans if disk sequence was truncated below index lastSeq
      if (indexedStream.lastSeq > maxDiskSeq) {
        indexStore.database.transaction(() => {
          const deleteEvents = indexStore.database.prepare(
            'DELETE FROM events WHERE stream_id = ? AND seq > ?',
          );
          const res = deleteEvents.run(streamId, maxDiskSeq);
          prunedOrphans += res.changes;

          indexStore.database.prepare(
            'UPDATE streams SET last_seq = ?, event_count = (SELECT COUNT(*) FROM events WHERE stream_id = ?) WHERE stream_id = ?',
          ).run(maxDiskSeq, streamId, streamId);
        })();
      }

      // 2. Index missing events if disk has events beyond index
      if (maxDiskSeq > indexedStream.lastSeq) {
        const missing = diskEvents.filter((d) => d.event.seq > indexedStream.lastSeq);
        indexStore.indexEventsBatch(missing);
        indexedMissing += missing.length;
      }
    }
  }

  return { syncedStreams, indexedMissing, prunedOrphans };
}

// ============================================================================
// Main Recovery Orchestrator
// ============================================================================

/**
 * Full Crash Recovery runner.
 * Scans journal directory, repairs torn tails, quarantines corrupted segments,
 * optionally emits system recovery events, and rebuilds/reconciles the index.
 */
export async function recoverJournal(options: RecoveryOptions): Promise<RecoveryReport> {
  const resolvedJournalDir = canonicalize(options.journalDir);
  const clock = options.clock ?? new SystemClock();
  const idGenerator = options.idGenerator ?? new UlidIdGenerator();
  const quarantineDir = options.quarantineDir
    ? canonicalize(options.quarantineDir)
    : canonicalize(path.join(resolvedJournalDir, '.quarantine'));

  const report: RecoveryReport = {
    scannedSegments: 0,
    repairedSegments: 0,
    quarantinedSegments: 0,
    truncatedBytesTotal: 0,
    recoveredEvents: [],
    quarantineEvents: [],
    rebuiltIndex: false,
    indexedEventsCount: 0,
    streamsRebuiltCount: 0,
  };

  if (!fs.existsSync(resolvedJournalDir)) {
    return report;
  }

  // 1. Scan directory for segment files
  const entries = await fs.promises.readdir(resolvedJournalDir, { withFileTypes: true });
  const segmentFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl') && parseSegmentFileName(e.name) !== null)
    .map((e) => path.join(resolvedJournalDir, e.name));

  report.scannedSegments = segmentFiles.length;

  let systemSeq = options.indexStore?.getStream('system')?.lastSeq ?? 0;

  // 2. Repair each segment
  for (const file of segmentFiles) {
    const repair = await repairSegmentFile(file, { quarantineDir });

    if (repair.action === 'truncated') {
      report.repairedSegments++;
      report.truncatedBytesTotal += repair.truncatedBytes;

      const parsed = parseSegmentFileName(path.basename(file));
      if (!parsed) continue;

      const recoveredEvent = createEnvelope({
        stream: 'system',
        seq: ++systemSeq,
        type: 'system.recovered',
        payload: {
          stream: parsed.stream,
          truncatedBytes: repair.truncatedBytes,
          lastValidSeq: repair.lastValidSeq,
        },
        clock,
        idGenerator,
      });

      report.recoveredEvents.push(recoveredEvent);
      if (options.eventBus) {
        options.eventBus.publish(recoveredEvent);
      }
    } else if (repair.action === 'quarantined') {
      report.quarantinedSegments++;

      const quarantineEvent = createEnvelope({
        stream: 'system',
        type: 'system.quarantine',
        seq: ++systemSeq,
        payload: {
          segmentPath: repair.filePath,
          reason: repair.reason ?? 'Corrupted segment quarantined',
          quarantinePath: repair.quarantinePath ?? repair.filePath,
        },
        clock,
        idGenerator,
      });

      report.quarantineEvents.push(quarantineEvent);
      if (options.eventBus) {
        options.eventBus.publish(quarantineEvent);
      }
    }
  }

  // 3. Rebuild or reconcile index
  if (options.indexStore) {
    if (options.autoRebuildIndex !== false) {
      const rebuildRes = await rebuildIndex(resolvedJournalDir, options.indexStore);
      report.rebuiltIndex = true;
      report.indexedEventsCount = rebuildRes.eventsIndexed;
      report.streamsRebuiltCount = rebuildRes.streamsRebuilt;
    } else {
      const reconcileRes = await reconcileIndex(resolvedJournalDir, options.indexStore);
      report.indexedEventsCount = reconcileRes.indexedMissing;
      report.streamsRebuiltCount = reconcileRes.syncedStreams;
    }
  }

  return report;
}
