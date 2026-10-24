/**
 * Unit tests for DPAPI encryption/decryption (Phase 9 - security hardening).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import { dpapiDecrypt, dpapiEncrypt } from '../../../src/sandbox/dpapi.js';

vi.mock('node:child_process', () => {
  return {
    execFile: vi.fn(),
  };
});

describe('Windows DPAPI helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls powershell ProtectedData Protect and returns encrypted Buffer', async () => {
    const original = Buffer.from('my-secret-key', 'utf-8');
    const fakeCipherBase64 = Buffer.from('encrypted-bytes').toString('base64');

    vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (err: Error | null, stdout: string) => void;
      callback(null, fakeCipherBase64);
      return {} as childProcess.ChildProcess;
    });

    const encrypted = await dpapiEncrypt(original);
    expect(encrypted.toString('utf-8')).toBe('encrypted-bytes');
  });

  it('calls powershell ProtectedData Unprotect and returns decrypted Buffer', async () => {
    const cipher = Buffer.from('encrypted-bytes', 'utf-8');

    vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (err: Error | null, stdout: string) => void;
      callback(null, 'my-secret-key');
      return {} as childProcess.ChildProcess;
    });

    const decrypted = await dpapiDecrypt(cipher);
    expect(decrypted.toString('utf-8')).toBe('my-secret-key');
  });

  it('rejects on powershell error', async () => {
    vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (err: Error | null, stdout: string) => void;
      callback(new Error('PowerShell error'), '');
      return {} as childProcess.ChildProcess;
    });

    await expect(dpapiEncrypt(Buffer.from('data'))).rejects.toThrow('PowerShell error');
  });
});
