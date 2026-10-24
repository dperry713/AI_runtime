import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearRegisteredSecrets,
  currentContext,
  enforceTotalLogBudget,
  flushLogs,
  getLogger,
  initLogging,
  initTestLogging,
  MemoryLogSink,
  redactObject,
  redactString,
  registerSecret,
  resetLogging,
  RotatingFileStream,
  StreamDispatcher,
  withContext,
} from '../../../src/observability/index.js';
import { AirError } from '../../../src/errors/index.js';
import { createRunId, createSessionId, createToolCallId, createTurnId } from '../../../src/types/index.js';
import { FakeClock } from '../../../src/util/index.js';

describe('observability logger module (P1-T06)', () => {
  let tempDir: string;
  let fakeClock: FakeClock;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-logger-test-'));
    fakeClock = new FakeClock(1700000000000); // deterministic timestamp
    clearRegisteredSecrets();
    resetLogging();
  });

  afterEach(() => {
    resetLogging();
    clearRegisteredSecrets();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('record schema & basic logging', () => {
    it('produces compliant v1 log record with metadata and injected clock', () => {
      const sink = initTestLogging(fakeClock);
      const logger = getLogger('kernel.supervisor');

      logger.info({ event: 'run.started', data: { mode: 'autonomous' } }, 'Agent run started');

      expect(sink.records).toHaveLength(1);
      const rec = sink.records[0];
      expect(rec).toBeDefined();
      expect(rec?.v).toBe(1);
      expect(rec?.ts).toBe(fakeClock.iso());
      expect(rec?.level).toBe('info');
      expect(rec?.stream).toBe('runtime');
      expect(rec?.component).toBe('kernel.supervisor');
      expect(rec?.event).toBe('run.started');
      expect(rec?.msg).toBe('Agent run started');
      expect(rec?.pid).toBe(process.pid);
      expect(typeof rec?.host).toBe('string');
      expect(rec?.data).toEqual({ mode: 'autonomous' });
    });

    it('supports child loggers with persistent bindings', () => {
      const sink = initTestLogging(fakeClock);
      const parent = getLogger('tools.executor');
      const child = parent.child({ tool: 'fs.read', sandbox: 'jail-1' });

      child.info({ event: 'tool.executing', data: { path: 'file.txt' } }, 'reading file');

      expect(sink.records).toHaveLength(1);
      const rec = sink.records[0];
      expect(rec).toBeDefined();
      expect(rec?.component).toBe('tools.executor');
      expect(rec?.data).toEqual({
        tool: 'fs.read',
        sandbox: 'jail-1',
        path: 'file.txt',
      });
    });
  });

  describe('correlation context (AsyncLocalStorage)', () => {
    it('automatically attaches correlation IDs from withContext', () => {
      const sink = initTestLogging(fakeClock);
      const logger = getLogger('turn.engine');

      const runId = createRunId();
      const sessionId = createSessionId();
      const turnId = createTurnId();
      const toolCallId = createToolCallId();

      withContext({ runId, sessionId, traceId: 'trace-123' }, () => {
        logger.info({ event: 'turn.started' }, 'turn started');

        withContext({ turnId, toolCallId, spanId: 'span-456' }, () => {
          logger.info({ event: 'tool.invoked' }, 'tool invoked');
        });
      });

      expect(sink.records).toHaveLength(2);
      const first = sink.records[0];
      expect(first).toBeDefined();
      expect(first?.runId).toBe(runId);
      expect(first?.sessionId).toBe(sessionId);
      expect(first?.traceId).toBe('trace-123');
      expect(first?.turnId).toBeUndefined();

      const second = sink.records[1];
      expect(second).toBeDefined();
      expect(second?.runId).toBe(runId);
      expect(second?.sessionId).toBe(sessionId);
      expect(second?.turnId).toBe(turnId);
      expect(second?.toolCallId).toBe(toolCallId);
      expect(second?.traceId).toBe('trace-123');
      expect(second?.spanId).toBe('span-456');
    });

    it('currentContext returns active context', () => {
      expect(currentContext()).toBeUndefined();
      const runId = createRunId();
      withContext({ runId }, () => {
        expect(currentContext()?.runId).toBe(runId);
      });
    });
  });

  describe('multi-stream routing and level filtering', () => {
    it('routes records to runtime, audit, llm, and tools streams', () => {
      const sink = initTestLogging(fakeClock);
      const logger = getLogger('test');

      logger.info({ stream: 'runtime', event: 'sys.start' }, 'runtime');
      logger.info({ stream: 'audit', event: 'policy.eval' }, 'audit');
      logger.info({ stream: 'llm', event: 'model.req' }, 'llm');
      logger.info({ stream: 'tools', event: 'tool.run' }, 'tools');

      expect(sink.records.map((r) => r.stream)).toEqual(['runtime', 'audit', 'llm', 'tools']);
    });

    it('always records audit stream even when log level is debug and logger is info', () => {
      const sink = initTestLogging(fakeClock, { level: 'info' });
      const logger = getLogger('security');

      // Regular debug should be filtered out
      logger.debug({ stream: 'runtime', event: 'cache.miss' }, 'debug cache');
      expect(sink.records).toHaveLength(0);

      // Audit stream debug MUST be recorded
      logger.debug({ stream: 'audit', event: 'auth.attempt' }, 'audit attempt');
      expect(sink.records).toHaveLength(1);
      expect(sink.records[0]?.stream).toBe('audit');
      expect(sink.records[0]?.event).toBe('auth.attempt');
    });

    it('honors per-component log level overrides', () => {
      const sink = initTestLogging(fakeClock, {
        level: 'warn',
        levels: { 'providers.nvidia': 'debug' },
      });

      const rootLogger = getLogger('kernel');
      const nvidiaLogger = getLogger('providers.nvidia');

      rootLogger.info({ event: 'kernel.info' }, 'should be dropped');
      nvidiaLogger.debug({ event: 'nvidia.chunk' }, 'should be kept');

      expect(sink.records).toHaveLength(1);
      expect(sink.records[0]?.component).toBe('providers.nvidia');
      expect(sink.records[0]?.event).toBe('nvidia.chunk');
    });

    it('manages test sinks in StreamDispatcher dynamically', () => {
      const logsDir = path.join(tempDir, 'dispatcher-logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const dispatcher = new StreamDispatcher(logsDir, {
        level: 'info',
        llmPayloads: 'off',
        maxTotalMb: 10,
        rotate: { maxSizeMb: 2, keep: 2 },
      });

      const sink1 = new MemoryLogSink();
      const sink2 = new MemoryLogSink();

      dispatcher.addTestSink(sink1);
      dispatcher.addTestSink(sink2);

      const record = {
        v: 1 as const,
        ts: fakeClock.iso(),
        level: 'info',
        stream: 'runtime' as const,
        component: 'test',
        event: 'test.event',
        msg: 'hello',
        pid: 1234,
        host: 'localhost',
      };

      dispatcher.write(record);
      expect(sink1.records).toHaveLength(1);
      expect(sink2.records).toHaveLength(1);

      dispatcher.removeTestSink(sink1);
      dispatcher.write(record);
      expect(sink1.records).toHaveLength(1);
      expect(sink2.records).toHaveLength(2);

      dispatcher.flush();
      dispatcher.close();
    });

    it('forwards log records to etwProvider and ignores etw exceptions', () => {
      const logsDir = path.join(tempDir, 'dispatcher-etw-logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const emittedRecords: unknown[] = [];
      let shouldThrow = false;
      const mockEtw = {
        emitFromLogRecord(record: unknown) {
          if (shouldThrow) {
            throw new Error('ETW buffer full');
          }
          emittedRecords.push(record);
        },
      };

      const dispatcher = new StreamDispatcher(
        logsDir,
        {
          level: 'info',
          llmPayloads: 'off',
          maxTotalMb: 10,
          rotate: { maxSizeMb: 2, keep: 2 },
        },
        mockEtw,
      );

      const record = {
        v: 1 as const,
        ts: fakeClock.iso(),
        level: 'info',
        stream: 'audit' as const,
        component: 'security',
        event: 'audit.test',
        msg: 'audit message',
        pid: 1234,
        host: 'localhost',
      };

      dispatcher.write(record);
      expect(emittedRecords).toHaveLength(1);

      shouldThrow = true;
      expect(() => dispatcher.write(record)).not.toThrow();

      dispatcher.close();
    });
  });

  describe('redaction engine (Rule R4)', () => {
    it('redacts registered secret in string message, URL-encoded, base64, and JSON escaped', () => {
      registerSecret('nvidia_nim_key', 'nvapi-SecretKey1234567890abcdef');

      const plain = redactString('Call with nvapi-SecretKey1234567890abcdef succeeded');
      expect(plain).toBe('Call with [REDACTED:nvidia_nim_key] succeeded');

      const urlEncoded = redactString(`token=${encodeURIComponent('nvapi-SecretKey1234567890abcdef')}`);
      expect(urlEncoded).toBe('token=[REDACTED:nvidia_nim_key]');

      const b64 = Buffer.from('nvapi-SecretKey1234567890abcdef', 'utf-8').toString('base64');
      const b64Redacted = redactString(`auth=${b64}`);
      expect(b64Redacted).toBe('auth=[REDACTED:nvidia_nim_key]');

      // JSON-escaped secrets with special characters
      registerSecret('special_key', 'sec"ret\\key');
      const jsonEscaped = JSON.stringify('sec"ret\\key').slice(1, -1);
      expect(redactString(`payload=${jsonEscaped}`)).toBe('payload=[REDACTED:special_key]');
    });

    it('redacts common API patterns (sk-..., Bearer tokens, private keys)', () => {
      expect(redactString('Bearer eyJhbGciOiJIUzI1NiJ9.test')).toBe('Bearer [REDACTED]');
      expect(redactString('Key is sk-ant-api03-abcdefghijklmnop123456789')).toContain('[REDACTED:api-key]');
      expect(redactString('Key is nvapi-abcdefghijklmnopqrstuv123456789')).toContain('[REDACTED:nvapi-key]');
    });

    it('redacts sensitive field names in objects recursively', () => {
      const payload = {
        user: 'alice',
        password: 'SuperSecretPassword!',
        nested: {
          apiKey: 'any-key-here',
          authToken: 'token-xyz',
          normalField: 42,
        },
      };

      const redacted = redactObject(payload);
      expect(redacted.user).toBe('alice');
      expect(redacted.password).toBe('[REDACTED:password]');
      expect(redacted.nested.apiKey).toBe('[REDACTED:apiKey]');
      expect(redacted.nested.authToken).toBe('[REDACTED:authToken]');
      expect(redacted.nested.normalField).toBe(42);
    });

    it('redacts errors including stack traces and custom sensitive properties', () => {
      const err = new Error('Database connection failed with credentials');
      (err as unknown as Record<string, unknown>)['secretToken'] = 'hidden-val';
      (err as unknown as Record<string, unknown>)['safeProperty'] = 'visible-val';

      const redacted = redactObject(err) as unknown as Record<string, unknown>;
      expect(redacted['message']).toBe('Database connection failed with credentials');
      expect(redacted['secretToken']).toBe('[REDACTED:secretToken]');
      expect(redacted['safeProperty']).toBe('visible-val');
    });
  });

  describe('file rotation & disk budget', () => {
    it('writes logs to files on disk and rotates when maxSizeBytes exceeded', () => {
      const logFile = path.join(tempDir, 'test.log');
      const stream = new RotatingFileStream({
        filePath: logFile,
        maxSizeBytes: 200, // Small size for testing rotation
        keep: 3,
      });

      // Write several chunks to trigger rotation
      stream.write('chunk-1-0123456789012345678901234567890123456789012345678901234567890123456789\n');
      stream.write('chunk-2-0123456789012345678901234567890123456789012345678901234567890123456789\n');
      stream.write('chunk-3-0123456789012345678901234567890123456789012345678901234567890123456789\n');
      stream.flushSync();

      expect(fs.existsSync(logFile)).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'test.1.log'))).toBe(true);

      stream.end();
    });

    it('enforceTotalLogBudget prunes oldest non-audit log files without deleting audit logs', () => {
      // Early returns: non-existent dir and within-budget dir
      expect(() => enforceTotalLogBudget(path.join(tempDir, 'does-not-exist'), 1000)).not.toThrow();
      expect(() => enforceTotalLogBudget(tempDir, 10000000)).not.toThrow();

      const runtimeLog = path.join(tempDir, 'runtime.1.log');
      const auditLog = path.join(tempDir, 'audit.1.log');

      fs.writeFileSync(runtimeLog, 'X'.repeat(500));
      fs.writeFileSync(auditLog, 'A'.repeat(500));

      // Set max budget to 600 bytes: runtime.1.log should be pruned, audit.1.log preserved
      enforceTotalLogBudget(tempDir, 600);

      expect(fs.existsSync(auditLog)).toBe(true);
      expect(fs.existsSync(runtimeLog)).toBe(false);
    });

    it('RotatingFileStream writes buffers directly and closes cleanly', () => {
      const streamLog = path.join(tempDir, 'stream-buf.log');
      const stream = new RotatingFileStream({
        filePath: streamLog,
        maxSizeBytes: 10000,
        keep: 2,
      });

      stream.write(Buffer.from('binary-buffer-line\n'));
      stream.flushSync();

      expect(fs.existsSync(streamLog)).toBe(true);
      const text = fs.readFileSync(streamLog, 'utf-8');
      expect(text).toContain('binary-buffer-line');

      stream.end();
    });

    it('integrates with disk-backed initLogging and flushes cleanly', () => {
      initLogging({
        home: tempDir,
        clock: fakeClock,
      });

      const logger = getLogger('daemon');
      logger.info({ event: 'system.starting' }, 'starting daemon');
      flushLogs();

      const runtimePath = path.join(tempDir, 'logs', 'runtime.log');
      expect(fs.existsSync(runtimePath)).toBe(true);
      const content = fs.readFileSync(runtimePath, 'utf-8');
      expect(content).toContain('"event":"system.starting"');
      expect(content).toContain('"component":"daemon"');
    });

    it('logs errors with code, stack, retryable, durationMs, and data payload', () => {
      const sink = initTestLogging(fakeClock, { level: 'trace' });
      const logger = getLogger('test-comp');

      const customErr = new AirError('INVALID_ARGUMENT', 'Invalid param', {
        retryable: false,
      });

      logger.error(
        {
          event: 'op.failed',
          err: customErr,
          durationMs: 42,
          data: { attempt: 3 },
        },
        'operation encountered failure',
      );

      expect(sink.records).toHaveLength(1);
      const rec = sink.records[0];
      expect(rec?.level).toBe('error');
      expect(rec?.durationMs).toBe(42);
      expect(rec?.data).toEqual({ attempt: 3 });
      expect(rec?.err).toBeDefined();
      expect(rec?.err?.message).toBe('Invalid param');
      expect(rec?.err?.code).toBe('INVALID_ARGUMENT');
      expect(rec?.err?.retryable).toBe(false);
      expect(rec?.err?.stack).toBeDefined();
    });

    it('supports trace, warn, fatal methods and child logger context binding', () => {
      const sink = initTestLogging(fakeClock, { level: 'trace' });
      const baseLogger = getLogger('parent');
      const childLogger = baseLogger.child({ subSystem: 'worker-1' });

      childLogger.trace({ event: 'sub.trace' }, 'trace message');
      childLogger.warn({ event: 'sub.warn' }, 'warn message');
      childLogger.fatal({ event: 'sub.fatal' }, 'fatal message');

      expect(sink.records).toHaveLength(3);
      expect(sink.records[0]?.level).toBe('trace');
      expect(sink.records[0]?.component).toBe('parent');
      expect(sink.records[0]?.data).toEqual({ subSystem: 'worker-1' });
      expect(sink.records[1]?.level).toBe('warn');
      expect(sink.records[2]?.level).toBe('fatal');
    });

    it('supports MemoryLogSink clear and getRecords filter', () => {
      const sink = initTestLogging(fakeClock);
      const logger = getLogger('test');

      logger.info({ event: 'event.one' }, 'msg 1');
      logger.error({ event: 'event.two' }, 'msg 2');

      const errors = sink.getRecords((r) => r.level === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.event).toBe('event.two');

      const all = sink.getRecords();
      expect(all).toHaveLength(2);

      sink.clear();
      expect(sink.records).toHaveLength(0);
    });

    it('redacts circular references and array structures cleanly', () => {
      interface CircularObj {
        prop: string;
        self?: CircularObj;
      }
      const obj: CircularObj = { prop: 'test' };
      obj.self = obj;

      const redacted = redactObject(obj);
      expect(redacted.self).toBe('[Circular]');

      const arrWithSecret = ['Bearer secret_token_abc12345678901234567890'];
      const redactedArr = redactObject(arrWithSecret);
      expect(redactedArr[0]).toBe('Bearer [REDACTED]');
    });

    it('lazily initializes logger when called without explicit initLogging', () => {
      resetLogging();
      const logger = getLogger('uninitialized-component');
      expect(logger).toBeDefined();
      expect(logger.component).toBe('uninitialized-component');
    });
  });
});
