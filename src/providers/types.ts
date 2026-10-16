/**
 * Normalized provider contracts, message schemas, and stream interfaces (Phase 3 - P3-T01).
 *
 * Implements vendor-neutral LLM abstraction:
 * - Normalized request and response types with strict Zod validation.
 * - Discriminated unions for message parts (text, thinking, image, tool_call, tool_result).
 * - Streaming delta event model for real-time model interaction.
 * - Provider capabilities, stop reasons, and token/cost accounting interfaces.
 */

import { z } from 'zod';
import type { ProviderType } from '../config/index.js';
import { AirError } from '../errors/index.js';
import type { RunId, SessionId, TurnId } from '../types/index.js';

// ---------------------------------------------------------------------------
// 1. Message Roles & Parts
// ---------------------------------------------------------------------------

export const MessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
export type TextPart = z.infer<typeof TextPartSchema>;

export const ThinkingPartSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
});
export type ThinkingPart = z.infer<typeof ThinkingPartSchema>;

export const ImagePartSchema = z.object({
  type: z.literal('image'),
  mediaType: z.string().min(1),
  data: z.string().min(1), // base64 or URL
});
export type ImagePart = z.infer<typeof ImagePartSchema>;

export const ToolCallPartSchema = z.object({
  type: z.literal('tool_call'),
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.union([z.record(z.string(), z.unknown()), z.string()]),
});
export type ToolCallPart = z.infer<typeof ToolCallPartSchema>;

export const ToolResultPartSchema = z.object({
  type: z.literal('tool_result'),
  toolCallId: z.string().min(1),
  content: z.unknown(),
  isError: z.boolean().optional(),
});
export type ToolResultPart = z.infer<typeof ToolResultPartSchema>;

export const MessagePartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ThinkingPartSchema,
  ImagePartSchema,
  ToolCallPartSchema,
  ToolResultPartSchema,
]);
export type MessagePart = z.infer<typeof MessagePartSchema>;

export const NormalizedMessageSchema = z.object({
  role: MessageRoleSchema,
  content: z.union([z.string(), z.array(MessagePartSchema)]),
  name: z.string().min(1).optional(),
});
export type NormalizedMessage = z.infer<typeof NormalizedMessageSchema>;

// ---------------------------------------------------------------------------
// 2. Tool Definitions & Choices
// ---------------------------------------------------------------------------

export const ProviderToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()), // JSON Schema
});
export type ProviderToolDefinition = z.infer<typeof ProviderToolDefinitionSchema>;

export const ToolChoiceSchema = z.union([
  z.literal('auto'),
  z.literal('none'),
  z.literal('required'),
  z.object({
    type: z.literal('tool'),
    name: z.string().min(1),
  }),
]);
export type ToolChoice = z.infer<typeof ToolChoiceSchema>;

// ---------------------------------------------------------------------------
// 3. Normalized Request
// ---------------------------------------------------------------------------

export const NormalizedRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(NormalizedMessageSchema),
  system: z.union([z.string(), z.array(z.string().min(1))]).optional(),
  tools: z.array(ProviderToolDefinitionSchema).optional(),
  toolChoice: ToolChoiceSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  stopSequences: z.array(z.string().min(1)).optional(),
  thinking: z
    .object({
      budgetTokens: z.number().int().positive().optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type NormalizedRequest = z.infer<typeof NormalizedRequestSchema>;

// ---------------------------------------------------------------------------
// 4. Token Usage & Stop Reasons
// ---------------------------------------------------------------------------

export const TokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  thinkingTokens: z.number().int().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const StopReasonSchema = z.enum([
  'stop',
  'tool_calls',
  'max_tokens',
  'content_filter',
  'cancelled',
  'error',
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

// ---------------------------------------------------------------------------
// 5. Normalized Response
// ---------------------------------------------------------------------------

export const NormalizedResponseSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  message: NormalizedMessageSchema,
  stopReason: StopReasonSchema,
  usage: TokenUsageSchema,
  raw: z.unknown().optional(),
});
export type NormalizedResponse = z.infer<typeof NormalizedResponseSchema>;

// ---------------------------------------------------------------------------
// 6. Provider Stream Events
// ---------------------------------------------------------------------------

export const StreamStartEventSchema = z.object({
  type: z.literal('stream_start'),
  id: z.string().min(1),
  model: z.string().min(1),
});
export type StreamStartEvent = z.infer<typeof StreamStartEventSchema>;

export const TextDeltaEventSchema = z.object({
  type: z.literal('text_delta'),
  text: z.string(),
});
export type TextDeltaEvent = z.infer<typeof TextDeltaEventSchema>;

export const ThinkingDeltaEventSchema = z.object({
  type: z.literal('thinking_delta'),
  text: z.string(),
});
export type ThinkingDeltaEvent = z.infer<typeof ThinkingDeltaEventSchema>;

export const ToolCallStartEventSchema = z.object({
  type: z.literal('tool_call_start'),
  index: z.number().int().nonnegative(),
  id: z.string().min(1),
  name: z.string().min(1),
});
export type ToolCallStartEvent = z.infer<typeof ToolCallStartEventSchema>;

export const ToolCallDeltaEventSchema = z.object({
  type: z.literal('tool_call_delta'),
  index: z.number().int().nonnegative(),
  argumentsDelta: z.string(),
});
export type ToolCallDeltaEvent = z.infer<typeof ToolCallDeltaEventSchema>;

export const ToolCallEndEventSchema = z.object({
  type: z.literal('tool_call_end'),
  index: z.number().int().nonnegative(),
  toolCall: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.union([z.record(z.string(), z.unknown()), z.string()]),
  }),
});
export type ToolCallEndEvent = z.infer<typeof ToolCallEndEventSchema>;

export const UsageEventSchema = z.object({
  type: z.literal('usage'),
  usage: TokenUsageSchema,
});
export type UsageEvent = z.infer<typeof UsageEventSchema>;

export const StreamEndEventSchema = z.object({
  type: z.literal('stream_end'),
  stopReason: StopReasonSchema,
  usage: TokenUsageSchema.optional(),
});
export type StreamEndEvent = z.infer<typeof StreamEndEventSchema>;

export const StreamErrorEventSchema = z.object({
  type: z.literal('error'),
  error: z.instanceof(Error).or(
    z.object({
      message: z.string(),
      code: z.string().optional(),
    }),
  ),
});
export type StreamErrorEvent = z.infer<typeof StreamErrorEventSchema>;

export const ProviderStreamEventSchema = z.discriminatedUnion('type', [
  StreamStartEventSchema,
  TextDeltaEventSchema,
  ThinkingDeltaEventSchema,
  ToolCallStartEventSchema,
  ToolCallDeltaEventSchema,
  ToolCallEndEventSchema,
  UsageEventSchema,
  StreamEndEventSchema,
  StreamErrorEventSchema,
]);
export type ProviderStreamEvent = z.infer<typeof ProviderStreamEventSchema>;

// ---------------------------------------------------------------------------
// 7. Provider Capabilities & Interfaces
// ---------------------------------------------------------------------------

export const ProviderCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  toolCalling: z.boolean(),
  imageInput: z.boolean(),
  systemPrompt: z.boolean(),
  extendedThinking: z.boolean(),
  promptCaching: z.boolean(),
  maxContextWindow: z.number().int().positive().optional(),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export interface ProviderCallOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly runId?: RunId | undefined;
  readonly sessionId?: SessionId | undefined;
  readonly turnId?: TurnId | undefined;
}

/**
 * Universal Provider contract implemented by all vendor adapters.
 */
export interface Provider {
  /** Unique provider instance identifier (matches config.providers[].id) */
  readonly id: string;
  /** Provider architecture type */
  readonly type: ProviderType;
  /** Default model string */
  readonly defaultModel: string;
  /** Capability flags for feature negotiation */
  readonly capabilities: ProviderCapabilities;

  /**
   * Performs non-streaming model completion.
   */
  complete(
    request: NormalizedRequest,
    options?: ProviderCallOptions,
  ): Promise<NormalizedResponse>;

  /**
   * Initiates real-time streaming model inference yielding structured deltas.
   */
  stream(
    request: NormalizedRequest,
    options?: ProviderCallOptions,
  ): AsyncIterable<ProviderStreamEvent>;
}

// ---------------------------------------------------------------------------
// 8. Type Guards & Extraction Helpers
// ---------------------------------------------------------------------------

export function isTextPart(part: MessagePart): part is TextPart {
  return part.type === 'text';
}

export function isThinkingPart(part: MessagePart): part is ThinkingPart {
  return part.type === 'thinking';
}

export function isImagePart(part: MessagePart): part is ImagePart {
  return part.type === 'image';
}

export function isToolCallPart(part: MessagePart): part is ToolCallPart {
  return part.type === 'tool_call';
}

export function isToolResultPart(part: MessagePart): part is ToolResultPart {
  return part.type === 'tool_result';
}

/**
 * Extracts all plain text content from a NormalizedMessage.
 */
export function extractText(message: NormalizedMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content
    .filter(isTextPart)
    .map((p) => p.text)
    .join('');
}

/**
 * Extracts thinking content from a NormalizedMessage if present.
 */
export function extractThinking(message: NormalizedMessage): string {
  if (typeof message.content === 'string') {
    return '';
  }
  return message.content
    .filter(isThinkingPart)
    .map((p) => p.thinking)
    .join('\n');
}

/**
 * Extracts all tool calls invoked by the assistant in a NormalizedMessage.
 */
export function extractToolCalls(message: NormalizedMessage): ToolCallPart[] {
  if (typeof message.content === 'string') {
    return [];
  }
  return message.content.filter(isToolCallPart);
}

/**
 * Assembles an AsyncIterable stream of ProviderStreamEvents into a complete NormalizedResponse.
 */
export async function assembleStreamResponse(
  events: AsyncIterable<ProviderStreamEvent>,
): Promise<NormalizedResponse> {
  let responseId = '';
  let responseModel = '';
  let textAccumulator = '';
  let thinkingAccumulator = '';
  let stopReason: StopReason = 'stop';

  interface InFlightToolCall {
    id: string;
    name: string;
    argsBuffer: string;
    finalArguments?: Record<string, unknown> | string | undefined;
  }
  const toolCallsByIndex = new Map<number, InFlightToolCall>();

  let usage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  for await (const event of events) {
    switch (event.type) {
      case 'stream_start': {
        responseId = event.id;
        responseModel = event.model;
        break;
      }

      case 'text_delta': {
        textAccumulator += event.text;
        break;
      }

      case 'thinking_delta': {
        thinkingAccumulator += event.text;
        break;
      }

      case 'tool_call_start': {
        toolCallsByIndex.set(event.index, {
          id: event.id,
          name: event.name,
          argsBuffer: '',
        });
        break;
      }

      case 'tool_call_delta': {
        const inFlight = toolCallsByIndex.get(event.index);
        if (inFlight) {
          inFlight.argsBuffer += event.argumentsDelta;
        }
        break;
      }

      case 'tool_call_end': {
        const inFlight = toolCallsByIndex.get(event.index);
        if (inFlight) {
          inFlight.finalArguments = event.toolCall.arguments;
        } else {
          toolCallsByIndex.set(event.index, {
            id: event.toolCall.id,
            name: event.toolCall.name,
            argsBuffer: '',
            finalArguments: event.toolCall.arguments,
          });
        }
        break;
      }

      case 'usage': {
        usage = event.usage;
        break;
      }

      case 'stream_end': {
        stopReason = event.stopReason;
        if (event.usage) {
          usage = event.usage;
        }
        break;
      }

      case 'error': {
        const err = event.error;
        const msg = err instanceof Error ? err.message : err.message;
        throw new AirError('PROVIDER_ERROR', `Stream error from provider: ${msg}`, {
          cause: err instanceof Error ? err : undefined,
        });
      }
    }
  }

  // Construct message parts
  const parts: MessagePart[] = [];

  if (thinkingAccumulator.length > 0) {
    parts.push({
      type: 'thinking',
      thinking: thinkingAccumulator,
    });
  }

  if (textAccumulator.length > 0) {
    parts.push({
      type: 'text',
      text: textAccumulator,
    });
  }

  // Finalize tool calls ordered by stream index
  const sortedIndices = Array.from(toolCallsByIndex.keys()).sort((a, b) => a - b);
  for (const idx of sortedIndices) {
    const item = toolCallsByIndex.get(idx);
    if (!item) continue;

    let parsedArgs: Record<string, unknown> | string = item.finalArguments ?? item.argsBuffer;
    if (typeof parsedArgs === 'string' && parsedArgs.trim().startsWith('{')) {
      try {
        parsedArgs = JSON.parse(parsedArgs) as Record<string, unknown>;
      } catch {
        // Keep as raw string if JSON parsing fails
      }
    }

    parts.push({
      type: 'tool_call',
      id: item.id,
      name: item.name,
      arguments: parsedArgs,
    });
  }

  const message: NormalizedMessage = {
    role: 'assistant',
    content: parts.length === 1 && parts[0]?.type === 'text' ? parts[0].text : parts,
  };

  return {
    id: responseId || 'stream_res_default',
    model: responseModel || 'default',
    message,
    stopReason,
    usage,
  };
}
