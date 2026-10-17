/**
 * Anthropic Messages API provider adapter (Phase 3 - P3-T03).
 *
 * Implements the universal Provider interface against the Anthropic Messages API
 * with streaming, tool use, extended thinking token capture, prompt cache tracking,
 * and comprehensive error mapping to typed AirError.
 */

import { AirError } from '../errors/index.js';
import type { Clock } from '../util/index.js';
import { SystemClock } from '../util/index.js';
import { parseSseStream } from './sse.js';
import type {
  Provider,
  ProviderCapabilities,
  ProviderCallOptions,
  NormalizedRequest,
  NormalizedResponse,
  NormalizedMessage,
  MessagePart,
  TextPart,
  ThinkingPart,
  ToolCallPart,
  ProviderToolDefinition,
  TokenUsage,
  StopReason,
  ProviderStreamEvent,
} from './types.js';

export type ApiKeyResolver = string | (() => Promise<string> | string);

export interface AnthropicProviderOptions {
  /**
   * Anthropic API key or async resolver function.
   */
  readonly apiKey?: ApiKeyResolver | undefined;

  /**
   * Base URL for the Anthropic API. Defaults to 'https://api.anthropic.com'.
   */
  readonly baseUrl?: string | undefined;

  /**
   * Anthropic API version. Defaults to '2023-06-01'.
   */
  readonly apiVersion?: string | undefined;

  /**
   * Optional custom beta headers (e.g. 'output-128k-2025-02-19').
   */
  readonly betas?: readonly string[] | undefined;

  /**
   * Custom fetch implementation for testing or proxy routing.
   */
  readonly fetch?: typeof fetch | undefined;

  /**
   * Default model name if not specified in NormalizedRequest.
   */
  readonly defaultModel?: string | undefined;

  /**
   * Default max tokens if not specified in NormalizedRequest. Defaults to 4096.
   */
  readonly defaultMaxTokens?: number | undefined;

  /**
   * Default timeout in milliseconds.
   */
  readonly timeoutMs?: number | undefined;

  /**
   * Optional injected Clock instance (Rule R6).
   */
  readonly clock?: Clock | undefined;
}

interface AnthropicTextContentBlock {
  readonly type: 'text';
  readonly text: string;
}

interface AnthropicThinkingContentBlock {
  readonly type: 'thinking';
  readonly thinking: string;
  readonly signature?: string | undefined;
}

interface AnthropicImageContentBlock {
  readonly type: 'image';
  readonly source: {
    readonly type: 'base64';
    readonly media_type: string;
    readonly data: string;
  };
}

interface AnthropicToolUseContentBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

interface AnthropicToolResultContentBlock {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string | readonly (AnthropicTextContentBlock | AnthropicImageContentBlock)[];
  readonly is_error?: boolean | undefined;
}

type AnthropicContentBlock =
  | AnthropicTextContentBlock
  | AnthropicThinkingContentBlock
  | AnthropicImageContentBlock
  | AnthropicToolUseContentBlock
  | AnthropicToolResultContentBlock;

interface AnthropicMessagePayload {
  readonly role: 'user' | 'assistant';
  readonly content: AnthropicContentBlock[];
}

interface AnthropicUsagePayload {
  readonly input_tokens?: number | undefined;
  readonly output_tokens?: number | undefined;
  readonly cache_creation_input_tokens?: number | undefined;
  readonly cache_read_input_tokens?: number | undefined;
}

interface AnthropicResponseMessage {
  readonly id: string;
  readonly type: 'message';
  readonly role: 'assistant';
  readonly model: string;
  readonly content: readonly AnthropicContentBlock[];
  readonly stop_reason?: string | null | undefined;
  readonly stop_sequence?: string | null | undefined;
  readonly usage?: AnthropicUsagePayload | undefined;
}

interface AnthropicStreamContentBlockStart {
  readonly type: 'content_block_start';
  readonly index: number;
  readonly content_block: {
    readonly type: string;
    readonly text?: string | undefined;
    readonly thinking?: string | undefined;
    readonly id?: string | undefined;
    readonly name?: string | undefined;
    readonly input?: unknown;
  };
}

interface AnthropicStreamContentBlockDelta {
  readonly type: 'content_block_delta';
  readonly index: number;
  readonly delta: {
    readonly type: string;
    readonly text?: string | undefined;
    readonly thinking?: string | undefined;
    readonly partial_json?: string | undefined;
  };
}

interface AnthropicStreamContentBlockStop {
  readonly type: 'content_block_stop';
  readonly index: number;
}

interface AnthropicStreamMessageDelta {
  readonly type: 'message_delta';
  readonly delta?: {
    readonly stop_reason?: string | null | undefined;
    readonly stop_sequence?: string | null | undefined;
  } | undefined;
  readonly usage?: {
    readonly output_tokens?: number | undefined;
  } | undefined;
}

interface AnthropicStreamMessageStart {
  readonly type: 'message_start';
  readonly message: {
    readonly id: string;
    readonly model: string;
    readonly usage?: AnthropicUsagePayload | undefined;
  };
}

interface AnthropicStreamError {
  readonly type: 'error';
  readonly error?: {
    readonly type?: string | undefined;
    readonly message?: string | undefined;
  } | undefined;
}

export class AnthropicProvider implements Provider {
  public readonly id = 'anthropic';
  public readonly type = 'anthropic' as const;
  public readonly defaultModel: string;
  public readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    imageInput: true,
    systemPrompt: true,
    extendedThinking: true,
    promptCaching: true,
    maxContextWindow: 200000,
  };

  private readonly apiKeyResolver?: ApiKeyResolver | undefined;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly betas?: readonly string[] | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly defaultMaxTokens: number;
  private readonly timeoutMs?: number | undefined;
  private readonly clock: Clock;

  constructor(options: AnthropicProviderOptions = {}) {
    this.apiKeyResolver = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    this.apiVersion = options.apiVersion ?? '2023-06-01';
    this.betas = options.betas;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.defaultModel = options.defaultModel ?? 'claude-3-5-sonnet-20241022';
    this.defaultMaxTokens = options.defaultMaxTokens ?? 4096;
    this.timeoutMs = options.timeoutMs;
    this.clock = options.clock ?? new SystemClock();
  }

  /**
   * Execute a non-streaming completion call.
   */
  async complete(
    req: NormalizedRequest,
    opts?: ProviderCallOptions
  ): Promise<NormalizedResponse> {
    const payload = this.buildRequestPayload(req, false);
    const headers = await this.buildHeaders();

    const fetchOptions: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    };
    if (opts?.signal) {
      fetchOptions.signal = opts.signal;
    }

    const response = await this.executeFetch(this.getMessagesUrl(), fetchOptions);

    const data = (await response.json()) as AnthropicResponseMessage;
    return this.translateResponse(data);
  }

  /**
   * Execute a streaming call yielding normalized provider stream events.
   */
  async *stream(
    req: NormalizedRequest,
    opts?: ProviderCallOptions
  ): AsyncIterable<ProviderStreamEvent> {
    const payload = this.buildRequestPayload(req, true);
    const headers = await this.buildHeaders();

    const fetchOptions: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    };
    if (opts?.signal) {
      fetchOptions.signal = opts.signal;
    }

    const response = await this.executeFetch(this.getMessagesUrl(), fetchOptions);

    if (!response.body) {
      throw new AirError('PROVIDER_UNAVAILABLE', 'Anthropic streaming response body is null', {
        retryable: true,
      });
    }

    let promptTokens = 0;
    let completionTokens = 0;
    let cacheReadTokens: number | undefined;
    let cacheWriteTokens: number | undefined;
    let stopReason: StopReason = 'stop';

    // Track active content blocks during streaming
    interface ActiveBlock {
      type: 'text' | 'thinking' | 'tool_use';
      toolCallId?: string | undefined;
      toolName?: string | undefined;
      accumulatedJson: string;
      toolCallIndex: number;
    }
    const activeBlocks = new Map<number, ActiveBlock>();
    let nextToolCallIndex = 0;

    const sseEvents = parseSseStream(response.body, opts?.signal);

    for await (const sse of sseEvents) {
      if (sse.event === 'ping') {
        continue;
      }

      let parsedData: unknown;
      try {
        parsedData = JSON.parse(sse.data);
      } catch {
        continue;
      }

      if (!parsedData || typeof parsedData !== 'object') {
        continue;
      }

      const eventType = sse.event || (parsedData as { type?: string }).type;

      if (eventType === 'error') {
        const errPayload = parsedData as AnthropicStreamError;
        const mappedErr = mapAnthropicHttpError(400, errPayload, undefined, this.clock);
        yield {
          type: 'error',
          error: mappedErr,
        };
        throw mappedErr;
      }

      if (eventType === 'message_start') {
        const msgStart = parsedData as AnthropicStreamMessageStart;
        const messageId = msgStart.message.id;
        const responseModel = msgStart.message.model;
        if (msgStart.message.usage) {
          promptTokens = msgStart.message.usage.input_tokens ?? 0;
          cacheReadTokens = msgStart.message.usage.cache_read_input_tokens;
          cacheWriteTokens = msgStart.message.usage.cache_creation_input_tokens;
        }

        yield {
          type: 'stream_start',
          id: messageId,
          model: responseModel,
        };

        const usageObj: TokenUsage = {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
          ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
        };

        yield {
          type: 'usage',
          usage: usageObj,
        };
      } else if (eventType === 'content_block_start') {
        const blockStart = parsedData as AnthropicStreamContentBlockStart;
        const block = blockStart.content_block;
        const idx = blockStart.index;

        if (block.type === 'tool_use') {
          const toolCallId = block.id ?? `toolu_${idx}`;
          const toolName = block.name ?? '';
          const toolCallIndex = nextToolCallIndex++;
          activeBlocks.set(idx, {
            type: 'tool_use',
            toolCallId,
            toolName,
            accumulatedJson: '',
            toolCallIndex,
          });
          yield {
            type: 'tool_call_start',
            index: toolCallIndex,
            id: toolCallId,
            name: toolName,
          };
        } else if (block.type === 'thinking') {
          activeBlocks.set(idx, {
            type: 'thinking',
            accumulatedJson: '',
            toolCallIndex: 0,
          });
        } else {
          activeBlocks.set(idx, {
            type: 'text',
            accumulatedJson: '',
            toolCallIndex: 0,
          });
        }
      } else if (eventType === 'content_block_delta') {
        const blockDelta = parsedData as AnthropicStreamContentBlockDelta;
        const idx = blockDelta.index;
        const delta = blockDelta.delta;

        if (delta.type === 'text_delta' && delta.text) {
          yield {
            type: 'text_delta',
            text: delta.text,
          };
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          yield {
            type: 'thinking_delta',
            text: delta.thinking,
          };
        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
          const active = activeBlocks.get(idx);
          if (active && active.type === 'tool_use' && active.toolCallId) {
            active.accumulatedJson += delta.partial_json;
            yield {
              type: 'tool_call_delta',
              index: active.toolCallIndex,
              argumentsDelta: delta.partial_json,
            };
          }
        }
      } else if (eventType === 'content_block_stop') {
        const blockStop = parsedData as AnthropicStreamContentBlockStop;
        const idx = blockStop.index;
        const active = activeBlocks.get(idx);
        if (active && active.type === 'tool_use' && active.toolCallId && active.toolName) {
          let parsedArgs: Record<string, unknown> | string = active.accumulatedJson;
          try {
            parsedArgs = JSON.parse(active.accumulatedJson) as Record<string, unknown>;
          } catch {
            // Keep as string
          }
          yield {
            type: 'tool_call_end',
            index: active.toolCallIndex,
            toolCall: {
              id: active.toolCallId,
              name: active.toolName,
              arguments: parsedArgs,
            },
          };
        }
        activeBlocks.delete(idx);
      } else if (eventType === 'message_delta') {
        const msgDelta = parsedData as AnthropicStreamMessageDelta;
        if (msgDelta.delta?.stop_reason) {
          stopReason = mapStopReason(msgDelta.delta.stop_reason);
        }
        if (msgDelta.usage?.output_tokens !== undefined) {
          completionTokens = msgDelta.usage.output_tokens;
        }
      } else if (eventType === 'message_stop') {
        const usageObj: TokenUsage = {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
          ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
        };

        yield {
          type: 'usage',
          usage: usageObj,
        };

        yield {
          type: 'stream_end',
          stopReason,
          usage: usageObj,
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers & Request Assembly
  // ---------------------------------------------------------------------------

  private getMessagesUrl(): string {
    return `${this.baseUrl}/v1/messages`;
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const apiKey = await resolveApiKey(this.apiKeyResolver);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': this.apiVersion,
    };

    if (this.betas && this.betas.length > 0) {
      headers['anthropic-beta'] = this.betas.join(',');
    }

    return headers;
  }

  private buildRequestPayload(
    req: NormalizedRequest,
    isStream: boolean
  ): Record<string, unknown> {
    const model = req.model || this.defaultModel;
    let maxTokens = req.maxTokens ?? this.defaultMaxTokens;

    // Separate system messages/system parameter from conversational turns
    const systemParts: string[] = [];

    if (typeof req.system === 'string') {
      systemParts.push(req.system);
    } else if (Array.isArray(req.system)) {
      systemParts.push(...req.system);
    }

    const nonSystemMessages: NormalizedMessage[] = [];

    for (const msg of req.messages) {
      if (msg.role === 'system') {
        if (typeof msg.content === 'string') {
          systemParts.push(msg.content);
        } else {
          for (const part of msg.content) {
            if (part.type === 'text') {
              systemParts.push(part.text);
            }
          }
        }
      } else {
        nonSystemMessages.push(msg);
      }
    }

    if (nonSystemMessages.length === 0) {
      throw new AirError(
        'INVALID_ARGUMENT',
        'Anthropic requires at least one conversational user or assistant message'
      );
    }

    // Convert messages and merge consecutive roles to adhere to Anthropic's strict alternation
    const formattedMessages = formatAnthropicMessages(nonSystemMessages);

    const payload: Record<string, unknown> = {
      model,
      messages: formattedMessages,
      max_tokens: maxTokens,
      stream: isStream,
    };

    if (systemParts.length > 0) {
      payload.system = systemParts.join('\n\n');
    }

    // Extended thinking configuration
    const thinkingBudget = req.thinking?.budgetTokens;
    if (thinkingBudget && thinkingBudget > 0) {
      payload.thinking = {
        type: 'enabled',
        budget_tokens: thinkingBudget,
      };

      // Anthropic requires max_tokens > budget_tokens
      if (maxTokens <= thinkingBudget) {
        maxTokens = thinkingBudget + 1024;
        payload.max_tokens = maxTokens;
      }
      // Temperature must be 1.0 or omitted when thinking is enabled
    } else {
      if (req.temperature !== undefined) {
        payload.temperature = req.temperature;
      }
      if (req.topP !== undefined) {
        payload.top_p = req.topP;
      }
    }

    if (req.stopSequences && req.stopSequences.length > 0) {
      payload.stop_sequences = req.stopSequences;
    }

    // Tools formatting
    if (req.tools && req.tools.length > 0) {
      payload.tools = req.tools.map(formatAnthropicTool);

      if (req.toolChoice) {
        if (req.toolChoice === 'auto') {
          payload.tool_choice = { type: 'auto' };
        } else if (req.toolChoice === 'required') {
          payload.tool_choice = { type: 'any' };
        } else if (typeof req.toolChoice === 'object' && req.toolChoice.type === 'tool') {
          payload.tool_choice = { type: 'tool', name: req.toolChoice.name };
        }
      }
    }

    return payload;
  }

  private async executeFetch(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    const signals: AbortSignal[] = [];
    if (init.signal) {
      signals.push(init.signal);
    }

    let timeoutTimer: NodeJS.Timeout | undefined;
    if (this.timeoutMs && this.timeoutMs > 0) {
      const timeoutCtrl = new AbortController();
      timeoutTimer = setTimeout(() => {
        timeoutCtrl.abort(new Error(`Anthropic request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      signals.push(timeoutCtrl.signal);
    }

    const combinedSignal =
      signals.length === 1
        ? signals[0]
        : signals.length > 1
          ? AbortSignal.any(signals)
          : undefined;

    const fetchInit: RequestInit = {
      ...init,
      ...(combinedSignal !== undefined ? { signal: combinedSignal } : {}),
    };

    let response: Response;
    try {
      response = await this.fetchFn(url, fetchInit);
    } catch (err: unknown) {
      if (
        (combinedSignal && combinedSignal.aborted) ||
        (err instanceof Error && err.name === 'AbortError')
      ) {
        throw new AirError('CANCELLED', 'Anthropic request was cancelled', {
          retryable: false,
          cause: err instanceof Error ? err : undefined,
        });
      }

      throw new AirError(
        'PROVIDER_UNAVAILABLE',
        `Network error contacting Anthropic API: ${err instanceof Error ? err.message : String(err)}`,
        {
          retryable: true,
          cause: err instanceof Error ? err : undefined,
        }
      );
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
    }

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => null);
      }

      throw mapAnthropicHttpError(response.status, body, response.headers, this.clock);
    }

    return response;
  }

  private translateResponse(data: AnthropicResponseMessage): NormalizedResponse {
    const content: MessagePart[] = [];

    for (const block of data.content) {
      if (block.type === 'text') {
        const textPart: TextPart = {
          type: 'text',
          text: block.text,
        };
        content.push(textPart);
      } else if (block.type === 'thinking') {
        const thinkingPart: ThinkingPart = {
          type: 'thinking',
          thinking: block.thinking,
          ...(block.signature !== undefined ? { signature: block.signature } : {}),
        };
        content.push(thinkingPart);
      } else if (block.type === 'tool_use') {
        let parsedArgs: Record<string, unknown> | string = {};
        if (typeof block.input === 'string') {
          try {
            parsedArgs = JSON.parse(block.input) as Record<string, unknown>;
          } catch {
            parsedArgs = block.input;
          }
        } else if (block.input && typeof block.input === 'object') {
          parsedArgs = block.input as Record<string, unknown>;
        }
        const toolCallPart: ToolCallPart = {
          type: 'tool_call',
          id: block.id,
          name: block.name,
          arguments: parsedArgs,
        };
        content.push(toolCallPart);
      }
    }

    const promptTokens = data.usage?.input_tokens ?? 0;
    const completionTokens = data.usage?.output_tokens ?? 0;
    const totalTokens = promptTokens + completionTokens;

    const usage: TokenUsage = {
      promptTokens,
      completionTokens,
      totalTokens,
      ...(data.usage?.cache_read_input_tokens !== undefined
        ? { cacheReadTokens: data.usage.cache_read_input_tokens }
        : {}),
      ...(data.usage?.cache_creation_input_tokens !== undefined
        ? { cacheWriteTokens: data.usage.cache_creation_input_tokens }
        : {}),
    };

    const stopReason = mapStopReason(data.stop_reason);

    return {
      id: data.id,
      model: data.model,
      message: {
        role: 'assistant',
        content,
      },
      stopReason,
      usage,
    };
  }
}

// ---------------------------------------------------------------------------
// Standalone Converters & Parsers
// ---------------------------------------------------------------------------

async function resolveApiKey(apiKeyResolver?: ApiKeyResolver): Promise<string> {
  if (!apiKeyResolver) {
    throw new AirError(
      'PROVIDER_AUTH_FAILED',
      'Anthropic API key is required but was not provided',
      { retryable: false }
    );
  }

  const key = typeof apiKeyResolver === 'function' ? await apiKeyResolver() : apiKeyResolver;
  const trimmed = key.trim();
  if (!trimmed) {
    throw new AirError('PROVIDER_AUTH_FAILED', 'Anthropic API key is empty', {
      retryable: false,
    });
  }

  return trimmed;
}

function mapStopReason(stopReason?: string | null): StopReason {
  switch (stopReason) {
    case 'end_turn':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop';
    default:
      return 'stop';
  }
}

export function mapAnthropicHttpError(
  status: number,
  body: unknown,
  headers?: Headers,
  clock: Clock = new SystemClock()
): AirError {
  let message = `Anthropic API error (HTTP ${status})`;
  let errorType: string | undefined;

  if (body && typeof body === 'object' && 'error' in body) {
    const errObj = (body as { error?: { message?: string; type?: string } }).error;
    if (errObj?.message) {
      message = errObj.message;
    }
    if (errObj?.type) {
      errorType = errObj.type;
    }
  } else if (typeof body === 'string' && body.trim().length > 0) {
    message = body;
  }

  let retryAfterMs: number | undefined;
  const retryHeader = headers?.get('retry-after');
  if (retryHeader) {
    const parsedSeconds = parseInt(retryHeader, 10);
    if (!Number.isNaN(parsedSeconds)) {
      retryAfterMs = parsedSeconds * 1000;
    } else {
      const parsedDate = Date.parse(retryHeader);
      if (!Number.isNaN(parsedDate)) {
        retryAfterMs = Math.max(0, parsedDate - clock.now().getTime());
      }
    }
  }

  const context: Record<string, unknown> = {
    status,
    ...(errorType !== undefined ? { errorType } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };

  switch (status) {
    case 400:
      return new AirError('PROVIDER_INVALID_REQUEST', message, {
        retryable: false,
        context,
      });
    case 401:
      return new AirError('PROVIDER_AUTH_FAILED', message, {
        retryable: false,
        context,
      });
    case 403:
      return new AirError('PERMISSION_DENIED', message, {
        retryable: false,
        context,
      });
    case 404:
      return new AirError('NOT_FOUND', message, {
        retryable: false,
        context,
      });
    case 429:
      return new AirError('PROVIDER_RATE_LIMITED', message, {
        retryable: true,
        context,
      });
    case 529:
      return new AirError(
        'PROVIDER_UNAVAILABLE',
        message || 'Anthropic API is overloaded',
        { retryable: true, context }
      );
    case 500:
    case 502:
    case 503:
    case 504:
      return new AirError('PROVIDER_UNAVAILABLE', message, {
        retryable: true,
        context,
      });
    default:
      return new AirError(
        status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR',
        message,
        {
          retryable: status >= 500,
          context,
        }
      );
  }
}

function formatAnthropicTool(tool: ProviderToolDefinition): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
  return result;
}

function formatAnthropicMessages(messages: readonly NormalizedMessage[]): AnthropicMessagePayload[] {
  const result: AnthropicMessagePayload[] = [];

  for (const msg of messages) {
    // In Anthropic API, role 'tool' maps to 'user' containing 'tool_result' content blocks
    const role: 'user' | 'assistant' = msg.role === 'assistant' ? 'assistant' : 'user';
    const blocks: AnthropicContentBlock[] = [];

    const contentParts: readonly (string | MessagePart)[] =
      typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : msg.content;

    for (const part of contentParts) {
      if (typeof part === 'string') {
        blocks.push({
          type: 'text',
          text: part,
        });
        continue;
      }

      if (part.type === 'text') {
        blocks.push({
          type: 'text',
          text: part.text,
        });
      } else if (part.type === 'thinking') {
        const thinkingBlock: AnthropicThinkingContentBlock = {
          type: 'thinking',
          thinking: part.thinking,
          ...(part.signature !== undefined ? { signature: part.signature } : {}),
        };
        blocks.push(thinkingBlock);
      } else if (part.type === 'image') {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.mediaType,
            data: part.data,
          },
        });
      } else if (part.type === 'tool_call') {
        let parsedArgs: unknown = part.arguments;
        if (typeof part.arguments === 'string') {
          try {
            parsedArgs = JSON.parse(part.arguments);
          } catch {
            parsedArgs = { raw: part.arguments };
          }
        }
        blocks.push({
          type: 'tool_use',
          id: part.id,
          name: part.name,
          input: parsedArgs ?? {},
        });
      } else if (part.type === 'tool_result') {
        const contentVal =
          typeof part.content === 'string'
            ? part.content
            : JSON.stringify(part.content);

        const resultBlock: AnthropicToolResultContentBlock = {
          type: 'tool_result',
          tool_use_id: part.toolCallId,
          content: contentVal,
          ...(part.isError !== undefined ? { is_error: part.isError } : {}),
        };
        blocks.push(resultBlock);
      }
    }

    if (blocks.length === 0) {
      continue;
    }

    // Merge adjacent messages of the same role
    const lastMsg = result[result.length - 1];
    if (lastMsg && lastMsg.role === role) {
      lastMsg.content.push(...blocks);
    } else {
      result.push({
        role,
        content: blocks,
      });
    }
  }

  return result;
}

export { parseSseStream, type SseEvent } from './sse.js';

