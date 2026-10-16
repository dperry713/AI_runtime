/**
 * Common contract for secret stores in AIR (Memory, Credential Manager, Vault).
 */
export interface SecretStore {
  /**
   * Retrieves a secret by name. Automatically registers with redactor if found.
   */
  get(name: string): Promise<string | undefined>;

  /**
   * Stores a secret by name. Automatically registers with redactor.
   */
  set(name: string, value: string): Promise<void>;

  /**
   * Deletes a secret by name. Returns true if removed, false if not found.
   */
  delete(name: string): Promise<boolean>;

  /**
   * Lists names of all stored secrets (names only, never values).
   */
  list(): Promise<string[]>;
}
