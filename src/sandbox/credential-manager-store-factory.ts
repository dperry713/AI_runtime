/**
 * Composition-root factory for the Windows Credential Manager secret store.
 *
 * This is intentionally located in the sandbox layer: it wires the secrets
 * abstraction to the process-isolated Credential Manager client without making
 * the lower-level secrets module depend on sandbox implementation details.
 */
import {
  CredentialManagerStore,
  type CredentialManagerOptions,
} from '../secrets/index.js';
import { CredentialManagerClient } from './credential-manager-client.js';

export type WindowsCredentialManagerStoreOptions = Omit<
  CredentialManagerOptions,
  'client' | 'mockHandler'
>;

export function createCredentialManagerStore(
  options: WindowsCredentialManagerStoreOptions = {},
): CredentialManagerStore {
  return new CredentialManagerStore({
    ...options,
    client: new CredentialManagerClient(),
  });
}
