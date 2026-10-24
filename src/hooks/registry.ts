/**
 * Hook Registry (Phase 10 - P10-T03).
 *
 * Manages registration, unregistration, sorting by priority, and filter-based
 * matching of hooks.
 */

import { AirError } from '../errors/index.js';
import type { HookContext, HookDefinition, HookKind } from './types.js';

export interface MatchingCriteria {
  readonly toolName?: string | undefined;
  readonly eventType?: string | undefined;
  readonly agentId?: string | undefined;
}

export class HookRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly hooks = new Map<string, HookDefinition<any>>();

  /**
   * Registers a hook definition.
   * Throws ALREADY_EXISTS if a hook with the same id is already registered.
   */
  register<TContext extends HookContext = HookContext>(hook: HookDefinition<TContext>): void {
    if (!hook.id || typeof hook.id !== 'string') {
      throw new AirError('INVALID_ARGUMENT', 'Hook id must be a non-empty string');
    }
    if (!hook.name || typeof hook.name !== 'string') {
      throw new AirError('INVALID_ARGUMENT', 'Hook name must be a non-empty string');
    }
    if (typeof hook.handler !== 'function') {
      throw new AirError('INVALID_ARGUMENT', 'Hook handler must be a function');
    }
    if (this.hooks.has(hook.id)) {
      throw new AirError('ALREADY_EXISTS', `Hook with id "${hook.id}" is already registered`);
    }

    this.hooks.set(hook.id, hook);
  }

  /**
   * Unregisters a hook by id.
   * Returns true if the hook was removed, false otherwise.
   */
  unregister(id: string): boolean {
    return this.hooks.delete(id);
  }

  /**
   * Looks up a hook by id.
   */
  get(id: string): HookDefinition<HookContext> | undefined {
    return this.hooks.get(id);
  }

  /**
   * Returns all registered hooks, optionally filtered by kind.
   */
  list(kind?: HookKind): readonly HookDefinition<HookContext>[] {
    const all = Array.from(this.hooks.values());
    if (kind) {
      return all.filter((h) => h.kind === kind);
    }
    return all;
  }

  /**
   * Returns matching hooks for a given kind and context criteria,
   * sorted in descending order of priority (higher executes first).
   */
  getMatchingHooks(kind: HookKind, criteria?: MatchingCriteria): readonly HookDefinition<HookContext>[] {
    const matching = this.list(kind).filter((hook) => {
      if (!hook.filter) {
        return true;
      }

      // Check tool filter
      if (criteria?.toolName && hook.filter.tools && hook.filter.tools.length > 0) {
        const matchesTool = hook.filter.tools.some((t) => {
          if (t === '*' || t === criteria.toolName) {
            return true;
          }
          if (t.endsWith('*')) {
            const prefix = t.slice(0, -1);
            return criteria.toolName?.startsWith(prefix);
          }
          return false;
        });
        if (!matchesTool) {
          return false;
        }
      }

      // Check event type filter
      if (criteria?.eventType && hook.filter.eventTypes && hook.filter.eventTypes.length > 0) {
        const matchesEvent = hook.filter.eventTypes.some((e) => {
          if (e === '*' || e === criteria.eventType) {
            return true;
          }
          if (e.endsWith('*')) {
            const prefix = e.slice(0, -1);
            return criteria.eventType?.startsWith(prefix);
          }
          return false;
        });
        if (!matchesEvent) {
          return false;
        }
      }

      // Check agent filter
      if (criteria?.agentId && hook.filter.agents && hook.filter.agents.length > 0) {
        const matchesAgent = hook.filter.agents.includes(criteria.agentId);
        if (!matchesAgent) {
          return false;
        }
      }

      return true;
    });

    // Sort descending by priority (default 100)
    return matching.sort((a, b) => {
      const pA = a.priority ?? 100;
      const pB = b.priority ?? 100;
      if (pA !== pB) {
        return pB - pA;
      }
      return a.id.localeCompare(b.id);
    });
  }

  /**
   * Clears all registered hooks.
   */
  clear(): void {
    this.hooks.clear();
  }
}
