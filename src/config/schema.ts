import { z } from 'zod';

export const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const LlmPayloadsSchema = z.enum(['full', 'redacted', 'off']);
export type LlmPayloads = z.infer<typeof LlmPayloadsSchema>;

export const RotateConfigSchema = z.object({
  maxSizeMb: z.number().positive().default(50),
  keep: z.number().int().nonnegative().default(10),
});
export type RotateConfig = z.infer<typeof RotateConfigSchema>;

export const LoggingConfigSchema = z.object({
  level: LogLevelSchema.default('info'),
  levels: z.record(z.string(), LogLevelSchema).optional(),
  llmPayloads: LlmPayloadsSchema.default('redacted'),
  maxTotalMb: z.number().positive().default(1024),
  rotate: RotateConfigSchema.default(() => RotateConfigSchema.parse({})),
});
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

export const ProviderTypeSchema = z.enum(['anthropic', 'openai-compat', 'ollama', 'mock']);
export type ProviderType = z.infer<typeof ProviderTypeSchema>;

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  type: ProviderTypeSchema,
  model: z.string().min(1),
  baseUrl: z.string().url().or(z.string().regex(/^https?:\/\//)).optional(),
  apiKeySecret: z.string().optional(),
  timeoutSeconds: z.number().positive().default(60),
  maxRetries: z.number().int().nonnegative().default(3),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const DefaultsConfigSchema = z.object({
  provider: z.string().default('anthropic'),
  fallbackProviders: z.array(z.string()).default([]),
  agent: z.string().default('default'),
  policyProfile: z.string().default('project-write'),
});
export type DefaultsConfig = z.infer<typeof DefaultsConfigSchema>;

export const BudgetsConfigSchema = z.object({
  maxUsdPerRun: z.number().nonnegative().default(2.0),
  maxTokensPerRun: z.number().int().nonnegative().default(500000),
  maxStepsPerRun: z.number().int().nonnegative().default(100),
  maxWallClockMinutes: z.number().positive().default(60),
});
export type BudgetsConfig = z.infer<typeof BudgetsConfigSchema>;

export const FsyncPolicySchema = z.enum(['always', 'batch', 'never']);
export type FsyncPolicy = z.infer<typeof FsyncPolicySchema>;

export const JournalConfigSchema = z.object({
  fsync: FsyncPolicySchema.default('batch'),
  segmentMaxMb: z.number().positive().default(64),
});
export type JournalConfig = z.infer<typeof JournalConfigSchema>;

export const NetworkDefaultSchema = z.enum(['none', 'allow']);
export type NetworkDefault = z.infer<typeof NetworkDefaultSchema>;

export const SandboxConfigSchema = z.object({
  defaultTimeoutSeconds: z.number().positive().default(120),
  maxOutputBytes: z.number().int().positive().default(1048576),
  maxProcessesPerCommand: z.number().int().positive().default(32),
  maxMemoryMbPerCommand: z.number().int().positive().default(2048),
  networkDefault: NetworkDefaultSchema.default('none'),
});
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

export const IpcConfigSchema = z.object({
  pipeName: z.string().min(1).default('air'),
});
export type IpcConfig = z.infer<typeof IpcConfigSchema>;

export const ConcurrencyConfigSchema = z.object({
  maxActiveRuns: z.number().int().positive().default(4),
  maxParallelToolCalls: z.number().int().positive().default(4),
});
export type ConcurrencyConfig = z.infer<typeof ConcurrencyConfigSchema>;

export const AirConfigSchema = z.object({
  version: z.literal(1).default(1),
  logging: LoggingConfigSchema.default(() => LoggingConfigSchema.parse({})),
  providers: z.array(ProviderConfigSchema).default([]),
  defaults: DefaultsConfigSchema.default(() => DefaultsConfigSchema.parse({})),
  budgets: BudgetsConfigSchema.default(() => BudgetsConfigSchema.parse({})),
  journal: JournalConfigSchema.default(() => JournalConfigSchema.parse({})),
  sandbox: SandboxConfigSchema.default(() => SandboxConfigSchema.parse({})),
  ipc: IpcConfigSchema.default(() => IpcConfigSchema.parse({})),
  concurrency: ConcurrencyConfigSchema.default(() => ConcurrencyConfigSchema.parse({})),
});

export type AirConfig = z.infer<typeof AirConfigSchema>;
