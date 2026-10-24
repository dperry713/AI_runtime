/**
 * Windows Credential Manager secret store (Phase W3 - Windows-native secrets).
 *
 * Protects the vault master key using Windows Credential Manager
 * (CredWriteW/CredReadW/CredDeleteW) instead of DPAPI-protected files.
 * Individual secrets are encrypted with AES-256-GCM using a key derived
 * from the Credential Manager-protected master key.
 *
 * The master key is stored as a Windows Credential Manager generic credential
 * bound to the current Windows user logon. It never exists in plaintext on
 * disk. Individual secrets are stored as encrypted .enc files in the vault
 * directory, encrypted with AES-256-GCM using a key derived from the master key.
 *
 * All file operations route through safe filesystem jail per Rule R2.
 * Credential Manager operations route through the sandbox helper per Rule R2.
 *
 * Adheres to:
 * - Rule R1: Structured logging via src/observability
 * - Rule R2: Process execution boundaries (sandbox helper + fs-safe)
 * - Rule R4: Secret scrubbing (integrated with observability redactor)
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { resolveAirHome } from '../config/index.js';
import { AirError } from '../errors/index.js';
import {
  canonicalize,
  existsIn,
  listIn,
  mkdirIn,
  readFileIn,
  removeIn,
  writeFileAtomicIn,
} from '../util/index.js';
import { redactor } from './redactor.js';
import {
  CredentialManagerClient,
  buildMasterKeyTargetName,
  type CmRequest,
  type CmResponse,
} from '../sandbox/index.js';
import type { SecretStore } from './store.js';

export interface CredentialManagerOptions {
  vaultDir?: string | undefined;
  masterKey?: string | undefined;
  /** Optional mock handler for testing (bypasses spawning air-sandbox.exe). */
  mockHandler?: ((request: CmRequest) => Promise<CmResponse>) | undefined;
}

interface EncryptedPayload {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

/**
 * Windows Credential Store adapter.
 *
 * Uses Windows Credential Manager (CredWriteW/CredReadW/CredDeleteW) to
 * protect the master key bound to the current Windows user logon credentials.
 * The master key never exists in plaintext on disk. Individual secrets are
 * encrypted with AES-256-GCM using a key derived from the master key.
 *
 * All file operations route through safe filesystem jail per Rule R2.
 * Credential Manager operations route through the sandbox helper per Rule R2.
 */
export class CredentialManagerStore implements SecretStore {
  private readonly vaultDir: string;
  private readonly optionsMasterKey: string | undefined;
  private readonly cmClient: CredentialManagerClient;

  private initialized = false;
  private deriving = false;
  private initPromise: Promise<void> | null = null;
  private derivedKey: Buffer | null = null;

  constructor(options: CredentialManagerOptions = {}) {
    const baseHome = options.vaultDir ?? path.join(resolveAirHome(), 'credentials');
    this.vaultDir = canonicalize(baseHome);
    this.optionsMasterKey = options.masterKey;
    this.cmClient = new CredentialManagerClient({
      mockHandler: options.mockHandler,
    });
  }

  // ============================================================================
  // Credential Manager master key protection
  // ============================================================================

  /**
   * Ensures the master key is loaded/created and the derived key is available.
   * Called by all public methods before any secret operation.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.deriving) {
      await this.initPromise;
      return;
    }

    this.deriving = true;
    this.initPromise = (async () => {
      try {
        const rawMasterKey = this.optionsMasterKey ?? (await this.getOrCreateMasterKey());
        const masterKey =
          typeof rawMasterKey === 'string' ? rawMasterKey : rawMasterKey.toString('base64');
        const identity = `${os.userInfo().username}@${os.hostname()}:${masterKey}`;
        const salt = 'AIR_WINDOWS_CREDENTIAL_SALT_2026';
        this.derivedKey = scryptSync(identity, salt, 32);
      } finally {
        this.initialized = true;
        this.deriving = false;
      }
    })();

    await this.initPromise;
  }

  /**
   * Returns the Credential Manager-protected master key, creating it on first use.
   * The master key is a random 256-bit value stored in Windows Credential Manager.
   * It never exists in plaintext on disk.
   */
  private async getOrCreateMasterKey(): Promise<Buffer> {
    const targetName = buildMasterKeyTargetName(this.vaultDir);

    // Try to read existing master key from Credential Manager
    const existing = await this.cmClient.readCredential(targetName);
    if (existing.found && existing.credentialBlob) {
      return Buffer.from(existing.credentialBlob, 'base64');
    }

    // No existing master key: generate a new one, store in Credential Manager
    const newKey = randomBytes(32);
    await this.cmClient.writeCredential({
      targetName,
      credentialBlob: newKey.toString('base64'),
      userName: 'AIR Vault Master Key',
      comment: 'AIR vault master key - do not delete',
      persist: 'local_machine',
    });
    return newKey;
  }

  // ============================================================================
  // SecretStore implementation
  // ============================================================================

  public async get(name: string): Promise<string | undefined> {
    await this.ensureInitialized();
    await this.ensureVaultDir();
    const sanitized = this.sanitizeName(name);
    const fileName = `${sanitized}.enc`;

    const exists = await existsIn(this.vaultDir, fileName);
    if (!exists) {
      return undefined;
    }

    try {
      const raw = await readFileIn(this.vaultDir, fileName);
      const payload = JSON.parse(raw) as EncryptedPayload;

      const derivedKey = this.derivedKey;
      if (!derivedKey) {
        throw new AirError('INVALID_STATE', 'Derived key not initialized');
      }
      const iv = Buffer.from(payload.iv, 'hex');
      const tag = Buffer.from(payload.tag, 'hex');
      const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv);
      decipher.setAuthTag(tag);

      let decrypted = decipher.update(payload.ciphertext, 'hex', 'utf-8');
      decrypted += decipher.final('utf-8');

      redactor.register(name, decrypted);
      return decrypted;
    } catch (err) {
      throw new AirError('SECRET_ACCESS_DENIED', `Failed to decrypt secret: ${name}`, {
        cause: err instanceof Error ? err : new Error(String(err)),
        context: { secretName: name },
      });
    }
  }

  public async set(name: string, value: string): Promise<void> {
    await this.ensureInitialized();
    await this.ensureVaultDir();
    const sanitized = this.sanitizeName(name);
    const fileName = `${sanitized}.enc`;

    const derivedKey = this.derivedKey;
    if (!derivedKey) {
      throw new AirError('INVALID_STATE', 'Derived key not initialized');
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);

    let ciphertext = cipher.update(value, 'utf-8', 'hex');
    ciphertext += cipher.final('hex');
    const tag = cipher.getAuthTag();

    const payload: EncryptedPayload = {
      v: 1,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ciphertext,
    };

    await writeFileAtomicIn(this.vaultDir, fileName, JSON.stringify(payload));
    redactor.register(name, value);
  }

  public async delete(name: string): Promise<boolean> {
    await this.ensureInitialized();
    await this.ensureVaultDir();
    const sanitized = this.sanitizeName(name);
    const fileName = `${sanitized}.enc`;

    const exists = await existsIn(this.vaultDir, fileName);
    if (!exists) {
      return false;
    }

    await removeIn(this.vaultDir, fileName);
    redactor.unregister(name);
    return true;
  }

  public async list(): Promise<string[]> {
    await this.ensureInitialized();
    await this.ensureVaultDir();
    const files = await listIn(this.vaultDir);
    return files
      .filter((f) => f.endsWith('.enc'))
      .map((f) => f.slice(0, -4))
      .sort();
  }

  private async ensureVaultDir(): Promise<void> {
    const exists = await existsIn(this.vaultDir, '.');
    if (!exists) {
      await mkdirIn(this.vaultDir, '.');
    }
  }

  private sanitizeName(name: string): string {
    const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!sanitized || sanitized.length === 0) {
      throw new AirError('INVALID_ARGUMENT', `Invalid secret name: ${name}`);
    }
    return sanitized;
  }
}
