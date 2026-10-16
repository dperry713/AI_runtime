/**
 * Event upcaster framework for the AIR journal (Phase 2 - P2-T07).
 *
 * Implements just-in-time schema evolution for historical events:
 * - Immutable storage: historical on-disk events are never modified.
 * - Stepwise chained migrations (v1 -> v2 -> v3).
 * - Version detection from metadata, payload, or custom extractors.
 * - Integration with JournalReader and ReplayEngine.
 */

import { z } from 'zod';
import { AirError } from '../errors/index.js';
import type { EventEnvelope } from './envelope.js';

/**
 * Interface representing a version upcaster for a specific event type.
 */
export interface Upcaster<TInput = unknown, TOutput = unknown> {
  /** The event type this upcaster applies to, e.g. "tool.requested" or "synthetic.action". */
  readonly eventType: string;
  /** Source schema version (positive integer >= 1). */
  readonly fromVersion: number;
  /** Target schema version (positive integer > fromVersion). */
  readonly toVersion: number;
  /** Optional human-readable description of the migration. */
  readonly description?: string | undefined;
  /**
   * Transforms an event envelope from `fromVersion` to `toVersion`.
   */
  upcast(envelope: EventEnvelope<TInput>): EventEnvelope<TOutput>;
}

/**
 * Pure transformation function signature for upcasting.
 */
export type UpcasterFunction<TInput = unknown, TOutput = unknown> = (
  envelope: EventEnvelope<TInput>,
) => EventEnvelope<TOutput>;

/**
 * Function type to extract the schema version from an EventEnvelope.
 */
export type VersionExtractor = (envelope: EventEnvelope) => number;

/**
 * Default version extractor inspecting meta and payload properties.
 * Order of precedence:
 * 1. envelope.meta.schemaVersion
 * 2. envelope.payload.schemaVersion
 * 3. envelope.payload.version
 * 4. envelope.payload.v
 * 5. Default to 1 (initial schema version)
 */
export function defaultVersionExtractor(envelope: EventEnvelope): number {
  if (envelope.meta && typeof envelope.meta.schemaVersion === 'number') {
    const v = envelope.meta.schemaVersion;
    if (Number.isInteger(v) && v > 0) return v;
  }

  const payload = envelope.payload;
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (typeof p['schemaVersion'] === 'number' && Number.isInteger(p['schemaVersion']) && p['schemaVersion'] > 0) {
      return p['schemaVersion'];
    }
    if (typeof p['version'] === 'number' && Number.isInteger(p['version']) && p['version'] > 0) {
      return p['version'];
    }
    if (typeof p['v'] === 'number' && Number.isInteger(p['v']) && p['v'] > 0) {
      return p['v'];
    }
  }

  return 1;
}

export interface CreateUpcasterOptions<TInput = unknown, TOutput = unknown> {
  eventType: string;
  fromVersion: number;
  toVersion?: number | undefined;
  description?: string | undefined;
  upcast: UpcasterFunction<TInput, TOutput>;
}

/**
 * Factory helper to construct a validated Upcaster instance.
 */
export function createUpcaster<TInput = unknown, TOutput = unknown>(
  options: CreateUpcasterOptions<TInput, TOutput>,
): Upcaster<TInput, TOutput> {
  const toVersion = options.toVersion ?? options.fromVersion + 1;

  if (!options.eventType || options.eventType.trim().length === 0) {
    throw new AirError('INVALID_ARGUMENT', 'Upcaster eventType cannot be empty');
  }
  if (!Number.isInteger(options.fromVersion) || options.fromVersion <= 0) {
    throw new AirError('INVALID_ARGUMENT', `fromVersion must be a positive integer, got: ${options.fromVersion}`);
  }
  if (!Number.isInteger(toVersion) || toVersion <= options.fromVersion) {
    throw new AirError(
      'INVALID_ARGUMENT',
      `toVersion must be strictly greater than fromVersion (${options.fromVersion}), got: ${toVersion}`,
    );
  }
  if (typeof options.upcast !== 'function') {
    throw new AirError('INVALID_ARGUMENT', 'Upcaster function must be executable');
  }

  const upcaster: Upcaster<TInput, TOutput> = {
    eventType: options.eventType.trim(),
    fromVersion: options.fromVersion,
    toVersion,
    upcast: options.upcast,
  };

  if (options.description) {
    (upcaster as { description?: string }).description = options.description;
  }

  return Object.freeze(upcaster);
}

export interface UpcasterRegistryOptions {
  versionExtractor?: VersionExtractor | undefined;
}

/**
 * Registry and coordinator for event upcasters.
 */
export class UpcasterRegistry {
  private readonly versionExtractor: VersionExtractor;
  /** Map of eventType -> Map of fromVersion -> Upcaster */
  private readonly upcasters = new Map<string, Map<number, Upcaster>>();

  constructor(options?: UpcasterRegistryOptions) {
    this.versionExtractor = options?.versionExtractor ?? defaultVersionExtractor;
  }

  /**
   * Registers an upcaster instance for its declared eventType and fromVersion.
   */
  public register<TInput = unknown, TOutput = unknown>(
    upcaster: Upcaster<TInput, TOutput>,
  ): this {
    if (!upcaster || typeof upcaster !== 'object') {
      throw new AirError('INVALID_ARGUMENT', 'Upcaster must be a valid object');
    }
    if (!upcaster.eventType || upcaster.eventType.trim().length === 0) {
      throw new AirError('INVALID_ARGUMENT', 'Upcaster eventType cannot be empty');
    }
    if (!Number.isInteger(upcaster.fromVersion) || upcaster.fromVersion <= 0) {
      throw new AirError('INVALID_ARGUMENT', `fromVersion must be a positive integer, got: ${upcaster.fromVersion}`);
    }
    if (!Number.isInteger(upcaster.toVersion) || upcaster.toVersion <= upcaster.fromVersion) {
      throw new AirError('INVALID_ARGUMENT', `toVersion must be greater than fromVersion, got: ${upcaster.toVersion}`);
    }
    if (typeof upcaster.upcast !== 'function') {
      throw new AirError('INVALID_ARGUMENT', 'Upcaster upcast method must be a function');
    }

    const typeKey = upcaster.eventType.trim();
    let typeMap = this.upcasters.get(typeKey);
    if (!typeMap) {
      typeMap = new Map<number, Upcaster>();
      this.upcasters.set(typeKey, typeMap);
    }

    if (typeMap.has(upcaster.fromVersion)) {
      throw new AirError(
        'ALREADY_EXISTS',
        `Upcaster already registered for "${typeKey}" from version ${upcaster.fromVersion}`,
      );
    }

    typeMap.set(upcaster.fromVersion, upcaster);
    return this;
  }

  /**
   * Convenience helper to register a functional upcaster directly.
   */
  public registerFn<TInput = unknown, TOutput = unknown>(
    eventType: string,
    fromVersion: number,
    upcast: UpcasterFunction<TInput, TOutput>,
    options?: { toVersion?: number | undefined; description?: string | undefined },
  ): this {
    const upcaster = createUpcaster<TInput, TOutput>({
      eventType,
      fromVersion,
      toVersion: options?.toVersion,
      description: options?.description,
      upcast,
    });
    return this.register(upcaster);
  }

  /**
   * Checks whether upcasters are registered for a given event type (and optional fromVersion).
   */
  public has(eventType: string, fromVersion?: number): boolean {
    const typeMap = this.upcasters.get(eventType.trim());
    if (!typeMap) return false;
    if (fromVersion !== undefined) {
      return typeMap.has(fromVersion);
    }
    return typeMap.size > 0;
  }

  /**
   * Returns all upcasters registered for an event type, ordered by fromVersion.
   */
  public getUpcastersFor(eventType: string): ReadonlyArray<Upcaster> {
    const typeMap = this.upcasters.get(eventType.trim());
    if (!typeMap) return [];
    return Array.from(typeMap.values()).sort((a, b) => a.fromVersion - b.fromVersion);
  }

  /**
   * Returns all event types that have registered upcasters.
   */
  public getRegisteredTypes(): string[] {
    return Array.from(this.upcasters.keys()).sort();
  }

  /**
   * Returns the maximum reachable target version for an event type, or 1 if unmanaged.
   */
  public getTargetVersion(eventType: string): number {
    const list = this.getUpcastersFor(eventType);
    if (list.length === 0) return 1;
    let max = 1;
    for (const u of list) {
      if (u.toVersion > max) {
        max = u.toVersion;
      }
    }
    return max;
  }

  /**
   * Clears all registered upcasters.
   */
  public clear(): void {
    this.upcasters.clear();
  }

  /**
   * Upcasts an EventEnvelope from its current schema version through all applicable
   * registered migration steps until the highest target version is reached.
   *
   * If no upcasters apply, the original envelope is returned unmodified.
   */
  public upcast<T = unknown>(envelope: EventEnvelope): EventEnvelope<T> {
    if (!envelope || typeof envelope !== 'object') {
      throw new AirError('INVALID_ARGUMENT', 'Envelope must be a non-null object');
    }
    if (!envelope.type || typeof envelope.type !== 'string') {
      throw new AirError('INVALID_ARGUMENT', 'Envelope must have a valid string type');
    }

    const typeMap = this.upcasters.get(envelope.type);
    if (!typeMap || typeMap.size === 0) {
      return envelope as EventEnvelope<T>;
    }

    const currentVersion = this.versionExtractor(envelope);
    const targetVersion = this.getTargetVersion(envelope.type);

    if (currentVersion >= targetVersion) {
      return envelope as EventEnvelope<T>;
    }

    // Resolve sequential migration path
    let v = currentVersion;
    const chain: Upcaster[] = [];

    while (v < targetVersion) {
      const nextUpcaster = typeMap.get(v);
      if (!nextUpcaster) {
        // Gap in migration chain
        throw new AirError(
          'INVALID_STATE',
          `Broken upcaster chain for "${envelope.type}": missing migration step from version ${v} to ${v + 1}`,
        );
      }
      chain.push(nextUpcaster);
      v = nextUpcaster.toVersion;
    }

    // Apply migrations sequentially
    let currentEnvelope = envelope;
    for (const step of chain) {
      let result: EventEnvelope;
      try {
        result = step.upcast(currentEnvelope);
      } catch (err) {
        throw new AirError(
          'UPCASTER_FAILED',
          `Upcaster failed for "${step.eventType}" (v${step.fromVersion} -> v${step.toVersion}): ${err instanceof Error ? err.message : String(err)}`,
          {
            cause: err instanceof Error ? err : undefined,
          },
        );
      }

      if (!result || typeof result !== 'object' || !result.id || !result.type || result.seq === undefined) {
        throw new AirError(
          'UPCASTER_FAILED',
          `Upcaster for "${step.eventType}" (v${step.fromVersion} -> v${step.toVersion}) returned an invalid EventEnvelope`,
        );
      }

      currentEnvelope = result;
    }

    return Object.freeze(currentEnvelope) as EventEnvelope<T>;
  }

  /**
   * Applies upcasting to an iterable collection of envelopes.
   */
  public upcastAll(envelopes: Iterable<EventEnvelope>): EventEnvelope[] {
    const results: EventEnvelope[] = [];
    for (const env of envelopes) {
      results.push(this.upcast(env));
    }
    return results;
  }

  /**
   * Asynchronous generator streaming upcasted envelopes.
   */
  public async *upcastStream(stream: AsyncIterable<EventEnvelope>): AsyncIterable<EventEnvelope> {
    for await (const env of stream) {
      yield this.upcast(env);
    }
  }
}

// ---------------------------------------------------------------------------
// Synthetic Test Fixtures (P2-T07: Synthetic v1 -> v2 schema migration)
// ---------------------------------------------------------------------------

/**
 * Synthetic V1 event payload schema for migration testing and demonstration.
 */
export const SyntheticV1PayloadSchema = z.object({
  user: z.string().min(1),
  action: z.string().min(1),
  timestamp: z.number().int().positive(),
});

export type SyntheticV1Payload = z.infer<typeof SyntheticV1PayloadSchema>;

/**
 * Synthetic V2 event payload schema (re-structured fields, ISO timestamp, metadata).
 */
export const SyntheticV2PayloadSchema = z.object({
  userId: z.string().min(1),
  actionType: z.string().min(1),
  performedAt: z.string().datetime({ offset: true }),
  metadata: z.object({
    migratedFromV1: z.boolean(),
  }),
});

export type SyntheticV2Payload = z.infer<typeof SyntheticV2PayloadSchema>;

/**
 * Synthetic V3 event payload schema (further evolution: tags and tenantId).
 */
export const SyntheticV3PayloadSchema = z.object({
  userId: z.string().min(1),
  actionType: z.string().min(1),
  performedAt: z.string().datetime({ offset: true }),
  tenantId: z.string().min(1),
  tags: z.array(z.string()),
  metadata: z.object({
    migratedFromV1: z.boolean(),
    migratedFromV2: z.boolean(),
  }),
});

export type SyntheticV3Payload = z.infer<typeof SyntheticV3PayloadSchema>;

/**
 * Canonical synthetic V1 -> V2 upcaster implementation.
 */
export const syntheticV1ToV2Upcaster: Upcaster<SyntheticV1Payload, SyntheticV2Payload> = createUpcaster({
  eventType: 'synthetic.action',
  fromVersion: 1,
  toVersion: 2,
  description: 'Migrate synthetic.action v1 -> v2: user to userId, action to actionType, timestamp to performedAt ISO',
  upcast(envelope: EventEnvelope<SyntheticV1Payload>): EventEnvelope<SyntheticV2Payload> {
    const v1 = envelope.payload;
    const v2Payload: SyntheticV2Payload = {
      userId: v1.user,
      actionType: v1.action,
      performedAt: new Date(v1.timestamp).toISOString(),
      metadata: {
        migratedFromV1: true,
      },
    };

    return {
      ...envelope,
      payload: v2Payload,
      meta: {
        ...envelope.meta,
        schemaVersion: 2,
      },
    };
  },
});

/**
 * Canonical synthetic V2 -> V3 upcaster implementation.
 */
export const syntheticV2ToV3Upcaster: Upcaster<SyntheticV2Payload, SyntheticV3Payload> = createUpcaster({
  eventType: 'synthetic.action',
  fromVersion: 2,
  toVersion: 3,
  description: 'Migrate synthetic.action v2 -> v3: add tenantId default and tags array',
  upcast(envelope: EventEnvelope<SyntheticV2Payload>): EventEnvelope<SyntheticV3Payload> {
    const v2 = envelope.payload;
    const v3Payload: SyntheticV3Payload = {
      userId: v2.userId,
      actionType: v2.actionType,
      performedAt: v2.performedAt,
      tenantId: 'default',
      tags: ['migrated'],
      metadata: {
        migratedFromV1: v2.metadata.migratedFromV1,
        migratedFromV2: true,
      },
    };

    return {
      ...envelope,
      payload: v3Payload,
      meta: {
        ...envelope.meta,
        schemaVersion: 3,
      },
    };
  },
});
