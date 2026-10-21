/**
 * Shell output formatting (Phase 9 - P9-T04/P9-T07).
 *
 * Provides consistent text and JSON output formatting for all `air`
 * commands. When `--json` is passed, all output (including errors) is
 * emitted as parseable JSON on stdout.
 */

import { ExitCode, type ExitCode as ExitCodeType } from './exit-codes.js';

export interface OutputOptions {
  /** Emit JSON instead of human-readable text. */
  readonly json?: boolean;
}

/** Write a success result to stdout. */
export function writeResult(data: unknown, options: OutputOptions = {}): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatValue(data)}\n`);
  }
}

/** Write an error to stdout (JSON mode) or stderr (text mode). */
export function writeError(
  err: Error,
  options: OutputOptions = {},
): ExitCodeType {
  const code = extractExitCode(err);

  if (options.json) {
    const payload = {
      ok: false,
      error: {
        code: err instanceof Error && 'code' in err
          ? String((err as { code?: unknown }).code)
          : 'UNKNOWN',
        message: err.message,
        exitCode: code,
      },
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stderr.write(`air: ${err.message}\n`);
  }

  return code;
}

/** Format a value for human-readable output. */
function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

/** Extract an exit code from an error, defaulting to GENERAL_ERROR. */
function extractExitCode(err: Error): ExitCodeType {
  const code = (err as { exitCode?: ExitCodeType }).exitCode;
  if (code !== undefined && Object.values(ExitCode).includes(code)) {
    return code;
  }
  // Map known error codes to exit codes
  const errCode = (err as { code?: string }).code;
  switch (errCode) {
    case 'IPC_CONNECTION_FAILED':
    case 'ENOENT':
    case 'ECONNREFUSED':
      return ExitCode.CONNECTION_ERROR;
    case 'RUN_NOT_FOUND':
    case 'SESSION_NOT_FOUND':
    case 'CONFIG_NOT_FOUND':
      return ExitCode.NOT_FOUND;
    case 'IPC_PROTOCOL_ERROR':
      return ExitCode.DAEMON_ERROR;
    default:
      return ExitCode.GENERAL_ERROR;
  }
}
