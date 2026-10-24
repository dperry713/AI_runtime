/**
 * `air` shell entrypoint (Phase 9 - P9-T04/P9-T05/P9-T07).
 *
 * CLI entry point for the `air` shell. Parses arguments, connects to `aird`
 * via IPC, executes a single command or starts the interactive REPL, and
 * exits with a documented exit code.
 *
 * Usage:
 *   air <command> [args...] [--json] [--pipe-name <name>]
 *   air [--json] [--pipe-name <name>]          # interactive REPL
 */

import { pathToFileURL } from 'node:url';
import { Repl } from './repl.js';
import { writeError, writeResult, type OutputOptions } from './output.js';
import { ExitCode } from './exit-codes.js';
import { CommandRegistry, registerBuiltinCommands } from './commands.js';
import { AirClient } from '../client/index.js';
import { AirError } from '../errors/index.js';
import { getLogger } from '../observability/index.js';

const logger = getLogger('air-main');

const VERSION = '0.0.0';

interface ParsedOptions {
  json: boolean;
  pipeName: string | undefined;
  requestTimeoutMs: number;
  command: string | undefined;
  commandArgs: string[];
}

/** Parse CLI arguments manually for reliability. */
function parseArgs(argv: string[]): ParsedOptions {
  const options: ParsedOptions = {
    json: false,
    pipeName: undefined,
    requestTimeoutMs: 30_000,
    command: undefined,
    commandArgs: [],
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i++;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      i++;
    } else if (arg === '--pipe-name' && i + 1 < argv.length) {
      const value = argv[i + 1];
      if (value !== undefined) {
        options.pipeName = value;
      }
      i += 2;
    } else if (arg.startsWith('--pipe-name=')) {
      options.pipeName = arg.slice('--pipe-name='.length);
      i++;
    } else if (arg === '--request-timeout-ms' && i + 1 < argv.length) {
      const value = argv[i + 1];
      if (value !== undefined) {
        options.requestTimeoutMs = Number.parseInt(value, 10) || 30_000;
      }
      i += 2;
    } else if (arg.startsWith('--request-timeout-ms=')) {
      options.requestTimeoutMs =
        Number.parseInt(arg.slice('--request-timeout-ms='.length), 10) || 30_000;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      options.command = 'help';
      i++;
    } else if (arg === '--version' || arg === '-V') {
      options.command = 'version';
      i++;
    } else if (options.command === undefined) {
      options.command = arg;
      i++;
    } else {
      options.commandArgs.push(arg);
      i++;
    }
  }

  return options;
}

/** Parse CLI arguments and run the shell. Returns the exit code. */
export async function runAir(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);

  logger.info({
    event: 'shell.start',
    command: parsed.command,
    json: parsed.json,
  }, 'Air shell started');

  const outputOptions: OutputOptions = { json: parsed.json };

  // Build the client
  const client = new AirClient({
    pipeName: parsed.pipeName,
    requestTimeoutMs: parsed.requestTimeoutMs,
  });

  // If no command, start interactive REPL
  if (!parsed.command) {
    const repl = new Repl({
      pipeName: parsed.pipeName,
      json: parsed.json,
      requestTimeoutMs: parsed.requestTimeoutMs,
    });
    return repl.run();
  }

  // Handle --help and --version
  if (parsed.command === 'help') {
    process.stdout.write(
      `AIR — AI Runtime shell v${VERSION}\nUsage: air <command> [args...] [--json] [--pipe-name <name>]\n`,
    );
    return ExitCode.SUCCESS;
  }
  if (parsed.command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return ExitCode.SUCCESS;
  }

  // Single-command mode: connect, run, disconnect
  try {
    await client.connect();
  } catch (err) {
    writeError(err as Error, outputOptions);
    return ExitCode.CONNECTION_ERROR;
  }

  try {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    const def = registry.get(parsed.command);
    if (!def) {
      writeError(
        new AirError('INVALID_ARGUMENT', `Unknown command: "${parsed.command}". Run 'air' without arguments for interactive help.`, {
          context: { command: parsed.command },
          exposeToModel: true,
        }),
        outputOptions,
      );
      return ExitCode.COMMAND_NOT_FOUND;
    }

    try {
      const result = await def.handler({ client, json: parsed.json }, parsed.commandArgs);
      writeResult(result.data, outputOptions);
      return ExitCode.SUCCESS;
    } catch (err) {
      return writeError(err as Error, outputOptions);
    }
  } finally {
    try {
      await client.disconnect();
    } catch {
      // Ignore disconnect errors during cleanup
    }
  }
}

// Invoke CLI entry point when executed directly
if (
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    import.meta.url.endsWith('/' + process.argv[1].replace(/\\/g, '/')))
) {
  void runAir().then((code) => {
    process.exitCode = code;
  });
}
