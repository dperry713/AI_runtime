/**
 * Public journal API for the AIR runtime (Phase 2).
 */

export {
  type EventMeta,
  EventMetaSchema,
  type EventEnvelope,
  GenericEventEnvelopeSchema,
  createEventEnvelopeSchema,
  type CreateEnvelopeOptions,
  createEnvelope,
} from './envelope.js';

export {
  // Payload schemas
  RunCreatedPayloadSchema,
  RunStartingPayloadSchema,
  RunRunningPayloadSchema,
  RunPausedPayloadSchema,
  RunResumedPayloadSchema,
  RunWaitingApprovalPayloadSchema,
  RunWaitingUserPayloadSchema,
  RunCompletedPayloadSchema,
  RunFailedPayloadSchema,
  RunCancelledPayloadSchema,
  RunBudgetExceededPayloadSchema,
  TurnStartedPayloadSchema,
  TurnCompletedPayloadSchema,
  TurnFailedPayloadSchema,
  ModelRequestedPayloadSchema,
  ModelRespondedPayloadSchema,
  ModelFailedPayloadSchema,
  ToolRequestedPayloadSchema,
  ToolPolicyDecidedPayloadSchema,
  ToolApprovalRequestedPayloadSchema,
  ToolApprovedPayloadSchema,
  ToolDeniedPayloadSchema,
  ToolStartedPayloadSchema,
  ToolOutputPayloadSchema,
  ToolCompletedPayloadSchema,
  ToolFailedPayloadSchema,
  ToolCancelledPayloadSchema,
  ToolTimedOutPayloadSchema,
  MemoryWrittenPayloadSchema,
  MemorySearchedPayloadSchema,
  MemoryForgottenPayloadSchema,
  SystemStartedPayloadSchema,
  SystemShutdownPayloadSchema,
  SystemRecoveredPayloadSchema,
  SystemQuarantinePayloadSchema,

  // Event catalog & Discriminated union
  EVENT_SCHEMAS,
  type EventType,
  KNOWN_EVENT_TYPES,
  AirEventEnvelopeSchema,
  type AnyAirEventEnvelope,

  // Functions & Type guards
  isKnownEventType,
  parseEventEnvelope,
  safeParseEventEnvelope,
  isRunEvent,
  isTurnEvent,
  isModelEvent,
  isToolEvent,
  isMemoryEvent,
  isSystemEvent,
} from './registry.js';

export {
  computeCrc32Hex,
  formatEventLine,
  type VerifyLineResult,
  verifyLineChecksum,
  type ParseLineResult,
  parseEventLine,
  sanitizeStream,
  desanitizeStream,
  type ParsedSegmentFileName,
  parseSegmentFileName,
  formatSegmentFileName,
  type ReadSegmentEventsResult,
  readSegmentEvents,
  type SegmentAppendResult,
  type StreamInfo,
  type SegmentWriterOptions,
  SegmentWriter,
  StreamSegmentWriter,
} from './segment-writer.js';

export {
  type Migration,
  type AppliedMigration,
  type MigrationResult,
  migrationV1,
  ALL_MIGRATIONS,
  ensureMigrationsTable,
  getCurrentMigrationVersion,
  getAppliedMigrations,
  type RunMigrationsOptions,
  runMigrations,
} from './migrations.js';

export {
  type EventLocation,
  type IndexedEvent,
  type StreamRecord,
  type RunRecord,
  type SessionRecord,
  type IndexStats,
  type StreamQueryOptions,
  type RunQueryOptions,
  type SessionQueryOptions,
  type CreateSessionOptions,
  type IndexStoreOptions,
  IndexStore,
} from './index-store.js';

export {
  type DropPolicy,
  type EventFilterPredicate,
  type EventSubscriptionFilter,
  type SubscriptionOptions,
  type SubscriptionStats,
  type Subscription,
  type EventHandler,
  type EventBusOptions,
  type EventBusStats,
  matchesEventFilter,
  EventBus,
} from './event-bus.js';

