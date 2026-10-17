/**
 * Policy Decision Engine (Phase 5 - P5-T03).
 *
 * Evaluates tool execution requests against loaded Policy Documents:
 * - Deny-by-default security model (Rule S1).
 * - Precedence rules: explicit deny always takes precedence over allow and ask_user.
 * - Specificity ordering: exact matches rank higher than wildcards.
 * - Explicit priority overrides (higher numbers evaluated first).
 * - Scope filtering: agent, session, profile matching.
 * - Tool matching with exact and wildcard namespace support.
 * - Granular capability matching with Windows path and network awareness.
 * - Argument constraints and taint escalation.
 * - Full audit explain output (`explain(request)`).
 * - Journal event emission: emits `tool.policy_decided` (Rule R8).
 * - Injected Clock and IdGenerator for deterministic replay (Rule R6).
 * - Adapter for ToolExecutor hook (`asToolPolicyHook()`).
 *
 * Adheres to:
 * - Rule R1: No console.log; uses observability logger.
 * - Rule R6: Injected Clock and IdGenerator.
 * - Rule R7: Strict TypeScript, no any.
 * - Rule R8: Journal tool.policy_decided on decisions.
 * - Rule R11: Typed AirError errors.
 * - Rule S1: Deny-by-default.
 */

import { AirError } from '../errors/index.js';
import type { Clock, IdGenerator } from '../util/index.js';
import { SystemClock, UlidIdGenerator } from '../util/index.js';
import type { EventBus } from '../journal/index.js';
import { createEnvelope } from '../journal/index.js';
import type { ComponentLogger } from '../observability/index.js';
import { getLogger } from '../observability/index.js';
import { parseToolCallId, type ToolCallId } from '../types/index.js';
import type {
  CapabilityAtom,
} from './capabilities.js';
import {
  calculateCapabilitySpecificity,
  matchCapability,
  parseCapabilityPattern,
} from './capabilities.js';
import type {
  PolicyDocument,
  PolicyEffect,
  PolicyRule,
  TaintLevel,
} from './schema.js';

// ============================================================================
// 1. Interfaces & Types
// ============================================================================

export interface PolicyEvaluationRequest {
  readonly toolName: string;
  readonly input?: unknown;
  readonly capabilities?: readonly (CapabilityAtom | string)[] | undefined;
  readonly agentId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly profile?: string | undefined;
  readonly runId?: string | undefined;
  readonly callId?: ToolCallId | string | undefined;
  readonly tainted?: boolean | undefined;
  readonly taintLevel?: TaintLevel | undefined;
  readonly context?: Record<string, unknown> | undefined;
}

export interface PolicyDecision {
  readonly decisionId: string;
  readonly effect: PolicyEffect;
  readonly allowed: boolean;
  readonly ruleId: string;
  readonly reason: string;
  readonly toolName: string;
  readonly evaluatedAt: string;
  readonly matchedRule?: PolicyRule | undefined;
  readonly specificity?: number | undefined;
  readonly priority?: number | undefined;
  readonly candidateRulesCount: number;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface RuleEvaluationTrace {
  readonly ruleId: string;
  readonly effect: PolicyEffect;
  readonly priority: number;
  readonly specificity: number;
  readonly matched: boolean;
  readonly rejectReason?: string | undefined;
  readonly selected?: boolean | undefined;
}

export interface PolicyExplainResult {
  readonly decision: PolicyDecision;
  readonly request: PolicyEvaluationRequest;
  readonly candidateRulesCount: number;
  readonly evaluatedRules: readonly RuleEvaluationTrace[];
  readonly explanation: string;
}

export interface PolicyEngineOptions {
  readonly clock?: Clock | undefined;
  readonly idGenerator?: IdGenerator | undefined;
  readonly eventBus?: EventBus | undefined;
  readonly defaultEffect?: 'deny' | 'ask_user' | undefined;
  readonly logger?: ComponentLogger | undefined;
}

/**
 * Structural duck-type adapter for ToolExecutor's ToolPolicyHook.
 */
export interface ToolPolicyHookLike {
  evaluate(context: {
    readonly tool: { readonly name: string };
    readonly input: unknown;
    readonly capabilities?: readonly unknown[] | undefined;
    readonly executionContext: {
      readonly callId: string;
      readonly runId: string;
      readonly sessionId?: string | undefined;
      readonly agentId?: string | undefined;
    };
  }): Promise<{
    readonly allowed: boolean;
    readonly decisionId?: string | undefined;
    readonly reason?: string | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }>;
}

interface MatchedCandidate {
  readonly rule: PolicyRule;
  readonly index: number;
  readonly priority: number;
  readonly specificity: number;
}

// ============================================================================
// 2. Helper Match Functions
// ============================================================================

/**
 * Case-insensitive wildcard glob matching (e.g. 'coder*', 'fs.*', '*').
 * Also supports pipe-delimited alternation (e.g. 'npm *|npx *|git *').
 */
function matchGlob(value: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '**') return true;

  if (pattern.includes('|')) {
    const subPatterns = pattern.split('|').map((p) => p.trim());
    return subPatterns.some((sp) => matchGlob(value, sp));
  }

  if (!pattern.includes('*') && !pattern.includes('?')) {
    return value.toLowerCase() === pattern.toLowerCase();
  }

  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  const regex = new RegExp(`^${escaped}$`, 'i');
  return regex.test(value);
}

/**
 * Checks if a value deeply matches an expected pattern.
 */
function matchArgumentPattern(actual: unknown, expected: unknown): boolean {
  if (expected === '*' || expected === '**') return true;

  if (typeof expected === 'string') {
    if (typeof actual !== 'string') return false;
    return matchGlob(actual, expected);
  }

  if (typeof expected === 'number' || typeof expected === 'boolean') {
    return actual === expected;
  }

  if (expected === null) {
    return actual === null;
  }

  // If expected is an array of candidate patterns and actual is not an array,
  // evaluate as OR: match if actual matches ANY pattern in the array.
  if (Array.isArray(expected) && !Array.isArray(actual)) {
    return expected.some((exp) => matchArgumentPattern(actual, exp));
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    if (expected.length !== actual.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (!matchArgumentPattern(actual[i], expected[i])) return false;
    }
    return true;
  }

  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null) return false;
    const actualObj = actual as Record<string, unknown>;
    for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
      if (!(k in actualObj)) return false;
      if (!matchArgumentPattern(actualObj[k], v)) return false;
    }
    return true;
  }

  return actual === expected;
}

// ============================================================================
// 3. PolicyEngine Class
// ============================================================================

export class PolicyEngine {
  private readonly document: PolicyDocument;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly eventBus?: EventBus | undefined;
  private readonly defaultEffect: 'deny' | 'ask_user';
  private readonly logger: ComponentLogger;

  constructor(document: PolicyDocument, options: PolicyEngineOptions = {}) {
    if (!document) {
      throw new AirError('POLICY_INVALID', 'PolicyEngine requires a valid PolicyDocument');
    }
    this.document = document;
    this.clock = options.clock ?? new SystemClock();
    this.idGenerator = options.idGenerator ?? new UlidIdGenerator(this.clock);
    this.eventBus = options.eventBus;
    this.defaultEffect = options.defaultEffect ?? document.defaultEffect ?? 'deny';
    this.logger = options.logger ?? getLogger('policy-engine');
  }

  /**
   * Retrieves the active PolicyDocument.
   */
  public getDocument(): PolicyDocument {
    return this.document;
  }

  /**
   * Evaluates a tool execution request against the policy document (Rule S1).
   */
  public evaluate(request: PolicyEvaluationRequest): PolicyDecision {
    const explainResult = this.evaluateInternal(request);
    const decision = explainResult.decision;

    // Rule R8: Emit tool.policy_decided event if eventBus is provided
    if (this.eventBus) {
      try {
        const rawCallId = request.callId ?? this.idGenerator.nextToolCallId();
        const toolCallId = parseToolCallId(rawCallId);
        const mappedDecision: 'allow' | 'deny' | 'ask' =
          decision.effect === 'ask_user' ? 'ask' : decision.effect;

        this.eventBus.publish(
          createEnvelope({
            stream: `run:${request.runId ?? 'default'}`,
            seq: 1,
            type: 'tool.policy_decided',
            payload: {
              toolCallId,
              decision: mappedDecision,
              ruleId: decision.ruleId,
              reason: decision.reason,
            },
            meta: {
              runId: request.runId,
              sessionId: request.sessionId,
              agentId: request.agentId,
              toolCallId,
            },
            clock: this.clock,
            idGenerator: this.idGenerator,
          }),
        );
      } catch (err) {
        this.logger.warn(
          {
            event: 'policy.publish_failed',
            err: err instanceof Error ? err : new Error(String(err)),
          },
          'Failed to publish tool.policy_decided journal event',
        );
      }
    }

    return decision;
  }

  /**
   * Alias for evaluate() per docs/MODULES.md.
   */
  public decide(request: PolicyEvaluationRequest): PolicyDecision {
    return this.evaluate(request);
  }

  /**
   * Produces an explainable audit trace of how the decision was derived.
   */
  public explain(request: PolicyEvaluationRequest): PolicyExplainResult {
    return this.evaluateInternal(request);
  }

  /**
   * Returns a hook adapter that duck-types to ToolExecutor's ToolPolicyHook.
   */
  public asToolPolicyHook(): ToolPolicyHookLike {
    return {
      evaluate: (ctx) => {
        const caps = Array.isArray(ctx.capabilities)
          ? (ctx.capabilities as readonly CapabilityAtom[])
          : [];

        const decision = this.evaluate({
          toolName: ctx.tool.name,
          input: ctx.input,
          capabilities: caps,
          callId: ctx.executionContext.callId,
          runId: ctx.executionContext.runId,
          sessionId: ctx.executionContext.sessionId,
          agentId: ctx.executionContext.agentId,
        });

        return Promise.resolve({
          allowed: decision.allowed,
          decisionId: decision.decisionId,
          reason: decision.reason,
          metadata: {
            effect: decision.effect,
            ruleId: decision.ruleId,
            specificity: decision.specificity,
            priority: decision.priority,
            evaluatedAt: decision.evaluatedAt,
          },
        });
      },
    };
  }

  // ==========================================================================
  // Internal Evaluation Engine
  // ==========================================================================

  private evaluateInternal(request: PolicyEvaluationRequest): PolicyExplainResult {
    const rules = this.document.rules ?? [];
    const evaluatedRules: RuleEvaluationTrace[] = [];
    const matchedCandidates: MatchedCandidate[] = [];

    for (let index = 0; index < rules.length; index++) {
      const rule = rules[index];
      if (!rule) continue;

      const evalResult = this.checkRuleMatch(rule, request);

      evaluatedRules.push({
        ruleId: rule.id,
        effect: rule.effect,
        priority: rule.priority ?? 0,
        specificity: evalResult.specificity,
        matched: evalResult.matched,
        rejectReason: evalResult.rejectReason,
      });

      if (evalResult.matched) {
        matchedCandidates.push({
          rule,
          index,
          priority: rule.priority ?? 0,
          specificity: evalResult.specificity,
        });
      }
    }

    const decisionId = this.idGenerator.next();
    const evaluatedAt = this.clock.now().toISOString();

    // Default Fallback if no candidate matched (Rule S1)
    if (matchedCandidates.length === 0) {
      const effect = this.defaultEffect;
      const reason =
        effect === 'ask_user'
          ? 'No matching policy rule; requiring approval by default'
          : 'No matching policy rule; denied by default';

      const decision: PolicyDecision = {
        decisionId,
        effect,
        allowed: false,
        ruleId: 'default',
        reason,
        toolName: request.toolName,
        evaluatedAt,
        candidateRulesCount: rules.length,
        specificity: 0,
        priority: 0,
      };

      const explanation = this.formatExplanation(request, decision, evaluatedRules);
      return {
        decision,
        request,
        candidateRulesCount: rules.length,
        evaluatedRules,
        explanation,
      };
    }

    // 1. Group candidates by priority (higher priority evaluated first)
    let maxPriority = -Infinity;
    for (const c of matchedCandidates) {
      if (c.priority > maxPriority) {
        maxPriority = c.priority;
      }
    }

    const topTierCandidates = matchedCandidates.filter((c) => c.priority === maxPriority);

    // 2. Deny Precedence: In top priority tier, explicit deny ALWAYS beats allow and ask_user
    const denyCandidates = topTierCandidates.filter((c) => c.rule.effect === 'deny');
    const askCandidates = topTierCandidates.filter((c) => c.rule.effect === 'ask_user');
    const allowCandidates = topTierCandidates.filter((c) => c.rule.effect === 'allow');

    let winningCandidate: MatchedCandidate;

    if (denyCandidates.length > 0) {
      winningCandidate = this.pickWinningCandidate(denyCandidates);
    } else if (askCandidates.length > 0) {
      winningCandidate = this.pickWinningCandidate(askCandidates);
    } else {
      winningCandidate = this.pickWinningCandidate(allowCandidates);
    }

    // Mark selected in trace
    const selectedTraceIndex = evaluatedRules.findIndex(
      (r) => r.ruleId === winningCandidate.rule.id,
    );
    if (selectedTraceIndex !== -1 && evaluatedRules[selectedTraceIndex]) {
      (evaluatedRules[selectedTraceIndex] as { selected?: boolean }).selected = true;
    }

    const winningRule = winningCandidate.rule;
    const effect = winningRule.effect;
    const allowed = effect === 'allow';

    const decision: PolicyDecision = {
      decisionId,
      effect,
      allowed,
      ruleId: winningRule.id,
      reason: winningRule.reason,
      toolName: request.toolName,
      evaluatedAt,
      matchedRule: winningRule,
      specificity: winningCandidate.specificity,
      priority: winningCandidate.priority,
      candidateRulesCount: rules.length,
    };

    const explanation = this.formatExplanation(request, decision, evaluatedRules);

    return {
      decision,
      request,
      candidateRulesCount: rules.length,
      evaluatedRules,
      explanation,
    };
  }

  /**
   * Selects the winning candidate among a subset by highest specificity, then earliest document index.
   */
  private pickWinningCandidate(candidates: MatchedCandidate[]): MatchedCandidate {
    const first = candidates[0];
    if (!first) {
      throw new AirError('INTERNAL', 'Cannot pick winning candidate from empty list');
    }
    let best = first;
    for (let i = 1; i < candidates.length; i++) {
      const current = candidates[i];
      if (!current) continue;
      if (current.specificity > best.specificity) {
        best = current;
      } else if (current.specificity === best.specificity && current.index < best.index) {
        best = current;
      }
    }
    return best;
  }

  // ==========================================================================
  // Rule Matching Logic
  // ==========================================================================

  private checkRuleMatch(
    rule: PolicyRule,
    request: PolicyEvaluationRequest,
  ): { matched: boolean; specificity: number; rejectReason?: string | undefined } {
    // 1. Scope filter
    const scopeCheck = this.matchScope(rule, request);
    if (!scopeCheck.matched) {
      return { matched: false, specificity: 0, rejectReason: scopeCheck.reason };
    }

    // 2. Tool name filter
    const toolCheck = this.matchTool(rule, request.toolName);
    if (!toolCheck.matched) {
      return { matched: false, specificity: 0, rejectReason: toolCheck.reason };
    }

    // 3. Capabilities filter
    const capCheck = this.matchCapabilities(rule, request);
    if (!capCheck.matched) {
      return { matched: false, specificity: 0, rejectReason: capCheck.reason };
    }

    // 4. Arguments filter
    const argsCheck = this.matchArgs(rule, request.input);
    if (!argsCheck.matched) {
      return { matched: false, specificity: 0, rejectReason: argsCheck.reason };
    }

    // 5. Taint filter
    const taintCheck = this.matchTaint(rule, request);
    if (!taintCheck.matched) {
      return { matched: false, specificity: 0, rejectReason: taintCheck.reason };
    }

    // Compute total monotonic specificity score
    const totalSpecificity =
      toolCheck.toolSpecificity + capCheck.capabilitySpecificity + argsCheck.argsSpecificity;

    return {
      matched: true,
      specificity: totalSpecificity,
    };
  }

  private matchScope(
    rule: PolicyRule,
    request: PolicyEvaluationRequest,
  ): { matched: boolean; reason?: string | undefined } {
    const scope = rule.scope;
    if (!scope) return { matched: true };

    if (scope.agents && scope.agents.length > 0) {
      const agentId = request.agentId;
      if (!agentId) {
        return { matched: false, reason: 'Rule requires agent scope, but no agentId was provided' };
      }
      const matched = scope.agents.some((pattern) => matchGlob(agentId, pattern));
      if (!matched) {
        return {
          matched: false,
          reason: `Agent '${agentId}' does not match scope [${scope.agents.join(', ')}]`,
        };
      }
    }

    if (scope.sessions && scope.sessions.length > 0) {
      const sessionId = request.sessionId;
      if (!sessionId) {
        return { matched: false, reason: 'Rule requires session scope, but no sessionId was provided' };
      }
      const matched = scope.sessions.some((pattern) => matchGlob(sessionId, pattern));
      if (!matched) {
        return {
          matched: false,
          reason: `Session '${sessionId}' does not match scope [${scope.sessions.join(', ')}]`,
        };
      }
    }

    if (scope.profiles && scope.profiles.length > 0) {
      const profile = request.profile;
      if (!profile) {
        return { matched: false, reason: 'Rule requires profile scope, but no profile was provided' };
      }
      const matched = scope.profiles.some((pattern) => matchGlob(profile, pattern));
      if (!matched) {
        return {
          matched: false,
          reason: `Profile '${profile}' does not match scope [${scope.profiles.join(', ')}]`,
        };
      }
    }

    return { matched: true };
  }

  private matchTool(
    rule: PolicyRule,
    toolName: string,
  ): { matched: boolean; toolSpecificity: number; reason?: string | undefined } {
    const tools = rule.match.tools;
    if (!tools) {
      return { matched: true, toolSpecificity: 0 };
    }

    const toolPatterns = Array.isArray(tools) ? tools : [tools];
    let bestSpecificity = -1;
    let anyMatched = false;

    for (const pattern of toolPatterns) {
      if (matchGlob(toolName, pattern)) {
        anyMatched = true;
        let spec: number;
        if (pattern === '*' || pattern === '**') {
          spec = 0;
        } else if (pattern.endsWith('.*') || pattern.includes('*')) {
          spec = 50;
        } else {
          spec = 100; // Exact tool match
        }
        if (spec > bestSpecificity) {
          bestSpecificity = spec;
        }
      }
    }

    if (!anyMatched) {
      return {
        matched: false,
        toolSpecificity: 0,
        reason: `Tool '${toolName}' does not match pattern [${toolPatterns.join(', ')}]`,
      };
    }

    return {
      matched: true,
      toolSpecificity: Math.max(0, bestSpecificity),
    };
  }

  private matchCapabilities(
    rule: PolicyRule,
    request: PolicyEvaluationRequest,
  ): { matched: boolean; capabilitySpecificity: number; reason?: string | undefined } {
    const rawPatterns = rule.match.capabilities;
    if (!rawPatterns) {
      return { matched: true, capabilitySpecificity: 0 };
    }

    const patterns = (Array.isArray(rawPatterns) ? rawPatterns : [rawPatterns]).map((p) =>
      parseCapabilityPattern(p),
    );

    const requestedCaps = request.capabilities ?? [];

    if (requestedCaps.length === 0) {
      return {
        matched: false,
        capabilitySpecificity: 0,
        reason: 'Rule requires capabilities, but request provided none',
      };
    }

    const parsedRequested: CapabilityAtom[] = requestedCaps.map((c) => {
      if (typeof c === 'string') {
        const p = parseCapabilityPattern(c);
        const action = Array.isArray(p.action) ? (p.action[0] ?? '*') : (p.action ?? '*');
        return {
          type: p.type,
          action,
          resource: p.resource,
          meta: p.meta,
        };
      }
      return c;
    });

    // DENY rules match if ANY requested capability matches ANY rule pattern
    if (rule.effect === 'deny') {
      let matchedAny = false;
      let maxSpec = 0;

      for (const reqCap of parsedRequested) {
        for (const pattern of patterns) {
          if (matchCapability(pattern, reqCap)) {
            matchedAny = true;
            const spec = calculateCapabilitySpecificity(pattern);
            if (spec > maxSpec) maxSpec = spec;
          }
        }
      }

      if (matchedAny) {
        return { matched: true, capabilitySpecificity: maxSpec };
      }
      return {
        matched: false,
        capabilitySpecificity: 0,
        reason: 'None of the requested capabilities matched deny patterns',
      };
    }

    // ALLOW and ASK_USER rules require ALL requested capabilities to match at least one pattern
    let totalMaxSpec = 0;
    for (const reqCap of parsedRequested) {
      let capMatched = false;
      for (const pattern of patterns) {
        if (matchCapability(pattern, reqCap)) {
          capMatched = true;
          const spec = calculateCapabilitySpecificity(pattern);
          if (spec > totalMaxSpec) totalMaxSpec = spec;
        }
      }
      if (!capMatched) {
        return {
          matched: false,
          capabilitySpecificity: 0,
          reason: `Requested capability '${reqCap.type}:${reqCap.action ?? '*'}:${reqCap.resource ?? '*'}' not permitted by rule`,
        };
      }
    }

    return {
      matched: true,
      capabilitySpecificity: totalMaxSpec,
    };
  }

  private matchArgs(
    rule: PolicyRule,
    input: unknown,
  ): { matched: boolean; argsSpecificity: number; reason?: string | undefined } {
    const expectedArgs = rule.match.args;
    if (!expectedArgs || Object.keys(expectedArgs).length === 0) {
      return { matched: true, argsSpecificity: 0 };
    }

    if (typeof input !== 'object' || input === null) {
      return {
        matched: false,
        argsSpecificity: 0,
        reason: 'Rule specifies argument conditions but input is not an object',
      };
    }

    const inputObj = input as Record<string, unknown>;
    for (const [argKey, expectedVal] of Object.entries(expectedArgs)) {
      if (!(argKey in inputObj)) {
        return {
          matched: false,
          argsSpecificity: 0,
          reason: `Missing required argument '${argKey}'`,
        };
      }
      if (!matchArgumentPattern(inputObj[argKey], expectedVal)) {
        return {
          matched: false,
          argsSpecificity: 0,
          reason: `Argument '${argKey}' value did not match expected pattern`,
        };
      }
    }

    return {
      matched: true,
      argsSpecificity: Object.keys(expectedArgs).length * 20,
    };
  }

  private matchTaint(
    rule: PolicyRule,
    request: PolicyEvaluationRequest,
  ): { matched: boolean; reason?: string | undefined } {
    const taintCondition = rule.match.taint;
    if (!taintCondition) return { matched: true };

    const isTainted =
      request.tainted === true || request.taintLevel === 'tainted';

    if (rule.effect === 'deny' || rule.effect === 'ask_user') {
      if (taintCondition.disallowTainted && !isTainted) {
        return {
          matched: false,
          reason: 'Rule targets tainted requests, but context is clean',
        };
      }
      if (taintCondition.maxTaintLevel === 'clean' && !isTainted) {
        return {
          matched: false,
          reason: 'Rule targets tainted requests, but context is clean',
        };
      }
      return { matched: true };
    }

    if (taintCondition.disallowTainted) {
      if (isTainted && rule.effect === 'allow') {
        return {
          matched: false,
          reason: 'Execution context is tainted; action disallowed by rule',
        };
      }
    }

    if (taintCondition.maxTaintLevel === 'clean') {
      if (isTainted && rule.effect === 'allow') {
        return {
          matched: false,
          reason: "Taint level 'tainted' exceeds maximum allowed 'clean'",
        };
      }
    }

    return { matched: true };
  }

  // ==========================================================================
  // Formatter for air policy explain
  // ==========================================================================

  private formatExplanation(
    request: PolicyEvaluationRequest,
    decision: PolicyDecision,
    traces: readonly RuleEvaluationTrace[],
  ): string {
    const lines: string[] = [];
    lines.push('=== Policy Evaluation Explanation ===');
    lines.push(`Tool:         ${request.toolName}`);
    if (request.agentId) lines.push(`Agent:        ${request.agentId}`);
    if (request.sessionId) lines.push(`Session:      ${request.sessionId}`);
    if (request.profile) lines.push(`Profile:      ${request.profile}`);
    if (request.tainted || request.taintLevel) {
      lines.push(`Taint:        ${request.taintLevel ?? 'tainted'}`);
    }

    lines.push('');
    lines.push(`Decision:     ${decision.effect.toUpperCase()}`);
    lines.push(`Allowed:      ${decision.allowed}`);
    lines.push(`Rule ID:      ${decision.ruleId}`);
    lines.push(`Reason:       ${decision.reason}`);
    lines.push(`Specificity:  ${decision.specificity ?? 0}`);
    lines.push(`Priority:     ${decision.priority ?? 0}`);
    lines.push('');
    lines.push(`Rules Evaluated (${traces.length} total):`);

    for (let i = 0; i < traces.length; i++) {
      const trace = traces[i];
      if (!trace) continue;
      const status = trace.selected
        ? 'SELECTED'
        : trace.matched
          ? 'MATCHED'
          : `REJECTED (${trace.rejectReason ?? 'did not match'})`;

      lines.push(
        `  [${i + 1}] ${trace.ruleId} (${trace.effect}, prio:${trace.priority}, spec:${trace.specificity}): ${status}`,
      );
    }

    return lines.join('\n');
  }
}
