/**
 * Windows Credential Manager client for secret store integration.
 *
 * Communicates with the native `air-sandbox.exe` helper via its versioned
 * JSON stdin/stdout protocol to store and retrieve credentials in Windows
 * Credential Manager (CredWriteW/CredReadW/CredDeleteW).
 *
 * Used by CredentialManagerStore to protect the vault master key without
 * storing it in plaintext on disk.
 *
 * Adheres to:
 * - Rule R1: Structured logging via src/observability
 * - Rule R2: Process execution boundaries (sandbox helper)
 * - Rule R4: Secret scrubbing (secrets registered with redactor)
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 */

import { spawn } from 'node:child_process';
import { AirError } from '../errors/index.js';
import type { CmRequest, CmResponse, CredentialListEntry, CredentialResult, CredentialSpec } from '../types/index.js';
export type { CmRequest, CmResponse, CredentialListEntry, CredentialResult, CredentialSpec } from '../types/index.js';
import { getLogger, type ComponentLogger } from '../observability/index.js';

const defaultLogger = getLogger('credential-manager-client');

export const CREDENTIAL_MANAGER_PROTOCOL_VERSION = 1;

export interface CredentialManagerClientOptions {
  readonly helperPath?: string | undefined;
  readonly logger?: ComponentLogger | undefined;
  /** Optional mock handler for testing (bypasses spawning air-sandbox.exe). */
  readonly mockHandler?: ((request: CmRequest) => Promise<CmResponse>) | undefined;
}

/**
 * Credential Manager client for managing Windows credentials via air-sandbox.exe.
 */
export class CredentialManagerClient {
  private readonly helperPath: string;
  private readonly logger: ComponentLogger;
  private readonly mockHandler?: ((request: CmRequest) => Promise<CmResponse>) | undefined;

  constructor(options: CredentialManagerClientOptions = {}) {
    this.helperPath = options.helperPath ?? 'air-sandbox.exe';
    this.logger = options.logger ?? defaultLogger;
    this.mockHandler = options.mockHandler;
  }

  /**
   * Writes a credential to Windows Credential Manager.
   */
  async writeCredential(spec: CredentialSpec): Promise<CredentialResult> {
    const request: CmRequest = { op: 'cm_write', credential: spec };
    const response = await this.sendRequest(request);

    if (response.type === 'cm_credential_written') {
      this.logger.info(
        {
          event: 'sandbox.credential_manager.written',
          targetName: response.targetName,
          success: response.success,
        },
        `Credential written: ${response.targetName}`,
      );
      return {
        targetName: response.targetName,
        success: response.success,
        message: 'Credential written successfully',
      };
    }

    if (response.type === 'error') {
      throw new AirError(
        'SECRET_ACCESS_DENIED',
        `Credential Manager write failed: ${response.message}`,
        { context: { code: response.code, targetName: spec.targetName } },
      );
    }

    throw new AirError(
      'SECRET_ACCESS_DENIED',
      `Unexpected Credential Manager response type: ${(response as { readonly type: string }).type}`,
      { context: { targetName: spec.targetName } },
    );
  }

  /**
   * Reads a credential from Windows Credential Manager by target name.
   * Returns undefined if the credential is not found.
   */
  async readCredential(targetName: string): Promise<{ readonly credentialBlob: string | undefined; readonly userName: string | undefined; readonly found: boolean }> {
    const request: CmRequest = { op: 'cm_read', targetName };
    const response = await this.sendRequest(request);

    if (response.type === 'cm_credential_read') {
      return {
        credentialBlob: response.credentialBlob,
        userName: response.userName,
        found: response.found,
      };
    }

    if (response.type === 'error') {
      throw new AirError(
        'SECRET_ACCESS_DENIED',
        `Credential Manager read failed: ${response.message}`,
        { context: { code: response.code, targetName } },
      );
    }

    throw new AirError(
      'SECRET_ACCESS_DENIED',
      `Unexpected Credential Manager response type: ${(response as { readonly type: string }).type}`,
      { context: { targetName } },
    );
  }

  /**
   * Deletes a credential from Windows Credential Manager by target name.
   */
  async deleteCredential(targetName: string): Promise<boolean> {
    const request: CmRequest = { op: 'cm_delete', targetName };
    const response = await this.sendRequest(request);

    if (response.type === 'cm_credential_deleted') {
      return response.success;
    }

    if (response.type === 'error') {
      throw new AirError(
        'SECRET_ACCESS_DENIED',
        `Credential Manager delete failed: ${response.message}`,
        { context: { code: response.code, targetName } },
      );
    }

    throw new AirError(
      'SECRET_ACCESS_DENIED',
      `Unexpected Credential Manager response type: ${(response as { readonly type: string }).type}`,
      { context: { targetName } },
    );
  }

  /**
   * Lists credentials matching an optional filter.
   */
  async listCredentials(filter?: string): Promise<readonly CredentialListEntry[]> {
    const request: CmRequest = { op: 'cm_list', filter };
    const response = await this.sendRequest(request);

    if (response.type === 'cm_credentials_listed') {
      return response.credentials;
    }

    if (response.type === 'error') {
      throw new AirError(
        'SECRET_ACCESS_DENIED',
        `Credential Manager list failed: ${response.message}`,
        { context: { code: response.code } },
      );
    }

    throw new AirError(
      'SECRET_ACCESS_DENIED',
      `Unexpected Credential Manager response type: ${(response as { readonly type: string }).type}`,
      { context: {} },
    );
  }

  /**
   * Sends a credential manager request to the air-sandbox.exe helper.
   * If a mockHandler is configured, uses it instead of spawning the helper.
   */
  private async sendRequest(request: CmRequest): Promise<CmResponse> {
    // Mock handler for testing (bypasses spawning air-sandbox.exe)
    if (this.mockHandler) {
      return this.mockHandler(request);
    }

    return new Promise<CmResponse>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.helperPath, [], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err: unknown) {
        return reject(
          new AirError(
            'TOOL_EXECUTION_FAILED',
            `Failed to launch sandbox helper "${this.helperPath}": ${(err as Error).message}`,
            { cause: err instanceof Error ? err : undefined },
          ),
        );
      }

      if (!child.stdin || !child.stdout || !child.stderr) {
        return reject(
          new AirError('TOOL_EXECUTION_FAILED', 'Failed to initialize stdio pipes for sandbox helper'),
        );
      }

      const childStdin = child.stdin;
      const childStdout = child.stdout;
      const childStderr = child.stderr;

      let stdoutAccum = '';
      let resolved = false;

      const cleanup = (): void => {
        try {
          child.kill();
        } catch {
          // Ignore
        }
      };

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new AirError('TOOL_TIMEOUT', 'Credential Manager request timed out'));
        }
      }, 10_000);

      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      childStdin.write(JSON.stringify(request) + '\n', () => {
        childStdin.end();
      });

      childStdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        stdoutAccum += text;
        const lines = stdoutAccum.split('\n');
        stdoutAccum = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;

          try {
            const resp = JSON.parse(trimmed) as { readonly type: string; readonly [key: string]: unknown };
            if (resp && typeof resp === 'object' && 'type' in resp) {
              if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                cleanup();
                resolve(resp as unknown as CmResponse);
              }
              return;
            }
          } catch {
            // Not a JSON protocol line - ignore
          }
        }
      });

      childStderr.on('data', () => {
        // Ignore stderr
      });

      child.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          cleanup();
          reject(new AirError('TOOL_EXECUTION_FAILED', `Sandbox helper process error: ${err.message}`, { cause: err }));
        }
      });

      child.on('close', (code: number | null) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          cleanup();
          reject(new AirError('TOOL_EXECUTION_FAILED', `Sandbox helper exited with code ${code ?? -1} before response`));
        }
      });
    });
  }
}

/**
 * Builds a Credential Manager target name for the AIR vault master key.
 * The target name is scoped to the vault directory to avoid collisions
 * between multiple AIR installations or vault directories.
 */
export function buildMasterKeyTargetName(vaultDir: string): string {
  // Use a hash of the vault dir path to create a unique target name
  const hash = Buffer.from(vaultDir, 'utf-8').toString('base64').replace(/[^a-zA-Z0-9]/g, '_');
  return `AIR:MasterKey:${hash}`;
}
