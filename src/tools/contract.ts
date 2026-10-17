/**
 * Tool Contract & Specification (Phase 4 - P4-T01).
 *
 * Defines:
 * - Tool risk classification ('low' | 'medium' | 'high' | 'critical')
 * - Tool capability descriptor model for policy engine derivation
 * - ToolDefinition<TInput, TOutput> with Zod input/output schemas
 * - Derived JSON Schema extraction for LLM tool calling
 * - Bridge to ProviderToolDefinition
 * - Type-safe validation utilities throwing normalized AirError
 */

import { z } from 'zod';
import { AirError } from '../errors/index.js';
import type { ProviderToolDefinition } from '../providers/index.js';
import type { ToolCallId } from '../types/index.js';
import type { Clock, Random } from '../util/index.js';

// ============================================================================
// Risk Classification
// ============================================================================

export const ToolRiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type ToolRiskLevel = z.infer<typeof ToolRiskLevelSchema>;

// ============================================================================
// Tool Capability Descriptors
// ============================================================================

export const ToolCapabilitySchema = z.object({
  /** Capability domain/type, e.g. 'fs', 'net', 'exec', 'system'. */
  type: z.string().min(1),
  /** Specific action within domain, e.g. 'read', 'write', 'execute', 'connect'. */
  action: z.string().min(1).optional(),
  /** Specific target resource, e.g. path, host, process name. */
  resource: z.string().optional(),
  /** Additional structured metadata for granular policy inspection. */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;

// ============================================================================
// Execution Context & Output
// ============================================================================

export interface ToolExecutionContext {
  /** Unique invocation ID for this tool call. */
  readonly callId: string;
  /** Active run identifier. */
  readonly runId: string;
  /** Session identifier if running in a session. */
  readonly sessionId?: string | undefined;
  /** Agent identifier initiating this tool call. */
  readonly agentId?: string | undefined;
  /** AbortSignal for cooperative cancellation and timeouts. */
  readonly signal?: AbortSignal | undefined;
  /** Injected clock for deterministic timestamps (Rule R6). */
  readonly clock: Clock;
  /** Injected random generator for determinism (Rule R6). */
  readonly random?: Random | undefined;
  /** Execution timeout in milliseconds. */
  readonly timeoutMs?: number | undefined;
  /** Maximum output size in bytes. */
  readonly maxOutputBytes?: number | undefined;
  /** Working directory or jail root for relative paths. */
  readonly workspaceRoot?: string | undefined;
}

export interface ToolExecutionResult<TOutput = unknown> {
  readonly callId?: ToolCallId | undefined;
  readonly toolName?: string | undefined;
  readonly output: TOutput;
  readonly truncated?: boolean | undefined;
  readonly durationMs?: number | undefined;
  readonly capabilities?: readonly ToolCapability[] | undefined;
  readonly meta?: Record<string, unknown> | undefined;
}

// ============================================================================
// Tool Definition Contract
// ============================================================================

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  /** Globally unique tool name, e.g. "fs.read", "exec.run". */
  readonly name: string;
  /** Clear human-readable description for LLM system prompts. */
  readonly description: string;
  /** Semver version string (e.g. "1.0.0"). */
  readonly version?: string | undefined;
  /** Risk classification. */
  readonly risk: ToolRiskLevel;
  /** Whether re-execution with identical arguments is side-effect safe. */
  readonly idempotent: boolean;
  /** Default execution timeout in milliseconds. */
  readonly defaultTimeoutMs?: number | undefined;
  /** Maximum output bytes allowed before truncation. */
  readonly maxOutputBytes?: number | undefined;
  /** Zod schema validating input arguments. */
  readonly inputSchema: z.ZodType<TInput>;
  /** Optional Zod schema validating tool output. */
  readonly outputSchema?: z.ZodType<TOutput> | undefined;
  /** Computes the capabilities requested by this invocation for policy evaluation. */
  readonly capabilities?: ((args: TInput) => readonly ToolCapability[]) | undefined;
  /** Tool execution implementation. */
  readonly execute: (args: TInput, ctx: ToolExecutionContext) => Promise<TOutput>;
}

/**
 * Erased tool definition for heterogeneous storage and registries.
 */
export interface AnyTool {
  readonly name: string;
  readonly description: string;
  readonly version?: string | undefined;
  readonly risk: ToolRiskLevel;
  readonly idempotent: boolean;
  readonly defaultTimeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly inputSchema: z.ZodType<unknown>;
  readonly outputSchema?: z.ZodType<unknown> | undefined;
  readonly capabilities?: ((args: unknown) => readonly ToolCapability[]) | undefined;
  readonly execute: (args: unknown, ctx: ToolExecutionContext) => Promise<unknown>;
}

/**
 * Converts any generic ToolDefinition into an erased AnyTool.
 */
export function toAnyTool<TInput, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
): AnyTool {
  const capFn = tool.capabilities;
  return {
    name: tool.name,
    description: tool.description,
    version: tool.version,
    risk: tool.risk,
    idempotent: tool.idempotent,
    defaultTimeoutMs: tool.defaultTimeoutMs,
    maxOutputBytes: tool.maxOutputBytes,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    capabilities: capFn ? (args: unknown) => capFn(args as TInput) : undefined,
    execute: (args: unknown, ctx: ToolExecutionContext) =>
      tool.execute(args as TInput, ctx),
  };
}

// ============================================================================
// Factory & Helper Utilities
// ============================================================================

/**
 * Creates and type-checks a ToolDefinition.
 */
export function defineTool<TInput, TOutput>(
  definition: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  if (!definition.name || definition.name.trim().length === 0) {
    throw new AirError('INVALID_ARGUMENT', 'Tool name must not be empty');
  }
  if (!definition.description || definition.description.trim().length === 0) {
    throw new AirError('INVALID_ARGUMENT', `Tool "${definition.name}" must have a description`);
  }
  return definition;
}

/**
 * Derives a clean JSON Schema from a Zod schema suitable for LLM provider tool calling.
 */
export function deriveJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const rawSchema = z.toJSONSchema(schema) as Record<string, unknown>;

  // Clean top-level schema metadata not expected by LLM tool parameters
  const cleaned: Record<string, unknown> = { ...rawSchema };
  delete cleaned['$schema'];
  delete cleaned['additionalProperties'];

  // Ensure type is object if properties are present
  if (cleaned.properties && !cleaned.type) {
    cleaned.type = 'object';
  }

  return cleaned;
}

/**
 * Converts an AIR ToolDefinition into a ProviderToolDefinition for LLM request payloads.
 */
export function toProviderToolDefinition<TInput, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
): ProviderToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: deriveJsonSchema(tool.inputSchema),
  };
}

/**
 * Validates raw arguments against a tool's input schema.
 * Throws typed AirError('INVALID_ARGUMENT') on validation failure.
 */
export function validateToolInput<TInput, TOutput = unknown>(
  tool: ToolDefinition<TInput, TOutput>,
  rawArgs: unknown,
): TInput {
  const parseResult = tool.inputSchema.safeParse(rawArgs);
  if (!parseResult.success) {
    const errorDetails = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new AirError('INVALID_ARGUMENT', `Invalid arguments for tool "${tool.name}": ${errorDetails}`, {
      context: {
        tool: tool.name,
        issues: parseResult.error.issues,
      },
    });
  }
  return parseResult.data;
}

/**
 * Validates tool execution output against an output schema if configured.
 * Throws typed AirError('INTERNAL') on schema mismatch.
 */
export function validateToolOutput<TInput, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
  rawOutput: unknown,
): TOutput {
  if (!tool.outputSchema) {
    return rawOutput as TOutput;
  }
  const parseResult = tool.outputSchema.safeParse(rawOutput);
  if (!parseResult.success) {
    const errorDetails = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new AirError('INTERNAL', `Output validation failed for tool "${tool.name}": ${errorDetails}`, {
      context: {
        tool: tool.name,
        issues: parseResult.error.issues,
      },
    });
  }
  return parseResult.data;
}
