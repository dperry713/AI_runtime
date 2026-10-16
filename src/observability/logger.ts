import * as os from 'node:os';
import * as path from 'node:path';
import type { LoggingConfig, LogLevel } from '../config/index.js';
import { LoggingConfigSchema } from '../config/index.js';
import type { Clock } from '../util/index.js';
import { SystemClock } from '../util/index.js';
import { currentContext } from './context.js';
import { redactObject, redactString } from './redaction.js';
import type { LogRecord, LogSink, LogStreamName } from './streams.js';
import { MemoryLogSink, StreamDispatcher } from './streams.js';

const LOG_LEVEL_WEIGHTS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const MAX_DATA_BYTES = 8192; // 8 KB cap per record data

export interface LogFields {
  event: string;
  stream?: LogStreamName | undefined;
  durationMs?: number | undefined;
  err?: Error | { code?: string; message: string; retryable?: boolean; stack?: string } | undefined;
  data?: Record<string, unknown> | undefined;
  [key: string]: unknown;
}

export interface LoggingInitOptions {
  home?: string | undefined;
  clock?: Clock | undefined;
  sink?: LogSink | undefined;
  config?: LoggingConfig | undefined;
}

let activeClock: Clock = new SystemClock();
let activeDispatcher: StreamDispatcher | undefined;
let activeMemorySink: MemoryLogSink | undefined;
let activeConfig: LoggingConfig = LoggingConfigSchema.parse({});
let isInitialized = false;

function formatError(err: unknown): { code?: string; message: string; retryable?: boolean; stack?: string } {
  if (err instanceof Error) {
    const res: { code?: string; message: string; retryable?: boolean; stack?: string } = {
      message: err.message,
    };
    if ('code' in err && typeof (err as { code: unknown }).code === 'string') {
      res.code = (err as { code: string }).code;
    }
    if ('retryable' in err && typeof (err as { retryable: unknown }).retryable === 'boolean') {
      res.retryable = (err as { retryable: boolean }).retryable;
    }
    if (err.stack) {
      res.stack = err.stack;
    }
    return res;
  }
  return { message: String(err) };
}

function capDataPayload(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;

  try {
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json, 'utf-8') <= MAX_DATA_BYTES) {
      return data;
    }

    // Truncate fields if total payload is oversized
    const truncated: Record<string, unknown> = { _truncated: true };
    for (const [key, value] of Object.entries(data)) {
      const valJson = JSON.stringify(value);
      if (valJson && valJson.length > 512) {
        truncated[key] = `${valJson.slice(0, 512)}... [TRUNCATED]`;
      } else {
        truncated[key] = value;
      }
    }
    return truncated;
  } catch {
    return { _truncated: true, _serialization_failed: true };
  }
}

export class ComponentLogger {
  constructor(
    public readonly component: string,
    private readonly bindings: Record<string, unknown> = {},
  ) {}

  public child(bindings: Record<string, unknown>): ComponentLogger {
    return new ComponentLogger(this.component, { ...this.bindings, ...bindings });
  }

  public trace(fieldsOrMsg: LogFields | string, msg?: string): void {
    this.log('trace', fieldsOrMsg, msg);
  }

  public debug(fieldsOrMsg: LogFields | string, msg?: string): void {
    this.log('debug', fieldsOrMsg, msg);
  }

  public info(fieldsOrMsg: LogFields | string, msg?: string): void {
    this.log('info', fieldsOrMsg, msg);
  }

  public warn(fieldsOrMsg: LogFields | string, msg?: string): void {
    this.log('warn', fieldsOrMsg, msg);
  }

  public error(fieldsOrMsg: LogFields | string, msg?: string): void {
    this.log('error', fieldsOrMsg, msg);
  }

  public fatal(fieldsOrMsg: LogFields | string, msg?: string): void {
    this.log('fatal', fieldsOrMsg, msg);
  }

  private isLevelEnabled(level: LogLevel): boolean {
    const requiredLevel: LogLevel =
      activeConfig.levels?.[this.component] ?? activeConfig.level;
    return LOG_LEVEL_WEIGHTS[level] >= LOG_LEVEL_WEIGHTS[requiredLevel];
  }

  private log(level: LogLevel, fieldsOrMsg: LogFields | string, msgText?: string): void {
    let fields: LogFields;
    let message: string;

    if (typeof fieldsOrMsg === 'string') {
      message = fieldsOrMsg;
      fields = { event: `${this.component}.${level}` };
    } else {
      fields = fieldsOrMsg;
      message = msgText ?? fields.event;
    }

    const stream: LogStreamName = fields.stream ?? 'runtime';

    // Audit logs are ALWAYS emitted regardless of log level per docs/LOGGING.md §1
    if (stream !== 'audit' && !this.isLevelEnabled(level)) {
      return;
    }

    const ctx = currentContext();
    const pid = process.pid;
    const host = os.hostname();

    // Redaction on message
    const redactedMsg = redactString(message);

    // Merge data from bindings and explicit data
    const combinedData: Record<string, unknown> = {
      ...this.bindings,
      ...(fields.data ?? {}),
    };

    // Redaction on data payload
    const redactedData = redactObject(combinedData);
    const cappedData = capDataPayload(redactedData);

    const record: LogRecord = {
      v: 1,
      ts: activeClock.iso(),
      level,
      stream,
      component: this.component,
      event: fields.event,
      msg: redactedMsg,
      pid,
      host,
    };

    // Context correlation IDs
    if (ctx?.sessionId !== undefined) record.sessionId = ctx.sessionId;
    if (ctx?.runId !== undefined) record.runId = ctx.runId;
    if (ctx?.agentId !== undefined) record.agentId = ctx.agentId;
    if (ctx?.turnId !== undefined) record.turnId = ctx.turnId;
    if (ctx?.toolCallId !== undefined) record.toolCallId = ctx.toolCallId;
    if (ctx?.eventId !== undefined) record.eventId = ctx.eventId;
    if (ctx?.traceId !== undefined) record.traceId = ctx.traceId;
    if (ctx?.spanId !== undefined) record.spanId = ctx.spanId;

    if (fields.durationMs !== undefined) {
      record.durationMs = fields.durationMs;
    }

    if (fields.err !== undefined) {
      const errFormatted = formatError(fields.err);
      record.err = {
        message: redactString(errFormatted.message),
      };
      if (errFormatted.code) record.err.code = errFormatted.code;
      if (errFormatted.retryable !== undefined) record.err.retryable = errFormatted.retryable;
      if (errFormatted.stack) record.err.stack = redactString(errFormatted.stack);
    }

    if (cappedData && Object.keys(cappedData).length > 0) {
      record.data = cappedData;
    }

    if (activeDispatcher) {
      activeDispatcher.write(record);
    }
  }
}

/**
 * Initializes structured logging system with file rotation and multi-stream routing.
 */
export function initLogging(options: LoggingInitOptions = {}): void {
  activeClock = options.clock ?? new SystemClock();
  activeConfig = options.config ?? LoggingConfigSchema.parse({});

  const logsDir = options.home
    ? path.join(options.home, 'logs')
    : path.join(process.cwd(), 'var', 'logs');

  if (activeDispatcher) {
    activeDispatcher.close();
  }

  activeDispatcher = new StreamDispatcher(logsDir, activeConfig);

  if (options.sink) {
    activeDispatcher.addTestSink(options.sink);
  }

  isInitialized = true;
}

/**
 * Initializes in-memory test logging sink for clean test assertions.
 */
export function initTestLogging(clock?: Clock, config?: Partial<LoggingConfig>): MemoryLogSink {
  activeMemorySink = new MemoryLogSink();
  const fullConfig = LoggingConfigSchema.parse(config ?? {});
  initLogging({
    clock: clock ?? new SystemClock(),
    config: fullConfig,
    sink: activeMemorySink,
  });
  return activeMemorySink;
}

/**
 * Resets logger state and closes active stream handles.
 */
export function resetLogging(): void {
  if (activeDispatcher) {
    activeDispatcher.close();
    activeDispatcher = undefined;
  }
  activeMemorySink = undefined;
  activeConfig = LoggingConfigSchema.parse({});
  activeClock = new SystemClock();
  isInitialized = false;
}

/**
 * Flushes all pending log streams synchronously.
 */
export function flushLogs(): void {
  if (activeDispatcher) {
    activeDispatcher.flush();
  }
}

/**
 * Retrieves a component logger adhering to docs/LOGGING.md rules.
 */
export function getLogger(component: string): ComponentLogger {
  if (!isInitialized && !activeDispatcher) {
    // Lazily initialize with defaults if getLogger is called before explicit init
    initLogging();
  }
  return new ComponentLogger(component);
}
