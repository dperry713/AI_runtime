/**
 * Minimal Dev Harness (Phase 6 - P6-T09).
 *
 * Provides a lightweight CLI and execution runner for manual slice testing:
 * `npm run dev:run -- <agent> "<goal>"`
 *
 * Adheres to:
 * - Rule R1: No console.log in src/ (structured logging via getLogger)
 * - Rule R3: Every tool call through policy engine
 * - Rule R6: Inject Clock and IdGenerator
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 */

import { pathToFileURL } from 'node:url';
import { EventBus } from '../journal/index.js';
import { getLogger, type ComponentLogger } from '../observability/index.js';
import { getPolicyProfile, PolicyEngine, type PolicyProfileName } from '../policy/index.js';
import {
  AnthropicProvider,
  MockProvider,
  OpenAIProvider,
  type Provider,
} from '../providers/index.js';
import {
  registerBuiltinExecTools,
  registerBuiltinFsTools,
  registerBuiltinHttpTools,
  registerBuiltinInteractionTools,
  ToolRegistry,
} from '../tools/index.js';
import {
  type Clock,
  type IdGenerator,
  SystemClock,
  UlidIdGenerator,
} from '../util/index.js';
import { loadAgent, type AgentManifest } from './manifest.js';
import { AgentRunner, type RunOutcome } from './runner.js';

// ============================================================================
// 1. Interfaces & Types
// ============================================================================

export interface DevHarnessOptions {
  readonly agent: string | AgentManifest;
  readonly goal: string;
  readonly runId?: string | undefined;
  readonly provider?: Provider | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly clock?: Clock | undefined;
  readonly idGenerator?: IdGenerator | undefined;
  readonly maxTurns?: number | undefined;
  readonly logger?: ComponentLogger | undefined;
}

// ============================================================================
// 2. runDevHarness Function
// ============================================================================

/**
 * Runs an agent slice against a goal using the standard runtime assembly.
 */
export async function runDevHarness(options: DevHarnessOptions): Promise<RunOutcome> {
  const clock = options.clock ?? new SystemClock();
  const idGenerator = options.idGenerator ?? new UlidIdGenerator(clock);
  const logger = options.logger ?? getLogger('dev-harness');

  // 1. Resolve manifest
  let manifest: AgentManifest;
  if (typeof options.agent === 'string') {
    manifest = await loadAgent(options.agent, options.workspaceRoot);
  } else {
    manifest = options.agent;
  }

  // 2. Initialize PolicyEngine with agent's declared policy profile
  const policyDoc = getPolicyProfile(manifest.policyProfile as PolicyProfileName);
  const eventBus = new EventBus({ clock, idGenerator });
  const policyEngine = new PolicyEngine(policyDoc, {
    clock,
    idGenerator,
    eventBus,
    logger,
  });

  // 3. Populate ToolRegistry with standard built-in tools
  const toolRegistry = new ToolRegistry();
  registerBuiltinFsTools(toolRegistry);
  registerBuiltinExecTools(toolRegistry);
  registerBuiltinHttpTools(toolRegistry);
  registerBuiltinInteractionTools(toolRegistry);

  // 4. Resolve Provider
  let provider = options.provider;
  if (!provider) {
    provider = resolveDefaultProvider(clock);
  }

  const runId = options.runId ?? idGenerator.nextRunId();

  logger.info(
    {
      event: 'dev_harness.started',
      runId,
      agentId: manifest.id,
      model: manifest.model.model,
      policyProfile: manifest.policyProfile,
      goal: options.goal,
    },
    'Starting agent run via dev harness',
  );

  // 5. Construct and execute AgentRunner
  const runner = new AgentRunner({
    manifest,
    runId,
    provider,
    toolRegistry,
    policyEngine,
    eventBus,
    logger,
    clock,
    idGenerator,
    maxTurns: options.maxTurns,
  });

  const outcome = await runner.run({ initialGoal: options.goal });

  logger.info(
    {
      event: 'dev_harness.completed',
      runId,
      status: outcome.status,
      totalTurns: outcome.totalTurns,
      reason: outcome.reason,
    },
    'Dev harness agent run completed',
  );

  return outcome;
}

/**
 * Resolves a default provider based on environment variables or falls back to a deterministic MockProvider.
 */
function resolveDefaultProvider(clock: Clock): Provider {
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  if (anthropicKey && anthropicKey.trim().length > 0) {
    return new AnthropicProvider({
      apiKey: anthropicKey,
      clock,
    });
  }

  const openaiKey = process.env['OPENAI_API_KEY'];
  if (openaiKey && openaiKey.trim().length > 0) {
    return new OpenAIProvider({
      apiKey: openaiKey,
      baseUrl: process.env['OPENAI_BASE_URL'],
      defaultModel: process.env['OPENAI_MODEL'],
      clock,
    });
  }

  // Fallback to scriptable MockProvider with a standard helpful response
  const mock = new MockProvider({ clock });
  mock.enqueue({
    response: 'Hello! I am the AIR dev-harness mock agent. All runtime subsystems are operational.',
    stopReason: 'stop',
  });
  return mock;
}

// ============================================================================
// 3. CLI Entrypoint
// ============================================================================

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const agentArg = args[0] ?? 'developer';
  const goalArg = args[1] ?? 'Report runtime status';

  try {
    const outcome = await runDevHarness({
      agent: agentArg,
      goal: goalArg,
    });

    if (outcome.text) {
      process.stdout.write(`\nAgent Response:\n${outcome.text}\n\nStatus: ${outcome.status} (Turns: ${outcome.totalTurns})\n`);
    } else {
      process.stdout.write(`\nStatus: ${outcome.status} (Turns: ${outcome.totalTurns})\n`);
    }

    if (outcome.status === 'completed') {
      process.exitCode = 0;
    } else {
      if (outcome.reason) {
        process.stdout.write(`Reason: ${outcome.reason}\n`);
      }
      process.exitCode = 1;
    }
  } catch (err) {
    const errorObj = err instanceof Error ? err : new Error(String(err));
    const logger = getLogger('dev-harness');
    logger.error({ event: 'dev_harness.failed', err: errorObj }, `Dev harness failed: ${errorObj.message}`);
    process.exitCode = 1;
  }
}

// Invoke main if executed directly via CLI
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
