/**
 * Policy Language Schema (Phase 5 - P5-T02).
 *
 * Defines the formal Zod schemas and TypeScript types for AIR policy documents:
 * - Policy effects: 'allow', 'deny', 'ask_user' (Rule S1: deny-by-default)
 * - Match conditions: tools, capabilities, argument patterns, and taint requirements
 * - Scope constraints: agents, sessions, profiles
 * - Complete policy document with validation and defaults
 *
 * Adheres to:
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 * - Rule R12: Zod schema validation
 */

import { z } from 'zod';
import { CapabilityPatternSchema } from './capabilities.js';

// ============================================================================
// 1. Effects and Enums
// ============================================================================

export const PolicyEffectSchema = z.enum(['allow', 'deny', 'ask_user']);
export type PolicyEffect = z.infer<typeof PolicyEffectSchema>;

export const TaintLevelSchema = z.enum(['clean', 'tainted']);
export type TaintLevel = z.infer<typeof TaintLevelSchema>;

// ============================================================================
// 2. Scope Constraints
// ============================================================================

export const PolicyScopeSchema = z.object({
  /** Specific agent IDs or wildcard patterns (e.g. ['coder', 'reviewer*']). */
  agents: z.array(z.string().min(1)).optional(),
  /** Specific session IDs or wildcard patterns. */
  sessions: z.array(z.string().min(1)).optional(),
  /** Specific policy profiles under which this rule applies. */
  profiles: z.array(z.string().min(1)).optional(),
});
export type PolicyScope = z.infer<typeof PolicyScopeSchema>;

// ============================================================================
// 3. Match Conditions
// ============================================================================

export const TaintConditionSchema = z.object({
  /** If true, the action is disallowed if the execution context or input is tainted. */
  disallowTainted: z.boolean().optional(),
  /** Maximum acceptable taint level. */
  maxTaintLevel: TaintLevelSchema.optional(),
});
export type TaintCondition = z.infer<typeof TaintConditionSchema>;

export const PolicyMatchConditionSchema = z.object({
  /** Tool name or array of tool names, with wildcard support (e.g. 'fs.*', 'exec.run'). */
  tools: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  /** Capability pattern or array of capability patterns to match against derived tool capabilities. */
  capabilities: z
    .union([
      z.string().min(1),
      CapabilityPatternSchema,
      z.array(z.union([z.string().min(1), CapabilityPatternSchema])),
    ])
    .optional(),
  /** Argument pattern constraints on raw tool input. */
  args: z.record(z.string(), z.unknown()).optional(),
  /** Taint and provenance constraints. */
  taint: TaintConditionSchema.optional(),
});
export type PolicyMatchCondition = z.infer<typeof PolicyMatchConditionSchema>;

// ============================================================================
// 4. Policy Rule
// ============================================================================

export const PolicyRuleSchema = z.object({
  /** Unique identifier for this rule. */
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_\-.:]+$/, 'Rule ID must contain only alphanumeric, dashes, dots, or colons'),
  /** Optional human-readable description of rule purpose. */
  description: z.string().optional(),
  /** Decision effect when rule matches. */
  effect: PolicyEffectSchema,
  /** Optional scope constraints. */
  scope: PolicyScopeSchema.optional(),
  /** Matching conditions. */
  match: PolicyMatchConditionSchema,
  /** Human-readable explanation/justification for audit trails and explain outputs. */
  reason: z.string().min(1, 'Policy rule requires an explicit reason'),
  /** Explicit priority override (higher numbers evaluated first). */
  priority: z.number().int().optional(),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

// ============================================================================
// 5. Policy Document
// ============================================================================

export const PolicyDocumentSchema = z.object({
  /** Schema identifier URI. */
  $schema: z.string().optional(),
  /** Policy document schema version. */
  version: z.literal(1).default(1),
  /** Unique name of this policy document. */
  name: z.string().min(1),
  /** Optional description. */
  description: z.string().optional(),
  /** Global default effect when no rule matches (strictly deny or ask_user; never allow). */
  defaultEffect: z.enum(['deny', 'ask_user']).default('deny'),
  /** Ordered list of policy rules. */
  rules: z.array(PolicyRuleSchema).default([]),
  /** Default resource and financial budgets. */
  budgets: z.record(z.string(), z.unknown()).optional(),
  /** Profile definitions. */
  profiles: z.record(z.string(), z.unknown()).optional(),
});
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;
