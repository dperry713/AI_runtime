/**
 * Taint Tracking & Provenance Engine (Phase 5 - P5-T06).
 *
 * Implements:
 * - Provenance labels for messages, tool inputs, file reads, web responses, and memory.
 * - Robust output fencing format with closing-tag evasion neutralization.
 * - Taint escalation rules per Rule S9 and Architecture §3:
 *   Tainted inputs cannot execute `risk >= medium` tools without approval (interactive)
 *   or immediate denial (headless).
 * - Prompt injection and argument smuggling sanitization (bidi overrides, null bytes, fence breakout).
 * - Per-run taint state management (`TaintTracker`).
 */

import { z } from 'zod';
import {
  type Clock,
  type IdGenerator,
  SystemClock,
  UlidIdGenerator,
} from '../util/index.js';
import { TaintLevelSchema, type TaintLevel, type PolicyEffect } from './schema.js';

export const TaintRiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type TaintRiskLevel = z.infer<typeof TaintRiskLevelSchema>;

// ============================================================================
// 1. Zod Schemas & Types
// ============================================================================

export const ProvenanceSourceTypeSchema = z.enum([
  'user',
  'system',
  'model',
  'tool_output',
  'web',
  'file',
  'mcp',
  'memory',
]);
export type ProvenanceSourceType = z.infer<typeof ProvenanceSourceTypeSchema>;

export const ProvenanceLabelSchema = z.object({
  sourceType: ProvenanceSourceTypeSchema,
  sourceId: z.string().optional(),
  taintLevel: TaintLevelSchema,
  timestamp: z.string().datetime({ offset: true }),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ProvenanceLabel = z.infer<typeof ProvenanceLabelSchema>;

export interface FenceOptions {
  /** Identifier of the data source (e.g., URL, file path, tool name). */
  readonly source?: string | undefined;
  /** High-level provenance source type. */
  readonly sourceType?: ProvenanceSourceType | undefined;
  /** Taint classification ('clean' | 'tainted'). Default: 'tainted'. */
  readonly taintLevel?: TaintLevel | undefined;
  /** Tool name producing this output, if applicable. */
  readonly toolName?: string | undefined;
  /** Custom tag name. Default: 'untrusted_content'. */
  readonly tag?: string | undefined;
}

export interface UnfenceResult {
  readonly content: string;
  readonly isFenced: boolean;
  readonly meta?: {
    readonly source?: string | undefined;
    readonly sourceType?: ProvenanceSourceType | undefined;
    readonly taintLevel?: TaintLevel | undefined;
    readonly toolName?: string | undefined;
    readonly tag?: string | undefined;
  } | undefined;
}

export interface TaintEscalationOptions {
  readonly isTainted: boolean;
  readonly toolRisk?: TaintRiskLevel | undefined;
  readonly effect: PolicyEffect;
  readonly headless?: boolean | undefined;
  readonly toolName?: string | undefined;
}

export interface TaintEscalationResult {
  readonly escalated: boolean;
  readonly originalEffect: PolicyEffect;
  readonly newEffect: PolicyEffect;
  readonly reason: string;
}

export interface InjectionDetectionResult {
  readonly detected: boolean;
  readonly indicators: readonly string[];
}

// ============================================================================
// 2. Output Fencing & Sanitization
// ============================================================================

export const DEFAULT_FENCE_TAG = 'untrusted_content';

/**
 * Fences content in an XML-style block with provenance attributes.
 * Sanitizes closing tags inside the payload to prevent fence-escape attacks.
 */
export function fenceOutput(content: string, options?: FenceOptions): string {
  const tag = (options?.tag ?? DEFAULT_FENCE_TAG).trim().toLowerCase();
  const taintLevel: TaintLevel = options?.taintLevel ?? 'tainted';
  const sourceType = options?.sourceType ?? 'tool_output';

  // Construct attribute string
  const attrs: string[] = [`taint="${taintLevel}"`, `type="${sourceType}"`];
  if (options?.toolName) {
    attrs.push(`tool="${escapeXmlAttr(options.toolName)}"`);
  }
  if (options?.source) {
    attrs.push(`source="${escapeXmlAttr(options.source)}"`);
  }

  // Prevent fence escape: replace any closing tag variants </tag> with safe neutral form <\/tag>
  const escapedContent = escapeClosingTags(content, tag);

  return `<${tag} ${attrs.join(' ')}>\n${escapedContent}\n</${tag}>`;
}

/**
 * Unfences previously fenced content, extracting original payload and metadata.
 */
export function unfenceOutput(fenced: string, expectedTag = DEFAULT_FENCE_TAG): UnfenceResult {
  const trimmed = fenced.trim();
  const tag = expectedTag.toLowerCase();

  // Pattern matching <tag ...>content</tag>
  const openRegex = new RegExp(`^<${tag}([^>]*)>\\r?\\n?([\\s\\S]*?)\\r?\\n?<\\/${tag}>$`, 'i');
  const match = openRegex.exec(trimmed);

  if (!match) {
    return {
      content: fenced,
      isFenced: false,
    };
  }

  const rawAttrs = match[1] ?? '';
  const rawContent = match[2] ?? '';

  // Parse attributes
  const taintMatch = /taint="([^"]+)"/i.exec(rawAttrs);
  const typeMatch = /type="([^"]+)"/i.exec(rawAttrs);
  const toolMatch = /tool="([^"]+)"/i.exec(rawAttrs);
  const sourceMatch = /source="([^"]+)"/i.exec(rawAttrs);

  const taintLevel = taintMatch?.[1] === 'clean' ? 'clean' : 'tainted';
  const sourceType = (typeMatch?.[1] as ProvenanceSourceType | undefined) ?? 'tool_output';
  const toolName = toolMatch?.[1] ? unescapeXmlAttr(toolMatch[1]) : undefined;
  const source = sourceMatch?.[1] ? unescapeXmlAttr(sourceMatch[1]) : undefined;

  // Restore escaped closing tags
  const restoredContent = unescapeClosingTags(rawContent, tag);

  return {
    content: restoredContent,
    isFenced: true,
    meta: {
      tag,
      taintLevel,
      sourceType,
      toolName,
      source,
    },
  };
}

/**
 * Returns true if content is enclosed within a valid fence block.
 */
export function isOutputFenced(content: string, expectedTag = DEFAULT_FENCE_TAG): boolean {
  return unfenceOutput(content, expectedTag).isFenced;
}

/**
 * Neutralizes closing tags matching the fence tag inside the content.
 */
export function escapeClosingTags(content: string, tag: string): string {
  // Replace </tag> and case variations with <\/tag> or zero-width space <\u200B/tag>
  const closingRegex = new RegExp(`<\\/\\s*${tag}\\s*>`, 'gi');
  return content.replace(closingRegex, `<\\/${tag}>`);
}

/**
 * Restores neutralized closing tags.
 */
export function unescapeClosingTags(content: string, tag: string): string {
  const escapedRegex = new RegExp(`<\\\\\\/${tag}>`, 'gi');
  return content.replace(escapedRegex, `</${tag}>`);
}

function escapeXmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unescapeXmlAttr(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ============================================================================
// 3. Prompt Injection & Smuggling Sanitizer
// ============================================================================

/**
 * Strips dangerous hidden characters, bidirectional override sequences, and null bytes.
 */
export function sanitizePromptInput(text: string): string {
  return text
    // Strip null bytes
    .replace(/\0/g, '')
    // Strip bidirectional override characters (LRO, RLO, LRE, RLE, PDF, LRI, RLI, FSI, PDI)
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    // Strip zero-width non-joiner/joiner sequences used in evasion
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

/**
 * Checks for obvious high-confidence prompt injection signatures.
 */
export function detectInjectionMarkers(text: string): InjectionDetectionResult {
  const indicators: string[] = [];
  const lower = text.toLowerCase();

  const patterns = [
    { name: 'instruction_override', regex: /ignore\s+(all\s+)?(previous|prior)\s+instructions/i },
    { name: 'system_tag_smuggling', regex: /<\/?system>/i },
    { name: 'role_prefix_smuggling', regex: /(^|\n)(human|assistant|system)\s*:/i },
    { name: 'jailbreak_marker', regex: /you\s+are\s+now\s+in\s+(dan|developer)\s+mode/i },
    { name: 'markdown_exfil', regex: /!\[.*?\]\s*\(\s*https?:\/\/[^\s)]+\?[^)]*?(secret|token|key|pwd|password|env)/i },
  ];

  for (const { name, regex } of patterns) {
    if (regex.test(lower)) {
      indicators.push(name);
    }
  }

  return {
    detected: indicators.length > 0,
    indicators,
  };
}

// ============================================================================
// 4. Taint Escalation Engine (Rule S9)
// ============================================================================

/**
 * Evaluates whether an action requires taint escalation per Rule S9:
 * "Tainted data cannot reach risk >= medium tools without approval (interactive) or denial (headless)."
 */
export function evaluateTaintEscalation(options: TaintEscalationOptions): TaintEscalationResult {
  const { isTainted, toolRisk = 'low', effect, headless = false, toolName = 'unknown' } = options;

  // 1. Untainted or already denied -> no escalation
  if (!isTainted || effect === 'deny') {
    return {
      escalated: false,
      originalEffect: effect,
      newEffect: effect,
      reason: 'No taint escalation required',
    };
  }

  // 2. Risk check: low-risk tools are exempt from automatic escalation
  if (toolRisk === 'low') {
    return {
      escalated: false,
      originalEffect: effect,
      newEffect: effect,
      reason: `Tool '${toolName}' is low risk; permitted under current taint policy`,
    };
  }

  // 3. Tool risk is >= medium (medium, high, critical)
  if (headless) {
    // In headless mode: immediate denial (Rule S1 / S9)
    return {
      escalated: true,
      originalEffect: effect,
      newEffect: 'deny',
      reason: `Rule S9: Tainted data cannot execute ${toolRisk}-risk tool '${toolName}' in headless mode`,
    };
  }

  // 4. In interactive mode: escalate 'allow' to 'ask_user'
  if (effect === 'allow') {
    return {
      escalated: true,
      originalEffect: 'allow',
      newEffect: 'ask_user',
      reason: `Rule S9: Tainted data escalation requiring operator approval for ${toolRisk}-risk tool '${toolName}'`,
    };
  }

  return {
    escalated: false,
    originalEffect: effect,
    newEffect: effect,
    reason: 'Already requires operator confirmation',
  };
}

// ============================================================================
// 5. TaintTracker (Runtime Provenance Store)
// ============================================================================

export interface RunTaintState {
  readonly runId: string;
  isTainted: boolean;
  taintLevel: TaintLevel;
  taintReasons: string[];
  sources: Map<string, ProvenanceLabel>;
}

export interface TaintTrackerOptions {
  readonly clock?: Clock | undefined;
  readonly idGenerator?: IdGenerator | undefined;
}

export class TaintTracker {
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly states = new Map<string, RunTaintState>();

  public constructor(options?: TaintTrackerOptions) {
    this.clock = options?.clock ?? new SystemClock();
    this.idGenerator = options?.idGenerator ?? new UlidIdGenerator();
  }

  /**
   * Initializes or returns the taint state for a run.
   */
  public getOrCreateRunState(runId: string): RunTaintState {
    let state = this.states.get(runId);
    if (!state) {
      state = {
        runId,
        isTainted: false,
        taintLevel: 'clean',
        taintReasons: [],
        sources: new Map(),
      };
      this.states.set(runId, state);
    }
    return state;
  }

  /**
   * Registers a data source or message with a provenance label.
   */
  public registerSource(runId: string, sourceId: string, label: ProvenanceLabel): void {
    const state = this.getOrCreateRunState(runId);
    state.sources.set(sourceId, label);

    if (label.taintLevel === 'tainted') {
      state.isTainted = true;
      state.taintLevel = 'tainted';
      state.taintReasons.push(`Source '${sourceId}' (${label.sourceType}) registered as tainted`);
    }
  }

  /**
   * Explicitly marks a run as tainted.
   */
  public markTainted(runId: string, reason: string): void {
    const state = this.getOrCreateRunState(runId);
    state.isTainted = true;
    state.taintLevel = 'tainted';
    state.taintReasons.push(reason);
  }

  /**
   * Returns true if the run is currently tainted.
   */
  public isTainted(runId: string): boolean {
    const state = this.states.get(runId);
    return state ? state.isTainted : false;
  }

  /**
   * Returns the current taint level for the run.
   */
  public getTaintLevel(runId: string): TaintLevel {
    const state = this.states.get(runId);
    return state ? state.taintLevel : 'clean';
  }

  /**
   * Analyzes a tool execution result and marks run as tainted if appropriate.
   */
  public inspectAndTagToolOutput(
    runId: string,
    toolName: string,
    output: unknown,
    metadata?: Record<string, unknown>,
  ): ProvenanceLabel {
    const isExplicitlyTainted = metadata?.tainted === true;
    const isNetworkOrWeb = toolName.startsWith('http.') || toolName.startsWith('web.');
    const isMcp = toolName.startsWith('mcp.') || toolName.startsWith('mcp_');

    const shouldTaint = isExplicitlyTainted || isNetworkOrWeb || isMcp;
    const taintLevel: TaintLevel = shouldTaint ? 'tainted' : 'clean';

    const label: ProvenanceLabel = {
      sourceType: isNetworkOrWeb ? 'web' : isMcp ? 'mcp' : 'tool_output',
      sourceId: toolName,
      taintLevel,
      timestamp: this.clock.now().toISOString(),
      tags: shouldTaint ? ['untrusted', toolName] : [toolName],
      metadata: {
        ...metadata,
        outputType: typeof output,
      },
    };

    const sourceTag = `${toolName}:${this.idGenerator.next()}`;
    this.registerSource(runId, sourceTag, label);
    return label;
  }

  /**
   * Resets taint state for a run.
   */
  public clear(runId: string): void {
    this.states.delete(runId);
  }
}
