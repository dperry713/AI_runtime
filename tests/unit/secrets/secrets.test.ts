import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  CredentialManagerStore,
  getSecretStore,
  MemorySecretStore,
  redactor,
  resetSecretStore,
  setSecretStore,
} from '../../../src/secrets/index.js';

describe('secrets module (P1-T09)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-secrets-test-'));
    redactor.clear();
    resetSecretStore();
  });

  afterEach(() => {
    redactor.clear();
    resetSecretStore();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('MemorySecretStore', () => {
    it('stores, retrieves, lists, and deletes secrets in memory', async () => {
      const store = new MemorySecretStore();

      await store.set('api_key', 'secret-key-12345');
      await store.set('db_pass', 'super-secret-pass');

      expect(await store.get('api_key')).toBe('secret-key-12345');
      expect(await store.get('db_pass')).toBe('super-secret-pass');
      expect(await store.get('non_existent')).toBeUndefined();

      const list = await store.list();
      expect(list).toEqual(['api_key', 'db_pass']);

      const deleted = await store.delete('api_key');
      expect(deleted).toBe(true);
      expect(await store.get('api_key')).toBeUndefined();
      expect(await store.delete('api_key')).toBe(false);
    });

    it('automatically registers and unregisters secrets with redactor', async () => {
      const store = new MemorySecretStore();
      await store.set('custom_key', 'my-custom-unpatterned-secret-98765');

      // Check redactor immediately redacts the stored secret
      expect(redactor.redact('Calling API with my-custom-unpatterned-secret-98765 now')).toBe(
        'Calling API with [REDACTED:custom_key] now',
      );

      // Delete secret and check unregistration
      await store.delete('custom_key');
      expect(redactor.redact('Calling API with my-custom-unpatterned-secret-98765 now')).toBe(
        'Calling API with my-custom-unpatterned-secret-98765 now',
      );
    });
  });

  describe('CredentialManagerStore (encrypted vault)', () => {
    it('persists encrypted secrets on disk and reads them back', async () => {
      const vaultDir = path.join(tempDir, 'vault');
      const store = new CredentialManagerStore({ vaultDir, masterKey: 'test-master' });

      await store.set('nvidia_key', 'nvapi-SecretNvidiaToken99999');

      // Verify file is encrypted on disk and does NOT contain raw secret text
      const encFile = path.join(vaultDir, 'nvidia_key.enc');
      expect(fs.existsSync(encFile)).toBe(true);
      const fileRaw = fs.readFileSync(encFile, 'utf-8');
      expect(fileRaw).not.toContain('nvapi-SecretNvidiaToken99999');
      expect(fileRaw).toContain('"ciphertext"');

      // Read back
      const retrieved = await store.get('nvidia_key');
      expect(retrieved).toBe('nvapi-SecretNvidiaToken99999');

      // Verify redactor registered the secret
      expect(redactor.redact('Key nvapi-SecretNvidiaToken99999 used')).toBe(
        'Key [REDACTED:nvidia_key] used',
      );

      // List & delete
      const list = await store.list();
      expect(list).toEqual(['nvidia_key']);

      const deleted = await store.delete('nvidia_key');
      expect(deleted).toBe(true);
      expect(fs.existsSync(encFile)).toBe(false);
    });

    it('throws AirError(SECRET_ACCESS_DENIED) on corrupted or tampered ciphertext', async () => {
      const vaultDir = path.join(tempDir, 'vault');
      const store = new CredentialManagerStore({ vaultDir });

      await store.set('target_key', 'plain-secret-data');

      // Tamper ciphertext
      const encFile = path.join(vaultDir, 'target_key.enc');
      const payload = JSON.parse(fs.readFileSync(encFile, 'utf-8')) as Record<string, unknown>;
      payload['ciphertext'] = '00'.repeat(16);
      fs.writeFileSync(encFile, JSON.stringify(payload), 'utf-8');

      await expect(store.get('target_key')).rejects.toThrowError(AirError);

      try {
        await store.get('target_key');
      } catch (err) {
        expect(err).toBeInstanceOf(AirError);
        expect((err as AirError).code).toBe('SECRET_ACCESS_DENIED');
      }
    });

    it('returns undefined for non-existent secret', async () => {
      const vaultDir = path.join(tempDir, 'vault');
      const store = new CredentialManagerStore({ vaultDir });
      expect(await store.get('missing')).toBeUndefined();
    });
  });

  describe('global store management', () => {
    it('allows switching and resetting the active secret store', async () => {
      expect(getSecretStore()).toBeInstanceOf(MemorySecretStore);

      const customStore = new MemorySecretStore();
      await customStore.set('k1', 'v1');
      setSecretStore(customStore);

      expect(getSecretStore()).toBe(customStore);
      expect(await getSecretStore().get('k1')).toBe('v1');

      resetSecretStore();
      expect(getSecretStore()).not.toBe(customStore);
      expect(await getSecretStore().get('k1')).toBeUndefined();
    });
  });
});
