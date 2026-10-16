import * as path from 'node:path';
import type { LoggingConfig } from '../config/index.js';
import { enforceTotalLogBudget, RotatingFileStream } from './rotation.js';
import type {
  AgentId,
  EventId,
  RunId,
  SessionId,
  ToolCallId,
  TurnId,
} from '../types/index.js';

export type LogStreamName = 'runtime' | 'audit' | 'llm' | 'tools';

export interface LogRecord {
  v: 1;
  ts: string;
  level: string;
  stream: LogStreamName;
  component: string;
  event: string;
  msg: string;
  pid: number;
  host: string;
  sessionId?: SessionId | undefined;
  runId?: RunId | undefined;
  agentId?: AgentId | undefined;
  turnId?: TurnId | undefined;
  toolCallId?: ToolCallId | undefined;
  eventId?: EventId | undefined;
  traceId?: string | undefined;
  spanId?: string | undefined;
  durationMs?: number | undefined;
  err?: {
    code?: string | undefined;
    message: string;
    retryable?: boolean | undefined;
    stack?: string | undefined;
  } | undefined;
  data?: Record<string, unknown> | undefined;
}

export interface LogSink {
  write(record: LogRecord): void;
  flush?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

export class MemoryLogSink implements LogSink {
  public records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }

  clear(): void {
    this.records = [];
  }

  getRecords(filter?: (r: LogRecord) => boolean): LogRecord[] {
    return filter ? this.records.filter(filter) : [...this.records];
  }
}

export class StreamDispatcher implements LogSink {
  private readonly fileStreams = new Map<LogStreamName, RotatingFileStream>();
  private readonly testSinks: LogSink[] = [];
  private readonly logsDir: string;
  private readonly maxTotalBytes: number;

  constructor(logsDir: string, config: LoggingConfig) {
    this.logsDir = logsDir;
    this.maxTotalBytes = config.maxTotalMb * 1024 * 1024;

    const streamSpecs: Record<LogStreamName, { fileName: string; maxSizeMb: number; keep: number }> = {
      runtime: { fileName: 'runtime.log', maxSizeMb: config.rotate.maxSizeMb, keep: config.rotate.keep },
      audit: { fileName: 'audit.log', maxSizeMb: 100, keep: 20 },
      llm: { fileName: 'llm.log', maxSizeMb: config.rotate.maxSizeMb, keep: config.rotate.keep },
      tools: { fileName: 'tools.log', maxSizeMb: config.rotate.maxSizeMb, keep: config.rotate.keep },
    };

    for (const [name, spec] of Object.entries(streamSpecs) as Array<[LogStreamName, (typeof streamSpecs)[LogStreamName]]>) {
      const filePath = path.join(logsDir, spec.fileName);
      const stream = new RotatingFileStream({
        filePath,
        maxSizeBytes: spec.maxSizeMb * 1024 * 1024,
        keep: spec.keep,
      });
      this.fileStreams.set(name, stream);
    }
  }

  public addTestSink(sink: LogSink): void {
    this.testSinks.push(sink);
  }

  public removeTestSink(sink: LogSink): void {
    const idx = this.testSinks.indexOf(sink);
    if (idx >= 0) {
      this.testSinks.splice(idx, 1);
    }
  }

  public write(record: LogRecord): void {
    // 1. Forward to test sinks
    for (const sink of this.testSinks) {
      try {
        sink.write(record);
      } catch {
        // Ignore sink errors
      }
    }

    // 2. Format to JSONL and write to appropriate file stream
    const line = `${JSON.stringify(record)}\n`;
    const target = this.fileStreams.get(record.stream) ?? this.fileStreams.get('runtime');
    if (target) {
      target.writeLine(line);
    }

    // Periodically enforce disk budget
    enforceTotalLogBudget(this.logsDir, this.maxTotalBytes);
  }

  public flush(): void {
    for (const stream of this.fileStreams.values()) {
      stream.flushSync();
    }
  }

  public close(): void {
    for (const stream of this.fileStreams.values()) {
      stream.end();
    }
    this.fileStreams.clear();
  }
}
