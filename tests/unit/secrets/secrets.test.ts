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
import type { CmRequest, CmResponse } from '../../../src/sandbox/index.js';

function makeCmMockHandler(): (request: CmRequest) => Promise<CmResponse> {
  let masterKey: string | undefined = undefined;
  return (request: CmRequest): Promise<CmResponse> => {
    switch (request.op) {
      case 'cm_read':
        if (masterKey) {
          return Promise.resolve({
            type: 'cm_credential_read',
            version: 1,
            targetName: request.targetName,
            credentialBlob: masterKey,
            userName: 'AIR Vault Master Key',
            found: true,
          });
        }
        return Promise.resolve({
          type: 'cm_credential_read',
          version: 1,
          targetName: request.targetName,
          credentialBlob: undefined,
          userName: undefined,
          found: false,
        });
      case 'cm_write':
        masterKey = request.credential.credentialBlob;
        return Promise.resolve({
          type: 'cm_credential_written',
          version: 1,
          targetName: request.credential.targetName,
          success: true,
        });
      case 'cm_delete':
        masterKey = undefined;
        return Promise.resolve({
          type: 'cm_credential_deleted',
          version: 1,
          targetName: request.targetName,
          success: true,
        });
      case 'cm_list':
        return Promise.resolve({
          type: 'cm_credentials_listed',
          version: 1,
          credentials: [],
        });
    }
  };
}

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
      const cmMock = makeCmMockHandler();
      const store = new CredentialManagerStore({ vaultDir, mockHandler: cmMock });

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

    it('returns undefined for non-existent secret and false on delete missing', async () => {
      const vaultDir = path.join(tempDir, 'vault');
      const cmMock = makeCmMockHandler();
      const store = new CredentialManagerStore({ vaultDir, mockHandler: cmMock });
      expect(await store.get('missing')).toBeUndefined();
      expect(await store.delete('missing')).toBe(false);
    });

    it('throws INVALID_ARGUMENT when secret name is empty', async () => {
      const vaultDir = path.join(tempDir, 'vault');
      const cmMock = makeCmMockHandler();
      const store = new CredentialManagerStore({ vaultDir, mockHandler: cmMock });
      await expect(store.get('')).rejects.toSatisfy(
        (err: unknown) => err instanceof AirError && err.code === 'INVALID_ARGUMENT',
      );
      await expect(store.set('', 'val')).rejects.toSatisfy(
        (err: unknown) => err instanceof AirError && err.code === 'INVALID_ARGUMENT',
      );
      await expect(store.delete('')).rejects.toSatisfy(
        (err: unknown) => err instanceof AirError && err.code === 'INVALID_ARGUMENT',
      );
    });

    it('throws INVALID_STATE when initialized without masterKey or cmClient', async () => {
      const vaultDir = path.join(tempDir, 'vault-no-client');
      const store = new CredentialManagerStore({ vaultDir });
      await expect(store.get('test')).rejects.toSatisfy(
        (err: unknown) => err instanceof AirError && err.code === 'INVALID_STATE',
      );
    });

    it('reads existing master key from Credential Manager across multiple store instances', async () => {
      const vaultDir = path.join(tempDir, 'vault-shared');
      const cmMock = makeCmMockHandler();
      const store1 = new CredentialManagerStore({ vaultDir, mockHandler: cmMock });
      await store1.set('shared_secret', 'secret-val-123');

      // Second instance reads the existing master key that was written
      const store2 = new CredentialManagerStore({ vaultDir, mockHandler: cmMock });
      const readVal = await store2.get('shared_secret');
      expect(readVal).toBe('secret-val-123');
    });

    it('handles concurrent operations gracefully during initial key derivation', async () => {
      const vaultDir = path.join(tempDir, 'vault-concurrent');
      const cmMock = makeCmMockHandler();
      const store = new CredentialManagerStore({ vaultDir, mockHandler: cmMock });

      // Run multiple gets in parallel before initialization completes
      const results = await Promise.all([
        store.get('key1'),
        store.get('key2'),
        store.get('key3'),
      ]);
      expect(results).toEqual([undefined, undefined, undefined]);
    });

    it('throws SECRET_ACCESS_DENIED when mockHandler returns unexpected read response', async () => {
      const vaultDir = path.join(tempDir, 'vault-bad-read');
      const badMock = () => Promise.resolve({ type: 'unexpected_type' } as unknown as CmResponse);
      const store = new CredentialManagerStore({ vaultDir, mockHandler: badMock });
      await expect(store.get('key')).rejects.toSatisfy(
        (err: unknown) => err instanceof AirError && err.code === 'SECRET_ACCESS_DENIED',
      );
    });

    it('throws SECRET_ACCESS_DENIED when mockHandler returns unexpected write response', async () => {
      const vaultDir = path.join(tempDir, 'vault-bad-write');
      const badMock = (req: CmRequest) => {
        if (req.op === 'cm_read') {
          return Promise.resolve({
            type: 'cm_credential_read',
            version: 1,
            targetName: req.targetName,
            credentialBlob: undefined,
            userName: undefined,
            found: false,
          } as CmResponse);
        }
        return Promise.resolve({ type: 'unexpected_type' } as unknown as CmResponse);
      };
      const store = new CredentialManagerStore({ vaultDir, mockHandler: badMock });
      await expect(store.get('key')).rejects.toSatisfy(
        (err: unknown) => err instanceof AirError && err.code === 'SECRET_ACCESS_DENIED',
      );
    });

    it('throws INVALID_STATE if derivedKey is unexpectedly missing in get or set', async () => {
      const vaultDir = path.join(tempDir, 'vault-missing-key');
      const store = new CredentialManagerStore({ vaultDir, masterKey: 'test-master' });
      await store.set('existing', 'value');

      // Artificially remove derivedKey while initialized is true
      (store as unknown as { derivedKey: unknown }).derivedKey = undefined;

      await expect(store.get('existing')).rejects.toSatisfy(
        (err: unknown) => err instanceof AirError && err.code === 'SECRET_ACCESS_DENIED',
      );
      await expect(store.set('new_key', 'val')).rejects.toSatisfy(
        (err: unknown) => err instanceof AirError && err.code === 'INVALID_STATE',
      );
    });

    it('uses default credentials directory when vaultDir is not provided', () => {
      const store = new CredentialManagerStore({ masterKey: 'key' });
      expect(store).toBeDefined();
    });

    it('handles mockHandler returning success: false on cm_write', async () => {
      const vaultDir = path.join(tempDir, 'vault-cm-fail');
      const store = new CredentialManagerStore({
        vaultDir,
        mockHandler: (req) => {
          if (req.op === 'cm_read') {
            return Promise.resolve({
              type: 'cm_credential_read',
              version: 1,
              targetName: req.targetName,
              credentialBlob: undefined,
              userName: undefined,
              found: false,
            });
          }
          if (req.op === 'cm_write') {
            return Promise.resolve({
              type: 'cm_credential_written',
              version: 1,
              targetName: req.credential.targetName,
              success: false,
            });
          }
          return Promise.resolve({
            type: 'cm_credential_deleted',
            version: 1,
            targetName: 'unknown',
            success: true,
          });
        },
      });
      await store.set('k', 'v');
      expect(await store.get('k')).toBe('v');
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
