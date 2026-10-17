/**
 * OpenAI-compatible chat completions provider adapter (Phase 3 - P3-T04).
 *
 * Implements the universal Provider interface against OpenAI and OpenAI-compatible
 * endpoints (OpenAI, NVIDIA NIM, OpenRouter, LM Studio, llama.cpp, etc.) with
 * streaming, parallel tool-call delta assembly, reasoning/thinking tokens capture,
 * prompt cache tracking, and comprehensive error mapping to typed AirError.
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

export interface OpenAIProviderOptions {
  /**
   * Unique identifier for this provider instance (e.g. 'openai', 'nvidia', 'lmstudio').
   * Defaults to 'openai'.
   */
  readonly id?: string | undefined;

  /**
   * Provider architecture type. Defaults to 'openai-compat'.
   */
  readonly type?: 'openai-compat' | 'nvidia' | undefined;

  /**
   * API key or async resolver function.
   * Optional for local servers (e.g. LM Studio, llama.cpp).
   */
  readonly apiKey?: ApiKeyResolver | undefined;

  /**
   * Base URL for the OpenAI-compatible API.
   * Defaults to 'https://api.openai.com/v1'.
   */
  readonly baseUrl?: string | undefined;

  /**
   * Optional OpenAI organization header (`OpenAI-Organization`).
   */
  readonly organization?: string | undefined;

  /**
   * Optional OpenAI project header (`OpenAI-Project`).
   */
  readonly project?: string | undefined;

  /**
   * Default model name if not specified in NormalizedRequest.
   * Defaults to 'gpt-4o'.
   */
  readonly defaultModel?: string | undefined;

  /**
   * Default max tokens if not specified in NormalizedRequest.
   */
  readonly defaultMaxTokens?: number | undefined;

  /**
   * Default timeout in milliseconds.
   */
  readonly timeoutMs?: number | undefined;

  /**
   * Optional custom fetch implementation.
   */
  readonly fetch?: typeof fetch | undefined;

  /**
   * Optional injected Clock instance (Rule R6).
   */
  readonly clock?: Clock | undefined;

  /**
   * Custom extra HTTP headers to send with all requests.
   */
  readonly extraHeaders?: Record<string, string> | undefined;

  /**
   * Custom extra parameters to merge into the request body.
   */
  readonly extraBody?: Record<string, unknown> | undefined;

  /**
   * Whether to send `max_completion_tokens` instead of `max_tokens` (e.g. for o1/o3 models).
   */
  readonly useMaxCompletionTokens?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// OpenAI Wire API Types (Non-streaming & Streaming)
// ---------------------------------------------------------------------------

interface OpenAIToolCallPayload {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

interface OpenAIMessagePayload {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | readonly unknown[] | null;
  readonly name?: string | undefined;
  readonly tool_calls?: readonly OpenAIToolCallPayload[] | undefined;
  readonly tool_call_id?: string | undefined;
}

interface OpenAIUsagePayload {
  readonly prompt_tokens?: number | undefined;
  readonly completion_tokens?: number | undefined;
  readonly total_tokens?: number | undefined;
  readonly prompt_tokens_details?: {
    readonly cached_tokens?: number | undefined;
  } | undefined;
  readonly completion_tokens_details?: {
    readonly reasoning_tokens?: number | undefined;
  } | undefined;
}

interface OpenAIChatCompletionChoice {
  readonly index: number;
  readonly message: {
    readonly role: 'assistant';
    readonly content?: string | null | undefined;
    readonly reasoning_content?: string | null | undefined;
    readonly thinking?: string | null | undefined;
    readonly tool_calls?: readonly OpenAIToolCallPayload[] | undefined;
  };
  readonly finish_reason?: string | null | undefined;
}

interface OpenAIChatCompletionResponse {
  readonly id: string;
  readonly object: string;
  readonly model: string;
  readonly choices: readonly OpenAIChatCompletionChoice[];
  readonly usage?: OpenAIUsagePayload | undefined;
}

interface OpenAIStreamChunkChoice {
  readonly index: number;
  readonly delta: {
    readonly role?: string | undefined;
    readonly content?: string | null | undefined;
    readonly reasoning_content?: string | null | undefined;
    readonly thinking?: string | null | undefined;
    readonly tool_calls?: readonly {
      readonly index: number;
      readonly id?: string | undefined;
      readonly type?: string | undefined;
      readonly function?: {
        readonly name?: string | undefined;
        readonly arguments?: string | undefined;
      } | undefined;
    }[] | undefined;
  };
  readonly finish_reason?: string | null | undefined;
}

interface OpenAIStreamChunk {
  readonly id?: string | undefined;
  readonly model?: string | undefined;
  readonly choices?: readonly OpenAIStreamChunkChoice[] | undefined;
  readonly usage?: OpenAIUsagePayload | undefined;
  readonly error?: {
    readonly message?: string | undefined;
    readonly type?: string | undefined;
    readonly code?: string | undefined;
  } | undefined;
}

export class OpenAIProvider implements Provider {
  public readonly id: string;
  public readonly type: 'openai-compat' | 'nvidia';
  public readonly defaultModel: string;
  public readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    imageInput: true,
    systemPrompt: true,
    extendedThinking: true,
    promptCaching: true,
    maxContextWindow: 128000,
  };

  private readonly apiKeyResolver?: ApiKeyResolver | undefined;
  private readonly baseUrl: string;
  private readonly organization?: string | undefined;
  private readonly project?: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly defaultMaxTokens?: number | undefined;
  private readonly timeoutMs?: number | undefined;
  private readonly clock: Clock;
  private readonly extraHeaders?: Record<string, string> | undefined;
  private readonly extraBody?: Record<string, unknown> | undefined;
  private readonly useMaxCompletionTokens: boolean;

  constructor(options: OpenAIProviderOptions = {}) {
    this.id = options.id ?? 'openai';
    this.type = options.type ?? 'openai-compat';
    this.apiKeyResolver = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.organization = options.organization;
    this.project = options.project;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.defaultModel = options.defaultModel ?? 'gpt-4o';
    this.defaultMaxTokens = options.defaultMaxTokens;
    this.timeoutMs = options.timeoutMs;
    this.clock = options.clock ?? new SystemClock();
    this.extraHeaders = options.extraHeaders;
    this.extraBody = options.extraBody;
    this.useMaxCompletionTokens = options.useMaxCompletionTokens ?? false;
  }

  /**
   * Execute a non-streaming chat completion call.
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

    const response = await this.executeFetch(this.getChatCompletionsUrl(), fetchOptions);
    const data = (await response.json()) as OpenAIChatCompletionResponse;
    return this.translateResponse(data);
  }

  /**
   * Execute a streaming chat completion call yielding normalized provider stream events.
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

    const response = await this.executeFetch(this.getChatCompletionsUrl(), fetchOptions);

    if (!response.body) {
      throw new AirError('PROVIDER_UNAVAILABLE', 'OpenAI streaming response body is null', {
        retryable: true,
      });
    }

    let hasYieldedStart = false;
    let stopReason: StopReason = 'stop';
    let finalUsage: TokenUsage | undefined;

    // Track active tool call deltas by index
    interface ActiveToolCall {
      id: string;
      name: string;
      accumulatedArgs: string;
      isStarted: boolean;
      isEnded: boolean;
    }
    const activeToolCalls = new Map<number, ActiveToolCall>();

    const sseEvents = parseSseStream(response.body, opts?.signal);

    for await (const sse of sseEvents) {
      const dataStr = sse.data.trim();
      if (!dataStr || dataStr === '[DONE]') {
        continue;
      }

      let parsedChunk: OpenAIStreamChunk;
      try {
        parsedChunk = JSON.parse(dataStr) as OpenAIStreamChunk;
      } catch {
        continue;
      }

      if (parsedChunk.error) {
        const mappedErr = mapOpenAiHttpError(400, { error: parsedChunk.error }, undefined, this.clock);
        yield {
          type: 'error',
          error: mappedErr,
        };
        throw mappedErr;
      }

      const streamId = parsedChunk.id ?? 'chatcmpl_stream';
      const streamModel = parsedChunk.model ?? req.model ?? this.defaultModel;

      if (!hasYieldedStart) {
        hasYieldedStart = true;
        yield {
          type: 'stream_start',
          id: streamId,
          model: streamModel,
        };
      }

      if (parsedChunk.usage) {
        finalUsage = translateUsage(parsedChunk.usage);
        yield {
          type: 'usage',
          usage: finalUsage,
        };
      }

      const choices = parsedChunk.choices ?? [];
      for (const choice of choices) {
        const delta = choice.delta;

        // 1. Text deltas
        if (delta.content) {
          yield {
            type: 'text_delta',
            text: delta.content,
          };
        }

        // 2. Reasoning / thinking deltas (DeepSeek-R1 / OpenAI o-series)
        const thinkingDelta = delta.reasoning_content ?? delta.thinking;
        if (thinkingDelta) {
          yield {
            type: 'thinking_delta',
            text: thinkingDelta,
          };
        }

        // 3. Tool call deltas
        if (delta.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            const idx = tcDelta.index;
            let active = activeToolCalls.get(idx);
            if (!active) {
              active = {
                id: tcDelta.id ?? `call_${idx}`,
                name: tcDelta.function?.name ?? '',
                accumulatedArgs: '',
                isStarted: false,
                isEnded: false,
              };
              activeToolCalls.set(idx, active);
            }

            if (tcDelta.id && !active.id) {
              active.id = tcDelta.id;
            }
            if (tcDelta.function?.name && !active.name) {
              active.name = tcDelta.function.name;
            }

            if (!active.isStarted && active.id && active.name) {
              active.isStarted = true;
              yield {
                type: 'tool_call_start',
                index: idx,
                id: active.id,
                name: active.name,
              };
            }

            if (tcDelta.function?.arguments) {
              active.accumulatedArgs += tcDelta.function.arguments;
              yield {
                type: 'tool_call_delta',
                index: idx,
                argumentsDelta: tcDelta.function.arguments,
              };
            }
          }
        }

        if (choice.finish_reason) {
          stopReason = mapStopReason(choice.finish_reason);
        }
      }
    }

    // Close any unended active tool calls
    for (const [idx, active] of activeToolCalls.entries()) {
      if (!active.isEnded) {
        active.isEnded = true;
        let parsedArgs: Record<string, unknown> | string = active.accumulatedArgs;
        try {
          parsedArgs = JSON.parse(active.accumulatedArgs) as Record<string, unknown>;
        } catch {
          // Keep as raw string if invalid JSON
        }
        yield {
          type: 'tool_call_end',
          index: idx,
          toolCall: {
            id: active.id,
            name: active.name,
            arguments: parsedArgs,
          },
        };
      }
    }

    if (!finalUsage) {
      finalUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
    }

    yield {
      type: 'stream_end',
      stopReason,
      usage: finalUsage,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers & Request Assembly
  // ---------------------------------------------------------------------------

  private getChatCompletionsUrl(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.extraHeaders,
    };

    if (this.apiKeyResolver) {
      const apiKey = await resolveApiKey(this.apiKeyResolver);
      if (apiKey) {
        headers['authorization'] = `Bearer ${apiKey}`;
      }
    }

    if (this.organization) {
      headers['openai-organization'] = this.organization;
    }
    if (this.project) {
      headers['openai-project'] = this.project;
    }

    return headers;
  }

  private buildRequestPayload(
    req: NormalizedRequest,
    isStream: boolean
  ): Record<string, unknown> {
    const model = req.model || this.defaultModel;
    const messages = formatOpenAIMessages(req.messages, req.system);

    const payload: Record<string, unknown> = {
      model,
      messages,
      ...this.extraBody,
    };

    if (isStream) {
      payload.stream = true;
      payload.stream_options = { include_usage: true };
    }

    const maxTokens = req.maxTokens ?? this.defaultMaxTokens;
    if (maxTokens !== undefined) {
      if (this.useMaxCompletionTokens) {
        payload.max_completion_tokens = maxTokens;
      } else {
        payload.max_tokens = maxTokens;
      }
    }

    if (req.temperature !== undefined) {
      payload.temperature = req.temperature;
    }
    if (req.topP !== undefined) {
      payload.top_p = req.topP;
    }
    if (req.stopSequences && req.stopSequences.length > 0) {
      payload.stop = req.stopSequences;
    }

    // Extended thinking / reasoning support
    if (req.thinking?.budgetTokens !== undefined && req.thinking.budgetTokens > 0) {
      const budget = req.thinking.budgetTokens;
      if (budget <= 1024) {
        payload.reasoning_effort = 'low';
      } else if (budget <= 4096) {
        payload.reasoning_effort = 'medium';
      } else {
        payload.reasoning_effort = 'high';
      }
    }

    // Tools formatting
    if (req.tools && req.tools.length > 0) {
      payload.tools = req.tools.map(formatOpenAITool);

      if (req.toolChoice) {
        if (req.toolChoice === 'auto') {
          payload.tool_choice = 'auto';
        } else if (req.toolChoice === 'required') {
          payload.tool_choice = 'required';
        } else if (req.toolChoice === 'none') {
          payload.tool_choice = 'none';
        } else if (typeof req.toolChoice === 'object' && req.toolChoice.type === 'tool') {
          payload.tool_choice = {
            type: 'function',
            function: { name: req.toolChoice.name },
          };
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
        timeoutCtrl.abort(new Error(`OpenAI request timed out after ${this.timeoutMs}ms`));
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
        throw new AirError('CANCELLED', 'OpenAI request was cancelled', {
          retryable: false,
          cause: err instanceof Error ? err : undefined,
        });
      }

      throw new AirError(
        'PROVIDER_UNAVAILABLE',
        `Network error contacting OpenAI API: ${err instanceof Error ? err.message : String(err)}`,
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

      throw mapOpenAiHttpError(response.status, body, response.headers, this.clock);
    }

    return response;
  }

  private translateResponse(data: OpenAIChatCompletionResponse): NormalizedResponse {
    const choice = data.choices[0];
    if (!choice) {
      throw new AirError('PROVIDER_ERROR', 'OpenAI response contained no choices');
    }

    const content: MessagePart[] = [];
    const msg = choice.message;

    // Reasoning / thinking part
    const reasoningText = msg.reasoning_content ?? msg.thinking;
    if (reasoningText) {
      const thinkingPart: ThinkingPart = {
        type: 'thinking',
        thinking: reasoningText,
      };
      content.push(thinkingPart);
    }

    // Text content part
    if (msg.content) {
      const textPart: TextPart = {
        type: 'text',
        text: msg.content,
      };
      content.push(textPart);
    }

    // Tool call parts
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        let parsedArgs: Record<string, unknown> | string = {};
        if (typeof tc.function.arguments === 'string') {
          try {
            parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            parsedArgs = tc.function.arguments;
          }
        }
        const toolCallPart: ToolCallPart = {
          type: 'tool_call',
          id: tc.id,
          name: tc.function.name,
          arguments: parsedArgs,
        };
        content.push(toolCallPart);
      }
    }

    const usage: TokenUsage = translateUsage(data.usage);
    const stopReason = mapStopReason(choice.finish_reason);

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
    return '';
  }

  const key = typeof apiKeyResolver === 'function' ? await apiKeyResolver() : apiKeyResolver;
  return key.trim();
}

function translateUsage(usage?: OpenAIUsagePayload): TokenUsage {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedTokens !== undefined ? { cacheReadTokens: cachedTokens } : {}),
  };
}

function mapStopReason(finishReason?: string | null): StopReason {
  switch (finishReason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export function mapOpenAiHttpError(
  status: number,
  body: unknown,
  headers?: Headers,
  clock: Clock = new SystemClock()
): AirError {
  let message = `OpenAI API error (HTTP ${status})`;
  let errorType: string | undefined;

  if (body && typeof body === 'object' && 'error' in body) {
    const errObj = (body as { error?: { message?: string; type?: string; code?: string } }).error;
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

function formatOpenAITool(tool: ProviderToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function formatOpenAIMessages(
  messages: readonly NormalizedMessage[],
  system?: string | readonly string[]
): OpenAIMessagePayload[] {
  const result: OpenAIMessagePayload[] = [];

  // Add system parameter if provided
  if (typeof system === 'string' && system.trim().length > 0) {
    result.push({ role: 'system', content: system });
  } else if (Array.isArray(system) && system.length > 0) {
    result.push({ role: 'system', content: system.join('\n\n') });
  }

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
      result.push({ role: 'system', content: text });
      continue;
    }

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
        continue;
      }

      const hasImages = msg.content.some((p) => p.type === 'image');
      if (!hasImages) {
        const text = msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
        result.push({ role: 'user', content: text });
      } else {
        const parts: unknown[] = [];
        for (const part of msg.content) {
          if (part.type === 'text') {
            parts.push({ type: 'text', text: part.text });
          } else if (part.type === 'image') {
            parts.push({
              type: 'image_url',
              image_url: {
                url: `data:${part.mediaType};base64,${part.data}`,
              },
            });
          }
        }
        result.push({ role: 'user', content: parts });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content });
        continue;
      }

      let textContent = '';
      const toolCalls: OpenAIToolCallPayload[] = [];

      for (const part of msg.content) {
        if (part.type === 'text') {
          textContent += part.text;
        } else if (part.type === 'thinking') {
          // Thinking/reasoning can be preserved in content prefix if appropriate
          if (!textContent) {
            textContent = part.thinking;
          }
        } else if (part.type === 'tool_call') {
          const argsStr =
            typeof part.arguments === 'string'
              ? part.arguments
              : JSON.stringify(part.arguments);
          toolCalls.push({
            id: part.id,
            type: 'function',
            function: {
              name: part.name,
              arguments: argsStr,
            },
          });
        }
      }

      result.push({
        role: 'assistant',
        content: textContent || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (msg.role === 'tool') {
      const parts = typeof msg.content === 'string' ? [{ type: 'tool_result' as const, toolCallId: '', content: msg.content }] : msg.content;
      for (const part of parts) {
        if (part.type === 'tool_result') {
          const contentStr =
            typeof part.content === 'string'
              ? part.content
              : JSON.stringify(part.content);
          result.push({
            role: 'tool',
            tool_call_id: part.toolCallId,
            content: contentStr,
          });
        }
      }
    }
  }

  return result;
}
