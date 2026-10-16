/**
 * Journal Reader for the AIR runtime (Phase 2 - P2-T05).
 *
 * Supports:
 * - Direct point lookups by event ID or (stream, seq).
 * - Exact byte-offset extraction from segment files using recorded offset and byte length.
 * - CRC-32 checksum verification on every read.
 * - Fast stream range queries via SQLite index with segment file fallback.
 * - Async iterable stream reader for memory-efficient iteration over large streams.
 */

import fs from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { AirError } from '../errors/index.js';
import type { EventId } from '../types/index.js';
import { canonicalize } from '../util/index.js';
import type { EventEnvelope } from './envelope.js';
import type { IndexStore } from './index-store.js';
import type { UpcasterRegistry } from './upcasters.js';
import {
  parseEventLine,
  parseSegmentFileName,
  readSegmentEvents,
  sanitizeStream,
} from './segment-writer.js';

export interface JournalReaderOptions {
  journalDir?: string | undefined;
  indexStore?: IndexStore | undefined;
  upcasters?: UpcasterRegistry | undefined;
}

export interface StreamReadOptions {
  fromSeq?: number | undefined;
  toSeq?: number | undefined;
  limit?: number | undefined;
  order?: 'asc' | 'desc' | undefined;
}

export class JournalReader {
  private readonly journalDir?: string | undefined;
  private readonly indexStore?: IndexStore | undefined;
  private readonly upcasters?: UpcasterRegistry | undefined;

  constructor(options?: JournalReaderOptions) {
    if (options?.journalDir) {
      this.journalDir = canonicalize(options.journalDir);
    }
    this.indexStore = options?.indexStore;
    this.upcasters = options?.upcasters;
  }

  /**
   * Retrieves a single event envelope by its unique EventId.
   */
  public async getEvent(id: EventId): Promise<EventEnvelope | null> {
    if (this.indexStore) {
      const indexed = this.indexStore.getEvent(id);
      if (!indexed) return null;
      return this.readEventFromIndexed(indexed.segmentPath, indexed.offset, indexed.bytes, indexed.crc32);
    }

    if (!this.journalDir) {
      throw new AirError(
        'INVALID_STATE',
        'Cannot read event by ID without an IndexStore or journalDir configured',
      );
    }

    // Fallback: Scan segment files in journalDir
    const files = await this.listAllSegmentFiles();
    for (const file of files) {
      const fullPath = path.join(this.journalDir, file);
      const res = await readSegmentEvents(fullPath);
      const found = res.validEvents.find((e) => e.id === id);
      if (found) return this.upcasters ? this.upcasters.upcast(found) : found;
    }

    return null;
  }

  /**
   * Retrieves a single event envelope by stream identifier and sequence number.
   */
  public async getEventByStreamSeq(streamId: string, seq: number): Promise<EventEnvelope | null> {
    if (this.indexStore) {
      const indexed = this.indexStore.getEventByStreamSeq(streamId, seq);
      if (!indexed) return null;
      return this.readEventFromIndexed(indexed.segmentPath, indexed.offset, indexed.bytes, indexed.crc32);
    }

    if (!this.journalDir) {
      throw new AirError(
        'INVALID_STATE',
        'Cannot read event by stream+seq without an IndexStore or journalDir configured',
      );
    }

    const segments = await this.findSegmentsForStream(streamId);
    for (const segmentPath of segments) {
      const res = await readSegmentEvents(segmentPath);
      const found = res.validEvents.find((e) => e.seq === seq);
      if (found) return this.upcasters ? this.upcasters.upcast(found) : found;
    }

    return null;
  }

  /**
   * Reads a slice of events from a stream in sequence order.
   */
  public async readStream(
    streamId: string,
    options?: StreamReadOptions,
  ): Promise<EventEnvelope[]> {
    const events: EventEnvelope[] = [];
    for await (const event of this.readStreamIter(streamId, options)) {
      events.push(event);
    }
    return events;
  }

  /**
   * Async iterator yielding events from a stream matching options.
   */
  public async *readStreamIter(
    streamId: string,
    options?: StreamReadOptions,
  ): AsyncIterable<EventEnvelope> {
    const order = options?.order ?? 'asc';
    const fromSeq = options?.fromSeq ?? 1;
    const toSeq = options?.toSeq;
    const limit = options?.limit;

    if (this.indexStore) {
      const indexedList = this.indexStore.getEventsByStream(streamId, {
        fromSeq,
        toSeq,
        order,
        limit,
      });

      for (const indexed of indexedList) {
        const ev = await this.readEventFromIndexed(
          indexed.segmentPath,
          indexed.offset,
          indexed.bytes,
          indexed.crc32,
        );
        yield ev;
      }
      return;
    }

    // Direct segment scanning fallback
    if (!this.journalDir) {
      throw new AirError(
        'INVALID_STATE',
        'Cannot read stream without an IndexStore or journalDir configured',
      );
    }

    const segments = await this.findSegmentsForStream(streamId);
    let allEvents: EventEnvelope[] = [];

    for (const segPath of segments) {
      const res = await readSegmentEvents(segPath);
      if (res.corruptLines.length > 0) {
        const first = res.corruptLines[0];
        throw new AirError(
          'JOURNAL_CORRUPT',
          `Corrupt line detected in segment file "${segPath}" at line ${first?.lineNumber}: ${first?.error}`,
        );
      }
      allEvents.push(...res.validEvents);
    }

    // Filter by sequence range
    allEvents = allEvents.filter((e) => {
      if (e.seq < fromSeq) return false;
      if (toSeq !== undefined && e.seq > toSeq) return false;
      return true;
    });

    // Sort order
    if (order === 'desc') {
      allEvents.sort((a, b) => b.seq - a.seq);
    } else {
      allEvents.sort((a, b) => a.seq - b.seq);
    }

    // Apply limit if specified
    if (limit !== undefined && limit >= 0) {
      allEvents = allEvents.slice(0, limit);
    }

    for (const event of allEvents) {
      yield this.upcasters ? this.upcasters.upcast(event) : event;
    }
  }

  /**
   * Reads an exact byte slice from a segment file and parses verified EventEnvelope.
   */
  public async readEventAt(
    segmentPath: string,
    offset: number,
    bytes: number,
    expectedCrc?: string,
  ): Promise<EventEnvelope> {
    const resolvedPath = this.resolveSegmentPath(segmentPath);

    const fh = await open(resolvedPath, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await fh.read(buffer, 0, bytes, offset);
      if (bytesRead !== bytes) {
        throw new AirError(
          'JOURNAL_CORRUPT',
          `Short read at offset ${offset} in "${resolvedPath}": expected ${bytes} bytes, got ${bytesRead}`,
        );
      }

      const line = buffer.toString('utf8');
      const parsed = parseEventLine(line);
      if (!parsed.valid || !parsed.envelope) {
        throw new AirError(
          'JOURNAL_CORRUPT',
          `Corrupt event at offset ${offset} in "${resolvedPath}": ${parsed.error ?? 'unknown error'}`,
        );
      }

      if (expectedCrc && parsed.crc && parsed.crc.toLowerCase() !== expectedCrc.toLowerCase()) {
        throw new AirError(
          'JOURNAL_CORRUPT',
          `CRC32 mismatch for event at offset ${offset} in "${resolvedPath}": expected ${expectedCrc}, got ${parsed.crc}`,
        );
      }

      return this.upcasters ? this.upcasters.upcast(parsed.envelope) : parsed.envelope;
    } finally {
      await fh.close();
    }
  }

  private async readEventFromIndexed(
    segmentPath: string,
    offset: number,
    bytes: number,
    expectedCrc?: string,
  ): Promise<EventEnvelope> {
    return this.readEventAt(segmentPath, offset, bytes, expectedCrc);
  }

  private resolveSegmentPath(segmentPath: string): string {
    if (path.isAbsolute(segmentPath)) {
      return canonicalize(segmentPath);
    }
    if (this.journalDir) {
      return canonicalize(path.resolve(this.journalDir, segmentPath));
    }
    return canonicalize(segmentPath);
  }

  private async findSegmentsForStream(streamId: string): Promise<string[]> {
    if (!this.journalDir) return [];
    const files = await this.listAllSegmentFiles();
    const sanitizedTarget = sanitizeStream(streamId);

    const matched: Array<{ fullPath: string; index: number }> = [];

    for (const file of files) {
      const parsed = parseSegmentFileName(file);
      if (parsed && parsed.sanitizedStream === sanitizedTarget) {
        matched.push({
          fullPath: path.join(this.journalDir, file),
          index: parsed.segmentIndex,
        });
      }
    }

    matched.sort((a, b) => a.index - b.index);
    return matched.map((m) => m.fullPath);
  }

  private async listAllSegmentFiles(): Promise<string[]> {
    if (!this.journalDir || !fs.existsSync(this.journalDir)) return [];
    try {
      const entries = await fs.promises.readdir(this.journalDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => e.name);
    } catch (err) {
      throw new AirError('JOURNAL_READ_FAILED', `Failed to list journal directory: ${String(err)}`);
    }
  }
}
