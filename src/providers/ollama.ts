/**
 * Ollama native API provider adapter (Phase 3 - P3-T05).
 *
 * Implements the universal Provider interface against Ollama's native HTTP API
 * (/api/chat, /api/tags, /api/show) with streaming NDJSON, tool use, image inputs,
 * thinking token extraction, tool capability detection, and error mapping to typed AirError.
 */

import { AirError } from '../errors/index.js';
import type { Clock } from '../util/index.js';
import { SystemClock } from '../util/index.js';
import { parseNdjsonStream } from './ndjson.js';
import type {
  Provider,
  ProviderCapabilities,
  ProviderCallOptions,
  NormalizedRequest,
  NormalizedResponse,
  NormalizedMessage,
  MessagePart,
  ToolCallPart,
  ProviderToolDefinition,
  TokenUsage,
  StopReason,
  ProviderStreamEvent,
} from './types.js';

export interface OllamaProviderOptions {
  /**
   * Unique identifier for this provider instance. Defaults to 'ollama'.
   */
  readonly id?: string | undefined;

  /**
   * Base URL of the Ollama server.
   * Defaults to 'http://localhost:11434'.
   */
  readonly baseUrl?: string | undefined;

  /**
   * Default model name if not specified in NormalizedRequest.
   * Defaults to 'llama3.1'.
   */
  readonly defaultModel?: string | undefined;

  /**
   * Default max tokens (`num_predict`) if not specified in NormalizedRequest.
   */
  readonly defaultMaxTokens?: number | undefined;

  /**
   * Default timeout in milliseconds.
   */
  readonly timeoutMs?: number | undefined;

  /**
   * Custom fetch implementation.
   */
  readonly fetch?: typeof fetch | undefined;

  /**
   * Injected Clock instance (Rule R6).
   */
  readonly clock?: Clock | undefined;

  /**
   * Extra HTTP headers sent with every request.
   */
  readonly extraHeaders?: Record<string, string> | undefined;

  /**
   * Extra options passed directly into Ollama's `options` payload (e.g. `num_ctx`, `temperature`).
   */
  readonly extraOptions?: Record<string, unknown> | undefined;
}

export interface OllamaModelDetails {
  readonly name: string;
  readonly model: string;
  readonly modifiedAt?: string | undefined;
  readonly size?: number | undefined;
  readonly digest?: string | undefined;
  readonly details?: {
    readonly format?: string | undefined;
    readonly family?: string | undefined;
    readonly families?: readonly string[] | undefined;
    readonly parameterSize?: string | undefined;
    readonly quantizationLevel?: string | undefined;
  } | undefined;
}

export interface OllamaShowResponse {
  readonly modelfile?: string | undefined;
  readonly parameters?: string | undefined;
  readonly template?: string | undefined;
  readonly system?: string | undefined;
  readonly details?: Record<string, unknown> | undefined;
  readonly capabilities?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// Ollama Wire Types
// ---------------------------------------------------------------------------

interface OllamaToolCallPayload {
  readonly function: {
    readonly name: string;
    readonly arguments: Record<string, unknown> | string;
  };
}

interface OllamaMessagePayload {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly images?: readonly string[] | undefined;
  readonly tool_calls?: readonly OllamaToolCallPayload[] | undefined;
}

interface OllamaChatResponseWire {
  readonly model: string;
  readonly created_at?: string | undefined;
  readonly message?: {
    readonly role: 'assistant';
    readonly content?: string | undefined;
    readonly thinking?: string | undefined;
    readonly tool_calls?: readonly OllamaToolCallPayload[] | undefined;
  } | undefined;
  readonly done: boolean;
  readonly done_reason?: string | undefined;
  readonly prompt_eval_count?: number | undefined;
  readonly eval_count?: number | undefined;
  readonly total_duration?: number | undefined;
  readonly error?: string | undefined;
}

export class OllamaProvider implements Provider {
  public readonly id: string;
  public readonly type = 'ollama' as const;
  public readonly defaultModel: string;
  public readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    imageInput: true,
    systemPrompt: true,
    extendedThinking: true,
    promptCaching: false,
    maxContextWindow: 128000,
  };

  private readonly baseUrl: string;
  private readonly defaultMaxTokens?: number | undefined;
  private readonly timeoutMs?: number | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly clock: Clock;
  private readonly extraHeaders?: Record<string, string> | undefined;
  private readonly extraOptions?: Record<string, unknown> | undefined;

  constructor(options: OllamaProviderOptions = {}) {
    this.id = options.id ?? 'ollama';
    this.baseUrl = (options.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.defaultModel = options.defaultModel ?? 'llama3.1';
    this.defaultMaxTokens = options.defaultMaxTokens;
    this.timeoutMs = options.timeoutMs;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? new SystemClock();
    this.extraHeaders = options.extraHeaders;
    this.extraOptions = options.extraOptions;
  }

  /**
   * Execute non-streaming completion via Ollama `/api/chat`.
   */
  async complete(
    req: NormalizedRequest,
    opts?: ProviderCallOptions
  ): Promise<NormalizedResponse> {
    const payload = this.buildRequestPayload(req, false);
    const headers = this.buildHeaders();

    const fetchOptions: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    };
    if (opts?.signal) {
      fetchOptions.signal = opts.signal;
    }

    const response = await this.executeFetch(this.getChatUrl(), fetchOptions);
    const data = (await response.json()) as OllamaChatResponseWire;
    return this.translateResponse(data, req.model || this.defaultModel);
  }

  /**
   * Execute streaming completion via Ollama `/api/chat` yielding normalized stream events.
   */
  async *stream(
    req: NormalizedRequest,
    opts?: ProviderCallOptions
  ): AsyncIterable<ProviderStreamEvent> {
    const model = req.model || this.defaultModel;
    const payload = this.buildRequestPayload(req, true);
    const headers = this.buildHeaders();

    const fetchOptions: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    };
    if (opts?.signal) {
      fetchOptions.signal = opts.signal;
    }

    const response = await this.executeFetch(this.getChatUrl(), fetchOptions);

    if (!response.body) {
      throw new AirError('PROVIDER_UNAVAILABLE', 'Ollama streaming response body is null', {
        retryable: true,
      });
    }

    let hasYieldedStart = false;
    let promptTokens = 0;
    let completionTokens = 0;
    let hadToolCalls = false;
    let nextToolCallIndex = 0;

    // Stream thinking state machine: handles <think>...</think> blocks in streaming content
    let inThinkTag = false;

    const chunks = parseNdjsonStream<OllamaChatResponseWire>(response.body, opts?.signal);

    for await (const chunk of chunks) {
      if (chunk.error) {
        const mappedErr = mapOllamaHttpError(400, { error: chunk.error }, undefined, this.clock);
        yield {
          type: 'error',
          error: mappedErr,
        };
        throw mappedErr;
      }

      if (!hasYieldedStart) {
        hasYieldedStart = true;
        yield {
          type: 'stream_start',
          id: `ollama_${this.clock.now().getTime()}`,
          model: chunk.model || model,
        };
      }

      const msg = chunk.message;
      if (msg) {
        // Direct thinking field (if supported by backend)
        if (msg.thinking) {
          yield {
            type: 'thinking_delta',
            text: msg.thinking,
          };
        }

        // Text content & thinking tag parsing
        if (msg.content) {
          let textToProcess = msg.content;

          while (textToProcess.length > 0) {
            if (!inThinkTag) {
              const startIdx = textToProcess.indexOf('<think>');
              if (startIdx !== -1) {
                if (startIdx > 0) {
                  yield {
                    type: 'text_delta',
                    text: textToProcess.slice(0, startIdx),
                  };
                }
                inThinkTag = true;
                textToProcess = textToProcess.slice(startIdx + 7);
              } else {
                yield {
                  type: 'text_delta',
                  text: textToProcess,
                };
                textToProcess = '';
              }
            } else {
              const endIdx = textToProcess.indexOf('</think>');
              if (endIdx !== -1) {
                if (endIdx > 0) {
                  yield {
                    type: 'thinking_delta',
                    text: textToProcess.slice(0, endIdx),
                  };
                }
                inThinkTag = false;
                textToProcess = textToProcess.slice(endIdx + 8);
              } else {
                yield {
                  type: 'thinking_delta',
                  text: textToProcess,
                };
                textToProcess = '';
              }
            }
          }
        }

        // Tool calls in stream chunk
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          hadToolCalls = true;
          for (const tc of msg.tool_calls) {
            const toolCallIndex = nextToolCallIndex++;
            const toolCallId = `call_${toolCallIndex}`;
            const toolName = tc.function.name;
            const argsObj = typeof tc.function.arguments === 'string'
              ? tryParseJson(tc.function.arguments)
              : tc.function.arguments;

            yield {
              type: 'tool_call_start',
              index: toolCallIndex,
              id: toolCallId,
              name: toolName,
            };

            yield {
              type: 'tool_call_delta',
              index: toolCallIndex,
              argumentsDelta: JSON.stringify(argsObj),
            };

            yield {
              type: 'tool_call_end',
              index: toolCallIndex,
              toolCall: {
                id: toolCallId,
                name: toolName,
                arguments: argsObj,
              },
            };
          }
        }
      }

      if (chunk.prompt_eval_count !== undefined) {
        promptTokens = chunk.prompt_eval_count;
      }
      if (chunk.eval_count !== undefined) {
        completionTokens = chunk.eval_count;
      }

      if (chunk.done) {
        let stopReason: StopReason = 'stop';
        if (chunk.done_reason === 'length') {
          stopReason = 'max_tokens';
        } else if (hadToolCalls) {
          stopReason = 'tool_calls';
        }

        const usageObj: TokenUsage = {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
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

  /**
   * List installed models on the Ollama instance via `/api/tags`.
   */
  async listModels(opts?: ProviderCallOptions): Promise<readonly OllamaModelDetails[]> {
    const headers = this.buildHeaders();
    const fetchOptions: RequestInit = {
      method: 'GET',
      headers,
    };
    if (opts?.signal) {
      fetchOptions.signal = opts.signal;
    }

    const response = await this.executeFetch(`${this.baseUrl}/api/tags`, fetchOptions);
    const data = (await response.json()) as {
      models?: readonly {
        name: string;
        model: string;
        modified_at?: string;
        size?: number;
        digest?: string;
        details?: {
          format?: string;
          family?: string;
          families?: string[];
          parameter_size?: string;
          quantization_level?: string;
        };
      }[];
    };

    return (data.models ?? []).map((m) => ({
      name: m.name,
      model: m.model,
      modifiedAt: m.modified_at,
      size: m.size,
      digest: m.digest,
      details: m.details
        ? {
            format: m.details.format,
            family: m.details.family,
            families: m.details.families,
            parameterSize: m.details.parameter_size,
            quantizationLevel: m.details.quantization_level,
          }
        : undefined,
    }));
  }

  /**
   * Inspect a model via `/api/show` to check its parameters, template, and details.
   */
  async showModel(modelName: string, opts?: ProviderCallOptions): Promise<OllamaShowResponse> {
    const headers = this.buildHeaders();
    const fetchOptions: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: modelName }),
    };
    if (opts?.signal) {
      fetchOptions.signal = opts.signal;
    }

    const response = await this.executeFetch(`${this.baseUrl}/api/show`, fetchOptions);
    return (await response.json()) as OllamaShowResponse;
  }

  /**
   * Detect whether a specific model supports native tool calling.
   * Checks `/api/show` template for tool keywords or known tool-capable model families.
   */
  async hasToolSupport(modelName: string, opts?: ProviderCallOptions): Promise<boolean> {
    try {
      const show = await this.showModel(modelName, opts);
      const template = (show.template ?? '').toLowerCase();
      const modelfile = (show.modelfile ?? '').toLowerCase();

      // Check template / modelfile indicators for tool calling
      if (
        template.includes('.tools') ||
        template.includes('tool_call') ||
        template.includes('[tools]') ||
        modelfile.includes('tools')
      ) {
        return true;
      }

      // Check model name / family conventions
      const lowerName = modelName.toLowerCase();
      const knownToolFamilies = [
        'llama3.1',
        'llama3.2',
        'llama3.3',
        'qwen2.5',
        'mistral',
        'mixtral',
        'command-r',
        'firefunction',
      ];
      return knownToolFamilies.some((fam) => lowerName.includes(fam));
    } catch {
      // If /api/show fails, fallback to name-based detection
      const lowerName = modelName.toLowerCase();
      return (
        lowerName.includes('llama3.1') ||
        lowerName.includes('llama3.2') ||
        lowerName.includes('llama3.3') ||
        lowerName.includes('qwen2.5') ||
        lowerName.includes('mistral')
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers & Request Assembly
  // ---------------------------------------------------------------------------

  private getChatUrl(): string {
    return `${this.baseUrl}/api/chat`;
  }

  private buildHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...this.extraHeaders,
    };
  }

  private buildRequestPayload(
    req: NormalizedRequest,
    isStream: boolean
  ): Record<string, unknown> {
    const model = req.model || this.defaultModel;
    const messages = formatOllamaMessages(req.messages, req.system);

    const options: Record<string, unknown> = {
      ...this.extraOptions,
    };

    const maxTokens = req.maxTokens ?? this.defaultMaxTokens;
    if (maxTokens !== undefined) {
      options.num_predict = maxTokens;
    }
    if (req.temperature !== undefined) {
      options.temperature = req.temperature;
    }
    if (req.topP !== undefined) {
      options.top_p = req.topP;
    }
    if (req.stopSequences && req.stopSequences.length > 0) {
      options.stop = req.stopSequences;
    }

    const payload: Record<string, unknown> = {
      model,
      messages,
      stream: isStream,
    };

    if (Object.keys(options).length > 0) {
      payload.options = options;
    }

    if (req.tools && req.tools.length > 0) {
      payload.tools = req.tools.map(formatOllamaTool);
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
        timeoutCtrl.abort(new Error(`Ollama request timed out after ${this.timeoutMs}ms`));
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
        throw new AirError('CANCELLED', 'Ollama request was cancelled', {
          retryable: false,
          cause: err instanceof Error ? err : undefined,
        });
      }

      const msg = err instanceof Error ? err.message : String(err);
      throw new AirError(
        'PROVIDER_UNAVAILABLE',
        `Cannot connect to Ollama server at ${this.baseUrl}: ${msg}. Is 'ollama serve' running?`,
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
      throw mapOllamaHttpError(response.status, body, response.headers, this.clock);
    }

    return response;
  }

  private translateResponse(
    data: OllamaChatResponseWire,
    requestedModel: string
  ): NormalizedResponse {
    if (data.error) {
      throw mapOllamaHttpError(400, { error: data.error }, undefined, this.clock);
    }

    const content: MessagePart[] = [];
    const msg = data.message;

    if (msg) {
      // 1. Direct thinking property (if provided by Ollama / reasoning model)
      if (msg.thinking) {
        content.push({
          type: 'thinking',
          thinking: msg.thinking,
        });
      }

      // 2. Parse text content and check for embedded <think>...</think> tags
      if (msg.content) {
        const text = msg.content;
        const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/);
        if (thinkMatch) {
          const thinkingText = thinkMatch[1]?.trim();
          if (thinkingText && !msg.thinking) {
            content.push({
              type: 'thinking',
              thinking: thinkingText,
            });
          }
          const cleanText = text.replace(/<think>[\s\S]*?<\/think>/, '').trim();
          if (cleanText) {
            content.push({
              type: 'text',
              text: cleanText,
            });
          }
        } else {
          content.push({
            type: 'text',
            text,
          });
        }
      }

      // 3. Tool calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (let i = 0; i < msg.tool_calls.length; i++) {
          const tc = msg.tool_calls[i];
          if (tc) {
            const args = typeof tc.function.arguments === 'string'
              ? tryParseJson(tc.function.arguments)
              : tc.function.arguments;
            const toolCallPart: ToolCallPart = {
              type: 'tool_call',
              id: `call_${i}`,
              name: tc.function.name,
              arguments: args,
            };
            content.push(toolCallPart);
          }
        }
      }
    }

    let stopReason: StopReason = 'stop';
    if (data.done_reason === 'length') {
      stopReason = 'max_tokens';
    } else if (msg?.tool_calls && msg.tool_calls.length > 0) {
      stopReason = 'tool_calls';
    }

    const promptTokens = data.prompt_eval_count ?? 0;
    const completionTokens = data.eval_count ?? 0;
    const usage: TokenUsage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };

    return {
      id: `ollama_${this.clock.now().getTime()}`,
      model: data.model || requestedModel,
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
// Standalone Converters & Helpers
// ---------------------------------------------------------------------------

export function mapOllamaHttpError(
  status: number,
  body: unknown,
  _headers?: Headers,
  _clock: Clock = new SystemClock()
): AirError {
  void _headers;
  void _clock;
  let message = `Ollama API error (HTTP ${status})`;
  if (body && typeof body === 'object' && 'error' in body) {
    const errObj = (body as { error?: string }).error;
    if (typeof errObj === 'string' && errObj.trim().length > 0) {
      message = errObj;
    }
  } else if (typeof body === 'string' && body.trim().length > 0) {
    message = body;
  }

  const context: Record<string, unknown> = { status };

  switch (status) {
    case 404:
      return new AirError('NOT_FOUND', message, {
        retryable: false,
        context,
      });
    case 400:
      return new AirError('PROVIDER_INVALID_REQUEST', message, {
        retryable: false,
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

function formatOllamaTool(tool: ProviderToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function formatOllamaMessages(
  messages: readonly NormalizedMessage[],
  system?: string | readonly string[]
): OllamaMessagePayload[] {
  const result: OllamaMessagePayload[] = [];

  // Add system prompt if provided
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

      const images: string[] = [];
      let textContent = '';
      for (const part of msg.content) {
        if (part.type === 'text') {
          textContent += part.text;
        } else if (part.type === 'image') {
          images.push(part.data);
        }
      }

      result.push({
        role: 'user',
        content: textContent,
        ...(images.length > 0 ? { images } : {}),
      });
      continue;
    }

    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content });
        continue;
      }

      let textContent = '';
      const toolCalls: OllamaToolCallPayload[] = [];

      for (const part of msg.content) {
        if (part.type === 'text') {
          textContent += part.text;
        } else if (part.type === 'thinking') {
          textContent += `<think>${part.thinking}</think>`;
        } else if (part.type === 'tool_call') {
          const args = typeof part.arguments === 'string'
            ? tryParseJson(part.arguments)
            : part.arguments;
          toolCalls.push({
            function: {
              name: part.name,
              arguments: args,
            },
          });
        }
      }

      result.push({
        role: 'assistant',
        content: textContent,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (msg.role === 'tool') {
      const parts = typeof msg.content === 'string'
        ? [{ type: 'tool_result' as const, toolCallId: '', content: msg.content }]
        : msg.content;
      for (const part of parts) {
        if (part.type === 'tool_result') {
          const contentStr = typeof part.content === 'string'
            ? part.content
            : JSON.stringify(part.content);
          result.push({
            role: 'tool',
            content: contentStr,
          });
        }
      }
    }
  }

  return result;
}

function tryParseJson(str: string): Record<string, unknown> | string {
  try {
    return JSON.parse(str) as Record<string, unknown>;
  } catch {
    return str;
  }
}
