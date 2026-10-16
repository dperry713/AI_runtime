import type { AirConfig } from './schema.js';
import { AirConfigSchema } from './schema.js';

export type ConfigSource = 'default' | 'file' | 'env' | 'cli';

export interface KeyProvenance {
  source: ConfigSource;
  detail?: string | undefined;
}

export type ProvenanceMap = Record<string, KeyProvenance>;

export interface ConfigKeyMetadata {
  key: string;
  description: string;
  envVar?: string | undefined;
  cliFlag?: string | undefined;
}

export interface ConfigExplanation {
  key: string;
  value: unknown;
  defaultValue: unknown;
  source: ConfigSource;
  detail?: string | undefined;
  description: string;
  envVar?: string | undefined;
  cliFlag?: string | undefined;
}

export const KNOWN_CONFIG_KEYS: ConfigKeyMetadata[] = [
  {
    key: 'logging.level',
    description: 'Root logging level for runtime output (trace, debug, info, warn, error, fatal)',
    envVar: 'AIR_LOG_LEVEL',
    cliFlag: '--log-level',
  },
  {
    key: 'logging.llmPayloads',
    description: 'Redaction policy for LLM prompt and completion payloads in logs (full, redacted, off)',
    envVar: 'AIR_LOG_PAYLOADS',
    cliFlag: '--llm-payloads',
  },
  {
    key: 'logging.maxTotalMb',
    description: 'Maximum total size in megabytes for all log files combined',
    envVar: 'AIR_LOG_MAX_TOTAL_MB',
    cliFlag: '--log-max-total-mb',
  },
  {
    key: 'logging.rotate.maxSizeMb',
    description: 'Maximum size in megabytes of a single log segment before rotation',
  },
  {
    key: 'logging.rotate.keep',
    description: 'Number of rotated log files to retain',
  },
  {
    key: 'defaults.provider',
    description: 'Identifier of default LLM provider',
    envVar: 'AIR_DEFAULTS_PROVIDER',
    cliFlag: '--provider',
  },
  {
    key: 'defaults.fallbackProviders',
    description: 'Ordered list of fallback provider IDs if default provider fails',
  },
  {
    key: 'defaults.agent',
    description: 'Default agent manifest name',
  },
  {
    key: 'defaults.policyProfile',
    description: 'Default policy security profile',
    envVar: 'AIR_POLICY_PROFILE',
    cliFlag: '--policy-profile',
  },
  {
    key: 'budgets.maxUsdPerRun',
    description: 'Maximum cost in USD allowed for a single agent run',
    envVar: 'AIR_BUDGET_USD',
    cliFlag: '--budget-usd',
  },
  {
    key: 'budgets.maxTokensPerRun',
    description: 'Maximum tokens (input + output) allowed for a single agent run',
    envVar: 'AIR_BUDGET_TOKENS',
    cliFlag: '--budget-tokens',
  },
  {
    key: 'budgets.maxStepsPerRun',
    description: 'Maximum execution turns / steps for a single agent run',
    envVar: 'AIR_BUDGET_STEPS',
    cliFlag: '--budget-steps',
  },
  {
    key: 'budgets.maxWallClockMinutes',
    description: 'Maximum wall-clock duration in minutes for a single agent run',
    envVar: 'AIR_BUDGET_MINUTES',
    cliFlag: '--budget-minutes',
  },
  {
    key: 'journal.fsync',
    description: 'Filesystem synchronization strategy for journal commits (always, batch, never)',
    envVar: 'AIR_JOURNAL_FSYNC',
    cliFlag: '--fsync',
  },
  {
    key: 'journal.segmentMaxMb',
    description: 'Maximum size in megabytes of a journal segment file before rotating',
  },
  {
    key: 'sandbox.defaultTimeoutSeconds',
    description: 'Default timeout in seconds for child process execution in sandbox',
    envVar: 'AIR_SANDBOX_TIMEOUT',
    cliFlag: '--sandbox-timeout',
  },
  {
    key: 'sandbox.maxOutputBytes',
    description: 'Maximum output bytes captured from stdout/stderr of sandboxed processes',
  },
  {
    key: 'sandbox.maxProcessesPerCommand',
    description: 'Maximum child processes that can be spawned under a single Job Object',
  },
  {
    key: 'sandbox.maxMemoryMbPerCommand',
    description: 'Maximum memory limit in megabytes per sandbox Job Object',
  },
  {
    key: 'sandbox.networkDefault',
    description: 'Default network access capability for sandboxed executions (none, allow)',
    envVar: 'AIR_SANDBOX_NETWORK',
  },
  {
    key: 'ipc.pipeName',
    description: 'Windows Named Pipe name for daemon-shell IPC communication',
    envVar: 'AIR_IPC_PIPE_NAME',
    cliFlag: '--pipe-name',
  },
  {
    key: 'concurrency.maxActiveRuns',
    description: 'Maximum concurrently executing agent runs hosted by daemon',
    envVar: 'AIR_MAX_ACTIVE_RUNS',
  },
  {
    key: 'concurrency.maxParallelToolCalls',
    description: 'Maximum parallel tool invocations within a single turn',
    envVar: 'AIR_MAX_PARALLEL_TOOLS',
  },
];

function getNestedValue(obj: unknown, path: string): unknown {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const parts = path.split('.');
  let curr: unknown = obj;
  for (const part of parts) {
    if (typeof curr !== 'object' || curr === null) return undefined;
    curr = (curr as Record<string, unknown>)[part];
  }
  return curr;
}

let activeConfig: AirConfig | undefined;
let activeProvenance: ProvenanceMap | undefined;

export function setActiveConfigContext(config: AirConfig, provenance: ProvenanceMap): void {
  activeConfig = config;
  activeProvenance = provenance;
}

export function resetActiveConfigContext(): void {
  activeConfig = undefined;
  activeProvenance = undefined;
}

/**
 * Explains configuration settings, showing their active values, default values,
 * documentation descriptions, and provenance (source layer: default, file, env, cli).
 */
export function explainConfig(
  key?: string,
  config?: AirConfig,
  provenance?: ProvenanceMap,
): ConfigExplanation[] | ConfigExplanation | undefined {
  const cfg = config ?? activeConfig ?? AirConfigSchema.parse({});
  const prov = provenance ?? activeProvenance ?? {};
  const defaults = AirConfigSchema.parse({});

  const explanations: ConfigExplanation[] = KNOWN_CONFIG_KEYS.map((meta) => {
    const value = getNestedValue(cfg, meta.key);
    const defaultValue = getNestedValue(defaults, meta.key);
    const itemProv = prov[meta.key];
    const source: ConfigSource = itemProv?.source ?? 'default';
    const detail: string | undefined = itemProv?.detail;

    const exp: ConfigExplanation = {
      key: meta.key,
      value,
      defaultValue,
      source,
      description: meta.description,
    };
    if (detail !== undefined) {
      exp.detail = detail;
    }
    if (meta.envVar !== undefined) {
      exp.envVar = meta.envVar;
    }
    if (meta.cliFlag !== undefined) {
      exp.cliFlag = meta.cliFlag;
    }
    return exp;
  });

  if (!key) {
    return explanations;
  }

  const exact = explanations.find((e) => e.key === key);
  if (exact) {
    return exact;
  }

  const prefixMatches = explanations.filter((e) => e.key.startsWith(`${key}.`));
  if (prefixMatches.length > 0) {
    return prefixMatches;
  }

  return undefined;
}
