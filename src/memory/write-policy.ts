/**
 * Memory Write Policy Engine (Phase 8 - P8-T05).
 *
 * Implements:
 * - Allow/deny rules for memory writes (scope validation, agent boundaries, content limits).
 * - Secret scrubbing (Rule R4: Never log/store secrets, integrated with src/observability/redaction).
 * - PII scrubbing (emails, phone numbers, SSNs, credit cards) with redact/reject modes.
 * - Provenance & taint tracking (Rule S9 / Threat T11: memory poisoning defense;
 *   tainted inputs cannot be stored as clean memories).
 * - High-confidence prompt injection detection & neutralization.
 * - Integration with SqliteMemoryStore and memory tools.
 */

import { AirError } from '../errors/index.js';
import { redactString } from '../observability/index.js';
import { detectInjectionMarkers } from '../policy/index.js';
import type { AgentId, RunId, SessionId, ToolCallId, TurnId } from '../types/index.js';
import type {
  CreateMemoryInput,
  MemoryKind,
  MemoryProvenance,
  MemoryScope,
  MemorySource,
  MemoryTaint,
  UpdateMemoryInput,
} from './types.js';

// ============================================================================
// 1. Types & Options
// ============================================================================

export type SecretScrubMode = 'redact' | 'reject' | 'warn';
export type PiiScrubMode = 'redact' | 'reject' | 'off';
export type PiiType = 'email' | 'phone' | 'ssn' | 'credit_card';
export type PromptInjectionAction = 'reject' | 'force_tainted' | 'allow';

export interface MemoryWritePolicyConfig {
  /** Maximum length for entry title in characters. Defaults to 256. */
  readonly maxTitleLength: number;
  /** Maximum length for entry content in characters. Defaults to 32,768. */
  readonly maxContentLength: number;
  /** Maximum number of tags allowed. Defaults to 20. */
  readonly maxTagsCount: number;
  /** Maximum length for a single tag. Defaults to 64. */
  readonly maxTagLength: number;
  /** Whether global scope writes are permitted. Defaults to false. */
  readonly allowGlobalScope: boolean;
  /** Whether calling context scope IDs must match entry scope IDs. Defaults to true. */
  readonly enforceScopeMatch: boolean;
  /** Secret scrubbing mode. Defaults to 'redact'. */
  readonly secretScrubMode: SecretScrubMode;
  /** PII scrubbing mode. Defaults to 'redact'. */
  readonly piiScrubMode: PiiScrubMode;
  /** Enabled PII detector types. Defaults to all 4 types. */
  readonly piiTypes: readonly PiiType[];
  /** Action when prompt injection markers are detected. Defaults to 'force_tainted'. */
  readonly promptInjectionAction: PromptInjectionAction;
  /** Legacy compatibility option; taint safety invariants are enforced regardless of this value. */
  readonly preserveTaint: boolean;
  /** Allowed memory kinds. Defaults to ['episodic', 'semantic', 'working']. */
  readonly allowedKinds: readonly MemoryKind[];
  /** Allowed memory scopes. Defaults to ['agent', 'session', 'run', 'global']. */
  readonly allowedScopes: readonly MemoryScope[];
}

export const DEFAULT_MEMORY_WRITE_POLICY_CONFIG: MemoryWritePolicyConfig = {
  maxTitleLength: 256,
  maxContentLength: 32_768,
  maxTagsCount: 20,
  maxTagLength: 64,
  allowGlobalScope: false,
  enforceScopeMatch: true,
  secretScrubMode: 'redact',
  piiScrubMode: 'redact',
  piiTypes: ['email', 'phone', 'ssn', 'credit_card'],
  promptInjectionAction: 'force_tainted',
  preserveTaint: true,
  allowedKinds: ['episodic', 'semantic', 'working'],
  allowedScopes: ['agent', 'session', 'run', 'global'],
};

export interface MemoryWriteContext {
  /** Identity of the agent attempting to write. */
  readonly callingAgentId?: AgentId | undefined;
  /** Identity of the session attempting to write. */
  readonly callingSessionId?: SessionId | undefined;
  /** Identity of the run attempting to write. */
  readonly callingRunId?: RunId | undefined;
  /** Turn ID in which the write is occurring. */
  readonly callingTurnId?: TurnId | undefined;
  /** Tool call ID triggering the write, if applicable. */
  readonly callingToolCallId?: ToolCallId | undefined;
  /** Whether the caller or input data is tainted (Rule S9). */
  readonly isTainted?: boolean | undefined;
  /** Explicit taint level of caller context. */
  readonly taintLevel?: MemoryTaint | undefined;
  /** High-level provenance source (default: 'model' or 'tool'). */
  readonly source?: MemorySource | undefined;
  /** Explicitly allow global scope write for this specific context. */
  readonly allowGlobalScope?: boolean | undefined;
  /** Actor identifier (human user, system, agent name). */
  readonly actorId?: string | undefined;
  /** Extra context metadata. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface MemoryWriteViolation {
  readonly rule: string;
  readonly message: string;
  readonly field?: string | undefined;
  readonly severity: 'error' | 'warning';
}

export interface MemoryWriteEvaluationResult {
  readonly allowed: boolean;
  readonly action: 'allow' | 'deny';
  readonly reason?: string | undefined;
  readonly violations: readonly MemoryWriteViolation[];
  readonly sanitizedInput: CreateMemoryInput;
  readonly redactionsCount: number;
  readonly piiCount: number;
  readonly injectionDetected: boolean;
}

// ============================================================================
// 2. Secret & PII Scrubbers
// ============================================================================

export interface PiiMatch {
  readonly type: PiiType;
  readonly count: number;
}

export interface ScrubResult {
  readonly text: string;
  readonly secretCount: number;
  readonly piiMatches: readonly PiiMatch[];
  readonly totalPiiCount: number;
}

const PII_PATTERNS: Record<PiiType, RegExp> = {
  // RFC 5322 simplified email
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  // Standard phone numbers (US + international formats)
  phone: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  // US SSN format: 000-00-0000
  ssn: /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  // Credit card format: 13 to 16 digits formatted or consecutive
  credit_card: /\b(?:\d{4}[ -]?){3}\d{4}\b/g,
};

const PII_REPLACEMENTS: Record<PiiType, string> = {
  email: '[REDACTED:email]',
  phone: '[REDACTED:phone]',
  ssn: '[REDACTED:ssn]',
  credit_card: '[REDACTED:credit-card]',
};

/**
 * Scrubs secrets and PII from a string.
 */
export function scrubText(
  text: string,
  options?: {
    secretMode?: SecretScrubMode | undefined;
    piiMode?: PiiScrubMode | undefined;
    piiTypes?: readonly PiiType[] | undefined;
  },
): ScrubResult {
  if (!text || typeof text !== 'string') {
    return { text, secretCount: 0, piiMatches: [], totalPiiCount: 0 };
  }

  const secretMode = options?.secretMode ?? 'redact';
  const piiMode = options?.piiMode ?? 'redact';
  const activePiiTypes = options?.piiTypes ?? ['email', 'phone', 'ssn', 'credit_card'];

  let current = text;
  let secretCount = 0;

  // 1. Secret scrubbing
  if (secretMode !== 'warn') {
    const redacted = redactString(current);
    if (redacted !== current) {
      // Approximate count of redacted items
      const matches = redacted.match(/\[REDACTED:[^\]]+\]/g);
      secretCount = matches ? matches.length : 1;
      if (secretMode === 'redact') {
        current = redacted;
      }
    }
  }

  // 2. PII scrubbing
  const piiMatches: PiiMatch[] = [];
  let totalPiiCount = 0;

  if (piiMode !== 'off') {
    for (const piiType of activePiiTypes) {
      const pattern = PII_PATTERNS[piiType];
      if (!pattern) continue;

      const matches = current.match(pattern);
      if (matches && matches.length > 0) {
        piiMatches.push({ type: piiType, count: matches.length });
        totalPiiCount += matches.length;

        if (piiMode === 'redact') {
          current = current.replace(pattern, PII_REPLACEMENTS[piiType]);
        }
      }
    }
  }

  return {
    text: current,
    secretCount,
    piiMatches,
    totalPiiCount,
  };
}

/**
 * Recursively scrubs string values in deep metadata objects.
 */
export function scrubMetadataValue(
  value: unknown,
  options?: {
    secretMode?: SecretScrubMode | undefined;
    piiMode?: PiiScrubMode | undefined;
    piiTypes?: readonly PiiType[] | undefined;
  },
): { value: unknown; secretCount: number; totalPiiCount: number } {
  if (value === null || value === undefined) {
    return { value, secretCount: 0, totalPiiCount: 0 };
  }

  if (typeof value === 'string') {
    const scrubbed = scrubText(value, options);
    return {
      value: scrubbed.text,
      secretCount: scrubbed.secretCount,
      totalPiiCount: scrubbed.totalPiiCount,
    };
  }

  if (Array.isArray(value)) {
    let secretCount = 0;
    let totalPiiCount = 0;
    const arrayResult = value.map((item) => {
      const res = scrubMetadataValue(item, options);
      secretCount += res.secretCount;
      totalPiiCount += res.totalPiiCount;
      return res.value;
    });
    return { value: arrayResult, secretCount, totalPiiCount };
  }

  if (typeof value === 'object') {
    let secretCount = 0;
    let totalPiiCount = 0;
    const objResult: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const res = scrubMetadataValue(v, options);
      secretCount += res.secretCount;
      totalPiiCount += res.totalPiiCount;
      objResult[k] = res.value;
    }
    return { value: objResult, secretCount, totalPiiCount };
  }

  return { value, secretCount: 0, totalPiiCount: 0 };
}

// ============================================================================
// 3. Memory Write Policy Evaluator
// ============================================================================

export class MemoryWritePolicy {
  readonly config: MemoryWritePolicyConfig;

  constructor(config?: Partial<MemoryWritePolicyConfig>) {
    this.config = {
      ...DEFAULT_MEMORY_WRITE_POLICY_CONFIG,
      ...config,
    };
  }

  /**
   * Evaluates a memory write request against all policy rules.
   */
  evaluate(input: CreateMemoryInput, context?: MemoryWriteContext): MemoryWriteEvaluationResult {
    const violations: MemoryWriteViolation[] = [];
    let redactionsCount = 0;
    let piiCount = 0;
    let injectionDetected = false;

    // ------------------------------------------------------------------------
    // Rule 1: Empty and Length Constraints
    // ------------------------------------------------------------------------
    if (!input.title || input.title.trim().length === 0) {
      violations.push({
        rule: 'empty_title',
        message: 'Memory title cannot be empty or whitespace-only',
        field: 'title',
        severity: 'error',
      });
    } else if (input.title.length > this.config.maxTitleLength) {
      violations.push({
        rule: 'max_title_length',
        message: `Memory title length (${input.title.length}) exceeds maximum allowed (${this.config.maxTitleLength})`,
        field: 'title',
        severity: 'error',
      });
    }

    if (!input.content || input.content.trim().length === 0) {
      violations.push({
        rule: 'empty_content',
        message: 'Memory content cannot be empty or whitespace-only',
        field: 'content',
        severity: 'error',
      });
    } else if (input.content.length > this.config.maxContentLength) {
      violations.push({
        rule: 'max_content_length',
        message: `Memory content length (${input.content.length}) exceeds maximum allowed (${this.config.maxContentLength})`,
        field: 'content',
        severity: 'error',
      });
    }

    if (input.tags) {
      if (input.tags.length > this.config.maxTagsCount) {
        violations.push({
          rule: 'max_tags_count',
          message: `Memory tags count (${input.tags.length}) exceeds maximum allowed (${this.config.maxTagsCount})`,
          field: 'tags',
          severity: 'error',
        });
      }
      for (const tag of input.tags) {
        if (!tag || tag.trim().length === 0) {
          violations.push({
            rule: 'empty_tag',
            message: 'Memory tag cannot be empty or whitespace-only',
            field: 'tags',
            severity: 'error',
          });
        } else if (tag.length > this.config.maxTagLength) {
          violations.push({
            rule: 'max_tag_length',
            message: `Tag '${tag.slice(0, 16)}...' length exceeds maximum allowed (${this.config.maxTagLength})`,
            field: 'tags',
            severity: 'error',
          });
        }
      }
    }

    // ------------------------------------------------------------------------
    // Rule 2: Allowed Kinds & Scopes
    // ------------------------------------------------------------------------
    if (!this.config.allowedKinds.includes(input.kind)) {
      violations.push({
        rule: 'kind_not_allowed',
        message: `Memory kind '${input.kind}' is not permitted by policy (allowed: ${this.config.allowedKinds.join(', ')})`,
        field: 'kind',
        severity: 'error',
      });
    }

    if (!this.config.allowedScopes.includes(input.scope)) {
      violations.push({
        rule: 'scope_not_allowed',
        message: `Memory scope '${input.scope}' is not permitted by policy (allowed: ${this.config.allowedScopes.join(', ')})`,
        field: 'scope',
        severity: 'error',
      });
    }

    // Global scope authorization
    if (input.scope === 'global') {
      const isGlobalAllowed = Boolean(this.config.allowGlobalScope || context?.allowGlobalScope);
      if (!isGlobalAllowed) {
        violations.push({
          rule: 'global_scope_denied',
          message: 'Writing to global memory scope is not permitted for this agent/context',
          field: 'scope',
          severity: 'error',
        });
      }
    }

    // ------------------------------------------------------------------------
    // Rule 3: Scope Identity Match & Boundary Isolation
    // ------------------------------------------------------------------------
    if (this.config.enforceScopeMatch && context) {
      if (input.scope === 'agent') {
        if (!input.agentId) {
          violations.push({
            rule: 'missing_scope_id',
            message: 'Agent-scoped memory requires an agentId',
            field: 'agentId',
            severity: 'error',
          });
        } else if (context.callingAgentId && input.agentId !== context.callingAgentId) {
          violations.push({
            rule: 'scope_mismatch',
            message: `Calling agent '${context.callingAgentId}' cannot write to memory scoped to agent '${input.agentId}'`,
            field: 'agentId',
            severity: 'error',
          });
        }
      }

      if (input.scope === 'session') {
        if (!input.sessionId) {
          violations.push({
            rule: 'missing_scope_id',
            message: 'Session-scoped memory requires a sessionId',
            field: 'sessionId',
            severity: 'error',
          });
        } else if (context.callingSessionId && input.sessionId !== context.callingSessionId) {
          violations.push({
            rule: 'scope_mismatch',
            message: `Calling session '${context.callingSessionId}' cannot write to memory scoped to session '${input.sessionId}'`,
            field: 'sessionId',
            severity: 'error',
          });
        }
      }

      if (input.scope === 'run') {
        if (!input.runId) {
          violations.push({
            rule: 'missing_scope_id',
            message: 'Run-scoped memory requires a runId',
            field: 'runId',
            severity: 'error',
          });
        } else if (context.callingRunId && input.runId !== context.callingRunId) {
          violations.push({
            rule: 'scope_mismatch',
            message: `Calling run '${context.callingRunId}' cannot write to memory scoped to run '${input.runId}'`,
            field: 'runId',
            severity: 'error',
          });
        }
      }
    }

    // ------------------------------------------------------------------------
    // Rule 4: Secret and PII Scrubbing
    // ------------------------------------------------------------------------
    const scrubOpts = {
      secretMode: this.config.secretScrubMode,
      piiMode: this.config.piiScrubMode,
      piiTypes: this.config.piiTypes,
    };

    const titleScrub = scrubText(input.title ?? '', scrubOpts);
    const contentScrub = scrubText(input.content ?? '', scrubOpts);

    redactionsCount += titleScrub.secretCount + contentScrub.secretCount;
    piiCount += titleScrub.totalPiiCount + contentScrub.totalPiiCount;

    // Check secret reject mode
    if (this.config.secretScrubMode === 'reject' && (titleScrub.secretCount > 0 || contentScrub.secretCount > 0)) {
      violations.push({
        rule: 'secret_detected',
        message: 'Memory write rejected: secret detected in title or content (Rule R4)',
        field: titleScrub.secretCount > 0 ? 'title' : 'content',
        severity: 'error',
      });
    }

    // Check PII reject mode
    if (this.config.piiScrubMode === 'reject' && (titleScrub.totalPiiCount > 0 || contentScrub.totalPiiCount > 0)) {
      violations.push({
        rule: 'pii_detected',
        message: 'Memory write rejected: personally identifiable information (PII) detected',
        field: titleScrub.totalPiiCount > 0 ? 'title' : 'content',
        severity: 'error',
      });
    }

    // Scrub tags
    const sanitizedTags: string[] = [];
    if (input.tags) {
      for (const t of input.tags) {
        const tagScrub = scrubText(t, scrubOpts);
        redactionsCount += tagScrub.secretCount;
        piiCount += tagScrub.totalPiiCount;
        if (this.config.secretScrubMode === 'reject' && tagScrub.secretCount > 0) {
          violations.push({
            rule: 'secret_detected',
            message: 'Memory write rejected: secret detected in tags',
            field: 'tags',
            severity: 'error',
          });
        }
        if (this.config.piiScrubMode === 'reject' && tagScrub.totalPiiCount > 0) {
          violations.push({
            rule: 'pii_detected',
            message: 'Memory write rejected: PII detected in tags',
            field: 'tags',
            severity: 'error',
          });
        }
        sanitizedTags.push(tagScrub.text);
      }
    }

    // Scrub metadata
    let sanitizedMetadata: Record<string, unknown> = {};
    if (input.metadata) {
      const metaRes = scrubMetadataValue(input.metadata, scrubOpts);
      redactionsCount += metaRes.secretCount;
      piiCount += metaRes.totalPiiCount;
      if (this.config.secretScrubMode === 'reject' && metaRes.secretCount > 0) {
        violations.push({
          rule: 'secret_detected',
          message: 'Memory write rejected: secret detected in metadata',
          field: 'metadata',
          severity: 'error',
        });
      }
      if (this.config.piiScrubMode === 'reject' && metaRes.totalPiiCount > 0) {
        violations.push({
          rule: 'pii_detected',
          message: 'Memory write rejected: PII detected in metadata',
          field: 'metadata',
          severity: 'error',
        });
      }
      sanitizedMetadata = (metaRes.value as Record<string, unknown>) ?? {};
    }

    // ------------------------------------------------------------------------
    // Rule 5: Threat T11 - Prompt Injection Detection & Poisoning Defense
    // ------------------------------------------------------------------------
    const titleInjection = detectInjectionMarkers(input.title ?? '');
    const contentInjection = detectInjectionMarkers(input.content ?? '');
    const allIndicators = Array.from(new Set([...titleInjection.indicators, ...contentInjection.indicators]));

    if (allIndicators.length > 0) {
      injectionDetected = true;
      if (this.config.promptInjectionAction === 'reject') {
        violations.push({
          rule: 'prompt_injection_detected',
          message: `Memory write rejected: high-confidence prompt injection indicators detected (${allIndicators.join(', ')})`,
          field: titleInjection.detected ? 'title' : 'content',
          severity: 'error',
        });
      } else {
        violations.push({
          rule: 'prompt_injection_warning',
          message: `Prompt injection markers detected (${allIndicators.join(', ')}); taint enforced to untrusted`,
          field: titleInjection.detected ? 'title' : 'content',
          severity: 'warning',
        });
      }
    }

    // ------------------------------------------------------------------------
    // Rule 6: Provenance & Taint Enforcement (Rule S9 / Threat T11)
    // ------------------------------------------------------------------------
    // 1. Determine the strongest applicable taint signal. This is a security
    // invariant, not a configurable preference: preserveTaint=false must never
    // permit untrusted input to be persisted as clean.
    const taintRank: Record<MemoryTaint, number> = { clean: 0, tainted: 1, untrusted: 2 };
    const inputTaint = input.provenance?.taint ?? 'clean';
    const contextTaint: MemoryTaint =
      context?.taintLevel === 'untrusted'
        ? 'untrusted'
        : context?.taintLevel === 'tainted' || context?.isTainted === true
          ? 'tainted'
          : 'clean';
    // Tool-originated content is untrusted unless a future, explicit
    // verification mechanism establishes otherwise. A caller cannot override
    // this classification by supplying a clean context or clean provenance.
    const sourceIsUntrusted = context?.source === 'tool' || input.provenance?.source === 'tool';
    const sourceTaint: MemoryTaint = sourceIsUntrusted ? 'tainted' : 'clean';
    const signals: MemoryTaint[] = [inputTaint, contextTaint, sourceTaint];
    let enforcedTaint = signals.reduce(
      (strongest, candidate) => taintRank[candidate] > taintRank[strongest] ? candidate : strongest,
      'clean' as MemoryTaint,
    );

    if (taintRank[enforcedTaint] > taintRank[inputTaint]) {
      violations.push({
        rule: 'taint_escalated',
        message: `Memory taint escalated to '${enforcedTaint}' based on input provenance, context, or untrusted source classification`,
        field: 'provenance.taint',
        severity: 'warning',
      });
    }

    // If prompt injection was detected and action is 'force_tainted', enforce 'untrusted'
    if (injectionDetected && this.config.promptInjectionAction === 'force_tainted') {
      enforcedTaint = 'untrusted';
      sanitizedMetadata = {
        ...sanitizedMetadata,
        __injection_indicators: allIndicators,
      };
      if (!sanitizedTags.includes('untrusted')) {
        sanitizedTags.push('untrusted');
      }
    }

    // Construct final sanitized provenance
    const sanitizedProvenance: MemoryProvenance = {
      source: input.provenance?.source ?? context?.source ?? 'model',
      actorId: input.provenance?.actorId ?? context?.actorId ?? context?.callingAgentId ?? 'unknown',
      runId: input.provenance?.runId ?? context?.callingRunId,
      turnId: input.provenance?.turnId ?? context?.callingTurnId,
      toolCallId: input.provenance?.toolCallId ?? context?.callingToolCallId,
      taint: enforcedTaint,
    };

    // ------------------------------------------------------------------------
    // Decision Assembly
    // ------------------------------------------------------------------------
    const hasErrors = violations.some((v) => v.severity === 'error');
    const allowed = !hasErrors;

    const sanitizedInput: CreateMemoryInput = {
      ...input,
      title: titleScrub.text,
      content: contentScrub.text,
      tags: sanitizedTags,
      metadata: sanitizedMetadata,
      provenance: sanitizedProvenance,
    };

    return {
      allowed,
      action: allowed ? 'allow' : 'deny',
      reason: allowed
        ? undefined
        : violations
            .filter((v) => v.severity === 'error')
            .map((v) => `[${v.rule}] ${v.message}`)
            .join('; '),
      violations,
      sanitizedInput,
      redactionsCount,
      piiCount,
      injectionDetected,
    };
  }

  /**
   * Evaluates and asserts that a memory write is permitted.
   * Returns the sanitized CreateMemoryInput or throws an AirError(POLICY_DENIED).
   */
  assertAllowed(input: CreateMemoryInput, context?: MemoryWriteContext): CreateMemoryInput {
    const result = this.evaluate(input, context);
    if (!result.allowed) {
      throw new AirError('POLICY_DENIED', `[POLICY_DENIED] Memory write rejected by policy: ${result.reason}`, {
        exposeToModel: true,
        context: {
          violations: result.violations as unknown as Record<string, unknown>,
          scope: input.scope,
          kind: input.kind,
        },
      });
    }
    return result.sanitizedInput;
  }

  /**
   * Enforces policy on an entire batch of memory writes.
   * If any entry is rejected, throws AirError(POLICY_DENIED) unless allowPartial is enabled.
   */
  enforceOnBatch(
    inputs: CreateMemoryInput[],
    context?: MemoryWriteContext,
  ): CreateMemoryInput[] {
    const sanitized: CreateMemoryInput[] = [];
    const errors: string[] = [];
    const rejected: Array<{ index: number; violations: readonly MemoryWriteViolation[] }> = [];

    for (let i = 0; i < inputs.length; i++) {
      const item = inputs[i];
      if (!item) continue;
      const res = this.evaluate(item, context);
      if (!res.allowed) {
        errors.push(`Item ${i}: ${res.reason}`);
        rejected.push({ index: i, violations: res.violations });
      } else {
        sanitized.push(res.sanitizedInput);
      }
    }

    if (errors.length > 0) {
      throw new AirError('POLICY_DENIED', `[POLICY_DENIED] Memory batch write rejected by policy: ${errors.join('; ')}`, {
        exposeToModel: true,
        context: {
          errorCount: errors.length,
          totalCount: inputs.length,
          violations: rejected,
        },
      });
    }

    return sanitized;
  }

  /**
   * Sanitizes an UpdateMemoryInput (scrubs secrets/PII on updated title/content/tags/metadata).
   */
  sanitizeUpdate(input: UpdateMemoryInput): UpdateMemoryInput {
    const scrubOpts = {
      secretMode: this.config.secretScrubMode,
      piiMode: this.config.piiScrubMode,
      piiTypes: this.config.piiTypes,
    };

    const result: UpdateMemoryInput = { ...input };

    if (input.title !== undefined) {
      const scrubbed = scrubText(input.title, scrubOpts);
      if (this.config.secretScrubMode === 'reject' && scrubbed.secretCount > 0) {
        throw new AirError('POLICY_DENIED', 'Memory update rejected: secret detected in title (Rule R4)');
      }
      if (this.config.piiScrubMode === 'reject' && scrubbed.totalPiiCount > 0) {
        throw new AirError('POLICY_DENIED', 'Memory update rejected: PII detected in title');
      }
      result.title = scrubbed.text;
    }

    if (input.content !== undefined) {
      const scrubbed = scrubText(input.content, scrubOpts);
      if (this.config.secretScrubMode === 'reject' && scrubbed.secretCount > 0) {
        throw new AirError('POLICY_DENIED', 'Memory update rejected: secret detected in content (Rule R4)');
      }
      if (this.config.piiScrubMode === 'reject' && scrubbed.totalPiiCount > 0) {
        throw new AirError('POLICY_DENIED', 'Memory update rejected: PII detected in content');
      }
      result.content = scrubbed.text;
    }

    if (input.tags !== undefined) {
      result.tags = input.tags.map((t) => {
        const scrubbed = scrubText(t, scrubOpts);
        if (this.config.secretScrubMode === 'reject' && scrubbed.secretCount > 0) {
          throw new AirError('POLICY_DENIED', 'Memory update rejected: secret detected in tags');
        }
        if (this.config.piiScrubMode === 'reject' && scrubbed.totalPiiCount > 0) {
          throw new AirError('POLICY_DENIED', 'Memory update rejected: PII detected in tags');
        }
        return scrubbed.text;
      });
    }

    if (input.metadata !== undefined) {
      const scrubbed = scrubMetadataValue(input.metadata, scrubOpts);
      if (this.config.secretScrubMode === 'reject' && scrubbed.secretCount > 0) {
        throw new AirError('POLICY_DENIED', 'Memory update rejected: secret detected in metadata');
      }
      if (this.config.piiScrubMode === 'reject' && scrubbed.totalPiiCount > 0) {
        throw new AirError('POLICY_DENIED', 'Memory update rejected: PII detected in metadata');
      }
      result.metadata = scrubbed.value as Record<string, unknown>;
    }

    return result;
  }
}

/**
 * Factory creating a configured MemoryWritePolicy instance.
 */
export function createMemoryWritePolicy(
  config?: Partial<MemoryWritePolicyConfig>,
): MemoryWritePolicy {
  return new MemoryWritePolicy(config);
}
