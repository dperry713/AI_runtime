import { describe, expect, it } from 'vitest';
import {
  AirError,
  type ErrorCode,
  isAirError,
  isRetryableError,
  assertAirError,
} from '../../../src/errors/AirError.js';

describe('AirError', () => {
  describe('construction', () => {
    it('creates an error with required fields', () => {
      const error = new AirError('INVALID_ARGUMENT', 'Invalid input');
      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.message).toBe('Invalid input');
      expect(error.name).toBe('AirError');
      expect(error.retryable).toBe(false);
      expect(error.cause).toBeUndefined();
      expect(error.context).toEqual({});
      expect(error.exposeToModel).toBe(false);
    });

    it('sets retryable based on code', () => {
      const retryableError = new AirError('UNAVAILABLE', 'Service unavailable');
      expect(retryableError.retryable).toBe(true);

      const nonRetryableError = new AirError('INVALID_ARGUMENT', 'Bad input');
      expect(nonRetryableError.retryable).toBe(false);
    });

    it('allows explicit retryable override', () => {
      const error = new AirError('INVALID_ARGUMENT', 'Bad input', { retryable: true });
      expect(error.retryable).toBe(true);
    });

    it('includes cause', () => {
      const cause = new Error('original');
      const error = new AirError('INTERNAL', 'Wrapped', { cause });
      expect(error.cause).toBe(cause);
    });

    it('includes context', () => {
      const error = new AirError('INVALID_ARGUMENT', 'Bad input', { context: { field: 'email', value: 'invalid' } });
      expect(error.context).toEqual({ field: 'email', value: 'invalid' });
    });

    it('sets exposeToModel', () => {
      const error = new AirError('INVALID_ARGUMENT', 'Bad input', { exposeToModel: true });
      expect(error.exposeToModel).toBe(true);
    });
  });

  describe('toJSON', () => {
    it('serializes all fields', () => {
      const cause = new Error('cause');
      const error = new AirError('INVALID_ARGUMENT', 'Bad input', {
        retryable: true,
        cause,
        context: { field: 'test' },
        exposeToModel: true,
      });

      const json = error.toJSON();
      expect(json.name).toBe('AirError');
      expect(json.code).toBe('INVALID_ARGUMENT');
      expect(json.message).toBe('Bad input');
      expect(json.retryable).toBe(true);
      expect(json.cause).toBe('cause');
      expect(json.context).toEqual({ field: 'test' });
      expect(json.exposeToModel).toBe(true);
      expect(typeof json.stack).toBe('string');
    });
  });

  describe('toModelSafeMessage', () => {
    it('returns message when exposeToModel is true', () => {
      const error = new AirError('INVALID_ARGUMENT', 'Bad input', { exposeToModel: true });
      expect(error.toModelSafeMessage()).toBe('Bad input');
    });

    it('returns sanitized message when exposeToModel is false', () => {
      const error = new AirError('INVALID_ARGUMENT', 'Bad input', { exposeToModel: false });
      expect(error.toModelSafeMessage()).toBe('[INVALID_ARGUMENT] Bad input');
    });

    it('defaults to sanitized when exposeToModel not set', () => {
      const error = new AirError('INVALID_ARGUMENT', 'Bad input');
      expect(error.toModelSafeMessage()).toBe('[INVALID_ARGUMENT] Bad input');
    });
  });

  describe('isAirError', () => {
    it('returns true for AirError', () => {
      const error = new AirError('INVALID_ARGUMENT', 'Bad input');
      expect(isAirError(error)).toBe(true);
    });

    it('returns false for regular Error', () => {
      expect(isAirError(new Error('regular'))).toBe(false);
    });

    it('returns false for plain objects', () => {
      expect(isAirError({ code: 'INVALID_ARGUMENT', message: 'Bad input' })).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(isAirError(null)).toBe(false);
      expect(isAirError(undefined)).toBe(false);
    });
  });

  describe('isRetryableError', () => {
    it('returns true for retryable AirError', () => {
      const error = new AirError('UNAVAILABLE', 'Service down');
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns false for non-retryable AirError', () => {
      const error = new AirError('INVALID_ARGUMENT', 'Bad input');
      expect(isRetryableError(error)).toBe(false);
    });

    it('returns false for non-AirError', () => {
      expect(isRetryableError(new Error('regular'))).toBe(false);
      expect(isRetryableError(null)).toBe(false);
    });
  });

  describe('fromUnknown', () => {
    it('returns AirError as-is', () => {
      const original = new AirError('INVALID_ARGUMENT', 'Bad input');
      const result = AirError.fromUnknown(original);
      expect(result).toBe(original);
    });

    it('wraps regular Error', () => {
      const original = new Error('regular error');
      const result = AirError.fromUnknown(original);
      expect(result).toBeInstanceOf(AirError);
      expect(result.code).toBe('INTERNAL');
      expect(result.message).toBe('regular error');
      expect(result.cause).toBe(original);
    });

    it('wraps unknown values', () => {
      const result = AirError.fromUnknown('string error');
      expect(result).toBeInstanceOf(AirError);
      expect(result.code).toBe('INTERNAL');
      expect(result.message).toBe('string error');
    });

    it('uses custom default code', () => {
      const result = AirError.fromUnknown(new Error('oops'), 'VALIDATION_FAILED');
      expect(result.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('wrap', () => {
    it('wraps AirError with new code and message', () => {
      const original = new AirError('PROVIDER_ERROR', 'Provider failed', { context: { provider: 'anthropic' } });
      const wrapped = AirError.wrap(original, 'INTERNAL', 'Operation failed');
      expect(wrapped.code).toBe('INTERNAL');
      expect(wrapped.message).toBe('Operation failed');
      expect(wrapped.cause).toBe(original);
      expect(wrapped.context.provider).toBe('anthropic');
    });

    it('preserves retryable from cause when not overridden', () => {
      const original = new AirError('UNAVAILABLE', 'Service down');
      const wrapped = AirError.wrap(original, 'INTERNAL', 'Operation failed');
      expect(wrapped.retryable).toBe(true);
    });

    it('allows retryable override', () => {
      const original = new AirError('UNAVAILABLE', 'Service down');
      const wrapped = AirError.wrap(original, 'INTERNAL', 'Operation failed', { retryable: false });
      expect(wrapped.retryable).toBe(false);
    });

    it('wraps regular Error', () => {
      const original = new Error('network error');
      const wrapped = AirError.wrap(original, 'UNAVAILABLE', 'Service unreachable');
      expect(wrapped.code).toBe('UNAVAILABLE');
      expect(wrapped.cause).toBe(original);
    });

    it('wraps unknown values', () => {
      const wrapped = AirError.wrap('unknown', 'INTERNAL', 'Unknown error');
      expect(wrapped.code).toBe('INTERNAL');
      expect(wrapped.message).toBe('Unknown error');
    });
  });

  describe('assertAirError', () => {
    it('returns AirError as-is', () => {
      const original = new AirError('INVALID_ARGUMENT', 'Bad input');
      const result = assertAirError(original, 'INVALID_ARGUMENT', 'Bad input');
      expect(result).toBe(original);
    });

    it('wraps regular Error', () => {
      const original = new Error('regular');
      const result = assertAirError(original, 'INTERNAL', 'Wrapped');
      expect(result).toBeInstanceOf(AirError);
      expect(result.code).toBe('INTERNAL');
      expect(result.cause).toBe(original);
    });

    it('wraps unknown values', () => {
      const result = assertAirError('unknown', 'INTERNAL', 'Wrapped');
      expect(result).toBeInstanceOf(AirError);
      expect(result.code).toBe('INTERNAL');
    });
  });

  describe('ErrorCode registry', () => {
    it('has all expected codes', () => {
      const codes: ErrorCode[] = [
        'UNKNOWN', 'INVALID_ARGUMENT', 'INVALID_STATE', 'NOT_FOUND', 'ALREADY_EXISTS',
        'PERMISSION_DENIED', 'UNAUTHENTICATED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION',
        'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS',
        'DEADLINE_EXCEEDED', 'CANCELLED', 'POLICY_DENIED', 'TOOL_TIMEOUT', 'TOOL_EXECUTION_FAILED',
        'PROVIDER_ERROR', 'PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_AUTH_FAILED',
        'PROVIDER_INVALID_REQUEST', 'JOURNAL_CORRUPT', 'JOURNAL_WRITE_FAILED', 'JOURNAL_READ_FAILED',
        'INDEX_CORRUPT', 'INDEX_WRITE_FAILED', 'MIGRATION_FAILED', 'CONFIG_INVALID', 'CONFIG_NOT_FOUND',
        'SECRET_NOT_FOUND', 'SECRET_ACCESS_DENIED', 'PATH_ESCAPE', 'PATH_NOT_ALLOWED', 'SANDBOX_VIOLATION',
        'SANDBOX_TIMEOUT', 'SANDBOX_RESOURCE_EXCEEDED', 'SANDBOX_ORPHANED', 'RUNTIME_ERROR',
        'SERIALIZATION_FAILED', 'DESERIALIZATION_FAILED', 'VALIDATION_FAILED', 'REPLAY_MISMATCH',
        'UPCASTER_FAILED', 'IPC_CONNECTION_FAILED', 'IPC_PROTOCOL_ERROR', 'DAEMON_NOT_RUNNING',
        'DAEMON_ALREADY_RUNNING', 'AGENT_NOT_FOUND', 'AGENT_ALREADY_RUNNING', 'RUN_NOT_FOUND',
        'RUN_ILLEGAL_TRANSITION', 'RUN_BUDGET_EXCEEDED', 'RUN_CANCELLED', 'APPROVAL_DENIED',
        'APPROVAL_EXPIRED', 'APPROVAL_NOT_FOUND', 'MEMORY_WRITE_DENIED', 'MEMORY_RETRIEVAL_FAILED',
        'EMBEDDING_FAILED', 'TOOL_NOT_FOUND', 'TOOL_VALIDATION_FAILED', 'TOOL_OUTPUT_TOO_LARGE',
      ];

      for (const code of codes) {
        expect(typeof AirError.isRetryable(code)).toBe('boolean');
      }
    });

    it('marks expected codes as retryable', () => {
      const retryableCodes: ErrorCode[] = [
        'UNAVAILABLE', 'DEADLINE_EXCEEDED', 'RESOURCE_EXHAUSTED',
        'PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'JOURNAL_WRITE_FAILED',
        'INDEX_WRITE_FAILED', 'SANDBOX_TIMEOUT', 'IPC_CONNECTION_FAILED', 'EMBEDDING_FAILED',
      ];

      for (const code of retryableCodes) {
        expect(AirError.isRetryable(code)).toBe(true);
      }
    });

    it('marks expected codes as non-retryable', () => {
      const nonRetryableCodes: ErrorCode[] = [
        'INVALID_ARGUMENT', 'INVALID_STATE', 'NOT_FOUND', 'PERMISSION_DENIED',
        'POLICY_DENIED', 'TOOL_TIMEOUT', 'JOURNAL_CORRUPT', 'CONFIG_INVALID',
        'PATH_ESCAPE', 'SANDBOX_VIOLATION', 'RUN_ILLEGAL_TRANSITION',
      ];

      for (const code of nonRetryableCodes) {
        expect(AirError.isRetryable(code)).toBe(false);
      }
    });
  });
});