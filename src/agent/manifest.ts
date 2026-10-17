/**
 * Agent Manifest Schema, Loader, and Validation (Phase 6 - P6-T01).
 *
 * Defines the contract, validation, and lifecycle loading for AIR agents:
 * - AgentManifestSchema: Formal Zod schema validating agent identity, LLM model settings,
 *   tool bindings, policy profile reference, system prompt templates, and budget limits.
 * - parseAgentManifest: Parses JSON or YAML manifest strings with SHA-256 integrity hash.
 * - loadAgentManifestFromFile: Loads manifest from disk via safe jail reading (Rule R2).
 * - resolvePolicyForManifest: Binds agent manifest to built-in or custom PolicyDocument.
 * - renderSystemPrompt: Performs safe template parameter substitution in system prompts.
 * - Standard built-in agent manifests: developer, reviewer, auditor, dev-shell.
 *
 * Adheres to:
 * - Rule R2: Uses safe fs methods (readFileIn) for disk reads
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 * - Rule R12: Zod schema validation
 * - Security S10: Manifest integrity hash check
 */

import crypto from 'node:crypto';
import yaml from 'yaml';
import { z } from 'zod';
import { AirError } from '../errors/index.js';
import {
  getPolicyProfile,
  type PolicyDocument,
  PolicyProfileNameSchema,
} from '../policy/index.js';
import { parseAgentId } from '../types/index.js';
import { readFileIn } from '../util/index.js';

// ============================================================================
// 1. Zod Schemas
// ============================================================================

export const AgentModelConfigSchema = z.object({
  /** Model identifier string, e.g. "claude-3-5-sonnet", "gpt-4o", "mock-model". */
  model: z.string().min(1, 'Model name must not be empty'),
  /** Preferred LLM provider name (e.g. "anthropic", "openai", "ollama", "mock"). */
  provider: z.string().optional(),
  /** Sampling temperature [0, 2]. Default: 0.0 for deterministic execution. */
  temperature: z.number().min(0).max(2).default(0.0),
  /** Max completion tokens per model call. */
  maxTokens: z.number().int().positive().optional(),
  /** Top-p nucleus sampling [0, 1]. */
  topP: z.number().min(0).max(1).optional(),
});
export type AgentModelConfig = z.infer<typeof AgentModelConfigSchema>;

export const AgentBudgetConfigSchema = z.object({
  /** Maximum turns / steps for a single run before halting. */
  maxSteps: z.number().int().positive().optional(),
  /** Maximum total tokens across all model calls. */
  maxTokens: z.number().int().positive().optional(),
  /** Maximum USD cost. */
  maxCostUsd: z.number().nonnegative().optional(),
  /** Maximum wall-clock execution time in seconds. */
  maxWallClockSeconds: z.number().positive().optional(),
});
export type AgentBudgetConfig = z.infer<typeof AgentBudgetConfigSchema>;

export const AgentManifestSchema = z.object({
  /** Schema version. */
  schemaVersion: z.literal(1).default(1),
  /** Unique agent identifier (e.g. "developer", "reviewer", "auditor"). */
  id: z
    .string()
    .min(1)
    .regex(
      /^[a-zA-Z0-9_\-.]+$/,
      'Agent ID must contain only alphanumeric, dashes, dots, or underscores',
    ),
  /** Human-readable agent display name. */
  name: z.string().min(1, 'Agent display name must not be empty'),
  /** Human-readable description of agent role and purpose. */
  description: z.string().min(1, 'Agent description must not be empty'),
  /** Semver version string (e.g. "1.0.0"). */
  version: z.string().default('1.0.0'),
  /** Model configuration for LLM interactions. */
  model: AgentModelConfigSchema,
  /** Base system prompt or prompt template supporting {{variable}} interpolation. */
  systemPrompt: z.string().min(1, 'System prompt must not be empty'),
  /** List of tool names or patterns available to this agent (e.g. ['fs.read', 'exec.run'] or ['*']). */
  tools: z.array(z.string().min(1)).default(['*']),
  /** Policy profile binding: built-in profile name ('readonly' | 'project-write' | 'dev-shell' | 'locked-down') or custom path. */
  policyProfile: z.string().min(1).default('project-write'),
  /** Resource and financial budgets for runs under this agent. */
  budgets: AgentBudgetConfigSchema.optional(),
  /** Maximum tokens in conversation history before triggering compaction. Default: 100,000. */
  maxContextTokens: z.number().int().positive().default(100_000),
  /** Maximum parallel tools scheduled in a single turn. Default: 4. */
  maxParallelTools: z.number().int().positive().default(4),
  /** Custom metadata attributes. */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type AgentManifest = z.infer<typeof AgentManifestSchema>;

export interface LoadedAgentManifest {
  readonly manifest: AgentManifest;
  readonly sha256: string;
  readonly rawText: string;
}

// ============================================================================
// 2. Hash & Template Utilities
// ============================================================================

/**
 * Computes SHA-256 hash of manifest string for integrity checking (Rule S10).
 */
export function computeManifestHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Renders a system prompt template by replacing `{{key}}` tokens with provided values.
 * Leaves unmatched tokens intact or cleans them if required.
 */
export function renderSystemPrompt(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      const val = variables[key];
      return val !== undefined ? val : match;
    }
    return match;
  });
}

// ============================================================================
// 3. Parser & Loader Functions
// ============================================================================

/**
 * Parses and validates an agent manifest from raw JSON or YAML text.
 */
export function parseAgentManifest(
  content: string,
  preferredFormat?: 'json' | 'yaml',
): LoadedAgentManifest {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new AirError('VALIDATION_FAILED', 'Agent manifest content must be a non-empty string');
  }

  const sha256 = computeManifestHash(content);
  let parsedRaw: unknown;

  if (preferredFormat === 'json') {
    try {
      parsedRaw = JSON.parse(content);
    } catch (err) {
      throw new AirError('VALIDATION_FAILED', `Invalid JSON syntax in agent manifest: ${(err as Error).message}`, {
        cause: err instanceof Error ? err : undefined,
      });
    }
  } else if (preferredFormat === 'yaml') {
    try {
      parsedRaw = yaml.parse(content);
    } catch (err) {
      throw new AirError('VALIDATION_FAILED', `Invalid YAML syntax in agent manifest: ${(err as Error).message}`, {
        cause: err instanceof Error ? err : undefined,
      });
    }
  } else {
    // Auto-detect: try JSON first, fallback to YAML
    try {
      parsedRaw = JSON.parse(content);
    } catch {
      try {
        parsedRaw = yaml.parse(content);
      } catch (yamlErr) {
        throw new AirError('VALIDATION_FAILED', `Failed to parse agent manifest as JSON or YAML: ${(yamlErr as Error).message}`, {
          cause: yamlErr instanceof Error ? yamlErr : undefined,
        });
      }
    }
  }

  const result = AgentManifestSchema.safeParse(parsedRaw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new AirError('VALIDATION_FAILED', `Agent manifest validation failed: ${issues}`, {
      context: { issues: result.error.issues },
    });
  }

  // Return branded AgentId validation check
  parseAgentId(result.data.id);

  return {
    manifest: result.data,
    sha256,
    rawText: content,
  };
}

/**
 * Loads and validates an agent manifest file from disk via safe jail reader (Rule R2).
 */
export async function loadAgentManifestFromFile(
  root: string,
  relativePath: string,
): Promise<LoadedAgentManifest> {
  let content: string;
  try {
    content = await readFileIn(root, relativePath, 'utf8');
  } catch (err) {
    if (err instanceof AirError) {
      throw err;
    }
    throw new AirError('NOT_FOUND', `Failed to read agent manifest file at "${relativePath}": ${(err as Error).message}`, {
      cause: err instanceof Error ? err : undefined,
      context: { root, relativePath },
    });
  }

  const ext = relativePath.toLowerCase();
  const format = ext.endsWith('.json') ? 'json' : ext.endsWith('.yaml') || ext.endsWith('.yml') ? 'yaml' : undefined;

  return parseAgentManifest(content, format);
}

/**
 * Binds an agent manifest to its corresponding PolicyDocument.
 * If the manifest specifies a built-in profile, retrieves it directly.
 * If a custom path is specified, calls the customLoader or throws.
 */
export async function resolvePolicyForManifest(
  manifest: AgentManifest,
  customLoader?: (profileRef: string) => Promise<PolicyDocument>,
): Promise<PolicyDocument> {
  const profileRef = manifest.policyProfile;

  // Check if it's one of the built-in profiles
  const profileParse = PolicyProfileNameSchema.safeParse(profileRef);
  if (profileParse.success) {
    return getPolicyProfile(profileParse.data);
  }

  // Otherwise, custom policy document
  if (!customLoader) {
    throw new AirError(
      'CONFIG_INVALID',
      `Agent "${manifest.id}" references custom policy profile "${profileRef}", but no custom loader was provided`,
      { context: { agentId: manifest.id, profileRef } },
    );
  }

  return customLoader(profileRef);
}

// ============================================================================
// 4. Default Standard Agent Manifests
// ============================================================================

export const DEFAULT_DEVELOPER_AGENT: AgentManifest = {
  schemaVersion: 1,
  id: 'developer',
  name: 'Developer Agent',
  description: 'Autonomous software engineering agent capable of reading, editing, and building code in workspace',
  version: '1.0.0',
  model: {
    model: 'claude-3-5-sonnet',
    temperature: 0.0,
    maxTokens: 4096,
  },
  systemPrompt: `You are an expert software engineer operating in the AIR runtime.
Your workspace root is {{workspaceRoot}}.
Follow strict engineering discipline: verify commands, inspect before modifying, test thoroughly.`,
  tools: ['fs.*', 'exec.run', 'http.fetch', 'user.ask', 'plan.update', 'run.finish'],
  policyProfile: 'project-write',
  budgets: {
    maxSteps: 50,
    maxTokens: 500_000,
    maxCostUsd: 10.0,
    maxWallClockSeconds: 1800,
  },
  maxContextTokens: 100_000,
  maxParallelTools: 4,
};

export const DEFAULT_REVIEWER_AGENT: AgentManifest = {
  schemaVersion: 1,
  id: 'reviewer',
  name: 'Code Reviewer Agent',
  description: 'Read-only auditing and code review agent that inspects source files without mutation',
  version: '1.0.0',
  model: {
    model: 'claude-3-5-sonnet',
    temperature: 0.0,
    maxTokens: 4096,
  },
  systemPrompt: `You are an expert code reviewer and security auditor operating in the AIR runtime.
Your workspace root is {{workspaceRoot}}.
Perform thorough, constructive code reviews, identifying bugs, security vulnerabilities, and architectural issues.`,
  tools: ['fs.read', 'fs.list', 'fs.glob', 'fs.grep', 'fs.stat', 'user.ask', 'plan.update', 'run.finish'],
  policyProfile: 'readonly',
  budgets: {
    maxSteps: 25,
    maxTokens: 250_000,
    maxCostUsd: 5.0,
    maxWallClockSeconds: 600,
  },
  maxContextTokens: 80_000,
  maxParallelTools: 4,
};

export const DEFAULT_DEV_SHELL_AGENT: AgentManifest = {
  schemaVersion: 1,
  id: 'dev-shell',
  name: 'Full Toolchain Agent',
  description: 'Autonomous development agent with shell execution and build/test capabilities',
  version: '1.0.0',
  model: {
    model: 'claude-3-5-sonnet',
    temperature: 0.0,
    maxTokens: 4096,
  },
  systemPrompt: `You are an autonomous engineering agent with full dev-shell tooling access in {{workspaceRoot}}.
Execute standard build, test, and git commands safely. Destructive system commands are prohibited.`,
  tools: ['*'],
  policyProfile: 'dev-shell',
  budgets: {
    maxSteps: 100,
    maxTokens: 1_000_000,
    maxCostUsd: 25.0,
    maxWallClockSeconds: 3600,
  },
  maxContextTokens: 120_000,
  maxParallelTools: 6,
};

export const DEFAULT_AUDITOR_AGENT: AgentManifest = {
  schemaVersion: 1,
  id: 'auditor',
  name: 'Zero-Trust Auditor Agent',
  description: 'High-security minimal privilege inspection agent operating under zero-trust locked-down policy',
  version: '1.0.0',
  model: {
    model: 'claude-3-5-sonnet',
    temperature: 0.0,
    maxTokens: 2048,
  },
  systemPrompt: `You are a zero-trust auditor operating in {{workspaceRoot}}.
All executions, writes, and outbound network calls are strictly prohibited.`,
  tools: ['fs.stat', 'fs.list', 'user.ask', 'plan.update', 'run.finish'],
  policyProfile: 'locked-down',
  budgets: {
    maxSteps: 15,
    maxTokens: 100_000,
    maxCostUsd: 2.0,
    maxWallClockSeconds: 300,
  },
  maxContextTokens: 60_000,
  maxParallelTools: 2,
};

export const BUILTIN_AGENTS: Record<string, AgentManifest> = {
  'developer': DEFAULT_DEVELOPER_AGENT,
  'reviewer': DEFAULT_REVIEWER_AGENT,
  'dev-shell': DEFAULT_DEV_SHELL_AGENT,
  'auditor': DEFAULT_AUDITOR_AGENT,
};

/**
 * Retrieves a standard built-in agent manifest by ID.
 */
export function getBuiltinAgent(id: string): AgentManifest | undefined {
  return BUILTIN_AGENTS[id];
}

/**
 * Lists all built-in agent manifests.
 */
export function listBuiltinAgents(): readonly AgentManifest[] {
  return Object.values(BUILTIN_AGENTS);
}

/**
 * Universal agent loader per docs/MODULES.md:
 * Resolves built-in agents by ID ('developer', 'reviewer', etc.) or loads
 * custom manifest files from disk.
 */
export async function loadAgent(
  identifier: string,
  workspaceRoot?: string,
): Promise<AgentManifest> {
  const builtin = getBuiltinAgent(identifier);
  if (builtin) {
    return builtin;
  }

  const root = workspaceRoot ?? process.cwd();
  const loaded = await loadAgentManifestFromFile(root, identifier);
  return loaded.manifest;
}
