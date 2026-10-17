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

export {
  type ApprovalScope,
  type ApprovalStatus,
  type ApprovalRiskLevel,
  type ApprovalRecord,
  type CachedApprovalGrant,
  type ApprovalPersistedState,
  type RequestApprovalOptions,
  type ResolveApprovalOptions,
  type CheckCachedApprovalParams,
  type ApprovalDecisionResult,
  type ApprovalBrokerStorageOptions,
  type ApprovalBrokerOptions,
  ApprovalBroker,
} from './approvals.js';

export {
  BudgetDimensionSchema,
  type BudgetDimension,
  RunBudgetLimitsSchema,
  type RunBudgetLimits,
  BudgetUsageSchema,
  type BudgetUsage,
  type BudgetStatus,
  type BudgetExceededDetails,
  type BudgetSnapshot,
  type BudgetPreCheckResult,
  type RecordTokensOptions,
  type BudgetTrackerOptions,
  type CreateRunBudgetOptions,
  BudgetTracker,
} from './budgets.js';

export {
  TaintRiskLevelSchema,
  type TaintRiskLevel,
  ProvenanceSourceTypeSchema,
  type ProvenanceSourceType,
  ProvenanceLabelSchema,
  type ProvenanceLabel,
  type FenceOptions,
  type UnfenceResult,
  type TaintEscalationOptions,
  type TaintEscalationResult,
  type InjectionDetectionResult,
  DEFAULT_FENCE_TAG,
  fenceOutput,
  unfenceOutput,
  isOutputFenced,
  escapeClosingTags,
  unescapeClosingTags,
  sanitizePromptInput,
  detectInjectionMarkers,
  evaluateTaintEscalation,
  type RunTaintState,
  type TaintTrackerOptions,
  TaintTracker,
} from './taint.js';

export {
  PolicyProfileNameSchema,
  type PolicyProfileName,
  type PolicyProfileSummary,
  READONLY_PROFILE,
  PROJECT_WRITE_PROFILE,
  DEV_SHELL_PROFILE,
  LOCKED_DOWN_PROFILE,
  DEFAULT_POLICY_PROFILES,
  getPolicyProfile,
  listPolicyProfiles,
} from './profiles.js';



