import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AirConfigSchema,
  CURRENT_CONFIG_VERSION,
  explainConfig,
  loadConfig,
  loadConfigWithProvenance,
  migrateConfig,
  resetActiveConfigContext,
  resolveAirHome,
} from '../../../src/config/index.js';
import { AirError } from '../../../src/errors/index.js';

describe('config module', () => {
  let tempDir: string;

  beforeEach(() => {
    resetActiveConfigContext();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-config-test-'));
  });

  afterEach(() => {
    resetActiveConfigContext();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('schema validation', () => {
    it('populates default configuration when given empty object', () => {
      const cfg = AirConfigSchema.parse({});
      expect(cfg.version).toBe(1);
      expect(cfg.logging.level).toBe('info');
      expect(cfg.logging.llmPayloads).toBe('redacted');
      expect(cfg.defaults.provider).toBe('anthropic');
      expect(cfg.budgets.maxUsdPerRun).toBe(2.0);
      expect(cfg.journal.fsync).toBe('batch');
      expect(cfg.sandbox.defaultTimeoutSeconds).toBe(120);
      expect(cfg.ipc.pipeName).toBe('air');
      expect(cfg.concurrency.maxActiveRuns).toBe(4);
    });

    it('validates a complete configuration file matching example format', () => {
      const example = {
        version: 1,
        logging: {
          level: 'debug',
          levels: { 'providers.anthropic': 'info' },
          llmPayloads: 'full',
          maxTotalMb: 2048,
          rotate: { maxSizeMb: 100, keep: 20 },
        },
        providers: [
          {
            id: 'anthropic',
            type: 'anthropic',
            model: 'claude-3-5-sonnet',
            apiKeySecret: 'anthropic-api-key',
          },
          {
            id: 'local',
            type: 'openai-compat',
            baseUrl: 'http://127.0.0.1:1234/v1',
            model: 'qwen2.5-coder',
          },
        ],
        defaults: {
          provider: 'anthropic',
          fallbackProviders: ['local'],
          agent: 'coder',
          policyProfile: 'project-read',
        },
        budgets: {
          maxUsdPerRun: 5.0,
          maxTokensPerRun: 1000000,
          maxStepsPerRun: 50,
          maxWallClockMinutes: 30,
        },
        journal: {
          fsync: 'always',
          segmentMaxMb: 128,
        },
        sandbox: {
          defaultTimeoutSeconds: 60,
          maxOutputBytes: 524288,
          maxProcessesPerCommand: 16,
          maxMemoryMbPerCommand: 1024,
          networkDefault: 'allow',
        },
        ipc: {
          pipeName: 'air-custom',
        },
        concurrency: {
          maxActiveRuns: 8,
          maxParallelToolCalls: 2,
        },
      };

      const parsed = AirConfigSchema.parse(example);
      expect(parsed.version).toBe(1);
      expect(parsed.providers).toHaveLength(2);
      expect(parsed.providers[0]?.id).toBe('anthropic');
      expect(parsed.defaults.fallbackProviders).toEqual(['local']);
      expect(parsed.ipc.pipeName).toBe('air-custom');
    });

    it('rejects invalid enum values and types', () => {
      expect(() =>
        AirConfigSchema.parse({
          logging: { level: 'super-verbose' },
        }),
      ).toThrow();

      expect(() =>
        AirConfigSchema.parse({
          budgets: { maxUsdPerRun: -10 },
        }),
      ).toThrow();
    });
  });

  describe('home resolution (Rule R10)', () => {
    it('uses AIR_HOME when explicitly set', () => {
      const customHome = path.join(tempDir, 'custom_air');
      const resolved = resolveAirHome({ AIR_HOME: customHome });
      expect(resolved.toLowerCase()).toBe(path.resolve(customHome).toLowerCase());
    });

    it('uses %LOCALAPPDATA%\\AIR on Windows', () => {
      const mockLocalAppData = path.join(tempDir, 'AppData', 'Local');
      const resolved = resolveAirHome({ LOCALAPPDATA: mockLocalAppData });
      const expected = path.join(mockLocalAppData, 'AIR');
      expect(resolved.toLowerCase()).toBe(path.resolve(expected).toLowerCase());
    });

    it('falls back to USERPROFILE/.air if LOCALAPPDATA is absent', () => {
      const mockUser = path.join(tempDir, 'Users', 'testuser');
      const resolved = resolveAirHome({ USERPROFILE: mockUser });
      const expected = path.join(mockUser, '.air');
      expect(resolved.toLowerCase()).toBe(path.resolve(expected).toLowerCase());
    });
  });

  describe('migration', () => {
    it('migrates unversioned v0 config to current version 1', () => {
      const v0 = {
        logging: { level: 'warn' },
      };
      const migrated = migrateConfig(v0);
      expect(migrated['version']).toBe(CURRENT_CONFIG_VERSION);
      expect(migrated['logging']).toEqual({ level: 'warn' });
    });

    it('leaves valid v1 config intact', () => {
      const v1 = {
        version: 1,
        ipc: { pipeName: 'test-pipe' },
      };
      const migrated = migrateConfig(v1);
      expect(migrated).toEqual(v1);
    });

    it('throws AirError(CONFIG_INVALID) for unsupported future version', () => {
      expect(() => migrateConfig({ version: 999 })).toThrowError(AirError);
      try {
        migrateConfig({ version: 999 });
      } catch (e) {
        expect(e).toBeInstanceOf(AirError);
        expect((e as AirError).code).toBe('CONFIG_INVALID');
      }
    });

    it('throws AirError(CONFIG_INVALID) for invalid inputs', () => {
      expect(() => migrateConfig('string-config')).toThrowError(AirError);
      expect(() => migrateConfig(null)).toThrowError(AirError);
      expect(() => migrateConfig({ version: 'one' })).toThrowError(AirError);
    });
  });

  describe('layered loader & provenance', () => {
    it('loads defaults when no file or overrides exist', async () => {
      const { config, provenance } = await loadConfigWithProvenance({
        env: {},
        argv: [],
        home: tempDir,
      });

      expect(config.logging.level).toBe('info');
      expect(config.budgets.maxUsdPerRun).toBe(2.0);
      expect(provenance).toBeDefined();
    });

    it('loads and merges JSON configuration file', async () => {
      const configFile = path.join(tempDir, 'air.config.json');
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          version: 1,
          logging: { level: 'debug' },
          ipc: { pipeName: 'json-pipe' },
        }),
      );

      const { config, provenance } = await loadConfigWithProvenance({
        configFile,
        env: {},
        argv: [],
        home: tempDir,
      });

      expect(config.logging.level).toBe('debug');
      expect(config.ipc.pipeName).toBe('json-pipe');
      expect(provenance['logging.level']?.source).toBe('file');
      expect(provenance['ipc.pipeName']?.source).toBe('file');
    });

    it('loads and merges YAML configuration file', async () => {
      const configFile = path.join(tempDir, 'air.config.yaml');
      fs.writeFileSync(
        configFile,
        `version: 1
logging:
  level: warn
defaults:
  provider: ollama
`,
      );

      const { config, provenance } = await loadConfigWithProvenance({
        configFile,
        env: {},
        argv: [],
        home: tempDir,
      });

      expect(config.logging.level).toBe('warn');
      expect(config.defaults.provider).toBe('ollama');
      expect(provenance['logging.level']?.source).toBe('file');
      expect(provenance['defaults.provider']?.source).toBe('file');
    });

    it('throws AirError(CONFIG_NOT_FOUND) when explicit config file is missing', async () => {
      const missingFile = path.join(tempDir, 'nonexistent.json');
      await expect(
        loadConfig({
          configFile: missingFile,
          env: {},
          argv: [],
          home: tempDir,
        }),
      ).rejects.toThrowError(AirError);

      try {
        await loadConfig({
          configFile: missingFile,
          env: {},
          argv: [],
          home: tempDir,
        });
      } catch (err) {
        expect((err as AirError).code).toBe('CONFIG_NOT_FOUND');
      }
    });

    it('enforces precedence: defaults < file < env < CLI', async () => {
      const configFile = path.join(tempDir, 'air.config.json');
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          version: 1,
          logging: { level: 'debug', llmPayloads: 'off' },
          budgets: { maxUsdPerRun: 10.0 },
          ipc: { pipeName: 'file-pipe' },
        }),
      );

      // Environment overrides file
      const env = {
        AIR_LOG_LEVEL: 'warn',
        AIR_BUDGET_USD: '15.5',
      };

      // CLI overrides environment and file
      const argv = ['--log-level', 'fatal', '--set', 'budgets.maxStepsPerRun=200'];

      const { config, provenance } = await loadConfigWithProvenance({
        configFile,
        env,
        argv,
        home: tempDir,
      });

      // CLI wins over env and file
      expect(config.logging.level).toBe('fatal');
      expect(provenance['logging.level']?.source).toBe('cli');

      // Env wins over file
      expect(config.budgets.maxUsdPerRun).toBe(15.5);
      expect(provenance['budgets.maxUsdPerRun']?.source).toBe('env');

      // File wins over defaults
      expect(config.logging.llmPayloads).toBe('off');
      expect(provenance['logging.llmPayloads']?.source).toBe('file');

      // CLI --set
      expect(config.budgets.maxStepsPerRun).toBe(200);
      expect(provenance['budgets.maxStepsPerRun']?.source).toBe('cli');

      // Untouched falls back to default
      expect(config.journal.fsync).toBe('batch');
      expect(provenance['journal.fsync']?.source).toBeUndefined(); // or default
    });

    it('throws AirError(CONFIG_INVALID) on invalid merged values', async () => {
      await expect(
        loadConfig({
          argv: ['--log-level', 'invalid-level'],
          env: {},
          home: tempDir,
        }),
      ).rejects.toThrowError(AirError);

      try {
        await loadConfig({
          argv: ['--log-level', 'invalid-level'],
          env: {},
          home: tempDir,
        });
      } catch (err) {
        expect((err as AirError).code).toBe('CONFIG_INVALID');
      }
    });
  });

  describe('explainConfig', () => {
    it('returns all known keys with descriptions and active values', async () => {
      const config = await loadConfig({
        argv: ['--log-level', 'debug'],
        env: {},
        home: tempDir,
      });
      expect(config.logging.level).toBe('debug');

      const all = explainConfig();
      expect(Array.isArray(all)).toBe(true);
      if (Array.isArray(all)) {
        expect(all.length).toBeGreaterThan(10);
        const logLevelExp = all.find((item) => item.key === 'logging.level');
        expect(logLevelExp).toBeDefined();
        expect(logLevelExp?.value).toBe('debug');
        expect(logLevelExp?.source).toBe('cli');
        expect(logLevelExp?.defaultValue).toBe('info');
        expect(logLevelExp?.envVar).toBe('AIR_LOG_LEVEL');
        expect(logLevelExp?.cliFlag).toBe('--log-level');
      }
    });

    it('explains a specific key', async () => {
      await loadConfig({
        env: { AIR_JOURNAL_FSYNC: 'always' },
        argv: [],
        home: tempDir,
      });

      const explanation = explainConfig('journal.fsync');
      expect(explanation).toBeDefined();
      if (explanation && !Array.isArray(explanation)) {
        expect(explanation.key).toBe('journal.fsync');
        expect(explanation.value).toBe('always');
        expect(explanation.defaultValue).toBe('batch');
        expect(explanation.source).toBe('env');
        expect(explanation.envVar).toBe('AIR_JOURNAL_FSYNC');
      }
    });

    it('explains a prefix section', async () => {
      await loadConfig({
        env: {},
        argv: [],
        home: tempDir,
      });

      const loggingSection = explainConfig('logging');
      expect(Array.isArray(loggingSection)).toBe(true);
      if (Array.isArray(loggingSection)) {
        expect(loggingSection.length).toBeGreaterThanOrEqual(3);
        expect(loggingSection.every((item) => item.key.startsWith('logging.'))).toBe(true);
      }
    });

    it('returns undefined for unknown key', () => {
      const exp = explainConfig('completely.unknown.setting');
      expect(exp).toBeUndefined();
    });
  });
});
