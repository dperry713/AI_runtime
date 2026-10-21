/**
 * Unit tests for IPC Framing (P9-T01).
 *
 * Covers: NDJSON line framing, incremental chunk feeding, max frame size
 * enforcement, malformed frame detection, and frame writing.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_FRAME_SIZE,
  FRAME_TERMINATOR,
  FrameReader,
  FrameTooLargeError,
  FrameWriter,
  MalformedFrameError,
  parseFrameLine,
} from '../../../src/ipc/framing.js';
import { type OutboundMessage } from '../../../src/ipc/protocol.js';

// ============================================================================
// Constants
// ============================================================================

describe('framing constants', () => {
  it('exports default max frame size of 4 MiB', () => {
    expect(DEFAULT_MAX_FRAME_SIZE).toBe(4 * 1024 * 1024);
  });

  it('exports newline as frame terminator', () => {
    expect(FRAME_TERMINATOR).toBe('\n');
  });
});

// ============================================================================
// FrameReader
// ============================================================================

describe('FrameReader', () => {
  it('emits a complete line when a newline is received', () => {
    const lines: string[] = [];
    const reader = new FrameReader({
      onLine: (line) => lines.push(line),
    });

    reader.feed('{"jsonrpc":"2.0"}\n');
    expect(lines).toEqual(['{"jsonrpc":"2.0"}']);
  });

  it('handles data split across multiple feed calls', () => {
    const lines: string[] = [];
    const reader = new FrameReader({
      onLine: (line) => lines.push(line),
    });

    reader.feed('{"json');
    reader.feed('rpc":"2.0"}\n');
    expect(lines).toEqual(['{"jsonrpc":"2.0"}']);
  });

  it('handles multiple lines in a single feed call', () => {
    const lines: string[] = [];
    const reader = new FrameReader({
      onLine: (line) => lines.push(line),
    });

    reader.feed('line1\nline2\nline3\n');
    expect(lines).toEqual(['line1', 'line2', 'line3']);
  });

  it('keeps partial data in buffer until newline arrives', () => {
    const lines: string[] = [];
    const reader = new FrameReader({
      onLine: (line) => lines.push(line),
    });

    reader.feed('partial');
    expect(lines).toEqual([]);
    expect(reader.remaining).toBe('partial');

    reader.feed(' data\n');
    expect(lines).toEqual(['partial data']);
    expect(reader.remaining).toBe('');
  });

  it('tracks lines processed count', () => {
    const reader = new FrameReader({
      onLine: () => {},
    });

    reader.feed('a\nb\nc\n');
    expect(reader.linesProcessed).toBe(3);
  });

  it('resets state on reset()', () => {
    const lines: string[] = [];
    const reader = new FrameReader({
      onLine: (line) => lines.push(line),
    });

    reader.feed('a\n');
    expect(reader.linesProcessed).toBe(1);

    reader.reset();
    expect(reader.linesProcessed).toBe(0);
    expect(reader.remaining).toBe('');
  });

  it('throws FrameTooLargeError when frame exceeds max size', () => {
    const reader = new FrameReader({
      maxFrameSize: 10,
      onLine: () => {},
    });

    expect(() => reader.feed('this is way too long\n')).toThrow(FrameTooLargeError);
  });

  it('allows frames up to max size', () => {
    const lines: string[] = [];
    const reader = new FrameReader({
      maxFrameSize: 5,
      onLine: (line) => lines.push(line),
    });

    reader.feed('12345\n');
    expect(lines).toEqual(['12345']);
  });

  it('rejects frames just over max size', () => {
    const reader = new FrameReader({
      maxFrameSize: 5,
      onLine: () => {},
    });

    expect(() => reader.feed('123456\n')).toThrow(FrameTooLargeError);
  });
});

// ============================================================================
// FrameWriter
// ============================================================================

describe('FrameWriter', () => {
  it('writes a serialized message as a newline-terminated line', () => {
    const written: string[] = [];
    const writer = new FrameWriter({
      write: (data) => written.push(data),
    });

    const message = { jsonrpc: '2.0', result: { ok: true }, id: '1' } as OutboundMessage;
    writer.writeMessage(message);

    expect(written).toHaveLength(1);
    const first = written[0];
    expect(first).toBeDefined();
    if (first) {
      expect(JSON.parse(first.slice(0, -1))).toEqual(message);
      expect(first.endsWith('\n')).toBe(true);
    }
  });

  it('writes raw data as a newline-terminated line', () => {
    const written: string[] = [];
    const writer = new FrameWriter({
      write: (data) => written.push(data),
    });

    writer.writeRaw('raw data');
    expect(written).toEqual(['raw data\n']);
  });
});

// ============================================================================
// parseFrameLine
// ============================================================================

describe('parseFrameLine', () => {
  it('parses a valid JSON line', () => {
    const result = parseFrameLine('{"key":"value"}', 1);
    expect(result).toEqual({ key: 'value' });
  });

  it('trims whitespace before parsing', () => {
    const result = parseFrameLine('  {"key":"value"}  ', 1);
    expect(result).toEqual({ key: 'value' });
  });

  it('throws MalformedFrameError on empty line', () => {
    expect(() => parseFrameLine('', 1)).toThrow(MalformedFrameError);
  });

  it('throws MalformedFrameError on whitespace-only line', () => {
    expect(() => parseFrameLine('   ', 1)).toThrow(MalformedFrameError);
  });

  it('throws MalformedFrameError on invalid JSON', () => {
    expect(() => parseFrameLine('not json', 1)).toThrow(MalformedFrameError);
  });

  it('includes line number in error', () => {
    try {
      parseFrameLine('not json', 42);
    } catch (err) {
      expect((err as Error).message).toContain('line 42');
    }
  });
});

// ============================================================================
// Errors
// ============================================================================

describe('framing errors', () => {
  it('FrameTooLargeError is an AirError with context', () => {
    const err = new FrameTooLargeError(100, 200);
    expect(err.name).toBe('AirError');
    expect(err.context.maxSize).toBe(100);
    expect(err.context.actualSize).toBe(200);
    expect(err.exposeToModel).toBe(true);
  });

  it('MalformedFrameError includes reason and optional line number', () => {
    const err1 = new MalformedFrameError('bad json', 5);
    expect(err1.context.reason).toBe('bad json');
    expect(err1.context.lineNumber).toBe(5);

    const err2 = new MalformedFrameError('bad json');
    expect(err2.context.lineNumber).toBeUndefined();
  });
});
