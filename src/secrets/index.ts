import { MemorySecretStore } from './memory-store.js';
import type { SecretStore } from './store.js';

export type { SecretStore } from './store.js';
export { redactor } from './redactor.js';
export { MemorySecretStore } from './memory-store.js';
export {
  type CredentialManagerOptions,
  CredentialManagerStore,
} from './credential-manager.js';

let activeStore: SecretStore = new MemorySecretStore();

/**
 * Returns the currently active system secret store.
 */
export function getSecretStore(): SecretStore {
  return activeStore;
}

/**
 * Sets the active secret store implementation.
 */
export function setSecretStore(store: SecretStore): void {
  activeStore = store;
}

/**
 * Resets secret store to a fresh in-memory instance.
 */
export function resetSecretStore(): void {
  activeStore = new MemorySecretStore();
}
