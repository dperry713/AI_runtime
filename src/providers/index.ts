/**
 * Providers layer entry point (Phase 3).
 */

export {
  // Roles & Message parts
  MessageRoleSchema,
  type MessageRole,
  TextPartSchema,
  type TextPart,
  ThinkingPartSchema,
  type ThinkingPart,
  ImagePartSchema,
  type ImagePart,
  ToolCallPartSchema,
  type ToolCallPart,
  ToolResultPartSchema,
  type ToolResultPart,
  MessagePartSchema,
  type MessagePart,
  NormalizedMessageSchema,
  type NormalizedMessage,

  // Tool Definitions & Choices
  ProviderToolDefinitionSchema,
  type ProviderToolDefinition,
  ToolChoiceSchema,
  type ToolChoice,

  // Request & Usage
  NormalizedRequestSchema,
  type NormalizedRequest,
  TokenUsageSchema,
  type TokenUsage,
  StopReasonSchema,
  type StopReason,
  NormalizedResponseSchema,
  type NormalizedResponse,

  // Stream Events
  StreamStartEventSchema,
  type StreamStartEvent,
  TextDeltaEventSchema,
  type TextDeltaEvent,
  ThinkingDeltaEventSchema,
  type ThinkingDeltaEvent,
  ToolCallStartEventSchema,
  type ToolCallStartEvent,
  ToolCallDeltaEventSchema,
  type ToolCallDeltaEvent,
  ToolCallEndEventSchema,
  type ToolCallEndEvent,
  UsageEventSchema,
  type UsageEvent,
  StreamEndEventSchema,
  type StreamEndEvent,
  StreamErrorEventSchema,
  type StreamErrorEvent,
  ProviderStreamEventSchema,
  type ProviderStreamEvent,

  // Capabilities & Interface
  ProviderCapabilitiesSchema,
  type ProviderCapabilities,
  type ProviderCallOptions,
  type Provider,

  // Guards & Helpers
  isTextPart,
  isThinkingPart,
  isImagePart,
  isToolCallPart,
  isToolResultPart,
  extractText,
  extractThinking,
  extractToolCalls,
  assembleStreamResponse,
} from './types.js';
