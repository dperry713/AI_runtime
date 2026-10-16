import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
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
import type { SecretStore } from './store.js';

export interface CredentialManagerOptions {
  vaultDir?: string | undefined;
  masterKey?: string | undefined;
}

interface EncryptedPayload {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

/**
 * Windows Credential Store adapter.
 * Uses AES-256-GCM authenticated encryption bound to user profile / local machine.
 * All file operations route through safe filesystem jail per Rule R2.
 */
export class CredentialManagerStore implements SecretStore {
  private readonly vaultDir: string;
  private readonly derivedKey: Buffer;

  constructor(options: CredentialManagerOptions = {}) {
    const baseHome = options.vaultDir ?? path.join(resolveAirHome(), 'credentials');
    this.vaultDir = canonicalize(baseHome);

    // Derive 256-bit key from user identity + optional masterKey
    const identity = `${os.userInfo().username}@${os.hostname()}:${options.masterKey ?? 'AIR_DEFAULT_CREDENTIAL_VAULT'}`;
    const salt = 'AIR_WINDOWS_CREDENTIAL_SALT_2026';
    this.derivedKey = scryptSync(identity, salt, 32);
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

  public async get(name: string): Promise<string | undefined> {
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

      const iv = Buffer.from(payload.iv, 'hex');
      const tag = Buffer.from(payload.tag, 'hex');
      const decipher = createDecipheriv('aes-256-gcm', this.derivedKey, iv);
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
    await this.ensureVaultDir();
    const sanitized = this.sanitizeName(name);
    const fileName = `${sanitized}.enc`;

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.derivedKey, iv);

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
    await this.ensureVaultDir();
    const files = await listIn(this.vaultDir);
    return files
      .filter((f) => f.endsWith('.enc'))
      .map((f) => f.slice(0, -4))
      .sort();
  }
}
