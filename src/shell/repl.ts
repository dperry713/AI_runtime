/**
 * Interactive REPL for the `air` shell (Phase 9 - P9-T04).
 *
 * Provides a readline-based REPL loop that connects to `aird` via IPC,
 * parses user input, dispatches to commands, and renders results.
 * Supports slash commands (.help, .exit, .json) and command history.
 */

import { createInterface } from 'node:readline';
import { AirClient } from '../client/index.js';
import { AirError } from '../errors/index.js';
import { CommandRegistry, registerBuiltinCommands } from './commands.js';
import { writeResult, writeError } from './output.js';
import { ExitCode } from './exit-codes.js';
import { getLogger } from '../observability/index.js';

const logger = getLogger('air-repl');

const PROMPT = 'air> ';
const HISTORY_MAX = 100;

export interface ReplOptions {
  readonly pipeName?: string | undefined;
  readonly json?: boolean;
  readonly requestTimeoutMs?: number;
}

export class Repl {
  private readonly client: AirClient;
  private readonly registry: CommandRegistry;
  private readonly json: boolean;
  private readonly history: string[] = [];
  private rl: ReturnType<typeof createInterface> | null = null;

  constructor(options: ReplOptions = {}) {
    this.client = new AirClient({
      pipeName: options.pipeName,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    this.registry = new CommandRegistry();
    registerBuiltinCommands(this.registry);
    this.json = options.json ?? false;
  }

  /** Run the REPL loop. Returns the exit code. */
  async run(): Promise<number> {
    try {
      await this.client.connect();
    } catch (err) {
      writeError(err as Error, { json: this.json });
      return ExitCode.CONNECTION_ERROR;
    }

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: PROMPT,
      historySize: HISTORY_MAX,
    });

    this.rl.on('line', (line) => {
      void this.handleLine(line).catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error({ event: 'shell.repl.line_error', err: error }, 'REPL line handler error');
        writeError(error, { json: this.json });
      });
    });

    this.rl.on('close', () => {
      // Interface closed (user exited)
    });

    this.rl.setPrompt(PROMPT);
    this.rl.prompt();

    // Wait until the interface is closed (user exits)
    const rl = this.rl;
    if (!rl) {
      throw new Error('readline interface not initialized');
    }
    await new Promise<void>((resolve) => {
      rl.once('close', () => resolve());
    });

    try {
      await this.client.disconnect();
    } catch {
      // Ignore disconnect errors during cleanup
    }

    return ExitCode.SUCCESS;
  }

  /** Stop the REPL (closes readline). */
  stop(): void {
    this.rl?.close();
    this.rl = null;
  }

  private async handleLine(rawLine: string): Promise<void> {
    const line = rawLine.trim();
    if (line.length === 0) {
      this.rl?.prompt();
      return;
    }

    // Add to history (avoid duplicates)
    if (this.history.length === 0 || this.history[this.history.length - 1] !== line) {
      this.history.push(line);
      if (this.history.length > HISTORY_MAX) {
        this.history.shift();
      }
    }

    // Handle slash commands
    if (line.startsWith('.')) {
      this.handleSlashCommand(line);
      this.rl?.prompt();
      return;
    }

    // Parse: <command> [args...]
    const parts = line.split(/\s+/);
    const first = parts[0];
    if (first === undefined) {
      this.rl?.prompt();
      return;
    }
    const cmdName = first;
    const args = parts.slice(1);

    const def = this.registry.get(cmdName);
    if (!def) {
      writeError(
        new AirError('INVALID_ARGUMENT', `Unknown command: "${cmdName}". Type .help for available commands.`, {
          context: { command: cmdName },
          exposeToModel: true,
        }),
        { json: this.json },
      );
      this.rl?.prompt();
      return;
    }

    try {
      const result = await def.handler({ client: this.client, json: this.json }, args);
      writeResult(result.data, { json: this.json });
    } catch (err) {
      writeError(err as Error, { json: this.json });
    }

    this.rl?.prompt();
  }

  private handleSlashCommand(line: string): void {
    const parts = line.slice(1).split(/\s+/);
    const first = parts[0];
    if (first === undefined) {
      process.stdout.write('Unknown slash command. Type .help for available commands.\n');
      return;
    }
    const cmd = first.toLowerCase();

    switch (cmd) {
      case 'help':
      case 'h':
        this.printHelp();
        break;
      case 'exit':
      case 'quit':
      case 'q':
        this.stop();
        break;
      case 'json':
        process.stdout.write(`JSON mode is ${this.json ? 'on' : 'off'}. Use --json flag to enable.\n`);
        break;
      case 'history':
        for (const entry of this.history) {
          process.stdout.write(`${entry}\n`);
        }
        break;
      case 'clear':
        process.stdout.write('\x1B[2J\x1B[H');
        break;
      case 'commands':
      case 'cmds':
        for (const def of this.registry.list()) {
          process.stdout.write(`  ${def.name.padEnd(20)} ${def.description}\n`);
        }
        break;
      default:
        process.stdout.write(`Unknown slash command: .${cmd}. Type .help for available commands.\n`);
    }
  }

  private printHelp(): void {
    process.stdout.write('AIR Shell — Interactive REPL\n');
    process.stdout.write('=============================\n\n');
    process.stdout.write('Commands:\n');
    for (const def of this.registry.list()) {
      process.stdout.write(`  ${def.name.padEnd(24)} ${def.usage}\n`);
      process.stdout.write(`         ${def.description}\n`);
    }
    process.stdout.write('\nSlash commands:\n');
    process.stdout.write('  .help        Show this help\n');
    process.stdout.write('  .commands    List all command names\n');
    process.stdout.write('  .history     Show command history\n');
    process.stdout.write('  .clear       Clear the screen\n');
    process.stdout.write('  .exit        Exit the REPL\n');
    process.stdout.write('\nUse --json flag for machine-readable output.\n');
  }
}
