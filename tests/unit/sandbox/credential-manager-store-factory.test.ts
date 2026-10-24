/**
 * Unit tests for createCredentialManagerStore factory (Phase W3).
 */

import { describe, expect, it } from 'vitest';
import { createCredentialManagerStore } from '../../../src/sandbox/credential-manager-store-factory.js';
import { CredentialManagerStore } from '../../../src/secrets/index.js';

describe('createCredentialManagerStore', () => {
  it('instantiates CredentialManagerStore with injected client', () => {
    const store = createCredentialManagerStore({
      vaultDir: 'C:\\test\\vault',
    });
    expect(store).toBeInstanceOf(CredentialManagerStore);
  });
});
