/**
 * Unit tests for shell output formatting (P9-T04/P9-T07).
 */

import { describe, expect, it } from 'vitest';
import { writeResult, writeError } from '../../../src/shell/output.js';
import { ExitCode } from '../../../src/shell/exit-codes.js';

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    chunks.push(chunk);
    return true;
  });
  try {
    fn();
  } finally {
    process.stdout.write = origWrite;
  }
  return chunks.join('');
}

describe('writeResult', () => {
  it('formats text output for a string', () => {
    const output = captureStdout(() => {
      writeResult('hello world', { json: false });
    });
    expect(output).toContain('hello world');
  });

  it('formats JSON output', () => {
    const output = captureStdout(() => {
      writeResult({ key: 'value' }, { json: true });
    });
    const parsed = JSON.parse(output.trim()) as { ok: boolean; data: { key: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ key: 'value' });
  });
});

describe('writeError', () => {
  it('returns GENERAL_ERROR for a generic error', () => {
    const err = new Error('something went wrong');
    const code = writeError(err, { json: false });
    expect(code).toBe(ExitCode.GENERAL_ERROR);
  });

  it('returns CONNECTION_ERROR for IPC_CONNECTION_FAILED', () => {
    const err = new Error('pipe error') as Error & { code: string };
    err.code = 'IPC_CONNECTION_FAILED';
    const code = writeError(err, { json: false });
    expect(code).toBe(ExitCode.CONNECTION_ERROR);
  });

  it('returns NOT_FOUND for RUN_NOT_FOUND', () => {
    const err = new Error('run not found') as Error & { code: string };
    err.code = 'RUN_NOT_FOUND';
    const code = writeError(err, { json: false });
    expect(code).toBe(ExitCode.NOT_FOUND);
  });

  it('emits JSON in json mode', () => {
    const output = captureStdout(() => {
      const err = new Error('test error');
      writeError(err, { json: true });
    });
    const parsed = JSON.parse(output.trim()) as { ok: boolean; error: { message: string; exitCode: number } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toBe('test error');
  });
});
