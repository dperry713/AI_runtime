/**
 * Hooks Module Public API (Phase 10 - P10-T03).
 */

import { HookRegistry } from './registry.js';
import { HookRunner, type HookRunnerOptions } from './runner.js';

export * from './types.js';
export * from './registry.js';
export * from './runner.js';

/**
 * Creates a HookRunner paired with an optional or newly created HookRegistry.
 */
export function createHookRunner(
  options: HookRunnerOptions & { registry?: HookRegistry | undefined } = {},
): { runner: HookRunner; registry: HookRegistry } {
  const registry = options.registry ?? new HookRegistry();
  const runner = new HookRunner(registry, options);
  return { runner, registry };
}
