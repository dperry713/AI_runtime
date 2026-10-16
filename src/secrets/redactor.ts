import {
  clearRegisteredSecrets,
  redactObject as obsRedactObject,
  redactString as obsRedactString,
  registerSecret,
  unregisterSecret,
} from '../observability/index.js';

/**
 * Secret redactor facade integrated with observability redaction engine.
 * Rule R4: Never log secrets.
 */
export const redactor = {
  register(name: string, value: string): void {
    registerSecret(name, value);
  },

  unregister(name: string): void {
    unregisterSecret(name);
  },

  clear(): void {
    clearRegisteredSecrets();
  },

  redact(value: string): string {
    return obsRedactString(value);
  },

  redactObject<T>(input: T): T {
    return obsRedactObject(input);
  },
};
