/**
 * Policy Engine module entry point (Phase 5).
 */

export {
  CapabilityDomainSchema,
  type CapabilityDomain,
  FsActionSchema,
  type FsAction,
  NetActionSchema,
  type NetAction,
  ExecActionSchema,
  type ExecAction,
  CapabilityAtomSchema,
  type CapabilityAtom,
  type FsCapability,
  type NetCapability,
  type ExecCapability,
  createFsCapability,
  createNetCapability,
  createExecCapability,
  createCapability,
  CapabilityPatternSchema,
  type CapabilityPattern,
  formatCapability,
  parseCapabilityPattern,
  matchPathPattern,
  matchHostPattern,
  tokenizeCommandLine,
  matchCommandPattern,
  matchCapability,
  calculateCapabilitySpecificity,
  isCapabilitySubsumed,
} from './capabilities.js';

export {
  PolicyEffectSchema,
  type PolicyEffect,
  TaintLevelSchema,
  type TaintLevel,
  PolicyScopeSchema,
  type PolicyScope,
  TaintConditionSchema,
  type TaintCondition,
  PolicyMatchConditionSchema,
  type PolicyMatchCondition,
  PolicyRuleSchema,
  type PolicyRule,
  PolicyDocumentSchema,
  type PolicyDocument,
} from './schema.js';

export {
  type LoadedPolicy,
  computePolicyHash,
  parsePolicy,
  loadPolicyFromFile,
} from './loader.js';

export {
  type PolicyLintIssue,
  type PolicyLintResult,
  lintPolicy,
} from './linter.js';

export {
  type PolicyEvaluationRequest,
  type PolicyDecision,
  type RuleEvaluationTrace,
  type PolicyExplainResult,
  type PolicyEngineOptions,
  type ToolPolicyHookLike,
  PolicyEngine,
} from './engine.js';
