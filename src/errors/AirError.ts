export type ErrorCode =
  | 'UNKNOWN'
  | 'INVALID_ARGUMENT'
  | 'INVALID_STATE'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'PERMISSION_DENIED'
  | 'UNAUTHENTICATED'
  | 'RESOURCE_EXHAUSTED'
  | 'FAILED_PRECONDITION'
  | 'ABORTED'
  | 'OUT_OF_RANGE'
  | 'UNIMPLEMENTED'
  | 'INTERNAL'
  | 'UNAVAILABLE'
  | 'DATA_LOSS'
  | 'DEADLINE_EXCEEDED'
  | 'CANCELLED'
  | 'POLICY_DENIED'
  | 'POLICY_INVALID'
  | 'TOOL_TIMEOUT'
  | 'TOOL_EXECUTION_FAILED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_INVALID_REQUEST'
  | 'JOURNAL_CORRUPT'
  | 'JOURNAL_WRITE_FAILED'
  | 'JOURNAL_READ_FAILED'
  | 'INDEX_CORRUPT'
  | 'INDEX_WRITE_FAILED'
  | 'MIGRATION_FAILED'
  | 'CONFIG_INVALID'
  | 'CONFIG_NOT_FOUND'
  | 'SECRET_NOT_FOUND'
  | 'SECRET_ACCESS_DENIED'
  | 'PATH_ESCAPE'
  | 'PATH_NOT_ALLOWED'
  | 'SANDBOX_VIOLATION'
  | 'SECURITY_VIOLATION'
  | 'SANDBOX_TIMEOUT'
  | 'SANDBOX_RESOURCE_EXCEEDED'
  | 'SANDBOX_ORPHANED'
  | 'RUNTIME_ERROR'
  | 'SERIALIZATION_FAILED'
  | 'DESERIALIZATION_FAILED'
  | 'VALIDATION_FAILED'
  | 'REPLAY_MISMATCH'
  | 'UPCASTER_FAILED'
  | 'IPC_CONNECTION_FAILED'
  | 'IPC_PROTOCOL_ERROR'
  | 'DAEMON_NOT_RUNNING'
  | 'DAEMON_ALREADY_RUNNING'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_ALREADY_RUNNING'
  | 'RUN_NOT_FOUND'
  | 'RUN_ILLEGAL_TRANSITION'
  | 'RUN_BUDGET_EXCEEDED'
  | 'RUN_CANCELLED'
  | 'APPROVAL_DENIED'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_NOT_FOUND'
  | 'MEMORY_WRITE_DENIED'
  | 'MEMORY_RETRIEVAL_FAILED'
  | 'EMBEDDING_FAILED'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_VALIDATION_FAILED'
  | 'TOOL_OUTPUT_TOO_LARGE'
  | 'AGENT_STALL_DETECTED'
  | 'CONTEXT_LIMIT_EXCEEDED';

const RETRYABLE_CODES: Set<ErrorCode> = new Set([
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'RESOURCE_EXHAUSTED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'JOURNAL_WRITE_FAILED',
  'INDEX_WRITE_FAILED',
  'SANDBOX_TIMEOUT',
  'IPC_CONNECTION_FAILED',
  'EMBEDDING_FAILED',
]);

export interface AirErrorContext {
  readonly [key: string]: unknown;
}

interface AirErrorOptions {
  retryable?: boolean | undefined;
  cause?: Error | undefined;
  context?: AirErrorContext | undefined;
  exposeToModel?: boolean | undefined;
}

export class AirError extends Error {
  public readonly code: ErrorCode;
  public readonly retryable: boolean;
  public override readonly cause: Error | undefined;
  public readonly context: AirErrorContext;
  public readonly exposeToModel: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: AirErrorOptions = {}
  ) {
    super(message);
    this.name = 'AirError';
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
    this.cause = options.cause;
    this.context = options.context ?? {};
    this.exposeToModel = options.exposeToModel ?? false;

    Object.setPrototypeOf(this, AirError.prototype);
  }

  static isRetryable(code: ErrorCode): boolean {
    return RETRYABLE_CODES.has(code);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      cause: this.cause?.message,
      context: this.context,
      exposeToModel: this.exposeToModel,
      stack: this.stack,
    };
  }

  toModelSafeMessage(): string {
    if (this.exposeToModel) {
      return this.message;
    }
    return `[${this.code}] ${this.message}`;
  }

  static fromUnknown(error: unknown, defaultCode: ErrorCode = 'INTERNAL'): AirError {
    if (error instanceof AirError) {
      return error;
    }
    if (error instanceof Error) {
      return new AirError(defaultCode, error.message, { cause: error });
    }
    return new AirError(defaultCode, String(error));
  }

  static wrap(error: unknown, code: ErrorCode, message: string, options: AirErrorOptions = {}): AirError {
    if (error instanceof AirError) {
      return new AirError(code, message, {
        retryable: options.retryable ?? error.retryable,
        cause: error,
        context: { ...error.context, ...options.context },
        exposeToModel: options.exposeToModel ?? error.exposeToModel,
      });
    }
    const cause = error instanceof Error ? error : undefined;
    return new AirError(code, message, {
      retryable: options.retryable,
      cause,
      context: options.context,
      exposeToModel: options.exposeToModel,
    });
  }
}

export function isAirError(error: unknown): error is AirError {
  return error instanceof AirError;
}

export function assertAirError(error: unknown, code: ErrorCode, message: string): AirError {
  if (error instanceof AirError) {
    return error;
  }
  if (error instanceof Error) {
    return new AirError(code, message, { cause: error });
  }
  return new AirError(code, message);
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof AirError) {
    return error.retryable;
  }
  return false;
}