/**
 * VCR Record / Replay Harness for AIR Providers (Phase 3 - P3-T08).
 *
 * Implements:
 * - Deterministic record & replay of non-streaming and streaming model interactions.
 * - Tape cassette format persisting request metadata, responses, and stream events.
 * - Secret scrubbing: automatic sanitization of API keys, bearer tokens, and registered secrets.
 * - Multiple modes: 'record', 'replay', 'auto' (record if missing, replay if present), 'passthrough'.
 * - Pluggable request matching strategies ('fifo', 'exact', 'model_and_messages').
 * - Jail-safe persistence via fs-safe utilities.
 */

import { AirError } from '../errors/index.js';
import { redactor } from '../secrets/index.js';
import {
  type Clock,
  existsIn,
  readFileIn,
  SystemClock,
  writeFileAtomicIn,
} from '../util/index.js';
import type {
  NormalizedMessage,
  NormalizedRequest,
  NormalizedResponse,
  Provider,
  ProviderCallOptions,
  ProviderCapabilities,
  ProviderStreamEvent,
  ProviderToolDefinition,
  ProviderType,
  ToolChoice,
} from './types.js';

// ============================================================================
// Types & Schemas
// ============================================================================

export type VcrMode = 'record' | 'replay' | 'auto' | 'passthrough';
export type VcrMatchStrategy = 'fifo' | 'exact' | 'model_and_messages';

export interface VcrRecordedRequest {
  readonly model: string;
  readonly messages: readonly NormalizedMessage[];
  readonly system?: string | readonly string[] | undefined;
  readonly tools?: readonly ProviderToolDefinition[] | undefined;
  readonly toolChoice?: ToolChoice | undefined;
  readonly maxTokens?: number | undefined;
}

export interface VcrInteraction {
  readonly id: string;
  readonly timestamp: string;
  readonly request: VcrRecordedRequest;
  readonly response?: NormalizedResponse | undefined;
  readonly streamEvents?: readonly ProviderStreamEvent[] | undefined;
}

export interface VcrCassette {
  readonly version: 1;
  readonly providerId: string;
  readonly recordedAt: string;
  readonly interactions: VcrInteraction[];
}

export interface VcrProviderOptions {
  /** Custom ID for the VCR provider. */
  readonly id?: string | undefined;
  /** Operating mode (default: 'auto'). */
  readonly mode?: VcrMode | undefined;
  /** Relative or absolute path to cassette file. */
  readonly cassettePath?: string | undefined;
  /** Root directory jail for cassette files (default: process.cwd()). */
  readonly cassetteRoot?: string | undefined;
  /** In-memory cassette to use directly. */
  readonly cassette?: VcrCassette | undefined;
  /** Underlying real or mock provider used for recording or passthrough. */
  readonly underlying?: Provider | undefined;
  /** Matching strategy when replaying (default: 'fifo'). */
  readonly matchStrategy?: VcrMatchStrategy | undefined;
  /** Automatically save cassette to disk when recording interactions (default: true). */
  readonly autoSave?: boolean | undefined;
  /** Scrub secrets, keys, and tokens from recorded tape (default: true). */
  readonly scrubSecrets?: boolean | undefined;
  /** Injected clock for timestamps (Rule R6). */
  readonly clock?: Clock | undefined;
}

// ============================================================================
// Secret Scrubbing Helper
// ============================================================================

export function sanitizeVcrData<T>(data: T, customScrubber?: (val: string) => string): T {
  if (typeof data === 'string') {
    let s: string = data;
    // 1. Redact via global redactor
    s = redactor.redact(s);
    if (customScrubber) {
      s = customScrubber(s);
    }
    // 2. Redact common API key and token signatures
    s = s.replace(/sk-ant-[a-zA-Z0-9_-]+/g, '[REDACTED_API_KEY]');
    s = s.replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_API_KEY]');
    s = s.replace(/nvapi-[a-zA-Z0-9_-]+/g, '[REDACTED_API_KEY]');
    s = s.replace(/Bearer\s+[a-zA-Z0-9_.-]+/gi, 'Bearer [REDACTED_TOKEN]');
    return s as unknown as T;
  }
  if (Array.isArray(data)) {
    const list = data as readonly unknown[];
    return list.map((item) => sanitizeVcrData(item, customScrubber)) as unknown as T;
  }
  if (data !== null && typeof data === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      copy[k] = sanitizeVcrData(v, customScrubber);
    }
    return copy as unknown as T;
  }
  return data;
}

// ============================================================================
// Cassette Storage Helpers
// ============================================================================

export async function loadCassette(cassettePath: string, root = process.cwd()): Promise<VcrCassette> {
  const content = await readFileIn(root, cassettePath);
  try {
    const parsed = JSON.parse(content) as VcrCassette;
    if (parsed.version !== 1 || !Array.isArray(parsed.interactions)) {
      throw new Error('Invalid cassette format');
    }
    return parsed;
  } catch (err) {
    throw new AirError('SERIALIZATION_FAILED', `Failed to parse VCR cassette from "${cassettePath}"`, {
      cause: err instanceof Error ? err : undefined,
      context: { cassettePath, root },
    });
  }
}

export async function saveCassette(
  cassettePath: string,
  cassette: VcrCassette,
  root = process.cwd(),
): Promise<void> {
  const serialized = JSON.stringify(cassette, null, 2);
  await writeFileAtomicIn(root, cassettePath, serialized);
}

// ============================================================================
// VcrProvider Implementation
// ============================================================================

export class VcrProvider implements Provider {
  readonly id: string;
  readonly type: ProviderType;
  readonly defaultModel: string;
  readonly capabilities: ProviderCapabilities;

  private readonly underlying?: Provider | undefined;
  private readonly cassettePath?: string | undefined;
  private readonly cassetteRoot: string;
  private readonly matchStrategy: VcrMatchStrategy;
  private readonly autoSave: boolean;
  private readonly scrubSecrets: boolean;
  private readonly clock: Clock;

  private mode: VcrMode;
  private cassette: VcrCassette;
  private replayIndex = 0;
  private readonly consumedIds = new Set<string>();
  private initialized = false;

  constructor(options: VcrProviderOptions = {}) {
    this.underlying = options.underlying;
    this.cassettePath = options.cassettePath;
    this.cassetteRoot = options.cassetteRoot ?? process.cwd();
    this.mode = options.mode ?? 'auto';
    this.matchStrategy = options.matchStrategy ?? 'fifo';
    this.autoSave = options.autoSave ?? true;
    this.scrubSecrets = options.scrubSecrets ?? true;
    this.clock = options.clock ?? new SystemClock();

    this.id = options.id ?? (this.underlying ? `vcr(${this.underlying.id})` : 'vcr');
    this.type = this.underlying?.type ?? 'mock';
    this.defaultModel = this.underlying?.defaultModel ?? 'vcr-model';
    this.capabilities = this.underlying?.capabilities ?? {
      streaming: true,
      toolCalling: true,
      imageInput: true,
      systemPrompt: true,
      extendedThinking: true,
      promptCaching: true,
    };

    this.cassette = options.cassette ?? {
      version: 1,
      providerId: this.id,
      recordedAt: this.clock.iso(),
      interactions: [],
    };
  }

  getMode(): VcrMode {
    return this.mode;
  }

  getCassette(): VcrCassette {
    return this.cassette;
  }

  getInteractions(): readonly VcrInteraction[] {
    return [...this.cassette.interactions];
  }

  resetReplayIndex(): void {
    this.replayIndex = 0;
    this.consumedIds.clear();
  }

  async complete(
    request: NormalizedRequest,
    options?: ProviderCallOptions,
  ): Promise<NormalizedResponse> {
    if (options?.signal?.aborted) {
      throw new AirError('CANCELLED', 'VCR completion was cancelled', {
        cause: options.signal.reason instanceof Error ? options.signal.reason : undefined,
      });
    }

    await this.ensureInitialized();

    if (this.mode === 'passthrough') {
      if (!this.underlying) {
        throw new AirError('FAILED_PRECONDITION', 'VCR in passthrough mode requires an underlying provider');
      }
      return this.underlying.complete(request, options);
    }

    if (this.mode === 'replay') {
      const interaction = this.matchInteraction(request);
      if (!interaction || !interaction.response) {
        throw new AirError(
          'NOT_FOUND',
          `VCR replay: no matching interaction found for request to model "${request.model}"`,
          {
            context: {
              model: request.model,
              cassettePath: this.cassettePath,
              matchStrategy: this.matchStrategy,
              interactionsRecorded: this.cassette.interactions.length,
            },
          },
        );
      }
      return interaction.response;
    }

    // Record mode
    if (!this.underlying) {
      throw new AirError('FAILED_PRECONDITION', 'VCR in record mode requires an underlying provider');
    }

    const response = await this.underlying.complete(request, options);

    const interaction: VcrInteraction = {
      id: `int_${String(this.cassette.interactions.length + 1)}`,
      timestamp: this.clock.iso(),
      request: this.sanitizeRequest(request),
      response: this.scrubSecrets ? sanitizeVcrData(response) : response,
    };

    this.cassette.interactions.push(interaction);

    if (this.autoSave && this.cassettePath) {
      await this.save();
    }

    return response;
  }

  async *stream(
    request: NormalizedRequest,
    options?: ProviderCallOptions,
  ): AsyncIterable<ProviderStreamEvent> {
    if (options?.signal?.aborted) {
      throw new AirError('CANCELLED', 'Replay stream was aborted', {
        cause: options.signal.reason instanceof Error ? options.signal.reason : undefined,
      });
    }

    await this.ensureInitialized();

    if (this.mode === 'passthrough') {
      if (!this.underlying) {
        throw new AirError('FAILED_PRECONDITION', 'VCR in passthrough mode requires an underlying provider');
      }
      yield* this.underlying.stream(request, options);
      return;
    }

    if (this.mode === 'replay') {
      const interaction = this.matchInteraction(request);
      if (!interaction || !interaction.streamEvents || interaction.streamEvents.length === 0) {
        throw new AirError(
          'NOT_FOUND',
          `VCR replay: no matching streaming interaction found for model "${request.model}"`,
          {
            context: {
              model: request.model,
              cassettePath: this.cassettePath,
              matchStrategy: this.matchStrategy,
              interactionsRecorded: this.cassette.interactions.length,
            },
          },
        );
      }

      for (const event of interaction.streamEvents) {
        if (options?.signal?.aborted) {
          throw new AirError('CANCELLED', 'Replay stream was aborted');
        }
        yield event;
      }
      return;
    }

    // Record mode
    if (!this.underlying) {
      throw new AirError('FAILED_PRECONDITION', 'VCR in record mode requires an underlying provider');
    }

    const recordedEvents: ProviderStreamEvent[] = [];
    const stream = this.underlying.stream(request, options);

    for await (const event of stream) {
      recordedEvents.push(event);
      yield event;
    }

    const interaction: VcrInteraction = {
      id: `int_${String(this.cassette.interactions.length + 1)}`,
      timestamp: this.clock.iso(),
      request: this.sanitizeRequest(request),
      streamEvents: this.scrubSecrets ? sanitizeVcrData(recordedEvents) : recordedEvents,
    };

    this.cassette.interactions.push(interaction);

    if (this.autoSave && this.cassettePath) {
      await this.save();
    }
  }

  async save(): Promise<void> {
    if (!this.cassettePath) {
      return;
    }
    await saveCassette(this.cassettePath, this.cassette, this.cassetteRoot);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.mode === 'auto') {
      if (this.cassettePath) {
        const exists = await existsIn(this.cassetteRoot, this.cassettePath);
        if (exists) {
          this.cassette = await loadCassette(this.cassettePath, this.cassetteRoot);
          this.mode = 'replay';
        } else {
          this.mode = 'record';
        }
      } else if (this.cassette.interactions.length > 0) {
        this.mode = 'replay';
      } else {
        this.mode = 'record';
      }
    } else if (this.mode === 'replay' && this.cassettePath && this.cassette.interactions.length === 0) {
      const exists = await existsIn(this.cassetteRoot, this.cassettePath);
      if (exists) {
        this.cassette = await loadCassette(this.cassettePath, this.cassetteRoot);
      }
    }

    this.initialized = true;
  }

  private matchInteraction(request: NormalizedRequest): VcrInteraction | undefined {
    if (this.matchStrategy === 'fifo') {
      if (this.replayIndex < this.cassette.interactions.length) {
        const item = this.cassette.interactions[this.replayIndex];
        this.replayIndex++;
        return item;
      }
      return undefined;
    }

    if (this.matchStrategy === 'exact') {
      for (const interaction of this.cassette.interactions) {
        if (this.consumedIds.has(interaction.id)) {
          continue;
        }
        if (this.isExactMatch(interaction.request, request)) {
          this.consumedIds.add(interaction.id);
          return interaction;
        }
      }
      return undefined;
    }

    if (this.matchStrategy === 'model_and_messages') {
      for (const interaction of this.cassette.interactions) {
        if (this.consumedIds.has(interaction.id)) {
          continue;
        }
        if (
          interaction.request.model === request.model &&
          JSON.stringify(interaction.request.messages) === JSON.stringify(request.messages)
        ) {
          this.consumedIds.add(interaction.id);
          return interaction;
        }
      }
      return undefined;
    }

    return undefined;
  }

  private isExactMatch(recorded: VcrRecordedRequest, request: NormalizedRequest): boolean {
    if (recorded.model !== request.model) {
      return false;
    }
    if (JSON.stringify(recorded.system) !== JSON.stringify(request.system)) {
      return false;
    }
    if (JSON.stringify(recorded.messages) !== JSON.stringify(request.messages)) {
      return false;
    }
    if (JSON.stringify(recorded.tools) !== JSON.stringify(request.tools)) {
      return false;
    }
    return true;
  }

  private sanitizeRequest(request: NormalizedRequest): VcrRecordedRequest {
    const recorded: VcrRecordedRequest = {
      model: request.model,
      messages: request.messages,
      system: request.system,
      tools: request.tools,
      toolChoice: request.toolChoice,
      maxTokens: request.maxTokens,
    };
    return this.scrubSecrets ? sanitizeVcrData(recorded) : recorded;
  }
}
