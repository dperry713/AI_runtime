/**
 * Built-in Memory Tools (Phase 8 - P8-T06).
 *
 * Implements three policy-governed memory tools:
 * - memory.search: keyword/vector/hybrid search over the memory store
 * - memory.write: write a memory entry through the write policy (secret/PII scrub, taint enforcement)
 * - memory.forget: delete a memory entry by ID or by filter
 *
 * Adheres to:
 * - Rule R3: Every tool call goes through the policy engine (write policy enforced on memory.write)
 * - Rule R6: Injected Clock and IdGenerator (via store and policy)
 * - Rule R11: Typed AirError errors
 * - Rule R12: Zod argument schema validation at the tool boundary
 * - Rule S9 / Threat T11: Tainted inputs cannot be stored as clean memories
 */

import { z } from 'zod';
import {
  type AnyTool,
  defineTool,
  toAnyTool,
  type ToolCapability,
  type ToolDefinition,
  type ToolExecutionContext,
} from '../contract.js';
import type { ToolRegistry } from '../registry.js';
import {
  parseAgentId,
  parseMemoryId,
  parseRunId,
  parseSessionId,
  parseToolCallId,
  parseTurnId,
} from '../../types/index.js';
import {
  type CreateMemoryInput,
  type MemoryFilter,
  type MemorySearchQuery,
  type MemoryStore,
  type MemoryWriteContext,
  type MemoryWritePolicy,
} from '../../memory/index.js';

// ============================================================================
// 1. memory.search
// ============================================================================

export const MemorySearchInputSchema = z.object({
  query: z.string().min(1).describe('Search query text'),
  filter: z
    .object({
      kinds: z.array(z.enum(['episodic', 'semantic', 'working'])).optional(),
      scopes: z.array(z.enum(['agent', 'session', 'run', 'global'])).optional(),
      agentId: z.string().optional().describe('Agent ID for agent-scoped filter'),
      sessionId: z.string().optional().describe('Session ID for session-scoped filter'),
      runId: z.string().optional().describe('Run ID for run-scoped filter'),
      tags: z.array(z.string()).optional().describe('All specified tags must be present'),
      taint: z
        .array(z.enum(['clean', 'tainted', 'untrusted']))
        .optional()
        .describe('Filter by memory taint level'),
      minImportance: z.number().min(0).max(1).optional(),
      includeExpired: z.boolean().optional().describe('Include expired memories'),
    })
    .optional()
    .describe('Optional filter to narrow search results'),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .default(10)
    .describe('Maximum number of results to return'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(0)
    .describe('Offset for pagination'),
  mode: z
    .enum(['keyword', 'vector', 'hybrid'])
    .optional()
    .default('keyword')
    .describe('Search mode: keyword (BM25/FTS5), vector (cosine similarity), or hybrid'),
  vector: z
    .array(z.number())
    .optional()
    .describe('Query vector for vector or hybrid search'),
  minScore: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Minimum composite score threshold'),
});

export type MemorySearchInput = z.infer<typeof MemorySearchInputSchema>;

export const MemorySearchOutputSchema = z.object({
  results: z.array(
    z.object({
      entry: z.any().describe('Memory entry'),
      score: z.number().describe('Composite relevance score (0-1)'),
      matchedBy: z.string().describe('Search mode that matched'),
      highlights: z
        .object({
          title: z.array(z.string()).optional(),
          content: z.array(z.string()).optional(),
        })
        .optional()
        .describe('Highlight snippets from keyword search'),
    }),
  ),
  count: z.number().int().nonnegative().describe('Number of results returned'),
});

export type MemorySearchOutput = z.infer<typeof MemorySearchOutputSchema>;

export function createMemorySearchTool(
  store: MemoryStore,
): ToolDefinition<MemorySearchInput, MemorySearchOutput> {
  return defineTool({
    name: 'memory.search',
    description:
      'Searches the agent memory store using keyword (BM25/FTS5), vector (cosine similarity), or hybrid search. Returns ranked results with scores and highlights.',
    risk: 'low',
    idempotent: true,
    inputSchema: MemorySearchInputSchema,
    outputSchema: MemorySearchOutputSchema,
    capabilities: (args): readonly ToolCapability[] => [
      {
        type: 'memory',
        action: 'search',
        resource: args.filter?.scopes?.[0] ?? 'global',
      },
    ],
    execute: async (args: MemorySearchInput): Promise<MemorySearchOutput> => {
      const filter: MemoryFilter | undefined = args.filter
        ? {
            kinds: args.filter.kinds,
            scopes: args.filter.scopes,
            agentId: args.filter.agentId ? parseAgentId(args.filter.agentId) : undefined,
            sessionId: args.filter.sessionId
              ? parseSessionId(args.filter.sessionId)
              : undefined,
            runId: args.filter.runId ? parseRunId(args.filter.runId) : undefined,
            tags: args.filter.tags,
            taint: args.filter.taint,
            minImportance: args.filter.minImportance,
            includeExpired: args.filter.includeExpired,
          }
        : undefined;

      const query: MemorySearchQuery = {
        query: args.query,
        filter,
        limit: args.limit,
        offset: args.offset,
        mode: args.mode,
        vector: args.vector,
        minScore: args.minScore,
      };

      const results = await store.search(query);

      return {
        results: results.map((r) => ({
          entry: r.entry,
          score: r.score,
          matchedBy: r.matchedBy,
          highlights: r.highlights,
        })),
        count: results.length,
      };
    },
  });
}

// ============================================================================
// 2. memory.write
// ============================================================================

export const MemoryWriteInputSchema = z
  .object({
    kind: z.enum(['episodic', 'semantic', 'working']).describe('Memory kind'),
    scope: z
      .enum(['agent', 'session', 'run', 'global'])
      .describe('Memory scope (agent/session/run/global)'),
    title: z.string().min(1).max(256).describe('Memory title'),
    content: z.string().min(1).describe('Memory content'),
    tags: z
      .array(z.string().min(1).max(64))
      .optional()
      .describe('Memory tags (max 20, max 64 chars each)'),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Arbitrary metadata key-value pairs'),
    importance: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.5)
      .describe('Importance weight (0-1)'),
    provenance: z
      .object({
        source: z.enum(['user', 'model', 'tool', 'system', 'consolidated']),
        actorId: z.string().optional(),
        runId: z.string().optional(),
        turnId: z.string().optional(),
        toolCallId: z.string().optional(),
        taint: z.enum(['clean', 'tainted', 'untrusted']).optional(),
      })
      .optional()
      .describe('Provenance and taint information'),
    ttlSeconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Time-to-live in seconds'),
    embedding: z.array(z.number()).optional().describe('Pre-computed embedding vector'),
    agentId: z.string().optional().describe('Agent ID (required for agent scope)'),
    sessionId: z.string().optional().describe('Session ID (required for session scope)'),
    runId: z.string().optional().describe('Run ID (required for run scope)'),
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

export type MemoryWriteInput = z.infer<typeof MemoryWriteInputSchema>;

export const MemoryWriteOutputSchema = z.object({
  id: z.string().describe('Memory entry ID'),
  entry: z.any().describe('The written memory entry'),
});

export type MemoryWriteOutput = z.infer<typeof MemoryWriteOutputSchema>;

function buildWriteContext(ctx: ToolExecutionContext): MemoryWriteContext {
  return {
    callingAgentId: ctx.agentId ? parseAgentId(ctx.agentId) : undefined,
    callingSessionId: ctx.sessionId ? parseSessionId(ctx.sessionId) : undefined,
    callingRunId: ctx.runId ? parseRunId(ctx.runId) : undefined,
    callingToolCallId: ctx.callId ? parseToolCallId(ctx.callId) : undefined,
    source: 'tool',
    actorId: ctx.agentId,
  };
}

export function createMemoryWriteTool(
  store: MemoryStore,
  writePolicy: MemoryWritePolicy,
): ToolDefinition<MemoryWriteInput, MemoryWriteOutput> {
  return defineTool({
    name: 'memory.write',
    description:
      'Writes a memory entry to the store. All writes pass through the memory write policy which scrubs secrets/PII (Rule R4), enforces scope boundaries, and applies taint tracking (Rule S9 / Threat T11). Tainted inputs cannot be stored as clean memories.',
    risk: 'medium',
    idempotent: false,
    inputSchema: MemoryWriteInputSchema,
    outputSchema: MemoryWriteOutputSchema,
    capabilities: (args): readonly ToolCapability[] => [
      { type: 'memory', action: 'write', resource: args.scope },
    ],
    execute: async (args: MemoryWriteInput, ctx: ToolExecutionContext): Promise<MemoryWriteOutput> => {
      const context = buildWriteContext(ctx);

      const input: CreateMemoryInput = {
        kind: args.kind,
        scope: args.scope,
        title: args.title,
        content: args.content,
        tags: args.tags,
        metadata: args.metadata,
        importance: args.importance,
        provenance: args.provenance
          ? {
              source: args.provenance.source,
              actorId: args.provenance.actorId,
              runId: args.provenance.runId ? parseRunId(args.provenance.runId) : undefined,
              turnId: args.provenance.turnId ? parseTurnId(args.provenance.turnId) : undefined,
              toolCallId: args.provenance.toolCallId
                ? parseToolCallId(args.provenance.toolCallId)
                : undefined,
              taint: args.provenance.taint ?? 'clean',
            }
          : undefined,
        ttlSeconds: args.ttlSeconds,
        embedding: args.embedding,
        agentId: args.agentId ? parseAgentId(args.agentId) : undefined,
        sessionId: args.sessionId ? parseSessionId(args.sessionId) : undefined,
        runId: args.runId ? parseRunId(args.runId) : undefined,
      };

      // Enforce write policy: scrub secrets/PII, validate scope, enforce taint
      const sanitizedInput = writePolicy.assertAllowed(input, context);

      const entry = await store.write(sanitizedInput);

      return {
        id: entry.id,
        entry,
      };
    },
  });
}

// ============================================================================
// 3. memory.forget
// ============================================================================

export const MemoryForgetInputSchema = z.object({
  id: z.string().optional().describe('Memory entry ID to forget'),
  filter: z
    .object({
      kinds: z.array(z.enum(['episodic', 'semantic', 'working'])).optional(),
      scopes: z.array(z.enum(['agent', 'session', 'run', 'global'])).optional(),
      agentId: z.string().optional(),
      sessionId: z.string().optional(),
      runId: z.string().optional(),
      tags: z.array(z.string()).optional(),
      taint: z
        .array(z.enum(['clean', 'tainted', 'untrusted']))
        .optional(),
      minImportance: z.number().min(0).max(1).optional(),
      includeExpired: z.boolean().optional(),
    })
    .optional()
    .describe('Filter to forget multiple memories matching criteria'),
})
  .refine(
    (data) => data.id !== undefined || data.filter !== undefined,
    { message: 'Either id or filter must be provided' },
  );

export type MemoryForgetInput = z.infer<typeof MemoryForgetInputSchema>;

export const MemoryForgetOutputSchema = z.object({
  deleted: z.number().int().nonnegative().describe('Number of memories deleted'),
  ids: z.array(z.string()).optional().describe('IDs of deleted memories (when forgetting by ID)'),
});

export type MemoryForgetOutput = z.infer<typeof MemoryForgetOutputSchema>;

export function createMemoryForgetTool(
  store: MemoryStore,
): ToolDefinition<MemoryForgetInput, MemoryForgetOutput> {
  return defineTool({
    name: 'memory.forget',
    description:
      'Forgets (deletes) a memory entry by ID, or multiple entries matching a filter. Forgetting removes the row, FTS index entry, and vector embedding. High risk: cannot be undone.',
    risk: 'high',
    idempotent: true,
    inputSchema: MemoryForgetInputSchema,
    outputSchema: MemoryForgetOutputSchema,
    capabilities: (args): readonly ToolCapability[] => [
      {
        type: 'memory',
        action: 'forget',
        resource: args.filter?.scopes?.[0] ?? 'global',
      },
    ],
    execute: async (args: MemoryForgetInput): Promise<MemoryForgetOutput> => {
      if (args.id !== undefined) {
        const memoryId = parseMemoryId(args.id);
        const removed = await store.forget(memoryId);
        return {
          deleted: removed ? 1 : 0,
          ids: removed ? [args.id] : [],
        };
      }

      const filter: MemoryFilter | undefined = args.filter
        ? {
            kinds: args.filter.kinds,
            scopes: args.filter.scopes,
            agentId: args.filter.agentId ? parseAgentId(args.filter.agentId) : undefined,
            sessionId: args.filter.sessionId
              ? parseSessionId(args.filter.sessionId)
              : undefined,
            runId: args.filter.runId ? parseRunId(args.filter.runId) : undefined,
            tags: args.filter.tags,
            taint: args.filter.taint,
            minImportance: args.filter.minImportance,
            includeExpired: args.filter.includeExpired,
          }
        : undefined;

      const deleted = await store.forgetByFilter(filter ?? {});
      return { deleted, ids: undefined };
    },
  });
}

// ============================================================================
// Catalogue & Registration Helper
// ============================================================================

/**
 * Creates all three memory tools bound to the given store and write policy.
 */
export function createMemoryTools(
  store: MemoryStore,
  writePolicy: MemoryWritePolicy,
): {
  memorySearchTool: ToolDefinition<MemorySearchInput, MemorySearchOutput>;
  memoryWriteTool: ToolDefinition<MemoryWriteInput, MemoryWriteOutput>;
  memoryForgetTool: ToolDefinition<MemoryForgetInput, MemoryForgetOutput>;
} {
  return {
    memorySearchTool: createMemorySearchTool(store),
    memoryWriteTool: createMemoryWriteTool(store, writePolicy),
    memoryForgetTool: createMemoryForgetTool(store),
  };
}

/**
 * Erased tool definitions for registry registration.
 */
export function createBuiltinMemoryTools(
  store: MemoryStore,
  writePolicy: MemoryWritePolicy,
): readonly AnyTool[] {
  const { memorySearchTool, memoryWriteTool, memoryForgetTool } = createMemoryTools(
    store,
    writePolicy,
  );
  return [toAnyTool(memorySearchTool), toAnyTool(memoryWriteTool), toAnyTool(memoryForgetTool)];
}

/**
 * Registers all three memory tools into a ToolRegistry.
 */
export function registerBuiltinMemoryTools(
  registry: ToolRegistry,
  store: MemoryStore,
  writePolicy: MemoryWritePolicy,
): void {
  registry.registerMany(createBuiltinMemoryTools(store, writePolicy));
}
