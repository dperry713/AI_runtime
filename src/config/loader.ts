import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AirError } from '../errors/index.js';
import { canonicalize } from '../util/index.js';
import { resolveAirHome } from './home.js';
import { migrateConfig } from './migrate.js';
import { type AirConfig, AirConfigSchema } from './schema.js';
import {
  type ProvenanceMap,
  setActiveConfigContext,
} from './explain.js';

export interface LoadConfigOptions {
  argv?: string[] | undefined;
  env?: Record<string, string | undefined> | undefined;
  home?: string | undefined;
  configFile?: string | undefined;
}

export interface LoadConfigResult {
  config: AirConfig;
  provenance: ProvenanceMap;
}

function isPlainObject(item: unknown): item is Record<string, unknown> {
  return typeof item === 'object' && item !== null && !Array.isArray(item);
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  prefix: string,
  sourceType: 'file' | 'env' | 'cli',
  detail: string,
  provenance: ProvenanceMap,
): void {
  for (const [key, sourceVal] of Object.entries(source)) {
    if (sourceVal === undefined) continue;
    const currentPath = prefix ? `${prefix}.${key}` : key;

    const targetVal = target[key];
    if (isPlainObject(sourceVal) && isPlainObject(targetVal)) {
      deepMerge(
        targetVal,
        sourceVal,
        currentPath,
        sourceType,
        detail,
        provenance,
      );
    } else {
      target[key] = sourceVal;
      provenance[currentPath] = { source: sourceType, detail };
    }
  }
}

function setNestedProperty(
  obj: Record<string, unknown>,
  propPath: string,
  value: unknown,
  sourceType: 'env' | 'cli',
  detail: string,
  provenance: ProvenanceMap,
): void {
  const parts = propPath.split('.');
  let curr = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!part) continue;
    const existing = curr[part];
    if (!isPlainObject(existing)) {
      curr[part] = {};
    }
    const nextObj = curr[part];
    if (isPlainObject(nextObj)) {
      curr = nextObj;
    }
  }
  const lastPart = parts[parts.length - 1];
  if (lastPart) {
    curr[lastPart] = value;
    provenance[propPath] = { source: sourceType, detail };
  }
}

function parseCliArgs(argv: string[]): {
  flags: Record<string, string>;
  explicitConfig?: string | undefined;
  setPairs: Array<{ key: string; value: string }>;
} {
  const flags: Record<string, string> = {};
  const setPairs: Array<{ key: string; value: string }> = [];
  let explicitConfig: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === '--config' && i + 1 < argv.length) {
      explicitConfig = argv[++i];
    } else if (arg.startsWith('--config=')) {
      explicitConfig = arg.slice('--config='.length);
    } else if (arg === '--set' && i + 1 < argv.length) {
      const pair = argv[++i];
      if (pair) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
          setPairs.push({ key: pair.slice(0, eqIdx), value: pair.slice(eqIdx + 1) });
        }
      }
    } else if (arg.startsWith('--set=')) {
      const pair = arg.slice('--set='.length);
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        setPairs.push({ key: pair.slice(0, eqIdx), value: pair.slice(eqIdx + 1) });
      }
    } else if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const eqIdx = name.indexOf('=');
      if (eqIdx > 0) {
        flags[name.slice(0, eqIdx)] = name.slice(eqIdx + 1);
      } else if (i + 1 < argv.length) {
        const nextArg = argv[i + 1];
        if (nextArg !== undefined && !nextArg.startsWith('--')) {
          flags[name] = nextArg;
          i++;
        }
      }
    }
  }

  return { flags, explicitConfig, setPairs };
}

function parseNumber(val: string): number | string {
  const num = Number(val);
  return Number.isNaN(num) ? val : num;
}

/**
 * Loads and merges configuration across all layers:
 * defaults < file < env < CLI
 *
 * Enforces validation via AirConfigSchema and tracks provenance for each setting.
 */
export async function loadConfigWithProvenance(
  options: LoadConfigOptions = {},
): Promise<LoadConfigResult> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  const home = options.home ?? resolveAirHome(env);

  const defaultValues = AirConfigSchema.parse({});
  const merged: Record<string, unknown> = JSON.parse(JSON.stringify(defaultValues)) as Record<string, unknown>;
  const provenance: ProvenanceMap = {};

  const cli = parseCliArgs(argv);

  // 1. Resolve configuration file path
  let configPath: string | undefined = options.configFile ?? cli.explicitConfig ?? env['AIR_CONFIG'];
  let isExplicit = false;

  if (configPath && configPath.trim().length > 0) {
    isExplicit = true;
    configPath = canonicalize(configPath.trim());
  } else {
    // Check discovered locations: ./air.config.json or $AIR_HOME/air.config.json
    const localJson = path.resolve(process.cwd(), 'air.config.json');
    const localYaml = path.resolve(process.cwd(), 'air.config.yaml');
    const homeJson = path.resolve(home, 'air.config.json');

    if (fs.existsSync(localJson)) {
      configPath = localJson;
    } else if (fs.existsSync(localYaml)) {
      configPath = localYaml;
    } else if (fs.existsSync(homeJson)) {
      configPath = homeJson;
    }
  }

  // 2. Read and merge config file if present
  if (configPath) {
    if (!fs.existsSync(configPath)) {
      if (isExplicit) {
        throw new AirError('CONFIG_NOT_FOUND', `Configuration file not found at: ${configPath}`, {
          context: { path: configPath },
        });
      }
    } else {
      let rawContent: string;
      try {
        rawContent = await fs.promises.readFile(configPath, 'utf-8');
      } catch (err) {
        throw new AirError('CONFIG_INVALID', `Failed to read configuration file: ${configPath}`, {
          cause: err instanceof Error ? err : new Error(String(err)),
          context: { path: configPath },
        });
      }

      let parsed: unknown;
      try {
        if (configPath.endsWith('.yaml') || configPath.endsWith('.yml')) {
          parsed = parseYaml(rawContent);
        } else {
          parsed = JSON.parse(rawContent);
        }
      } catch (err) {
        throw new AirError('CONFIG_INVALID', `Failed to parse configuration file syntax: ${configPath}`, {
          cause: err instanceof Error ? err : new Error(String(err)),
          context: { path: configPath },
        });
      }

      const migrated = migrateConfig(parsed);
      deepMerge(merged, migrated, '', 'file', canonicalize(configPath), provenance);
    }
  }

  // 3. Environment variable overrides
  const envMappings: Array<{ envKey: string; configPath: string; isNum?: boolean }> = [
    { envKey: 'AIR_LOG_LEVEL', configPath: 'logging.level' },
    { envKey: 'AIR_LOG_PAYLOADS', configPath: 'logging.llmPayloads' },
    { envKey: 'AIR_LOG_MAX_TOTAL_MB', configPath: 'logging.maxTotalMb', isNum: true },
    { envKey: 'AIR_DEFAULTS_PROVIDER', configPath: 'defaults.provider' },
    { envKey: 'AIR_POLICY_PROFILE', configPath: 'defaults.policyProfile' },
    { envKey: 'AIR_BUDGET_USD', configPath: 'budgets.maxUsdPerRun', isNum: true },
    { envKey: 'AIR_BUDGET_TOKENS', configPath: 'budgets.maxTokensPerRun', isNum: true },
    { envKey: 'AIR_BUDGET_STEPS', configPath: 'budgets.maxStepsPerRun', isNum: true },
    { envKey: 'AIR_BUDGET_MINUTES', configPath: 'budgets.maxWallClockMinutes', isNum: true },
    { envKey: 'AIR_JOURNAL_FSYNC', configPath: 'journal.fsync' },
    { envKey: 'AIR_SANDBOX_TIMEOUT', configPath: 'sandbox.defaultTimeoutSeconds', isNum: true },
    { envKey: 'AIR_SANDBOX_NETWORK', configPath: 'sandbox.networkDefault' },
    { envKey: 'AIR_IPC_PIPE_NAME', configPath: 'ipc.pipeName' },
    { envKey: 'AIR_MAX_ACTIVE_RUNS', configPath: 'concurrency.maxActiveRuns', isNum: true },
    { envKey: 'AIR_MAX_PARALLEL_TOOLS', configPath: 'concurrency.maxParallelToolCalls', isNum: true },
  ];

  for (const m of envMappings) {
    const val = env[m.envKey];
    if (val !== undefined && val.trim().length > 0) {
      const parsedVal = m.isNum ? parseNumber(val.trim()) : val.trim();
      setNestedProperty(merged, m.configPath, parsedVal, 'env', m.envKey, provenance);
    }
  }

  // 4. CLI flag overrides
  const cliMappings: Array<{ flagKey: string; configPath: string; isNum?: boolean }> = [
    { flagKey: 'log-level', configPath: 'logging.level' },
    { flagKey: 'llm-payloads', configPath: 'logging.llmPayloads' },
    { flagKey: 'log-max-total-mb', configPath: 'logging.maxTotalMb', isNum: true },
    { flagKey: 'provider', configPath: 'defaults.provider' },
    { flagKey: 'policy-profile', configPath: 'defaults.policyProfile' },
    { flagKey: 'budget-usd', configPath: 'budgets.maxUsdPerRun', isNum: true },
    { flagKey: 'budget-tokens', configPath: 'budgets.maxTokensPerRun', isNum: true },
    { flagKey: 'budget-steps', configPath: 'budgets.maxStepsPerRun', isNum: true },
    { flagKey: 'budget-minutes', configPath: 'budgets.maxWallClockMinutes', isNum: true },
    { flagKey: 'fsync', configPath: 'journal.fsync' },
    { flagKey: 'sandbox-timeout', configPath: 'sandbox.defaultTimeoutSeconds', isNum: true },
    { flagKey: 'pipe-name', configPath: 'ipc.pipeName' },
  ];

  for (const m of cliMappings) {
    const val = cli.flags[m.flagKey];
    if (val !== undefined) {
      const parsedVal = m.isNum ? parseNumber(val) : val;
      setNestedProperty(merged, m.configPath, parsedVal, 'cli', `--${m.flagKey}`, provenance);
    }
  }

  // Handle generic --set key=value flags
  for (const pair of cli.setPairs) {
    const parsedVal = parseNumber(pair.value);
    setNestedProperty(merged, pair.key, parsedVal, 'cli', `--set ${pair.key}`, provenance);
  }

  // 5. Schema validation
  const result = AirConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new AirError('CONFIG_INVALID', `Configuration validation failed: ${issues}`, {
      context: { issues: result.error.issues },
    });
  }

  setActiveConfigContext(result.data, provenance);

  return {
    config: result.data,
    provenance,
  };
}

/**
 * Standard configuration loader per docs/MODULES.md:
 * loadConfig({argv, env, home}): Promise<AirConfig>
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<AirConfig> {
  const result = await loadConfigWithProvenance(options);
  return result.config;
}
