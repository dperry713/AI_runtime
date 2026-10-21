/**
 * Unit tests for shell exit codes (P9-T04/P9-T07).
 */

import { describe, expect, it } from 'vitest';
import { ExitCode, exitCodeDescription } from '../../../src/shell/exit-codes.js';

describe('ExitCode', () => {
  it('defines all documented exit codes', () => {
    expect(ExitCode.SUCCESS).toBe(0);
    expect(ExitCode.GENERAL_ERROR).toBe(1);
    expect(ExitCode.CONNECTION_ERROR).toBe(2);
    expect(ExitCode.COMMAND_NOT_FOUND).toBe(3);
    expect(ExitCode.INVALID_ARGS).toBe(4);
    expect(ExitCode.DAEMON_ERROR).toBe(5);
    expect(ExitCode.NOT_FOUND).toBe(6);
  });

  it('exitCodeDescription returns human-readable text for each code', () => {
    expect(exitCodeDescription(ExitCode.SUCCESS)).toBe('Success');
    expect(exitCodeDescription(ExitCode.GENERAL_ERROR)).toBe('General error');
    expect(exitCodeDescription(ExitCode.CONNECTION_ERROR)).toBe('Cannot connect to daemon');
    expect(exitCodeDescription(ExitCode.COMMAND_NOT_FOUND)).toBe('Command not found');
    expect(exitCodeDescription(ExitCode.INVALID_ARGS)).toBe('Invalid arguments');
    expect(exitCodeDescription(ExitCode.DAEMON_ERROR)).toBe('Daemon error');
    expect(exitCodeDescription(ExitCode.NOT_FOUND)).toBe('Resource not found');
  });
});
