/**
 * Default Policy Profiles (Phase 5 - P5-T07).
 *
 * Implements 4 standard production policy profiles:
 * 1. `readonly`: Safe inspection mode. Read/list/stat tools allowed; all writes, commands, and network denied.
 * 2. `project-write`: Default workspace development profile. Workspace filesystem read/write/edit allowed;
 *    destructive deletion and shell execution require operator approval; network bounded.
 * 3. `dev-shell`: Autonomous developer profile. Workspace read/write and developer tooling (npm, git, test) allowed;
 *    outbound network to package registries allowed; dangerous system modifications require operator approval.
 * 4. `locked-down`: High-security / zero-trust profile. Minimal inspection only; all execution, writes, and network strictly denied.
 *
 * All profiles conform to PolicyDocumentSchema and pass static validation under lintPolicy().
 */

import { z } from 'zod';
import { type PolicyDocument } from './schema.js';

// ============================================================================
// 1. Types & Profile Names
// ============================================================================

export const PolicyProfileNameSchema = z.enum([
  'readonly',
  'project-write',
  'dev-shell',
  'locked-down',
]);
export type PolicyProfileName = z.infer<typeof PolicyProfileNameSchema>;

export interface PolicyProfileSummary {
  readonly name: PolicyProfileName;
  readonly description: string;
  readonly rulesCount: number;
}

// ============================================================================
// 2. Profile Definitions
// ============================================================================

/**
 * 1. Read-Only Profile: Safe auditing & read-only analysis.
 */
export const READONLY_PROFILE: PolicyDocument = {
  version: 1,
  name: 'readonly',
  description: 'Read-only workspace inspection profile. File modifications, shell execution, and network are denied.',
  defaultEffect: 'deny',
  rules: [
    // High-priority explicit denials for modifications & executions
    {
      id: 'deny-fs-write',
      description: 'Deny all file writes and mutations',
      effect: 'deny',
      priority: 100,
      match: {
        tools: ['fs.write', 'fs.edit', 'fs.mkdir', 'fs.move', 'fs.delete'],
      },
      reason: 'Readonly profile forbids file modifications',
    },
    {
      id: 'deny-exec',
      description: 'Deny all command execution',
      effect: 'deny',
      priority: 100,
      match: {
        tools: ['exec.run', 'exec.*'],
      },
      reason: 'Readonly profile forbids shell command execution',
    },
    {
      id: 'deny-network',
      description: 'Deny all outbound network requests',
      effect: 'deny',
      priority: 100,
      match: {
        tools: ['http.fetch', 'http.*'],
      },
      reason: 'Readonly profile forbids outbound network access',
    },
    // Allow safe read tools within workspace
    {
      id: 'allow-fs-read',
      description: 'Allow reading and inspecting workspace files',
      effect: 'allow',
      priority: 10,
      match: {
        tools: ['fs.read', 'fs.list', 'fs.glob', 'fs.grep', 'fs.stat'],
      },
      reason: 'Readonly profile allows safe file reads and directory traversal',
    },
    // Allow safe interaction tools
    {
      id: 'allow-interaction',
      description: 'Allow user clarification and plan updates',
      effect: 'allow',
      priority: 10,
      match: {
        tools: ['user.ask', 'plan.update', 'run.finish'],
      },
      reason: 'User interaction and task planning tools are permitted',
    },
  ],
};

/**
 * 2. Project-Write Profile (Default): Standard agentic development profile.
 */
export const PROJECT_WRITE_PROFILE: PolicyDocument = {
  version: 1,
  name: 'project-write',
  description: 'Standard workspace development profile with guarded shell and deletion.',
  defaultEffect: 'deny',
  rules: [
    // Deletion requires operator approval
    {
      id: 'ask-fs-delete',
      description: 'File deletion requires operator confirmation',
      effect: 'ask_user',
      priority: 50,
      match: {
        tools: ['fs.delete'],
      },
      reason: 'File deletion requires operator approval to prevent accidental data loss',
    },
    // Shell execution requires operator approval
    {
      id: 'ask-exec-run',
      description: 'Shell commands require operator confirmation',
      effect: 'ask_user',
      priority: 50,
      match: {
        tools: ['exec.run'],
      },
      reason: 'Process execution requires operator approval under project-write profile',
    },
    // Network calls require operator confirmation
    {
      id: 'ask-http-fetch',
      description: 'Outbound network requests require operator confirmation',
      effect: 'ask_user',
      priority: 50,
      match: {
        tools: ['http.fetch'],
      },
      reason: 'Outbound HTTP requests require operator approval under project-write profile',
    },
    // Safe filesystem operations allowed in workspace
    {
      id: 'allow-fs-workspace',
      description: 'Allow reading, writing, and editing files in workspace',
      effect: 'allow',
      priority: 10,
      match: {
        tools: ['fs.read', 'fs.write', 'fs.edit', 'fs.list', 'fs.glob', 'fs.grep', 'fs.stat', 'fs.mkdir', 'fs.move'],
      },
      reason: 'Standard workspace file manipulation permitted',
    },
    // Interaction tools allowed
    {
      id: 'allow-interaction',
      description: 'Allow user clarification and plan updates',
      effect: 'allow',
      priority: 10,
      match: {
        tools: ['user.ask', 'plan.update', 'run.finish'],
      },
      reason: 'User interaction and task planning tools are permitted',
    },
  ],
};

/**
 * 3. Dev-Shell Profile: Autonomous developer with shell execution privileges.
 */
export const DEV_SHELL_PROFILE: PolicyDocument = {
  version: 1,
  name: 'dev-shell',
  description: 'Developer profile allowing workspace writes and standard build/test/git commands.',
  defaultEffect: 'deny',
  rules: [
    // Explicit denial of dangerous system commands
    {
      id: 'deny-dangerous-commands',
      description: 'Block formatting, registry edits, and system shutdowns',
      effect: 'deny',
      priority: 100,
      match: {
        tools: ['exec.run'],
        args: {
          command: '*format *|*regedit*|*shutdown*|*diskpart*',
        },
      },
      reason: 'Destructive system-level commands are strictly prohibited',
    },
    // Safe developer commands allowed directly
    {
      id: 'allow-dev-commands',
      description: 'Allow standard build, test, lint, and git commands',
      effect: 'allow',
      priority: 20,
      match: {
        tools: ['exec.run'],
        args: {
          command: 'npm *|npx *|git *|tsc*|vitest*|node *|cargo *|pwsh *',
        },
      },
      reason: 'Common developer toolchain commands are permitted',
    },
    // Other arbitrary exec commands ask user
    {
      id: 'ask-other-exec',
      description: 'Non-standard shell commands require operator approval',
      effect: 'ask_user',
      priority: 15,
      match: {
        tools: ['exec.run'],
      },
      reason: 'Non-standard shell command requires operator approval',
    },
    // Outbound HTTP allowed
    {
      id: 'allow-http-dev',
      description: 'Allow outbound HTTP access for documentation and package fetching',
      effect: 'allow',
      priority: 15,
      match: {
        tools: ['http.fetch'],
      },
      reason: 'Developer profile allows network requests',
    },
    // Workspace fs operations allowed
    {
      id: 'allow-fs-all',
      description: 'Allow full workspace filesystem operations',
      effect: 'allow',
      priority: 10,
      match: {
        tools: ['fs.read', 'fs.write', 'fs.edit', 'fs.list', 'fs.glob', 'fs.grep', 'fs.stat', 'fs.mkdir', 'fs.move', 'fs.delete'],
      },
      reason: 'Full workspace filesystem operations permitted under dev-shell profile',
    },
    // Interaction tools allowed
    {
      id: 'allow-interaction',
      description: 'Allow user clarification and plan updates',
      effect: 'allow',
      priority: 10,
      match: {
        tools: ['user.ask', 'plan.update', 'run.finish'],
      },
      reason: 'User interaction and task planning tools are permitted',
    },
  ],
};

/**
 * 4. Locked-Down Profile: Minimal privileges; deny-by-default with zero mutations.
 */
export const LOCKED_DOWN_PROFILE: PolicyDocument = {
  version: 1,
  name: 'locked-down',
  description: 'High-security zero-trust profile. Only basic inspection and planning permitted.',
  defaultEffect: 'deny',
  rules: [
    // Strict denial of all execution, network, and modification
    {
      id: 'deny-all-mutations',
      description: 'Strictly deny all file modifications',
      effect: 'deny',
      priority: 100,
      match: {
        tools: ['fs.write', 'fs.edit', 'fs.mkdir', 'fs.move', 'fs.delete'],
      },
      reason: 'Locked-down profile denies all mutations',
    },
    {
      id: 'deny-all-exec',
      description: 'Strictly deny all shell executions',
      effect: 'deny',
      priority: 100,
      match: {
        tools: ['exec.run', 'exec.*'],
      },
      reason: 'Locked-down profile denies all shell executions',
    },
    {
      id: 'deny-all-network',
      description: 'Strictly deny all network requests',
      effect: 'deny',
      priority: 100,
      match: {
        tools: ['http.fetch', 'http.*'],
      },
      reason: 'Locked-down profile denies all network requests',
    },
    // Disallow any action if tainted
    {
      id: 'deny-tainted-actions',
      description: 'Disallow any action if context is tainted',
      effect: 'deny',
      priority: 90,
      match: {
        taint: {
          disallowTainted: true,
        },
      },
      reason: 'Locked-down profile rejects all tainted execution contexts',
    },
    // Allow minimal file inspection
    {
      id: 'allow-safe-inspection',
      description: 'Allow basic file inspection',
      effect: 'allow',
      priority: 10,
      match: {
        tools: ['fs.stat', 'fs.list'],
      },
      reason: 'Locked-down profile permits basic file stat and listing',
    },
    // File reading requires operator confirmation
    {
      id: 'ask-fs-read',
      description: 'File reading requires operator confirmation',
      effect: 'ask_user',
      priority: 5,
      match: {
        tools: ['fs.read', 'fs.glob', 'fs.grep'],
      },
      reason: 'Locked-down profile requires confirmation to inspect file contents',
    },
    // Interaction tools allowed
    {
      id: 'allow-interaction',
      description: 'Allow user clarification and plan updates',
      effect: 'allow',
      priority: 10,
      match: {
        tools: ['user.ask', 'plan.update', 'run.finish'],
      },
      reason: 'User interaction and task planning tools are permitted',
    },
  ],
};

// ============================================================================
// 3. Registry & Helper Functions
// ============================================================================

export const DEFAULT_POLICY_PROFILES: Record<PolicyProfileName, PolicyDocument> = {
  'readonly': READONLY_PROFILE,
  'project-write': PROJECT_WRITE_PROFILE,
  'dev-shell': DEV_SHELL_PROFILE,
  'locked-down': LOCKED_DOWN_PROFILE,
};

/**
 * Retrieves a standard policy profile document by name.
 */
export function getPolicyProfile(name: PolicyProfileName): PolicyDocument {
  const profile = DEFAULT_POLICY_PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown policy profile: '${name}'`);
  }
  return profile;
}

/**
 * Returns summaries of all available built-in policy profiles.
 */
export function listPolicyProfiles(): PolicyProfileSummary[] {
  return Object.values(DEFAULT_POLICY_PROFILES).map((p) => ({
    name: p.name as PolicyProfileName,
    description: p.description ?? '',
    rulesCount: p.rules.length,
  }));
}
