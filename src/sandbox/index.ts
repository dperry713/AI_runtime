/**
 * Sandbox module entry point (Phase 4 / Phase 7).
 */

export {
  type ShellType,
  type ProcessRunOptions,
  type ProcessRunResult,
  type ProcessRunner,
  type ActiveProcessInfo,
} from './types.js';

export {
  type StandardProcessRunnerOptions,
  type ScrubEnvironmentOptions,
  DEFAULT_ENV_ALLOWLIST,
  BLOCKED_ENV_PATTERNS,
  isBlockedEnvName,
  scrubEnvironment,
  killProcessTree,
  StandardProcessRunner,
} from './process-runner.js';

export {
  type NaiveProcessRunnerOptions,
  NaiveProcessRunner,
} from './naive-runner.js';

export {
  type MockProcessStep,
  MockProcessRunner,
} from './mock-runner.js';

export {
  type JobLimitsConfig,
  type HelperLaunchRequest,
  type HelperResponse,
  type SandboxHelperClientOptions,
  HELPER_PROTOCOL_VERSION,
  SandboxHelperClient,
} from './helper-client.js';

export {
  type ReparseType,
  type ReparseNode,
  type ReparseInspectionResult,
  type HardlinkInfo,
  type SafeFileHandle,
  type ReparseDefenseOptions,
  ReparseDefense,
  isReparsePoint,
  isReparsePointSync,
  resolveLinkTarget,
  checkHardlinks,
  inspectReparseChain,
  assertNoReparseEscape,
  openSafelyInJail,
} from './reparse.js';

export {
  type EgressDecision,
  type EgressLogEvent,
  type EgressProxyOptions,
  type EgressControllerConfig,
  type FirewallRuleResult,
  EgressProxy,
  NetworkEgressController,
  WindowsFirewallManager,
  parseHostAndPort,
  matchesHostPattern,
  evaluateEgressPolicy,
} from './network.js';

export {
  type TrackedChildProcess,
  type TrackedChildrenFile,
  type ReapedProcessInfo,
  type ReapResult,
  type OrphanReaperOptions,
  CHILDREN_REGISTRY_FILENAME,
  CHILDREN_REGISTRY_VERSION,
  OrphanReaper,
  isProcessAlive,
} from './orphan-reaper.js';

