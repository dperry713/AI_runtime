/**
 * Shell commands (Phase 9 - P9-T04/P9-T05).
 *
 * Each command is an async function that takes an `AirClient` and parsed
 * arguments, performs the IPC call(s), and returns a result for output
 * formatting. Commands throw typed errors that the shell maps to exit
 * codes.
 */

import type { AirClient } from '../client/index.js';
import { AirError } from '../errors/index.js';
import { getLogger } from '../observability/index.js';

const logger = getLogger('air-shell');

/** Returns the argument at the given index, throwing if missing. */
function requireArg(args: string[], index: number): string {
  const value = args[index];
  if (value === undefined) {
    throw new AirError('INVALID_ARGUMENT', `Missing argument at position ${index}`, {
      exposeToModel: true,
    });
  }
  return value;
}

// ============================================================================
// Command result types
// ============================================================================

export interface CommandResult {
  readonly kind: 'text' | 'json' | 'table';
  readonly data: unknown;
}

// ============================================================================
// Command context
// ============================================================================

export interface CommandContext {
  readonly client: AirClient;
  readonly json: boolean;
}

// ============================================================================
// Command handler type
// ============================================================================

export type CommandHandler = (ctx: CommandContext, args: string[]) => Promise<CommandResult>;

// ============================================================================
// Command registry
// ============================================================================

export interface CommandDefinition {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly usage: string;
  readonly handler: CommandHandler;
}

export class CommandRegistry {
  private readonly commands = new Map<string, CommandDefinition>();

  register(def: CommandDefinition): void {
    if (this.commands.has(def.name)) {
      throw new AirError('IPC_PROTOCOL_ERROR', `Command "${def.name}" is already registered`, {
        context: { command: def.name },
        exposeToModel: true,
      });
    }
    this.commands.set(def.name, def);
    for (const alias of def.aliases) {
      this.commands.set(alias, { ...def, name: alias });
    }
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  get(name: string): CommandDefinition | undefined {
    return this.commands.get(name);
  }

  list(): readonly CommandDefinition[] {
    const seen = new Set<string>();
    const result: CommandDefinition[] = [];
    for (const def of this.commands.values()) {
      if (!seen.has(def.name)) {
        seen.add(def.name);
        result.push(def);
      }
    }
    return result;
  }
}

// ============================================================================
// Built-in commands
// ============================================================================

async function cmdHealth(ctx: CommandContext): Promise<CommandResult> {
  void ctx;
  const health = await ctx.client.health();
  return { kind: 'text', data: health };
}

async function cmdSessionCreate(ctx: CommandContext, args: string[]): Promise<CommandResult> {
  void ctx;
  if (args.length < 1) {
    throw new AirError('INVALID_ARGUMENT', 'Usage: session.create <agentId>', {
      context: { usage: 'session.create <agentId>' },
      exposeToModel: true,
    });
  }
  const session = await ctx.client.createSession({ agentId: requireArg(args, 0) }); 
  return { kind: 'text', data: session };
}

async function cmdSessionList(ctx: CommandContext): Promise<CommandResult> {
  void ctx;
  const sessions = await ctx.client.listSessions();
  return { kind: 'text', data: sessions };
}

async function cmdRunStart(ctx: CommandContext, args: string[]): Promise<CommandResult> {
  void ctx;
  if (args.length < 3) {
    throw new AirError('INVALID_ARGUMENT', 'Usage: run.start <sessionId> <agentId> <goal>', {
      context: { usage: 'run.start <sessionId> <agentId> <goal>' },
      exposeToModel: true,
    });
  }
  const run = await ctx.client.startRun({
    sessionId: requireArg(args, 0), 
    agentId: requireArg(args, 1), 
    goal: args.slice(2).join(' '),
  });
  return { kind: 'text', data: run };
}

async function cmdRunList(ctx: CommandContext, args: string[]): Promise<CommandResult> {
  void ctx;
  const runs = await ctx.client.listRuns(args.length > 0 ? { sessionId: requireArg(args, 0) } : {}); 
  return { kind: 'text', data: runs };
}

async function cmdRunGet(ctx: CommandContext, args: string[]): Promise<CommandResult> {
  void ctx;
  if (args.length < 1) {
    throw new AirError('INVALID_ARGUMENT', 'Usage: run.get <runId>', {
      context: { usage: 'run.get <runId>' },
      exposeToModel: true,
    });
  }
  const run = await ctx.client.getRun({ runId: requireArg(args, 0) }); 
  return { kind: 'text', data: run };
}

async function cmdRunCancel(ctx: CommandContext, args: string[]): Promise<CommandResult> {
  void ctx;
  if (args.length < 1) {
    throw new AirError('INVALID_ARGUMENT', 'Usage: run.cancel <runId>', {
      context: { usage: 'run.cancel <runId>' },
      exposeToModel: true,
    });
  }
  const result = await ctx.client.cancelRun({ runId: requireArg(args, 0) }); 
  return { kind: 'text', data: result };
}

async function cmdRunPause(ctx: CommandContext, args: string[]): Promise<CommandResult> {
  void ctx;
  if (args.length < 1) {
    throw new AirError('INVALID_ARGUMENT', 'Usage: run.pause <runId>', {
      context: { usage: 'run.pause <runId>' },
      exposeToModel: true,
    });
  }
  const result = await ctx.client.pauseRun({ runId: requireArg(args, 0) }); 
  return { kind: 'text', data: result };
}

async function cmdRunResume(ctx: CommandContext, args: string[]): Promise<CommandResult> {
  void ctx;
  if (args.length < 1) {
    throw new AirError('INVALID_ARGUMENT', 'Usage: run.resume <runId>', {
      context: { usage: 'run.resume <runId>' },
      exposeToModel: true,
    });
  }
  const result = await ctx.client.resumeRun({ runId: requireArg(args, 0) }); 
  return { kind: 'text', data: result };
}

async function cmdRunReplay(ctx: CommandContext, args: string[]): Promise<CommandResult> {
  void ctx;
  if (args.length < 1) {
    throw new AirError('INVALID_ARGUMENT', 'Usage: run.replay <runId>', {
      context: { usage: 'run.replay <runId>' },
      exposeToModel: true,
    });
  }
  const replay = await ctx.client.replayRun({ runId: requireArg(args, 0) }); 
  return { kind: 'text', data: replay };
}

async function cmdApprovalList(ctx: CommandContext): Promise<CommandResult> {
  void ctx;
  const approvals = await ctx.client.listApprovals();
  return { kind: 'text', data: approvals };
}

async function cmdApprovalResolve(ctx: CommandContext, args: string[]): Promise<CommandResult> {
  void ctx;
  if (args.length < 2) {
    throw new AirError('INVALID_ARGUMENT', 'Usage: approval.resolve <approvalId> <approve|deny> [reason]', {
      context: { usage: 'approval.resolve <approvalId> <approve|deny> [reason]' },
      exposeToModel: true,
    });
  }
  const decision = requireArg(args, 1); 
  if (decision !== 'approve' && decision !== 'deny') {
    throw new AirError('INVALID_ARGUMENT', 'Decision must be "approve" or "deny"', {
      context: { decision },
      exposeToModel: true,
    });
  }
  const result = await ctx.client.resolveApproval({
    approvalId: requireArg(args, 0), 
    decision: decision,
    reason: args[2] ?? undefined,
  });
  return { kind: 'text', data: result };
}

async function cmdLogsTail(ctx: CommandContext, args: string[]): Promise<CommandResult> {
  void ctx;
  const logs = await ctx.client.tailLogs({
    stream: args[0] ?? undefined,
    limit: args[1] ? Number.parseInt(args[1], 10) : undefined,
  });
  return { kind: 'text', data: logs };
}

async function cmdConfigGet(ctx: CommandContext, args: string[]): Promise<CommandResult> {
  void ctx;
  if (args.length < 1) {
    throw new AirError('INVALID_ARGUMENT', 'Usage: config.get <key>', {
      context: { usage: 'config.get <key>' },
      exposeToModel: true,
    });
  }
  const config = await ctx.client.getConfig({ key: requireArg(args, 0) }); 
  return { kind: 'text', data: config };
}

async function cmdConfigExplain(ctx: CommandContext, args: string[]): Promise<CommandResult> {
  void ctx;
  if (args.length < 1) {
    throw new AirError('INVALID_ARGUMENT', 'Usage: config.explain <key>', {
      context: { usage: 'config.explain <key>' },
      exposeToModel: true,
    });
  }
  const explained = await ctx.client.explainConfig({ key: requireArg(args, 0) }); 
  return { kind: 'text', data: explained };
}

async function cmdChat(ctx: CommandContext, args: string[]): Promise<CommandResult> {
  if (args.length < 1) {
    throw new AirError('INVALID_ARGUMENT', 'Usage: chat <goal>', {
      context: { usage: 'chat <goal>' },
      exposeToModel: true,
    });
  }
  const goal = args.join(' ');
  logger.info({ event: 'shell.chat.start', goal }, 'Starting chat run');

  const session = await ctx.client.createSession({ agentId: 'default' });
  const run = await ctx.client.startRun({
    sessionId: session.sessionId,
    agentId: 'default',
    goal,
  });

  return {
    kind: 'text',
    data: {
      sessionId: session.sessionId,
      runId: run.runId,
      goal,
      status: 'started',
      message: `Chat run started. Use 'run.get ${run.runId}' to check status.`,
    },
  };
}

async function cmdDoctor(ctx: CommandContext): Promise<CommandResult> {
  const health = await ctx.client.health();
  return {
    kind: 'text',
    data: {
      daemon: health,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
    },
  };
}

function cmdAgents(ctx: CommandContext): Promise<CommandResult> {
  void ctx;
  return Promise.resolve({
    kind: 'text',
    data: {
      agents: [
        { id: 'default', description: 'Default general-purpose agent' },
      ],
    },
  });
}

function cmdPolicy(_ctx: CommandContext, args: string[]): Promise<CommandResult> {
  const sub = requireArg(args, 0);
  if (sub === 'explain') {
    return Promise.resolve({ kind: 'text', data: { message: 'Policy explain not yet implemented via shell' } });
  }
  if (sub === 'lint') {
    return Promise.resolve({ kind: 'text', data: { message: 'Policy lint not yet implemented via shell' } });
  }
  return Promise.resolve({
    kind: 'text',
    data: {
      subcommands: ['explain', 'lint'],
      message: 'Use: policy explain | policy lint',
    },
  });
}

function cmdAuditVerify(_ctx: CommandContext): Promise<CommandResult> {
  void _ctx;
  return Promise.resolve({
    kind: 'text',
    data: {
      verified: false,
      message: 'Audit chain verification not yet implemented via shell',
    },
  });
}

// ============================================================================
// Built-in command registration
// ============================================================================

export function registerBuiltinCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'health',
    aliases: [],
    description: 'Check daemon health and protocol version',
    usage: 'health',
    handler: cmdHealth,
  });

  registry.register({
    name: 'session.create',
    aliases: [],
    description: 'Create a new session',
    usage: 'session.create <agentId>',
    handler: cmdSessionCreate,
  });

  registry.register({
    name: 'session.list',
    aliases: [],
    description: 'List sessions',
    usage: 'session.list',
    handler: cmdSessionList,
  });

  registry.register({
    name: 'run.start',
    aliases: [],
    description: 'Start a new agent run',
    usage: 'run.start <sessionId> <agentId> <goal>',
    handler: cmdRunStart,
  });

  registry.register({
    name: 'run.list',
    aliases: ['ps'],
    description: 'List runs (optionally filtered by session)',
    usage: 'run.list [sessionId]',
    handler: cmdRunList,
  });

  registry.register({
    name: 'run.get',
    aliases: [],
    description: 'Get run details and current state',
    usage: 'run.get <runId>',
    handler: cmdRunGet,
  });

  registry.register({
    name: 'run.cancel',
    aliases: ['kill'],
    description: 'Cancel a run',
    usage: 'run.cancel <runId>',
    handler: cmdRunCancel,
  });

  registry.register({
    name: 'run.pause',
    aliases: ['pause'],
    description: 'Pause a run',
    usage: 'run.pause <runId>',
    handler: cmdRunPause,
  });

  registry.register({
    name: 'run.resume',
    aliases: ['resume'],
    description: 'Resume a paused run',
    usage: 'run.resume <runId>',
    handler: cmdRunResume,
  });

  registry.register({
    name: 'run.replay',
    aliases: [],
    description: 'Replay a completed run from the journal',
    usage: 'run.replay <runId>',
    handler: cmdRunReplay,
  });

  registry.register({
    name: 'approval.list',
    aliases: [],
    description: 'List pending approval requests',
    usage: 'approval.list',
    handler: cmdApprovalList,
  });

  registry.register({
    name: 'approval.resolve',
    aliases: [],
    description: 'Approve or deny a pending approval',
    usage: 'approval.resolve <approvalId> <approve|deny> [reason]',
    handler: cmdApprovalResolve,
  });

  registry.register({
    name: 'logs.tail',
    aliases: ['logs'],
    description: 'Tail recent log records',
    usage: 'logs.tail [stream] [limit]',
    handler: cmdLogsTail,
  });

  registry.register({
    name: 'config.get',
    aliases: [],
    description: 'Get effective configuration value',
    usage: 'config.get <key>',
    handler: cmdConfigGet,
  });

  registry.register({
    name: 'config.explain',
    aliases: [],
    description: 'Explain configuration provenance for a key',
    usage: 'config.explain <key>',
    handler: cmdConfigExplain,
  });

  registry.register({
    name: 'chat',
    aliases: [],
    description: 'Start an interactive chat run with a goal',
    usage: 'chat <goal>',
    handler: cmdChat,
  });

  registry.register({
    name: 'doctor',
    aliases: [],
    description: 'Environment diagnostics',
    usage: 'doctor',
    handler: cmdDoctor,
  });

  registry.register({
    name: 'agents',
    aliases: [],
    description: 'List available agents',
    usage: 'agents',
    handler: cmdAgents,
  });

  registry.register({
    name: 'policy',
    aliases: [],
    description: 'Policy operations (explain, lint)',
    usage: 'policy <explain|lint>',
    handler: cmdPolicy,
  });

  registry.register({
    name: 'audit.verify',
    aliases: [],
    description: 'Verify the audit chain integrity',
    usage: 'audit.verify',
    handler: cmdAuditVerify,
  });
}
