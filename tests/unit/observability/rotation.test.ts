/**
 * Unit tests for RotatingFileStream and enforceTotalLogBudget (src/observability/rotation.ts).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RotatingFileStream,
  enforceTotalLogBudget,
} from '../../../src/observability/rotation.js';

describe('RotatingFileStream', () => {
  let tempDir: string;
  let logFile: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'air-rot-test-'));
    logFile = path.join(tempDir, 'test.log');
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('creates log file and writes lines using writeLine', () => {
    const stream = new RotatingFileStream({
      filePath: logFile,
      maxSizeBytes: 1000,
      keep: 2,
    });

    stream.writeLine('hello world\n');
    stream.flushSync();

    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toBe('hello world\n');
  });

  it('writes via standard Writable stream write and final callback', async () => {
    const stream = new RotatingFileStream({
      filePath: logFile,
      maxSizeBytes: 1000,
      keep: 2,
    });

    await new Promise<void>((resolve, reject) => {
      stream.write(Buffer.from('chunk1\n'), 'utf-8', (err) => {
        if (err) return reject(err);
        stream.write('chunk2\n', 'utf-8', (err2) => {
          if (err2) return reject(err2);
          stream.end(() => resolve());
        });
      });
    });

    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toBe('chunk1\nchunk2\n');
  });

  it('handles stream.end() when currentFd is null in _final', async () => {
    const stream = new RotatingFileStream({
      filePath: logFile,
      maxSizeBytes: 1000,
      keep: 2,
    });
    (stream as unknown as { currentFd: number | null }).currentFd = null;
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  });

  it('handles fs.closeSync error in _final callback when fd is invalid', async () => {
    const stream = new RotatingFileStream({
      filePath: logFile,
      maxSizeBytes: 1000,
      keep: 2,
    });
    const errorHandler = vi.fn();
    stream.on('error', errorHandler);
    (stream as unknown as { currentFd: number | null }).currentFd = 999999;
    await new Promise<void>((resolve) => {
      stream.end((err?: Error | null) => {
        expect(err).toBeDefined();
        resolve();
      });
    });
    expect(errorHandler).toHaveBeenCalled();
  });

  it('rotates file when maxSizeBytes is exceeded', () => {
    const stream = new RotatingFileStream({
      filePath: logFile,
      maxSizeBytes: 30, // 30 bytes
      keep: 2,
    });

    stream.writeLine('12345678901234567890\n'); // 21 bytes
    stream.writeLine('12345678901234567890\n'); // exceeds 30 bytes -> rotates to .1
    stream.writeLine('12345678901234567890\n'); // exceeds 30 bytes -> rotates to .2
    stream.writeLine('12345678901234567890\n'); // exceeds 30 bytes -> unlinks oldest .2, rotates .1 -> .2

    stream.flushSync();

    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'test.1.log'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'test.2.log'))).toBe(true);
  });

  it('re-opens file if currentFd is null when writeLine is called', () => {
    const stream = new RotatingFileStream({
      filePath: logFile,
      maxSizeBytes: 1000,
      keep: 2,
    });
    (stream as unknown as { currentFd: number | null }).currentFd = null;
    stream.writeLine('re-opened line\n');
    stream.flushSync();
    expect(fs.readFileSync(logFile, 'utf8')).toContain('re-opened line\n');
  });

  it('propagates error in _write callback when writeLine fails', async () => {
    const stream = new RotatingFileStream({
      filePath: logFile,
      maxSizeBytes: 1000,
      keep: 2,
    });
    const errorHandler = vi.fn();
    stream.on('error', errorHandler);
    vi.spyOn(stream, 'writeLine').mockImplementation(() => {
      throw new Error('simulated disk error');
    });

    await new Promise<void>((resolve) => {
      stream.write('failing line', 'utf-8', (err) => {
        expect(err?.message).toBe('simulated disk error');
        resolve();
      });
    });
    expect(errorHandler).toHaveBeenCalled();
  });

  it('closes existing fd on openCurrentFile and handles openSync errors', () => {
    const stream = new RotatingFileStream({
      filePath: logFile,
      maxSizeBytes: 1000,
      keep: 2,
    });
    // Call openCurrentFile while fd is open
    expect((stream as unknown as { currentFd: number | null }).currentFd).not.toBeNull();
    (stream as unknown as { openCurrentFile: () => void }).openCurrentFile();
    expect((stream as unknown as { currentFd: number | null }).currentFd).not.toBeNull();

    // Test openCurrentFile error handling when target path cannot be opened (openSync fails)
    const failingStream = new RotatingFileStream({
      filePath: path.join(tempDir, 'invalid:stream:name.log'),
      maxSizeBytes: 1000,
      keep: 2,
    });
    expect((failingStream as unknown as { currentFd: number | null }).currentFd).toBeNull();
  });
});

describe('enforceTotalLogBudget', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'air-budget-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('returns early when logsDir does not exist', () => {
    expect(() => enforceTotalLogBudget(path.join(tempDir, 'nonexistent'), 100)).not.toThrow();
  });

  it('returns early when total bytes is within maxTotalBytes', () => {
    const file = path.join(tempDir, 'test.log');
    fs.writeFileSync(file, 'short');
    enforceTotalLogBudget(tempDir, 1000);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('removes oldest non-audit log files when budget exceeded and preserves audit logs', () => {
    const oldLog = path.join(tempDir, 'runtime.2.log');
    const midLog = path.join(tempDir, 'runtime.1.log');
    const auditLog = path.join(tempDir, 'audit.log');

    fs.writeFileSync(oldLog, 'x'.repeat(500));
    fs.writeFileSync(midLog, 'y'.repeat(500));
    fs.writeFileSync(auditLog, 'z'.repeat(500));

    // Ensure mtimes differ
    const now = Date.now();
    fs.utimesSync(oldLog, (now - 2000) / 1000, (now - 2000) / 1000);
    fs.utimesSync(midLog, (now - 1000) / 1000, (now - 1000) / 1000);
    fs.utimesSync(auditLog, (now - 3000) / 1000, (now - 3000) / 1000);

    // Limit to 700 bytes: total is 1500. oldLog (500) and midLog (500) should be evaluated.
    enforceTotalLogBudget(tempDir, 700);

    // audit log must NEVER be deleted
    expect(fs.existsSync(auditLog)).toBe(true);
    // oldest non-audit log should have been deleted
    expect(fs.existsSync(oldLog)).toBe(false);
  });
});
