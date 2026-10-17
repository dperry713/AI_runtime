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

export {
  type MockScriptStep,
  type MockResponseInput,
  type MockCallRecord,
  type MockProviderOptions,
  MockProvider,
} from './mock.js';

export {
  type ApiKeyResolver,
  type AnthropicProviderOptions,
  AnthropicProvider,
  mapAnthropicHttpError,
  parseSseStream,
} from './anthropic.js';

export {
  type SseEvent,
} from './sse.js';

export {
  type OpenAIProviderOptions,
  OpenAIProvider,
  mapOpenAiHttpError,
} from './openai.js';

export {
  parseNdjsonStream,
} from './ndjson.js';

export {
  type OllamaProviderOptions,
  type OllamaModelDetails,
  type OllamaShowResponse,
  OllamaProvider,
  mapOllamaHttpError,
} from './ollama.js';

export {
  type CircuitState,
  type CircuitBreakerOptions,
  type RetryOptions,
  type FallbackOptions,
  type ResilienceEvent,
  type ResilienceOptions,
  CircuitBreaker,
  ResilientProvider,
  defaultIsFailure,
  defaultIsRetryable,
  defaultShouldFallback,
} from './resilience.js';

export {
  type ModelPricing,
  DEFAULT_MODEL_PRICING,
  PricingRegistry,
  type CostBreakdown,
  calculateCost,
  estimateTokens,
  type CostEstimate,
  estimateCost,
  type RunUsageRecord,
  type RunUsageSummary,
  RunUsageTracker,
} from './accounting.js';

export {
  type VcrMode,
  type VcrMatchStrategy,
  type VcrRecordedRequest,
  type VcrInteraction,
  type VcrCassette,
  type VcrProviderOptions,
  sanitizeVcrData,
  loadCassette,
  saveCassette,
  VcrProvider,
} from './vcr.js';

