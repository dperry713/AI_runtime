/**
 * Windows DPAPI helper functions (Phase 9 - security hardening).
 *
 * Provides DPAPI (CryptProtectData/CryptUnprotectData) encryption/decryption
 * bound to the current Windows user logon credentials. Used by the secrets
 * module to protect the master key without storing it in plaintext on disk.
 *
 * All child_process usage is confined to the sandbox layer per Rule R2.
 */

import { execFile } from 'node:child_process';

/**
 * Encrypt data using Windows DPAPI bound to the current user logon
 * credentials. The encrypted data can only be decrypted by the same user
 * on the same machine.
 */
export async function dpapiEncrypt(data: Buffer): Promise<Buffer> {
  const base64 = String(data.toString('base64'));
  const result = await new Promise<{ stdout: string }>((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([System.Convert]::FromBase64String('${base64}'), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))`,
      ],
      { timeout: 10_000 },
        (err: Error | null, stdout: string) => {
          if (err) {
            reject(err);
          } else {
            resolve({ stdout: stdout.trim() });
          }
        },
      );
    });
    return Buffer.from(result.stdout, 'base64');
  }

  /**
   * Decrypt data previously encrypted with dpapiEncrypt. Only the same user
   * on the same machine can decrypt.
   */
  export async function dpapiDecrypt(data: Buffer): Promise<Buffer> {
    const base64 = String(data.toString('base64'));
    const result = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `[System.Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect([System.Convert]::FromBase64String('${base64}'), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))`,
        ],
        { timeout: 10_000 },
        (err: Error | null, stdout: string) => {
          if (err) {
            reject(err);
          } else {
            resolve({ stdout: stdout.trim() });
          }
        },
      );
    });
  return Buffer.from(result.stdout, 'utf-8');
}
