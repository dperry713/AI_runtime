import { z } from 'zod';
import type { MemoryId } from '../types/index.js';
import {
  MemoryIdSchema,
  AgentIdSchema,
  SessionIdSchema,
  RunIdSchema,
  TurnIdSchema,
  ToolCallIdSchema,
} from '../types/index.js';

// --- Memory Classification ---

export const MemoryKindSchema = z.enum(['episodic', 'semantic', 'working']);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemoryScopeSchema = z.enum(['agent', 'session', 'run', 'global']);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemoryTaintSchema = z.enum(['clean', 'tainted', 'untrusted']);
export type MemoryTaint = z.infer<typeof MemoryTaintSchema>;

export const MemorySourceSchema = z.enum(['user', 'model', 'tool', 'system', 'consolidated']);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

// --- Provenance & Metadata ---

export const MemoryProvenanceSchema = z.object({
  source: MemorySourceSchema,
  actorId: z.string().optional(),
  runId: RunIdSchema.optional(),
  turnId: TurnIdSchema.optional(),
  toolCallId: ToolCallIdSchema.optional(),
  taint: MemoryTaintSchema.default('clean'),
});
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>;

// --- Memory Entry ---

export const MemoryEntrySchema = z.object({
  id: MemoryIdSchema,
  kind: MemoryKindSchema,
  scope: MemoryScopeSchema,
  agentId: AgentIdSchema.optional(),
  sessionId: SessionIdSchema.optional(),
  runId: RunIdSchema.optional(),
  title: z.string().min(1).max(256),
  content: z.string().min(1),
  tags: z.array(z.string().min(1).max(64)).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  importance: z.number().min(0).max(1).default(0.5),
  provenance: MemoryProvenanceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  accessedAt: z.string().datetime().optional(),
  accessCount: z.number().int().nonnegative().default(0),
  ttlSeconds: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
  embedding: z.array(z.number()).optional(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

// --- Input Contracts ---

export const CreateMemoryInputSchema = z
  .object({
    id: MemoryIdSchema.optional(),
    kind: MemoryKindSchema,
    scope: MemoryScopeSchema,
    agentId: AgentIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
    runId: RunIdSchema.optional(),
    title: z.string().min(1).max(256),
    content: z.string().min(1),
    tags: z.array(z.string().min(1).max(64)).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    importance: z.number().min(0).max(1).optional(),
    provenance: MemoryProvenanceSchema.optional(),
    ttlSeconds: z.number().int().positive().optional(),
    embedding: z.array(z.number()).optional(),
  })
  .refine(
    (data) => {
      if (data.scope === 'agent' && !data.agentId) return false;
      if (data.scope === 'session' && !data.sessionId) return false;
      if (data.scope === 'run' && !data.runId) return false;
      return true;
    },
    {
      message: 'Scoped memory requires corresponding scope ID (agentId, sessionId, or runId)',
    },
  );
export type CreateMemoryInput = z.infer<typeof CreateMemoryInputSchema>;

export const UpdateMemoryInputSchema = z.object({
  title: z.string().min(1).max(256).optional(),
  content: z.string().min(1).optional(),
  tags: z.array(z.string().min(1).max(64)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  importance: z.number().min(0).max(1).optional(),
  ttlSeconds: z.number().int().positive().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  embedding: z.array(z.number()).nullable().optional(),
});
export type UpdateMemoryInput = z.infer<typeof UpdateMemoryInputSchema>;

// --- Filter & Search Contracts ---

export const MemoryFilterSchema = z.object({
  kinds: z.array(MemoryKindSchema).optional(),
  scopes: z.array(MemoryScopeSchema).optional(),
  agentId: AgentIdSchema.optional(),
  sessionId: SessionIdSchema.optional(),
  runId: RunIdSchema.optional(),
  tags: z.array(z.string()).optional(),
  taint: z.array(MemoryTaintSchema).optional(),
  minImportance: z.number().min(0).max(1).optional(),
  includeExpired: z.boolean().optional(),
});
export type MemoryFilter = z.infer<typeof MemoryFilterSchema>;

export const MemorySearchModeSchema = z.enum(['keyword', 'vector', 'hybrid']);
export type MemorySearchMode = z.infer<typeof MemorySearchModeSchema>;

export const MemorySearchQuerySchema = z.object({
  query: z.string().min(1),
  filter: MemoryFilterSchema.optional(),
  limit: z.number().int().positive().max(100).default(10),
  offset: z.number().int().nonnegative().default(0),
  mode: MemorySearchModeSchema.default('keyword'),
  vector: z.array(z.number()).optional(),
  minScore: z.number().min(0).max(1).optional(),
});
export type MemorySearchQuery = z.input<typeof MemorySearchQuerySchema>;
export type ParsedMemorySearchQuery = z.output<typeof MemorySearchQuerySchema>;

export const MemorySearchResultSchema = z.object({
  entry: MemoryEntrySchema,
  score: z.number(),
  matchedBy: MemorySearchModeSchema,
  highlights: z
    .object({
      title: z.array(z.string()).optional(),
      content: z.array(z.string()).optional(),
    })
    .optional(),
});
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;

// --- Store Interface ---

export interface MemoryStore {
  write(input: CreateMemoryInput): Promise<MemoryEntry>;
  batchWrite(inputs: CreateMemoryInput[]): Promise<MemoryEntry[]>;
  get(id: MemoryId): Promise<MemoryEntry | null>;
  update(id: MemoryId, input: UpdateMemoryInput): Promise<MemoryEntry>;
  forget(id: MemoryId): Promise<boolean>;
  forgetByFilter(filter: MemoryFilter): Promise<number>;
  search(query: MemorySearchQuery): Promise<MemorySearchResult[]>;
  list(filter?: MemoryFilter, options?: { limit?: number; offset?: number }): Promise<MemoryEntry[]>;
  pruneExpired(nowIso?: string): Promise<number>;
  count(filter?: MemoryFilter): Promise<number>;
  close(): Promise<void>;
}

// --- Utilities ---

export function calculateExpiresAt(createdAtIso: string, ttlSeconds: number): string {
  const createdMs = Date.parse(createdAtIso);
  if (Number.isNaN(createdMs)) {
    throw new Error(`Invalid createdAtIso date: ${createdAtIso}`);
  }
  return new Date(createdMs + ttlSeconds * 1000).toISOString();
}

export function isMemoryExpired(entry: Pick<MemoryEntry, 'expiresAt'>, nowIso?: string): boolean {
  if (!entry.expiresAt || !nowIso) {
    return false;
  }
  const nowMs = Date.parse(nowIso);
  const expiresMs = Date.parse(entry.expiresAt);
  if (Number.isNaN(nowMs) || Number.isNaN(expiresMs)) {
    return false;
  }
  return nowMs >= expiresMs;
}

export function matchesFilter(entry: MemoryEntry, filter?: MemoryFilter, nowIso?: string): boolean {
  // Expired check (default to excluding expired unless includeExpired is true)
  const includeExpired = filter?.includeExpired ?? false;
  if (!includeExpired && isMemoryExpired(entry, nowIso)) {
    return false;
  }

  if (!filter) {
    return true;
  }

  // Kind filter
  if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(entry.kind)) {
    return false;
  }

  // Scope filter
  if (filter.scopes && filter.scopes.length > 0 && !filter.scopes.includes(entry.scope)) {
    return false;
  }

  // Specific scope IDs
  if (filter.agentId && entry.agentId !== filter.agentId) {
    return false;
  }
  if (filter.sessionId && entry.sessionId !== filter.sessionId) {
    return false;
  }
  if (filter.runId && entry.runId !== filter.runId) {
    return false;
  }

  // Tags filter (requires all specified tags to be present)
  if (filter.tags && filter.tags.length > 0) {
    const entryTags = new Set(entry.tags);
    for (const tag of filter.tags) {
      if (!entryTags.has(tag)) {
        return false;
      }
    }
  }

  // Taint filter
  if (filter.taint && filter.taint.length > 0 && !filter.taint.includes(entry.provenance.taint)) {
    return false;
  }

  // Importance filter
  if (filter.minImportance !== undefined && entry.importance < filter.minImportance) {
    return false;
  }

  return true;
}

export function validateMemoryEntry(value: unknown): MemoryEntry {
  return MemoryEntrySchema.parse(value);
}

export function validateCreateMemoryInput(value: unknown): CreateMemoryInput {
  return CreateMemoryInputSchema.parse(value);
}
