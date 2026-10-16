import { redactor } from './redactor.js';
import type { SecretStore } from './store.js';

/**
 * In-memory implementation of SecretStore.
 * Automatically integrates with redactor for all retrieved and set secrets.
 */
export class MemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();

  public get(name: string): Promise<string | undefined> {
    const value = this.secrets.get(name);
    if (value !== undefined) {
      redactor.register(name, value);
    }
    return Promise.resolve(value);
  }

  public set(name: string, value: string): Promise<void> {
    this.secrets.set(name, value);
    redactor.register(name, value);
    return Promise.resolve();
  }

  public delete(name: string): Promise<boolean> {
    const existed = this.secrets.delete(name);
    if (existed) {
      redactor.unregister(name);
    }
    return Promise.resolve(existed);
  }

  public list(): Promise<string[]> {
    return Promise.resolve(Array.from(this.secrets.keys()).sort());
  }

  public clear(): void {
    for (const name of this.secrets.keys()) {
      redactor.unregister(name);
    }
    this.secrets.clear();
  }
}
