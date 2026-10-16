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
