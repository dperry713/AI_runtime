/**
 * Mock / Scripted Provider for testing and local deterministic execution (Phase 3 - P3-T02).
 *
 * Implements:
 * - Deterministic scripted responses (FIFO queue, pattern/predicate handlers, repeat/default fallbacks).
 * - Latency injection with cancellation safety (honoring injected Clock and AbortSignal).
 * - Fault and error injection (immediate errors, delayed errors, mid-stream errors).
 * - Automatic stream synthesis from static responses or custom event sequences.
 * - Call history inspection and assertion spy (requests, options, timestamps, counts).
 */

import { AirError, isAirError } from '../errors/index.js';
import {
  type Clock,
  type IdGenerator,
  SystemClock,
  UlidIdGenerator,
  sleep,
} from '../util/index.js';
import {
  extractText,
  extractThinking,
  extractToolCalls,
  type MessagePart,
  type NormalizedMessage,
  type NormalizedRequest,
  type NormalizedResponse,
  type Provider,
  type ProviderCallOptions,
  type ProviderCapabilities,
  type ProviderStreamEvent,
  type StopReason,
  type TokenUsage,
} from './types.js';

/**
 * Script step describing how the mock provider should respond to a request.
 */
export interface MockScriptStep {
  /** Text content, message parts, or complete NormalizedResponse */
  readonly response?: string | ReadonlyArray<MessagePart> | NormalizedResponse | undefined;
  /** Explicit streaming events if custom event sequences are needed */
  readonly streamEvents?: ReadonlyArray<ProviderStreamEvent> | undefined;
  /** Simulated latency in milliseconds before producing response / emitting chunks */
  readonly delayMs?: number | undefined;
  /** Simulated delay between chunks in streaming mode */
  readonly chunkDelayMs?: number | undefined;
  /** Simulated error to throw on complete or emit in stream */
  readonly error?: Error | AirError | string | undefined;
  /** Custom stopReason (defaults to 'stop', or 'tool_calls' if tool calls are present) */
  readonly stopReason?: StopReason | undefined;
  /** Custom token usage report */
  readonly usage?: Partial<TokenUsage> | undefined;
  /** Dynamic factory returning response or step based on request */
  readonly fn?: ((request: NormalizedRequest, callCount: number) => MockResponseInput | Promise<MockResponseInput>) | undefined;
}

/**
 * Shorthand inputs accepted when scripting mock responses.
 */
export type MockResponseInput =
  | string
  | ReadonlyArray<MessagePart>
  | NormalizedResponse
  | MockScriptStep;

/**
 * Record of an invocation made to the mock provider.
 */
export interface MockCallRecord {
  readonly callIndex: number;
  readonly request: NormalizedRequest;
  readonly options?: ProviderCallOptions | undefined;
  readonly timestamp: string;
  readonly streamed: boolean;
}

export interface MockProviderOptions {
  /** Unique provider instance identifier (default 'mock') */
  readonly id?: string | undefined;
  /** Default model string (default 'mock-model') */
  readonly defaultModel?: string | undefined;
  /** Custom capability overrides */
  readonly capabilities?: Partial<ProviderCapabilities> | undefined;
  /** Injected Clock for deterministic timestamps and sleep */
  readonly clock?: Clock | undefined;
  /** Injected IdGenerator for response IDs */
  readonly idGenerator?: IdGenerator | undefined;
  /** Default response when queue is exhausted */
  readonly defaultResponse?: MockResponseInput | undefined;
  /** If true, repeats the last response when queue is exhausted */
  readonly repeatLast?: boolean | undefined;
}

interface ConditionalHandler {
  readonly predicate: (request: NormalizedRequest) => boolean;
  readonly response: MockResponseInput;
}

/**
 * Production-grade mock provider implementing universal Provider contract.
 */
export class MockProvider implements Provider {
  public readonly id: string;
  public readonly type = 'mock' as const;
  public readonly defaultModel: string;
  public readonly capabilities: ProviderCapabilities;

  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly defaultResponse?: MockResponseInput | undefined;
  private readonly repeatLast: boolean;

  private readonly queuedSteps: MockScriptStep[] = [];
  private readonly recordedCalls: MockCallRecord[] = [];
  private readonly conditionalHandlers: ConditionalHandler[] = [];
  private lastUsedStep?: MockScriptStep | undefined;

  constructor(options?: MockProviderOptions) {
    this.id = options?.id ?? 'mock';
    this.defaultModel = options?.defaultModel ?? 'mock-model';
    this.clock = options?.clock ?? new SystemClock();
    this.idGenerator = options?.idGenerator ?? new UlidIdGenerator(this.clock);
    this.defaultResponse = options?.defaultResponse;
    this.repeatLast = options?.repeatLast ?? false;

    this.capabilities = {
      streaming: true,
      toolCalling: true,
      imageInput: true,
      systemPrompt: true,
      extendedThinking: true,
      promptCaching: true,
      maxContextWindow: 128000,
      ...options?.capabilities,
    };
  }

  // ---------------------------------------------------------------------------
  // Provider Interface Implementation
  // ---------------------------------------------------------------------------

  public async complete(
    request: NormalizedRequest,
    options?: ProviderCallOptions,
  ): Promise<NormalizedResponse> {
    const callIndex = this.recordCall(request, options, false);
    const step = await this.resolveStep(request, callIndex);

    if (step.delayMs && step.delayMs > 0) {
      await sleep(step.delayMs, { signal: options?.signal });
    }

    if (options?.signal?.aborted) {
      throw new AirError('CANCELLED', 'Provider call was cancelled by abort signal');
    }

    if (step.error) {
      throw this.toAirError(step.error);
    }

    return this.buildResponse(request, step);
  }

  public async *stream(
    request: NormalizedRequest,
    options?: ProviderCallOptions,
  ): AsyncIterable<ProviderStreamEvent> {
    const callIndex = this.recordCall(request, options, true);
    const step = await this.resolveStep(request, callIndex);

    if (step.delayMs && step.delayMs > 0) {
      await sleep(step.delayMs, { signal: options?.signal });
    }

    if (options?.signal?.aborted) {
      throw new AirError('CANCELLED', 'Provider stream was cancelled by abort signal');
    }

    if (step.error) {
      yield { type: 'error', error: this.toAirError(step.error) };
      return;
    }

    // 1. Explicit stream events
    if (step.streamEvents && step.streamEvents.length > 0) {
      for (const event of step.streamEvents) {
        if (options?.signal?.aborted) {
          throw new AirError('CANCELLED', 'Provider stream was cancelled during emission');
        }
        if (step.chunkDelayMs && step.chunkDelayMs > 0) {
          await sleep(step.chunkDelayMs, { signal: options?.signal });
        }
        yield event;
      }
      return;
    }

    // 2. Synthesize stream events from response
    const response = this.buildResponse(request, step);
    const model = request.model || this.defaultModel;

    yield {
      type: 'stream_start',
      id: response.id,
      model,
    };

    const message = response.message;

    // Stream thinking if present
    const thinking = extractThinking(message);
    if (thinking.length > 0) {
      if (step.chunkDelayMs && step.chunkDelayMs > 0) {
        await sleep(step.chunkDelayMs, { signal: options?.signal });
      }
      yield {
        type: 'thinking_delta',
        text: thinking,
      };
    }

    // Stream text if present
    const text = extractText(message);
    if (text.length > 0) {
      // Chunk text into small pieces if requested or single chunk
      const chunkSize = 20;
      for (let i = 0; i < text.length; i += chunkSize) {
        if (options?.signal?.aborted) {
          throw new AirError('CANCELLED', 'Provider stream was cancelled during text delivery');
        }
        if (step.chunkDelayMs && step.chunkDelayMs > 0) {
          await sleep(step.chunkDelayMs, { signal: options?.signal });
        }
        yield {
          type: 'text_delta',
          text: text.slice(i, i + chunkSize),
        };
      }
    }

    // Stream tool calls if present
    const toolCalls = extractToolCalls(message);
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      if (!tc) continue;

      if (options?.signal?.aborted) {
        throw new AirError('CANCELLED', 'Provider stream was cancelled during tool call emission');
      }

      yield {
        type: 'tool_call_start',
        index: i,
        id: tc.id,
        name: tc.name,
      };

      const argsStr = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
      yield {
        type: 'tool_call_delta',
        index: i,
        argumentsDelta: argsStr,
      };

      yield {
        type: 'tool_call_end',
        index: i,
        toolCall: {
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        },
      };
    }

    // Finalize usage and stream_end
    yield {
      type: 'usage',
      usage: response.usage,
    };

    yield {
      type: 'stream_end',
      stopReason: response.stopReason,
      usage: response.usage,
    };
  }

  // ---------------------------------------------------------------------------
  // Scripting Configuration API
  // ---------------------------------------------------------------------------

  /**
   * Enqueues a response step into the FIFO script queue.
   */
  public enqueue(input: MockResponseInput): this {
    this.queuedSteps.push(this.normalizeInput(input));
    return this;
  }

  /**
   * Enqueues a plain text assistant response.
   */
  public enqueueResponse(
    text: string,
    options?: {
      delayMs?: number | undefined;
      stopReason?: StopReason | undefined;
      usage?: Partial<TokenUsage> | undefined;
    },
  ): this {
    return this.enqueue({
      response: text,
      delayMs: options?.delayMs,
      stopReason: options?.stopReason ?? 'stop',
      usage: options?.usage,
    });
  }

  /**
   * Enqueues assistant tool calls.
   */
  public enqueueToolCalls(
    toolCalls: Array<{
      id?: string | undefined;
      name: string;
      arguments: Record<string, unknown> | string;
    }>,
    options?: {
      text?: string | undefined;
      delayMs?: number | undefined;
      usage?: Partial<TokenUsage> | undefined;
    },
  ): this {
    const parts: MessagePart[] = [];

    if (options?.text) {
      parts.push({ type: 'text', text: options.text });
    }

    for (const tc of toolCalls) {
      parts.push({
        type: 'tool_call',
        id: tc.id ?? `call_${this.idGenerator.next()}`,
        name: tc.name,
        arguments: tc.arguments,
      });
    }

    return this.enqueue({
      response: parts,
      delayMs: options?.delayMs,
      stopReason: 'tool_calls',
      usage: options?.usage,
    });
  }

  /**
   * Enqueues an error to simulate model failure, network drop, or rate limits.
   */
  public enqueueError(
    error: Error | AirError | string,
    options?: { delayMs?: number | undefined },
  ): this {
    return this.enqueue({
      error,
      delayMs: options?.delayMs,
    });
  }

  /**
   * Enqueues an explicit list of streaming events.
   */
  public enqueueStream(
    events: ReadonlyArray<ProviderStreamEvent>,
    options?: { delayMs?: number | undefined; chunkDelayMs?: number | undefined },
  ): this {
    return this.enqueue({
      streamEvents: events,
      delayMs: options?.delayMs,
      chunkDelayMs: options?.chunkDelayMs,
    });
  }

  /**
   * Registers a conditional handler matching requests by predicate.
   */
  public when(
    predicate: (request: NormalizedRequest) => boolean,
    response: MockResponseInput,
  ): this {
    this.conditionalHandlers.push({
      predicate,
      response,
    });
    return this;
  }

  /**
   * Matches requests where any user message contains the specified substring or regex.
   */
  public whenUserTextMatches(pattern: RegExp | string, response: MockResponseInput): this {
    return this.when((req) => {
      for (const msg of req.messages) {
        if (msg.role === 'user') {
          const text = extractText(msg);
          if (typeof pattern === 'string') {
            if (text.includes(pattern)) return true;
          } else if (pattern.test(text)) {
            return true;
          }
        }
      }
      return false;
    }, response);
  }

  // ---------------------------------------------------------------------------
  // Inspection & Spy API
  // ---------------------------------------------------------------------------

  /**
   * All recorded calls made to this provider instance.
   */
  public get calls(): ReadonlyArray<MockCallRecord> {
    return this.recordedCalls;
  }

  /**
   * Number of calls made so far.
   */
  public getCallCount(): number {
    return this.recordedCalls.length;
  }

  /**
   * Retrieves a specific call record by index.
   */
  public getCall(index: number): MockCallRecord | undefined {
    return this.recordedCalls[index];
  }

  /**
   * Retrieves the most recent call record.
   */
  public getLastCall(): MockCallRecord | undefined {
    return this.recordedCalls[this.recordedCalls.length - 1];
  }

  /**
   * Clears recorded call history without resetting queued script steps.
   */
  public clearCalls(): void {
    this.recordedCalls.length = 0;
  }

  /**
   * Resets all calls, queued steps, conditional handlers, and state.
   */
  public reset(): void {
    this.recordedCalls.length = 0;
    this.queuedSteps.length = 0;
    this.conditionalHandlers.length = 0;
    this.lastUsedStep = undefined;
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  private recordCall(
    request: NormalizedRequest,
    options: ProviderCallOptions | undefined,
    streamed: boolean,
  ): number {
    const callIndex = this.recordedCalls.length;
    this.recordedCalls.push({
      callIndex,
      request,
      options,
      timestamp: this.clock.iso(),
      streamed,
    });
    return callIndex;
  }

  private async resolveStep(
    request: NormalizedRequest,
    callIndex: number,
  ): Promise<MockScriptStep> {
    // 1. Check conditional handlers
    for (const handler of this.conditionalHandlers) {
      if (handler.predicate(request)) {
        return this.evaluateStep(handler.response, request, callIndex);
      }
    }

    // 2. Dequeue next step
    if (this.queuedSteps.length > 0) {
      const step = this.queuedSteps.shift();
      if (step) {
        this.lastUsedStep = step;
        return this.evaluateStep(step, request, callIndex);
      }
    }

    // 3. Repeat last step if enabled
    if (this.repeatLast && this.lastUsedStep) {
      return this.evaluateStep(this.lastUsedStep, request, callIndex);
    }

    // 4. Fallback to default response if configured
    if (this.defaultResponse !== undefined) {
      return this.evaluateStep(this.defaultResponse, request, callIndex);
    }

    throw new AirError(
      'INVALID_STATE',
      `MockProvider "${this.id}" has no scripted responses remaining (call #${callIndex + 1})`,
    );
  }

  private async evaluateStep(
    input: MockResponseInput,
    request: NormalizedRequest,
    callIndex: number,
  ): Promise<MockScriptStep> {
    const step = this.normalizeInput(input);
    if (step.fn) {
      const dynamicResult = await step.fn(request, callIndex);
      return this.normalizeInput(dynamicResult);
    }
    return step;
  }

  private normalizeInput(input: MockResponseInput): MockScriptStep {
    if (typeof input === 'string') {
      return { response: input };
    }
    if (Array.isArray(input)) {
      return { response: input };
    }
    if (input && typeof input === 'object') {
      if ('stopReason' in input && 'usage' in input && 'message' in input) {
        // Complete NormalizedResponse
        return { response: input };
      }
      return input as MockScriptStep;
    }
    return {};
  }

  private buildResponse(request: NormalizedRequest, step: MockScriptStep): NormalizedResponse {
    if (step.response && typeof step.response === 'object' && 'stopReason' in step.response && 'message' in step.response) {
      return step.response;
    }

    const message = this.buildMessage(step);
    const stopReason = step.stopReason ?? (extractToolCalls(message).length > 0 ? 'tool_calls' : 'stop');

    // Synthesize plausible usage based on length if not explicitly provided
    const estPrompt = 10 + request.messages.length * 15;
    const estComp = 10 + (typeof message.content === 'string' ? message.content.length / 4 : 20);

    const usage: TokenUsage = {
      promptTokens: step.usage?.promptTokens ?? Math.round(estPrompt),
      completionTokens: step.usage?.completionTokens ?? Math.round(estComp),
      totalTokens:
        step.usage?.totalTokens ??
        (step.usage?.promptTokens ?? Math.round(estPrompt)) +
          (step.usage?.completionTokens ?? Math.round(estComp)),
    };

    if (step.usage?.cacheReadTokens !== undefined) {
      (usage as { cacheReadTokens?: number }).cacheReadTokens = step.usage.cacheReadTokens;
    }
    if (step.usage?.cacheWriteTokens !== undefined) {
      (usage as { cacheWriteTokens?: number }).cacheWriteTokens = step.usage.cacheWriteTokens;
    }
    if (step.usage?.thinkingTokens !== undefined) {
      (usage as { thinkingTokens?: number }).thinkingTokens = step.usage.thinkingTokens;
    }

    return {
      id: `mock_resp_${this.idGenerator.next()}`,
      model: request.model || this.defaultModel,
      message,
      stopReason,
      usage,
    };
  }

  private buildMessage(step: MockScriptStep): NormalizedMessage {
    if (step.response === undefined) {
      return { role: 'assistant', content: '' };
    }
    if (typeof step.response === 'string') {
      return { role: 'assistant', content: step.response };
    }
    if (Array.isArray(step.response)) {
      return { role: 'assistant', content: step.response };
    }
    if (typeof step.response === 'object' && 'message' in step.response) {
      return step.response.message;
    }
    return { role: 'assistant', content: '' };
  }

  private toAirError(err: Error | AirError | string): AirError {
    if (isAirError(err)) {
      return err;
    }
    if (err instanceof Error) {
      return new AirError('PROVIDER_ERROR', err.message, { cause: err });
    }
    return new AirError('PROVIDER_ERROR', String(err));
  }
}
