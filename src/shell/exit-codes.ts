/**
 * Shell exit codes (Phase 9 - P9-T04/P9-T07).
 *
 * Documented exit codes for the `air` CLI. Programs and scripts can
 * rely on these codes to determine the outcome of a command.
 */

export const ExitCode = {
  /** Command completed successfully. */
  SUCCESS: 0,
  /** Unexpected or general error. */
  GENERAL_ERROR: 1,
  /** Cannot connect to the daemon (pipe not available, refused, etc.). */
  CONNECTION_ERROR: 2,
  /** Unknown or unsupported command. */
  COMMAND_NOT_FOUND: 3,
  /** Invalid command arguments or flags. */
  INVALID_ARGS: 4,
  /** Daemon returned an error (e.g. run not found, invalid state). */
  DAEMON_ERROR: 5,
  /** Requested resource not found (run, session, approval, etc.). */
  NOT_FOUND: 6,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Human-readable description of an exit code. */
export function exitCodeDescription(code: ExitCode): string {
  switch (code) {
    case ExitCode.SUCCESS:
      return 'Success';
    case ExitCode.GENERAL_ERROR:
      return 'General error';
    case ExitCode.CONNECTION_ERROR:
      return 'Cannot connect to daemon';
    case ExitCode.COMMAND_NOT_FOUND:
      return 'Command not found';
    case ExitCode.INVALID_ARGS:
      return 'Invalid arguments';
    case ExitCode.DAEMON_ERROR:
      return 'Daemon error';
    case ExitCode.NOT_FOUND:
      return 'Resource not found';
    default:
      return `Unknown exit code ${String(code)}`;
  }
}
