/**
 * JSONL Segment Writer for the AIR Journal (P2-T02).
 *
 * Implements:
 * - Line framing: `<crc32> <json>\n` with 8-character hex CRC-32 computed over the JSON payload.
 * - Single serialized queue per stream (gapless monotonic ordering without race conditions).
 * - Configurable fsync policies: 'always' | 'batch' | 'never'.
 * - Segment rotation based on byte size limit (`segmentMaxBytes` / `segmentMaxMb`).
 * - Atomic segment sealing via `.active.jsonl` -> `.sealed.jsonl` rename.
 * - Discovery and resumption of existing segments across restarts.
 * - Injected Clock for determinism (Rule R6).
 */

import fs from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import type { FsyncPolicy } from '../config/index.js';
import { AirError } from '../errors/index.js';
import { journalEventsCounter } from '../observability/index.js';
import { canonicalize, type Clock, SystemClock } from '../util/index.js';
import type { EventEnvelope } from './envelope.js';

// ============================================================================
// Formatting & Checksum Utilities
// ============================================================================

/**
 * Computes an 8-character lowercase hexadecimal CRC-32 checksum over string or Buffer content.
 */
export function computeCrc32Hex(content: string | Buffer): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return crc32(buf).toString(16).padStart(8, '0').toLowerCase();
}

/**
 * Formats an event envelope as a framed segment line: `<crc32> <json>\n`.
 */
export function formatEventLine(event: unknown): string {
  const jsonStr = JSON.stringify(event);
  const crcHex = computeCrc32Hex(jsonStr);
  return `${crcHex} ${jsonStr}\n`;
}

export interface VerifyLineResult {
  valid: boolean;
  error?: string | undefined;
  expectedCrc?: string | undefined;
  actualCrc?: string | undefined;
  rawJson?: string | undefined;
}

/**
 * Verifies framing and CRC-32 checksum of a single line from a segment file.
 */
export function verifyLineChecksum(line: string): VerifyLineResult {
  const trimmed = line.replace(/[\r\n]+$/, '');
  if (trimmed.length < 9) {
    return { valid: false, error: 'Line is too short to contain CRC32 header and payload' };
  }
  if (trimmed[8] !== ' ') {
    return { valid: false, error: 'Malformed line framing: missing delimiter after 8-char CRC' };
  }
  const expectedCrc = trimmed.slice(0, 8).toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(expectedCrc)) {
    return { valid: false, error: 'Invalid CRC32 hex characters in header', expectedCrc };
  }
  const rawJson = trimmed.slice(9);
  const actualCrc = computeCrc32Hex(rawJson);
  if (expectedCrc !== actualCrc) {
    return {
      valid: false,
      error: `CRC32 checksum mismatch: expected ${expectedCrc}, computed ${actualCrc}`,
      expectedCrc,
      actualCrc,
      rawJson,
    };
  }
  return {
    valid: true,
    expectedCrc,
    actualCrc,
    rawJson,
  };
}

export interface ParseLineResult<T = unknown> {
  valid: boolean;
  error?: string | undefined;
  envelope?: EventEnvelope<T> | undefined;
  rawJson?: string | undefined;
  crc?: string | undefined;
}

/**
 * Validates framing, checks CRC-32, and parses JSON into an EventEnvelope.
 */
export function parseEventLine<T = unknown>(line: string): ParseLineResult<T> {
  const verified = verifyLineChecksum(line);
  if (!verified.valid || !verified.rawJson) {
    return { valid: false, error: verified.error, crc: verified.expectedCrc };
  }
  try {
    const envelope = JSON.parse(verified.rawJson) as EventEnvelope<T>;
    return {
      valid: true,
      envelope,
      rawJson: verified.rawJson,
      crc: verified.actualCrc,
    };
  } catch (err) {
    return {
      valid: false,
      error: `JSON parse error: ${String(err)}`,
      rawJson: verified.rawJson,
      crc: verified.actualCrc,
    };
  }
}

// ============================================================================
// Stream Sanitization & Segment File Naming
// ============================================================================

/**
 * Sanitizes a stream ID for safe use in Windows filenames (Rule R5).
 * Replaces any character outside `[a-zA-Z0-9-]` with `_${hex}`.
 */
export function sanitizeStream(stream: string): string {
  if (!stream || stream.trim().length === 0) {
    throw new AirError('INVALID_ARGUMENT', 'Stream identifier cannot be empty');
  }
  return stream.replace(/[^a-zA-Z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(2, '0').toLowerCase()}`);
}

/**
 * Reverses `sanitizeStream`, restoring the original stream identifier.
 */
export function desanitizeStream(sanitized: string): string {
  return sanitized.replace(/_([0-9a-fA-F]{2})/g, (_match: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export interface ParsedSegmentFileName {
  stream: string;
  sanitizedStream: string;
  segmentIndex: number;
  status: 'active' | 'sealed';
  fileName: string;
}

const SEGMENT_FILE_REGEX = /^([a-zA-Z0-9_-]+)\.(\d{8})\.(active|sealed)\.jsonl$/;

/**
 * Parses a segment filename into its components.
 */
export function parseSegmentFileName(fileName: string): ParsedSegmentFileName | null {
  const match = SEGMENT_FILE_REGEX.exec(fileName);
  if (!match || !match[1] || !match[2] || !match[3]) {
    return null;
  }
  const sanitizedStream = match[1];
  const stream = desanitizeStream(sanitizedStream);
  const segmentIndex = parseInt(match[2], 10);
  const status = match[3] as 'active' | 'sealed';
  return {
    stream,
    sanitizedStream,
    segmentIndex,
    status,
    fileName,
  };
}

/**
 * Formats a canonical segment filename.
 */
export function formatSegmentFileName(stream: string, segmentIndex: number, status: 'active' | 'sealed'): string {
  const sanitized = sanitizeStream(stream);
  const indexStr = String(segmentIndex).padStart(8, '0');
  return `${sanitized}.${indexStr}.${status}.jsonl`;
}

// ============================================================================
// Segment Reader Utilities
// ============================================================================

export interface ReadSegmentEventsResult {
  validEvents: EventEnvelope[];
  corruptLines: Array<{
    lineNumber: number;
    rawLine: string;
    error: string;
  }>;
  totalLines: number;
}

/**
 * Reads all events from a segment file, validating checksums line by line.
 */
export async function readSegmentEvents(filePath: string): Promise<ReadSegmentEventsResult> {
  const content = await fs.promises.readFile(filePath, 'utf8');
  const lines = content.split('\n');
  const validEvents: EventEnvelope[] = [];
  const corruptLines: Array<{ lineNumber: number; rawLine: string; error: string }> = [];

  let lineNumber = 0;
  for (const raw of lines) {
    lineNumber++;
    // Ignore trailing empty line produced by final \n
    if (lineNumber === lines.length && raw.trim() === '') {
      continue;
    }
    if (raw.trim() === '') {
      corruptLines.push({ lineNumber, rawLine: raw, error: 'Unexpected empty line in segment' });
      continue;
    }
    const parsed = parseEventLine(raw);
    if (!parsed.valid || !parsed.envelope) {
      corruptLines.push({ lineNumber, rawLine: raw, error: parsed.error ?? 'Unknown validation error' });
    } else {
      validEvents.push(parsed.envelope);
    }
  }

  const effectiveTotalLines = lines.length > 0 && lines[lines.length - 1]?.trim() === ''
    ? lines.length - 1
    : lines.length;

  return {
    validEvents,
    corruptLines,
    totalLines: effectiveTotalLines,
  };
}

// ============================================================================
// Segment Writer
// ============================================================================

export interface SegmentAppendResult {
  stream: string;
  seq: number;
  segmentIndex: number;
  segmentPath: string;
  bytesWritten: number;
  offset: number;
  crc32: string;
}

export interface StreamInfo {
  stream: string;
  lastSeq: number;
  activeSegmentIndex: number;
  activeSegmentPath?: string | undefined;
  activeSegmentBytes: number;
  sealedSegments: string[];
  totalSegments: number;
}

export interface SegmentWriterOptions {
  /** Directory where segment files are stored */
  journalDir: string;
  /** Optional stream binding (if bound, writer only accepts events for this stream) */
  defaultStream?: string | undefined;
  /** Maximum segment size in bytes. Defaults to 64MB (67,108,864 bytes) */
  segmentMaxBytes?: number | undefined;
  /** Fsync policy: 'always' | 'batch' | 'never'. Defaults to 'batch' */
  fsync?: FsyncPolicy | undefined;
  /** Batch sync interval in milliseconds. Defaults to 50ms */
  batchSyncIntervalMs?: number | undefined;
  /** Maximum unsynced writes before triggering batch sync. Defaults to 100 */
  batchMaxUnsynced?: number | undefined;
  /** Injected clock for determinism (Rule R6) */
  clock?: Clock | undefined;
}

interface StreamState {
  stream: string;
  sanitized: string;
  queue: Promise<unknown>;
  initialized: boolean;
  activeSegmentIndex: number;
  activeSegmentPath?: string | undefined;
  activeHandle?: FileHandle | undefined;
  currentBytes: number;
  lastSeq: number;
  unsyncedWrites: number;
  sealedSegments: string[];
}

async function ignoreError(action: Promise<unknown>): Promise<void> {
  try {
    await action;
  } catch {
    // Suppress ignored errors (e.g. handle cleanup on close)
  }
}

export class SegmentWriter {
  readonly journalDir: string;
  readonly defaultStream?: string | undefined;
  readonly segmentMaxBytes: number;
  readonly fsync: FsyncPolicy;
  readonly batchSyncIntervalMs: number;
  readonly batchMaxUnsynced: number;
  readonly clock: Clock;

  private streams = new Map<string, StreamState>();
  private closed = false;
  private batchTimer: NodeJS.Timeout | undefined;

  constructor(options: SegmentWriterOptions) {
    if (!options.journalDir || options.journalDir.trim().length === 0) {
      throw new AirError('INVALID_ARGUMENT', 'journalDir cannot be empty');
    }
    this.journalDir = canonicalize(options.journalDir);
    this.defaultStream = options.defaultStream;
    this.segmentMaxBytes = options.segmentMaxBytes ?? 64 * 1024 * 1024; // 64 MB
    this.fsync = options.fsync ?? 'batch';
    this.batchSyncIntervalMs = options.batchSyncIntervalMs ?? 50;
    this.batchMaxUnsynced = options.batchMaxUnsynced ?? 100;
    this.clock = options.clock ?? new SystemClock();
  }

  /**
   * Appends an event to its stream segment file.
   * Operations for the same stream are strictly serialized through a single FIFO queue.
   */
  async append<T>(event: EventEnvelope<T>): Promise<SegmentAppendResult> {
    if (this.closed) {
      throw new AirError('INVALID_STATE', 'SegmentWriter is closed');
    }
    if (this.defaultStream && event.stream !== this.defaultStream) {
      throw new AirError(
        'INVALID_ARGUMENT',
        `Event stream "${event.stream}" does not match writer default stream "${this.defaultStream}"`,
      );
    }

    const state = this.getOrCreateStreamState(event.stream);

    const op = async (): Promise<SegmentAppendResult> => {
      if (this.closed) {
        throw new AirError('INVALID_STATE', 'SegmentWriter is closed');
      }
      await this.ensureInitialized(state);
      return this.executeAppend(state, event);
    };

    const resPromise = state.queue.then(op, op);
    state.queue = ignoreError(resPromise);
    return resPromise;
  }

  /**
   * Appends multiple events in sequence.
   */
  async appendBatch<T>(events: EventEnvelope<T>[]): Promise<SegmentAppendResult[]> {
    const results: SegmentAppendResult[] = [];
    for (const event of events) {
      results.push(await this.append(event));
    }
    return results;
  }

  /**
   * Flushes and fsyncs pending writes across all open streams.
   */
  async flush(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
    const promises: Promise<void>[] = [];
    for (const state of this.streams.values()) {
      promises.push(this.flushStreamInternal(state));
    }
    await Promise.all(promises);
  }

  /**
   * Flushes and fsyncs a specific stream.
   */
  async flushStream(stream: string): Promise<void> {
    const state = this.streams.get(stream);
    if (!state) return;
    await this.flushStreamInternal(state);
  }

  /**
   * Atomically seals the active segment for a specific stream.
   * Flushes data, closes the handle, and renames the active file to `.sealed.jsonl`.
   * Returns the path of the sealed file, or undefined if no events were in the active segment.
   */
  async sealStream(stream: string): Promise<string | undefined> {
    const state = this.getOrCreateStreamState(stream);

    const sealOp = async (): Promise<string | undefined> => {
      await this.ensureInitialized(state);

      if (state.activeHandle) {
        await ignoreError(state.activeHandle.datasync());
        await ignoreError(state.activeHandle.close());
        state.activeHandle = undefined;
      }

      if (!state.activeSegmentPath || !fs.existsSync(state.activeSegmentPath)) {
        return undefined;
      }

      if (state.currentBytes === 0) {
        // Delete empty active segment
        await ignoreError(fs.promises.unlink(state.activeSegmentPath));
        state.activeSegmentPath = undefined;
        return undefined;
      }

      const sealedPath = path.join(
        this.journalDir,
        formatSegmentFileName(state.stream, state.activeSegmentIndex, 'sealed'),
      );

      await fs.promises.rename(state.activeSegmentPath, sealedPath);
      state.sealedSegments.push(sealedPath);
      state.activeSegmentPath = undefined;
      state.activeSegmentIndex++;
      state.currentBytes = 0;
      state.unsyncedWrites = 0;

      return sealedPath;
    };

    const resPromise = state.queue.then(sealOp, sealOp);
    state.queue = ignoreError(resPromise);
    return resPromise;
  }

  /**
   * Atomically seals all active segments across all streams.
   */
  async sealAll(): Promise<string[]> {
    const streams = Array.from(this.streams.keys());
    const results: string[] = [];
    for (const stream of streams) {
      const sealed = await this.sealStream(stream);
      if (sealed) {
        results.push(sealed);
      }
    }
    return results;
  }

  /**
   * Returns metadata and status for a stream.
   */
  async getStreamInfo(stream: string): Promise<StreamInfo> {
    const state = this.getOrCreateStreamState(stream);

    const infoOp = async (): Promise<StreamInfo> => {
      await this.ensureInitialized(state);
      return {
        stream: state.stream,
        lastSeq: state.lastSeq,
        activeSegmentIndex: state.activeSegmentIndex,
        activeSegmentPath: state.activeSegmentPath,
        activeSegmentBytes: state.currentBytes,
        sealedSegments: [...state.sealedSegments],
        totalSegments: state.sealedSegments.length + (state.activeSegmentPath ? 1 : 0),
      };
    };

    const resPromise = state.queue.then(infoOp, infoOp);
    state.queue = ignoreError(resPromise);
    return resPromise;
  }

  /**
   * Closes all stream handles and drains all queues.
   */
  async close(options?: { seal?: boolean | undefined }): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }

    for (const state of this.streams.values()) {
      await ignoreError(state.queue);

      if (state.activeHandle) {
        await ignoreError(state.activeHandle.datasync());
        await ignoreError(state.activeHandle.close());
        state.activeHandle = undefined;
      }

      if (
        options?.seal &&
        state.activeSegmentPath &&
        fs.existsSync(state.activeSegmentPath) &&
        state.currentBytes > 0
      ) {
        const sealedPath = path.join(
          this.journalDir,
          formatSegmentFileName(state.stream, state.activeSegmentIndex, 'sealed'),
        );
        await ignoreError(fs.promises.rename(state.activeSegmentPath, sealedPath));
        state.sealedSegments.push(sealedPath);
        state.activeSegmentPath = undefined;
      }
    }
  }

  /**
   * Returns a single-stream proxy bound to a specific stream ID.
   */
  forStream(stream: string): StreamSegmentWriter {
    return new StreamSegmentWriter(this, stream);
  }

  // ==========================================================================
  // Internal Stream Operations
  // ==========================================================================

  private getOrCreateStreamState(stream: string): StreamState {
    let state = this.streams.get(stream);
    if (!state) {
      state = {
        stream,
        sanitized: sanitizeStream(stream),
        queue: Promise.resolve(),
        initialized: false,
        activeSegmentIndex: 0,
        currentBytes: 0,
        lastSeq: 0,
        unsyncedWrites: 0,
        sealedSegments: [],
      };
      this.streams.set(stream, state);
    }
    return state;
  }

  private async ensureInitialized(state: StreamState): Promise<void> {
    if (state.initialized) return;

    await fs.promises.mkdir(this.journalDir, { recursive: true });

    const entries = await fs.promises.readdir(this.journalDir);
    const streamSegments: Array<{ index: number; status: 'active' | 'sealed'; name: string; fullPath: string }> = [];

    for (const entry of entries) {
      const parsed = parseSegmentFileName(entry);
      if (parsed && parsed.sanitizedStream === state.sanitized) {
        streamSegments.push({
          index: parsed.segmentIndex,
          status: parsed.status,
          name: entry,
          fullPath: path.join(this.journalDir, entry),
        });
      }
    }

    streamSegments.sort((a, b) => a.index - b.index);

    state.sealedSegments = [];
    let activeSeg: (typeof streamSegments)[0] | undefined;

    for (const seg of streamSegments) {
      if (seg.status === 'sealed') {
        state.sealedSegments.push(seg.fullPath);
      } else if (seg.status === 'active') {
        activeSeg = seg;
      }
    }

    if (activeSeg) {
      state.activeSegmentIndex = activeSeg.index;
      state.activeSegmentPath = activeSeg.fullPath;
      const readResult = await readSegmentEvents(activeSeg.fullPath);
      if (readResult.validEvents.length > 0) {
        const lastEv = readResult.validEvents[readResult.validEvents.length - 1];
        if (lastEv) {
          state.lastSeq = lastEv.seq;
        }
      } else if (state.sealedSegments.length > 0) {
        // Read last event from last sealed segment
        const lastSealed = state.sealedSegments[state.sealedSegments.length - 1];
        if (lastSealed) {
          const sealedEvents = await readSegmentEvents(lastSealed);
          const lastEv = sealedEvents.validEvents[sealedEvents.validEvents.length - 1];
          if (lastEv) {
            state.lastSeq = lastEv.seq;
          }
        }
      }
      const stat = await fs.promises.stat(activeSeg.fullPath);
      state.currentBytes = stat.size;
      state.activeHandle = await open(activeSeg.fullPath, 'a');
    } else if (state.sealedSegments.length > 0) {
      const lastSealed = state.sealedSegments[state.sealedSegments.length - 1];
      let lastIndex = 0;
      if (lastSealed) {
        const parsed = parseSegmentFileName(path.basename(lastSealed));
        if (parsed) {
          lastIndex = parsed.segmentIndex;
        }
        const sealedEvents = await readSegmentEvents(lastSealed);
        const lastEv = sealedEvents.validEvents[sealedEvents.validEvents.length - 1];
        if (lastEv) {
          state.lastSeq = lastEv.seq;
        }
      }
      state.activeSegmentIndex = lastIndex + 1;
      state.currentBytes = 0;
      const newPath = path.join(
        this.journalDir,
        formatSegmentFileName(state.stream, state.activeSegmentIndex, 'active'),
      );
      state.activeSegmentPath = newPath;
      state.activeHandle = await open(newPath, 'a');
    } else {
      state.activeSegmentIndex = 0;
      state.lastSeq = 0;
      state.currentBytes = 0;
      const newPath = path.join(
        this.journalDir,
        formatSegmentFileName(state.stream, 0, 'active'),
      );
      state.activeSegmentPath = newPath;
      state.activeHandle = await open(newPath, 'a');
    }

    state.initialized = true;
  }

  private async executeAppend<T>(state: StreamState, event: EventEnvelope<T>): Promise<SegmentAppendResult> {
    // Monotonic sequence validation
    if (state.lastSeq === 0) {
      if (event.seq <= 0) {
        throw new AirError(
          'INVALID_ARGUMENT',
          `Event sequence number must be a positive integer, got ${event.seq}`,
        );
      }
      state.lastSeq = event.seq;
    } else {
      const expectedSeq = state.lastSeq + 1;
      if (event.seq !== expectedSeq) {
        throw new AirError(
          'INVALID_ARGUMENT',
          `Non-monotonic sequence number for stream "${state.stream}": expected ${expectedSeq}, got ${event.seq}`,
        );
      }
      state.lastSeq = event.seq;
    }

    const line = formatEventLine(event);
    const lineBuffer = Buffer.from(line, 'utf8');
    const lineBytes = lineBuffer.byteLength;

    // Check if segment rotation is needed
    if (state.currentBytes > 0 && state.currentBytes + lineBytes > this.segmentMaxBytes) {
      await this.rotateSegment(state);
    }

    if (!state.activeHandle) {
      if (!state.activeSegmentPath) {
        state.activeSegmentPath = path.join(
          this.journalDir,
          formatSegmentFileName(state.stream, state.activeSegmentIndex, 'active'),
        );
      }
      state.activeHandle = await open(state.activeSegmentPath, 'a');
    }

    const offset = state.currentBytes;
    try {
      await state.activeHandle.write(lineBuffer);
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw new AirError(
        'JOURNAL_WRITE_FAILED',
        `Failed to write event to journal stream "${state.stream}": ${String(err)}`,
        { cause },
      );
    }
    state.currentBytes += lineBytes;

    // Fsync policy enforcement
    if (this.fsync === 'always') {
      try {
        await state.activeHandle.datasync();
      } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        throw new AirError(
          'JOURNAL_WRITE_FAILED',
          `Failed to sync journal stream "${state.stream}": ${String(err)}`,
          { cause },
        );
      }
      state.unsyncedWrites = 0;
    } else if (this.fsync === 'batch') {
      state.unsyncedWrites++;
      if (state.unsyncedWrites >= this.batchMaxUnsynced) {
        await state.activeHandle.datasync();
        state.unsyncedWrites = 0;
      } else {
        this.scheduleBatchSync();
      }
    }

    journalEventsCounter.inc(1, { stream: state.stream, type: event.type });

    const segmentPath = state.activeSegmentPath ?? path.join(
      this.journalDir,
      formatSegmentFileName(state.stream, state.activeSegmentIndex, 'active'),
    );

    return {
      stream: state.stream,
      seq: event.seq,
      segmentIndex: state.activeSegmentIndex,
      segmentPath,
      bytesWritten: lineBytes,
      offset,
      crc32: line.slice(0, 8),
    };
  }

  private async rotateSegment(state: StreamState): Promise<void> {
    if (state.activeHandle) {
      await ignoreError(state.activeHandle.datasync());
      await ignoreError(state.activeHandle.close());
      state.activeHandle = undefined;
    }

    if (state.activeSegmentPath && fs.existsSync(state.activeSegmentPath)) {
      const sealedPath = path.join(
        this.journalDir,
        formatSegmentFileName(state.stream, state.activeSegmentIndex, 'sealed'),
      );
      await fs.promises.rename(state.activeSegmentPath, sealedPath);
      state.sealedSegments.push(sealedPath);
    }

    state.activeSegmentIndex++;
    state.currentBytes = 0;
    state.unsyncedWrites = 0;

    const newPath = path.join(
      this.journalDir,
      formatSegmentFileName(state.stream, state.activeSegmentIndex, 'active'),
    );
    state.activeSegmentPath = newPath;
    state.activeHandle = await open(newPath, 'a');
  }

  private scheduleBatchSync(): void {
    if (this.batchTimer || this.closed) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      void this.flush();
    }, this.batchSyncIntervalMs);
    this.batchTimer.unref();
  }

  private async flushStreamInternal(state: StreamState): Promise<void> {
    const flushOp = async (): Promise<void> => {
      if (state.activeHandle && state.unsyncedWrites > 0) {
        await state.activeHandle.datasync();
        state.unsyncedWrites = 0;
      }
    };
    const resPromise = state.queue.then(flushOp, flushOp);
    state.queue = ignoreError(resPromise);
    return resPromise;
  }
}

/**
 * Proxy for writing events to a single pre-bound stream.
 */
export class StreamSegmentWriter {
  constructor(
    private readonly parent: SegmentWriter,
    readonly stream: string,
  ) {}

  async append<T>(event: EventEnvelope<T>): Promise<SegmentAppendResult> {
    if (event.stream !== this.stream) {
      throw new AirError(
        'INVALID_ARGUMENT',
        `Event stream "${event.stream}" does not match bound stream "${this.stream}"`,
      );
    }
    return this.parent.append(event);
  }

  async appendBatch<T>(events: EventEnvelope<T>[]): Promise<SegmentAppendResult[]> {
    for (const ev of events) {
      if (ev.stream !== this.stream) {
        throw new AirError(
          'INVALID_ARGUMENT',
          `Event stream "${ev.stream}" does not match bound stream "${this.stream}"`,
        );
      }
    }
    return this.parent.appendBatch(events);
  }

  flush(): Promise<void> {
    return this.parent.flushStream(this.stream);
  }

  seal(): Promise<string | undefined> {
    return this.parent.sealStream(this.stream);
  }

  getInfo(): Promise<StreamInfo> {
    return this.parent.getStreamInfo(this.stream);
  }
}
