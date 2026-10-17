/**
 * Built-in Interaction Tools: user.ask, plan.update, run.finish (P4-T07).
 *
 * Provides:
 * - user.ask: Human-in-the-loop interaction for asking questions or requesting clarifications.
 * - plan.update: Managing dynamic checklist and task step progress during agent runs.
 * - run.finish: Declaring run completion with status, user-facing summary, and deliverables.
 */

import { z } from 'zod';
import { AirError } from '../../errors/index.js';
import type { Clock } from '../../util/index.js';
import { SystemClock } from '../../util/index.js';
import type { AnyTool, ToolCapability, ToolDefinition, ToolExecutionContext } from '../contract.js';
import { defineTool, toAnyTool } from '../contract.js';
import type { ToolRegistry } from '../registry.js';

// ============================================================================
// user.ask Schemas & Definition
// ============================================================================

export const UserAskInputSchema = z.object({
  question: z.string().min(1, 'Question cannot be empty').describe('The question or prompt to present to the user'),
  options: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe('Optional list of choices for multiple-choice selection'),
  timeoutMs: z.number().int().positive().max(600_000).optional().describe('Timeout in ms to wait for user answer'),
  allowFreeform: z.boolean().default(true).describe('Whether freeform text is allowed when options are provided'),
});

export type UserAskInput = z.infer<typeof UserAskInputSchema>;

export const UserAskOutputSchema = z.object({
  answer: z.string().describe('The user response text'),
  selectedOption: z.string().optional().describe('Matching option if selected from provided options'),
  timedOut: z.boolean().describe('Whether the question timed out without response'),
  answeredAt: z.string().describe('ISO timestamp of response'),
});

export type UserAskOutput = z.infer<typeof UserAskOutputSchema>;

export type UserAskHandler = (
  input: UserAskInput,
  context: ToolExecutionContext,
) => Promise<{ answer: string; selectedOption?: string | undefined }>;

// ============================================================================
// plan.update Schemas & Definition
// ============================================================================

export const PlanStepStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed', 'skipped']);
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>;

export const PlanStepSchema = z.object({
  id: z.string().min(1, 'Step ID cannot be empty'),
  description: z.string().min(1, 'Step description cannot be empty'),
  status: PlanStepStatusSchema,
});

export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanUpdateInputSchema = z.object({
  plan: z.string().min(1, 'Plan description cannot be empty').describe('High-level overview of the plan'),
  steps: z.array(PlanStepSchema).min(1, 'Plan must contain at least one step').describe('Step checklist'),
  notes: z.string().optional().describe('Optional contextual notes or current blockers'),
});

export type PlanUpdateInput = z.infer<typeof PlanUpdateInputSchema>;

export const PlanUpdateOutputSchema = z.object({
  updated: z.literal(true),
  totalSteps: z.number().int().nonnegative(),
  completedSteps: z.number().int().nonnegative(),
  inProgressSteps: z.number().int().nonnegative(),
  pendingSteps: z.number().int().nonnegative(),
  failedSteps: z.number().int().nonnegative(),
  skippedSteps: z.number().int().nonnegative(),
});

export type PlanUpdateOutput = z.infer<typeof PlanUpdateOutputSchema>;

export type PlanUpdateHandler = (
  input: PlanUpdateInput,
  context: ToolExecutionContext,
) => Promise<void> | void;

// ============================================================================
// run.finish Schemas & Definition
// ============================================================================

export const RunStatusSchema = z.enum(['success', 'failed', 'aborted']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunArtifactSchema = z.object({
  name: z.string().min(1),
  path: z.string().optional(),
  description: z.string().optional(),
});

export type RunArtifact = z.infer<typeof RunArtifactSchema>;

export const RunFinishInputSchema = z.object({
  status: RunStatusSchema.default('success').describe('Final outcome status of the run'),
  summary: z.string().min(1, 'Summary report is required').describe('User-facing summary report of achievements'),
  artifacts: z.array(RunArtifactSchema).optional().describe('Key deliverables or files produced during run'),
  metrics: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
});

export type RunFinishInput = z.infer<typeof RunFinishInputSchema>;

export const RunFinishOutputSchema = z.object({
  finished: z.literal(true),
  status: RunStatusSchema,
  summary: z.string(),
  artifactCount: z.number().int().nonnegative(),
  timestamp: z.string(),
});

export type RunFinishOutput = z.infer<typeof RunFinishOutputSchema>;

export type RunFinishHandler = (
  input: RunFinishInput,
  context: ToolExecutionContext,
) => Promise<void> | void;

// ============================================================================
// Options and Factory
// ============================================================================

export interface InteractionToolOptions {
  readonly onAsk?: UserAskHandler | undefined;
  readonly onPlanUpdate?: PlanUpdateHandler | undefined;
  readonly onFinish?: RunFinishHandler | undefined;
  readonly clock?: Clock | undefined;
}

export function createUserAskTool(
  options?: InteractionToolOptions,
): ToolDefinition<UserAskInput, UserAskOutput> {
  const clock = options?.clock ?? new SystemClock();
  const handler = options?.onAsk;

  return defineTool({
    name: 'user.ask',
    description:
      'Asks the human user a question or prompts for guidance or confirmation, optionally with structured choices.',
    risk: 'low',
    idempotent: false,
    defaultTimeoutMs: 120_000, // 2 minutes default for human interaction
    inputSchema: UserAskInputSchema,
    outputSchema: UserAskOutputSchema,

    capabilities: (args): readonly ToolCapability[] => [
      {
        type: 'interaction',
        action: 'ask',
        resource: args.question.slice(0, 100),
      },
    ],

    execute: async (input, context) => {
      if (context.signal?.aborted) {
        throw new AirError('CANCELLED', 'User prompt was cancelled');
      }

      if (!handler) {
        // Fallback default response when running non-interactively without custom broker
        return {
          answer: 'Proceed with default plan.',
          selectedOption: input.options?.[0],
          timedOut: false,
          answeredAt: clock.iso(),
        };
      }

      const res = await handler(input, context);
      return {
        answer: res.answer,
        selectedOption: res.selectedOption,
        timedOut: false,
        answeredAt: clock.iso(),
      };
    },
  });
}

export function createPlanUpdateTool(
  options?: InteractionToolOptions,
): ToolDefinition<PlanUpdateInput, PlanUpdateOutput> {
  const handler = options?.onPlanUpdate;

  return defineTool({
    name: 'plan.update',
    description:
      'Updates the current task checklist, tracking completed, in-progress, pending, failed, or skipped steps.',
    risk: 'low',
    idempotent: true,
    inputSchema: PlanUpdateInputSchema,
    outputSchema: PlanUpdateOutputSchema,

    capabilities: (): readonly ToolCapability[] => [
      {
        type: 'agent',
        action: 'plan',
      },
    ],

    execute: async (input, context) => {
      let completed = 0;
      let inProgress = 0;
      let pending = 0;
      let failed = 0;
      let skipped = 0;

      for (const step of input.steps) {
        if (step.status === 'completed') completed += 1;
        else if (step.status === 'in_progress') inProgress += 1;
        else if (step.status === 'pending') pending += 1;
        else if (step.status === 'failed') failed += 1;
        else if (step.status === 'skipped') skipped += 1;
      }

      if (handler) {
        await handler(input, context);
      }

      return {
        updated: true,
        totalSteps: input.steps.length,
        completedSteps: completed,
        inProgressSteps: inProgress,
        pendingSteps: pending,
        failedSteps: failed,
        skippedSteps: skipped,
      };
    },
  });
}

export function createRunFinishTool(
  options?: InteractionToolOptions,
): ToolDefinition<RunFinishInput, RunFinishOutput> {
  const clock = options?.clock ?? new SystemClock();
  const handler = options?.onFinish;

  return defineTool({
    name: 'run.finish',
    description:
      'Signals that the agent has completed its overall run, reporting final status, user summary, and deliverables.',
    risk: 'low',
    idempotent: true,
    inputSchema: RunFinishInputSchema,
    outputSchema: RunFinishOutputSchema,

    capabilities: (): readonly ToolCapability[] => [
      {
        type: 'agent',
        action: 'finish',
      },
    ],

    execute: async (input, context) => {
      if (handler) {
        await handler(input, context);
      }

      return {
        finished: true,
        status: input.status,
        summary: input.summary,
        artifactCount: input.artifacts ? input.artifacts.length : 0,
        timestamp: clock.iso(),
      };
    },
  });
}

export const userAskTool = createUserAskTool();
export const planUpdateTool = createPlanUpdateTool();
export const runFinishTool = createRunFinishTool();

export const BUILTIN_INTERACTION_TOOLS: readonly AnyTool[] = [
  toAnyTool(userAskTool),
  toAnyTool(planUpdateTool),
  toAnyTool(runFinishTool),
];

/**
 * Registers all built-in interaction tools with the provided ToolRegistry.
 */
export function registerBuiltinInteractionTools(
  registry: ToolRegistry,
  options?: InteractionToolOptions,
): void {
  const ask = options ? createUserAskTool(options) : userAskTool;
  const plan = options ? createPlanUpdateTool(options) : planUpdateTool;
  const finish = options ? createRunFinishTool(options) : runFinishTool;

  registry.register(ask);
  registry.register(plan);
  registry.register(finish);
}
