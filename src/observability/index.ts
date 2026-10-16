export {
  type LogContext,
  withContext,
  currentContext,
} from './context.js';

export {
  registerSecret,
  unregisterSecret,
  clearRegisteredSecrets,
  redactString,
  redactObject,
} from './redaction.js';

export {
  type RotationOptions,
  RotatingFileStream,
  enforceTotalLogBudget,
} from './rotation.js';

export {
  type LogStreamName,
  type LogRecord,
  type LogSink,
  MemoryLogSink,
  StreamDispatcher,
} from './streams.js';

export {
  type LogFields,
  type LoggingInitOptions,
  ComponentLogger,
  getLogger,
  initLogging,
  initTestLogging,
  resetLogging,
  flushLogs,
} from './logger.js';

export {
  GENESIS_HASH,
  type AuditRecord,
  type AuditVerificationSuccess,
  type AuditVerificationFailure,
  type AuditVerificationResult,
  canonicalJson,
  computeAuditHash,
  AuditLog,
  verifyAuditChain,
} from './audit.js';

export {
  type MetricLabels,
  type HistogramSummary,
  type MetricSnapshot,
  Counter,
  Gauge,
  Histogram,
  MetricsRegistry,
  metrics,
  runsTotalCounter,
  turnsTotalCounter,
  toolCallsTotalCounter,
  policyDecisionsCounter,
  providerRequestsCounter,
  tokensTotalCounter,
  costUsdTotalCounter,
  errorsTotalCounter,
  journalEventsCounter,
  toolDurationHistogram,
  modelLatencyHistogram,
  turnDurationHistogram,
  journalAppendHistogram,
  ipcRequestHistogram,
  activeRunsGauge,
  pendingApprovalsGauge,
  eventbusQueueDepthGauge,
  rssBytesGauge,
  openHandlesGauge,
  childProcessesGauge,
  writeMetricsSnapshot,
  startPeriodicMetricsSnapshot,
  stopPeriodicMetricsSnapshot,
} from './metrics.js';
