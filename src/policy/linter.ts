/**
 * Policy Linter (Phase 5 - P5-T02).
 *
 * Performs static analysis and security verification on policy documents:
 * - Duplicate rule ID detection
 * - Shadowed/unreachable rule detection (subsumption analysis)
 * - Contradictory rule detection (same pattern, opposing effects)
 * - Dangerous permissions warnings (e.g. unconstrained exec:run:* or write to C:\Windows)
 * - Malformed capability pattern checks
 *
 * Adheres to:
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 */

import {
  formatCapability,
  isCapabilitySubsumed,
  parseCapabilityPattern,
} from './capabilities.js';
import { parsePolicy } from './loader.js';
import type { PolicyDocument, PolicyRule } from './schema.js';

export interface PolicyLintIssue {
  readonly ruleId?: string | undefined;
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
}

export interface PolicyLintResult {
  readonly valid: boolean;
  readonly errors: readonly PolicyLintIssue[];
  readonly warnings: readonly PolicyLintIssue[];
}

/**
 * Normalizes tool list from rule match condition.
 */
function getRuleTools(rule: PolicyRule): string[] {
  if (!rule.match.tools) return ['*'];
  return Array.isArray(rule.match.tools) ? rule.match.tools : [rule.match.tools];
}

/**
 * Normalizes capability patterns from rule match condition.
 */
function getRuleCapabilities(rule: PolicyRule): string[] {
  if (!rule.match.capabilities) return [];
  const raw = Array.isArray(rule.match.capabilities)
    ? rule.match.capabilities
    : [rule.match.capabilities];
  return raw.map((c) => (typeof c === 'string' ? c : formatCapability(c)));
}

/**
 * Statically analyzes a policy document and returns all errors and warnings.
 */
export function lintPolicy(policyOrContent: PolicyDocument | string): PolicyLintResult {
  let doc: PolicyDocument;
  if (typeof policyOrContent === 'string') {
    try {
      const loaded = parsePolicy(policyOrContent);
      doc = loaded.policy;
    } catch (err) {
      return {
        valid: false,
        errors: [
          {
            severity: 'error',
            code: 'SYNTAX_ERROR',
            message: (err as Error).message,
          },
        ],
        warnings: [],
      };
    }
  } else {
    doc = policyOrContent;
  }

  const errors: PolicyLintIssue[] = [];
  const warnings: PolicyLintIssue[] = [];

  // 1. Check for Duplicate Rule IDs
  const seenIds = new Set<string>();
  for (const rule of doc.rules) {
    if (seenIds.has(rule.id)) {
      errors.push({
        ruleId: rule.id,
        severity: 'error',
        code: 'DUPLICATE_RULE_ID',
        message: `Duplicate rule ID found: "${rule.id}"`,
      });
    }
    seenIds.add(rule.id);
  }

  // 2. Inspect individual rules
  for (const rule of doc.rules) {
    // Check for empty match condition
    const hasTools = rule.match.tools !== undefined && (Array.isArray(rule.match.tools) ? rule.match.tools.length > 0 : true);
    const hasCaps = rule.match.capabilities !== undefined && (Array.isArray(rule.match.capabilities) ? rule.match.capabilities.length > 0 : true);
    const hasArgs = rule.match.args !== undefined && Object.keys(rule.match.args).length > 0;
    const hasTaint = rule.match.taint !== undefined;

    if (!hasTools && !hasCaps && !hasArgs && !hasTaint) {
      warnings.push({
        ruleId: rule.id,
        severity: 'warning',
        code: 'EMPTY_MATCH_CONDITION',
        message: `Rule "${rule.id}" has no match criteria specified; it will match all tool calls`,
      });
    }

    // Validate capability patterns syntax
    const caps = getRuleCapabilities(rule);
    for (const capStr of caps) {
      try {
        parseCapabilityPattern(capStr);
      } catch (capErr) {
        errors.push({
          ruleId: rule.id,
          severity: 'error',
          code: 'INVALID_CAPABILITY_PATTERN',
          message: `Rule "${rule.id}" defines an unparseable capability pattern "${capStr}": ${(capErr as Error).message}`,
        });
      }
    }

    // Check for dangerous grants
    if (rule.effect === 'allow') {
      for (const capStr of caps) {
        // Universal wildcard grant
        if (capStr === '*:*:*' || capStr === '*') {
          warnings.push({
            ruleId: rule.id,
            severity: 'warning',
            code: 'OVERLY_PERMISSIVE_GRANT',
            message: `Rule "${rule.id}" grants universal allow across all capabilities (*:*:*)`,
          });
        }

        // Unconstrained execution
        if (capStr === 'exec:run:*' || capStr === 'exec:run') {
          warnings.push({
            ruleId: rule.id,
            severity: 'warning',
            code: 'UNCONSTRAINED_EXEC_GRANT',
            message: `Rule "${rule.id}" allows unconstrained execution of any system binary (exec:run:*)`,
          });
        }

        // System directories allow
        const lower = capStr.toLowerCase();
        if (
          lower.includes('c:\\windows') ||
          lower.includes('c:/windows') ||
          lower.includes('c:\\program files') ||
          lower.includes('c:/program files')
        ) {
          if (!lower.includes(':read:')) {
            errors.push({
              ruleId: rule.id,
              severity: 'error',
              code: 'DANGEROUS_SYSTEM_PATH_GRANT',
              message: `Rule "${rule.id}" allows modifying Windows system directories: "${capStr}"`,
            });
          }
        }
      }

      // Check for unconstrained exec tool allow
      const tools = getRuleTools(rule);
      if (tools.includes('exec.run') && caps.length === 0) {
        warnings.push({
          ruleId: rule.id,
          severity: 'warning',
          code: 'UNCONSTRAINED_EXEC_TOOL',
          message: `Rule "${rule.id}" allows exec.run without any capability or argument constraints`,
        });
      }
    }
  }

  // 3. Shadowed & Contradictory Rule Detection
  for (let i = 0; i < doc.rules.length; i++) {
    const prior = doc.rules[i];
    if (!prior) continue;

    const priorTools = getRuleTools(prior);
    const priorCaps = getRuleCapabilities(prior);
    const priorPriority = prior.priority ?? 0;

    for (let j = i + 1; j < doc.rules.length; j++) {
      const current = doc.rules[j];
      if (!current) continue;

      const currentTools = getRuleTools(current);
      const currentCaps = getRuleCapabilities(current);
      const currentPriority = current.priority ?? 0;

      // Only check rules with equal or lower priority
      if (currentPriority > priorPriority) {
        continue;
      }

      // Check if tools match
      const toolsMatch =
        priorTools.includes('*') ||
        currentTools.every((t) => priorTools.includes(t) || priorTools.some((pt) => pt.endsWith('.*') && t.startsWith(pt.slice(0, -1))));

      if (!toolsMatch) continue;

      // Check capability subsumption
      const capsSubsumed =
        priorCaps.length === 0 ||
        priorCaps.includes('*:*:*') ||
        (currentCaps.length > 0 &&
          currentCaps.every((cc) => priorCaps.some((pc) => isCapabilitySubsumed(cc, pc))));

      if (capsSubsumed) {
        // If prior effect is the same, current rule is shadowed and redundant
        if (prior.effect === current.effect && !current.match.args && !current.match.taint) {
          warnings.push({
            ruleId: current.id,
            severity: 'warning',
            code: 'SHADOWED_RULE',
            message: `Rule "${current.id}" is shadowed by preceding rule "${prior.id}" with the same effect (${prior.effect})`,
          });
        } else if (
          prior.effect === 'deny' &&
          current.effect === 'allow' &&
          priorPriority === currentPriority &&
          !current.match.args &&
          !current.match.taint
        ) {
          // Preceding deny rule blocks current allow rule completely
          warnings.push({
            ruleId: current.id,
            severity: 'warning',
            code: 'UNREACHABLE_ALLOW_RULE',
            message: `Rule "${current.id}" is unreachable because preceding deny rule "${prior.id}" matches all its criteria`,
          });
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
