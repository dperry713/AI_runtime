/**
 * IPC Framing — NDJSON line framing with size limits (Phase 9 - P9-T01).
 *
 * Implements:
 * - NDJSON framing: one JSON-RPC message per `\n`-terminated line
 * - Max frame size enforcement (4 MiB default)
 * - Incremental line buffering across arbitrary chunk boundaries
 * - Malformed frame detection and reporting
 *
 * Adheres to:
 * - Rule R7: No any; strict TypeScript
 * - Rule R11: Typed AirError errors
 */

import { AirError } from '../errors/index.js';
import { type OutboundMessage, serializeMessage } from './protocol.js';

// ============================================================================
// 1. Constants & Errors
// ============================================================================

/** Default maximum frame size in bytes (4 MiB). */
export const DEFAULT_MAX_FRAME_SIZE = 4 * 1024 * 1024;

/** Line terminator for NDJSON framing. */
export const FRAME_TERMINATOR = '\n';

/** Thrown when a frame exceeds the maximum allowed size. */
export class FrameTooLargeError extends AirError {
  constructor(maxSize: number, actualSize: number) {
    super('IPC_PROTOCOL_ERROR', `Frame size (${actualSize} bytes) exceeds maximum (${maxSize} bytes)`, {
      context: { maxSize, actualSize },
      exposeToModel: true,
    });
  }
}

/** Thrown when a frame contains invalid JSON or is otherwise malformed. */
export class MalformedFrameError extends AirError {
  constructor(reason: string, lineNumber?: number) {
    super('IPC_PROTOCOL_ERROR', `Malformed frame${lineNumber !== undefined ? ` at line ${lineNumber}` : ''}: ${reason}`, {
      context: { reason, ...(lineNumber !== undefined ? { lineNumber } : {}) },
      exposeToModel: true,
    });
  }
}

// ============================================================================
// 2. Frame Reader
// ============================================================================

export interface FrameReaderOptions {
  /** Maximum frame size in bytes. Defaults to 4 MiB. */
  readonly maxFrameSize?: number;
  /** Callback invoked for each complete, valid line. */
  readonly onLine: (line: string) => void;
}

/**
 * Incremental NDJSON frame reader. Accumulates raw chunks, splits on newlines,
 * enforces max frame size, and invokes callbacks for complete lines.
 *
 * Designed to be fed data from a Node.js stream (e.g. net.Socket) via `feed()`.
 */
export class FrameReader {
  private readonly maxFrameSize: number;
  private readonly onLine: (line: string) => void;

  private buffer = '';
  private lineNumber = 0;
  private currentFrameBytes = 0;

  constructor(options: FrameReaderOptions) {
    this.maxFrameSize = options.maxFrameSize ?? DEFAULT_MAX_FRAME_SIZE;
    this.onLine = options.onLine;
  }

  /**
   * Feed raw data (as received from a stream) into the reader. Complete lines
   * are extracted and passed to `onLine`. Oversized frames trigger
   * `FrameTooLargeError`.
   */
  feed(chunk: string | Buffer): void {
    const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.buffer += data;

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf(FRAME_TERMINATOR)) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.lineNumber += 1;
      this.currentFrameBytes += Buffer.byteLength(line, 'utf8');

      if (this.currentFrameBytes > this.maxFrameSize) {
        const err = new FrameTooLargeError(this.maxFrameSize, this.currentFrameBytes);
        this.currentFrameBytes = 0;
        throw err;
      }

      this.onLine(line);
      this.currentFrameBytes = 0;
    }
  }

  /** Returns any remaining buffered data that has not yet been terminated by a newline. */
  get remaining(): string {
    return this.buffer;
  }

  /** Returns the number of complete lines processed so far. */
  get linesProcessed(): number {
    return this.lineNumber;
  }

  /** Resets the reader state (buffer, counters). */
  reset(): void {
    this.buffer = '';
    this.lineNumber = 0;
    this.currentFrameBytes = 0;
  }
}

// ============================================================================
// 3. Frame Writer
// ============================================================================

export interface FrameWriterOptions {
  /** Callback invoked to write a serialized frame to the underlying stream. */
  readonly write: (data: string) => void;
}

/**
 * NDJSON frame writer. Serializes outbound messages and writes them as
 * newline-terminated lines to the underlying stream via the `write` callback.
 */
export class FrameWriter {
  private readonly write: (data: string) => void;

  constructor(options: FrameWriterOptions) {
    this.write = options.write;
  }

  /** Serialize and write an outbound message as a single NDJSON frame. */
  writeMessage(message: OutboundMessage): void {
    const line = serializeMessage(message);
    this.write(`${line}${FRAME_TERMINATOR}`);
  }

  /** Write a raw string as a single NDJSON frame (for testing / raw payloads). */
  writeRaw(data: string): void {
    this.write(`${data}${FRAME_TERMINATOR}`);
  }
}

// ============================================================================
// 4. Helper: Parse a line into a message
// ============================================================================

/** Parse a single NDJSON line into a JSON value, throwing on malformed input. */
export function parseFrameLine(line: string, lineNumber: number): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new MalformedFrameError('Empty line', lineNumber);
  }
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new MalformedFrameError(
      `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      lineNumber,
    );
  }
}
