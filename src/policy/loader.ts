/**
 * Policy Loader (Phase 5 - P5-T02).
 *
 * Loads, parses, and validates policy documents from JSON/YAML strings or files:
 * - Supports JSON and YAML formats
 * - Validates schema with Zod, producing structured AirError('POLICY_INVALID') on failure
 * - Computes SHA-256 integrity hash for audit trail and tamper detection (Rule S10)
 *
 * Adheres to:
 * - Rule R2: Uses safe fs methods when loading from disk
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 */

import crypto from 'node:crypto';
import yaml from 'yaml';
import { AirError } from '../errors/index.js';
import { readFileIn } from '../util/index.js';
import { type PolicyDocument, PolicyDocumentSchema } from './schema.js';

export interface LoadedPolicy {
  readonly policy: PolicyDocument;
  readonly sha256: string;
  readonly rawText: string;
}

/**
 * Computes SHA-256 hash of a policy string for integrity verification.
 */
export function computePolicyHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Parses and validates a policy document from a raw JSON or YAML string.
 */
export function parsePolicy(content: string): LoadedPolicy {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new AirError('POLICY_INVALID', 'Policy content must be a non-empty string');
  }

  const sha256 = computePolicyHash(content);

  let parsedRaw: unknown;
  const trimmed = content.trim();

  try {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      parsedRaw = JSON.parse(trimmed);
    } else {
      parsedRaw = yaml.parse(trimmed);
    }
  } catch (err) {
    throw new AirError('POLICY_INVALID', `Failed to parse policy syntax: ${(err as Error).message}`, {
      cause: err instanceof Error ? err : undefined,
      context: { sha256 },
    });
  }

  const result = PolicyDocumentSchema.safeParse(parsedRaw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new AirError('POLICY_INVALID', `Policy schema validation failed: ${issues}`, {
      context: { sha256, issues: result.error.issues },
    });
  }

  return {
    policy: result.data,
    sha256,
    rawText: content,
  };
}

/**
 * Loads and validates a policy document from disk within an allowed jail root.
 */
export async function loadPolicyFromFile(root: string, relativePath: string): Promise<LoadedPolicy> {
  const content = await readFileIn(root, relativePath, 'utf-8');
  return parsePolicy(content);
}
