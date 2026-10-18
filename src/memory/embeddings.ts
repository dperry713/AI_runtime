/**
 * Embedding abstractions, vector math, and providers for AIR Memory (P8-T03).
 *
 * Provides:
 * - EmbeddingProvider interface & types
 * - In-process vector math: cosine similarity, dot product, euclidean distance, normalization
 * - Vector ranking: rankByVector() for in-memory cosine ranking
 * - MockEmbeddingProvider for deterministic offline testing (Rule R6 compliant)
 * - RemoteEmbeddingProvider for OpenAI/Ollama/NIM compatible /v1/embeddings endpoints
 * - Factory helper createEmbeddingProvider()
 */

import { z } from 'zod';
import { AirError } from '../errors/index.js';
import type { Clock } from '../util/index.js';
import { SystemClock } from '../util/index.js';
import type { MemoryEmbeddingsConfig } from '../config/index.js';

// ============================================================================
// Types & Contracts
// ============================================================================

export type EmbeddingVector = number[];

export const EmbeddingVectorSchema = z.array(z.number());

export interface EmbeddingOptions {
  /** Optional cancellation signal. */
  signal?: AbortSignal | undefined;
  /** Timeout in milliseconds. */
  timeoutMs?: number | undefined;
}

export interface EmbeddingBatchOptions extends EmbeddingOptions {
  /** Maximum items per HTTP chunk. Defaults to 100. */
  maxBatchSize?: number | undefined;
}

export interface EmbeddingProvider {
  /** Unique provider identifier (e.g. 'mock', 'openai-compat', 'ollama'). */
  readonly id: string;
  /** Dimensionality of the output embedding vectors. */
  readonly dimensions: number;
  /** Embed a single text string into a vector. */
  embed(text: string, options?: EmbeddingOptions): Promise<EmbeddingVector>;
  /** Embed a batch of text strings into vectors preserving input order. */
  embedBatch(texts: string[], options?: EmbeddingBatchOptions): Promise<EmbeddingVector[]>;
}

// ============================================================================
// Vector Math
// ============================================================================

/**
 * Validates that an argument is a non-empty numeric vector without NaN / non-number items.
 */
function validateVector(v: unknown, name: string): asserts v is number[] {
  if (!Array.isArray(v)) {
    throw new AirError('INVALID_ARGUMENT', `${name} must be an array of numbers`);
  }
  if (v.length === 0) {
    throw new AirError('INVALID_ARGUMENT', `${name} cannot be empty`);
  }
  for (let i = 0; i < v.length; i++) {
    const val: unknown = (v as unknown[])[i];
    if (typeof val !== 'number' || Number.isNaN(val)) {
      throw new AirError('INVALID_ARGUMENT', `${name} contains invalid number at index ${i}`);
    }
  }
}

/**
 * Computes cosine similarity between two numeric vectors in [-1, 1].
 *
 * If either vector has zero magnitude, returns 0.
 * Throws INVALID_ARGUMENT on dimension mismatch or invalid input.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  validateVector(a, 'Vector A');
  validateVector(b, 'Vector B');

  if (a.length !== b.length) {
    throw new AirError(
      'INVALID_ARGUMENT',
      `Vector dimension mismatch: vector A has ${a.length} dimensions, vector B has ${b.length}`,
    );
  }

  let dot = 0;
  let sumSqA = 0;
  let sumSqB = 0;

  for (let i = 0; i < a.length; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    sumSqA += va * va;
    sumSqB += vb * vb;
  }

  if (sumSqA === 0 || sumSqB === 0) {
    return 0;
  }

  const magnitude = Math.sqrt(sumSqA) * Math.sqrt(sumSqB);
  if (magnitude === 0) {
    return 0;
  }

  const similarity = dot / magnitude;
  // Guard against floating point imprecision exceeding [-1, 1]
  return Math.max(-1, Math.min(1, similarity));
}

/**
 * Computes the dot product of two numeric vectors of identical length.
 */
export function dotProduct(a: number[], b: number[]): number {
  validateVector(a, 'Vector A');
  validateVector(b, 'Vector B');

  if (a.length !== b.length) {
    throw new AirError(
      'INVALID_ARGUMENT',
      `Vector dimension mismatch: vector A has ${a.length} dimensions, vector B has ${b.length}`,
    );
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

/**
 * Computes Euclidean distance between two vectors: sqrt(sum((a_i - b_i)^2)).
 */
export function euclideanDistance(a: number[], b: number[]): number {
  validateVector(a, 'Vector A');
  validateVector(b, 'Vector B');

  if (a.length !== b.length) {
    throw new AirError(
      'INVALID_ARGUMENT',
      `Vector dimension mismatch: vector A has ${a.length} dimensions, vector B has ${b.length}`,
    );
  }

  let sumSq = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq);
}

/**
 * Computes Euclidean magnitude (L2 norm) of a vector.
 */
export function vectorMagnitude(v: number[]): number {
  if (!Array.isArray(v)) {
    throw new AirError('INVALID_ARGUMENT', 'Vector must be an array of numbers');
  }
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) {
    const val = v[i] ?? 0;
    if (typeof val !== 'number' || Number.isNaN(val)) {
      throw new AirError('INVALID_ARGUMENT', `Vector contains invalid number at index ${i}`);
    }
    sumSq += val * val;
  }
  return Math.sqrt(sumSq);
}

/**
 * Normalizes a vector to unit length (L2 norm = 1).
 * If magnitude is 0, returns a vector of zeros.
 */
export function normalizeVector(v: number[]): number[] {
  validateVector(v, 'Vector');
  const mag = vectorMagnitude(v);
  if (mag === 0) {
    return v.map(() => 0);
  }
  return v.map((x) => x / mag);
}

/**
 * Result structure returned by rankByVector().
 */
export interface VectorRankResult<T> {
  item: T;
  similarity: number;
}

/**
 * Options for rankByVector().
 */
export interface RankByVectorOptions {
  /** Maximum number of results to return. Defaults to 10. */
  limit?: number | undefined;
  /** Minimum cosine similarity threshold (between -1 and 1). */
  minSimilarity?: number | undefined;
}

/**
 * Ranks candidate items with embeddings against a query vector using cosine similarity.
 *
 * Items without embeddings or with mismatched dimensions are ignored.
 */
export function rankByVector<T extends { embedding?: number[] | null | undefined }>(
  queryVector: number[],
  candidates: T[],
  options?: RankByVectorOptions,
): VectorRankResult<T>[] {
  validateVector(queryVector, 'Query vector');

  const limit = options?.limit ?? 10;
  const minSimilarity = options?.minSimilarity;

  const scored: VectorRankResult<T>[] = [];

  for (const item of candidates) {
    const emb = item.embedding;
    if (!emb || !Array.isArray(emb) || emb.length !== queryVector.length) {
      continue;
    }
    const similarity = cosineSimilarity(queryVector, emb);
    if (minSimilarity !== undefined && similarity < minSimilarity) {
      continue;
    }
    scored.push({ item, similarity });
  }

  scored.sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, limit);
}

// ============================================================================
// Mulberry32 Deterministic PRNG Helper (Rule R6 compliant)
// ============================================================================

function createMulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Computes a 32-bit FNV-1a hash of a UTF-8 string.
 */
function hashFnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ============================================================================
// MockEmbeddingProvider (Offline & Deterministic)
// ============================================================================

export interface MockEmbeddingProviderOptions {
  id?: string | undefined;
  dimensions?: number | undefined;
  /** Explicit canned embeddings mapping text -> vector. */
  cannedEmbeddings?: Record<string, number[]> | undefined;
  /** Whether generated vectors are deterministic hashes of text (default: true). */
  deterministic?: boolean | undefined;
  /** Simulated latency in milliseconds. */
  delayMs?: number | undefined;
  /** Injected clock for deterministic sleeps. */
  clock?: Clock | undefined;
  /** Whether the provider should simulate failure. */
  shouldFail?: boolean | undefined;
  /** Specific error to throw on simulated failure. */
  failureError?: Error | undefined;
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  readonly clock: Clock;

  private readonly canned: Map<string, number[]>;
  private readonly deterministic: boolean;
  private readonly delayMs: number;
  private shouldFail: boolean;
  private failureError?: Error | undefined;

  constructor(options: MockEmbeddingProviderOptions = {}) {
    this.id = options.id ?? 'mock-embeddings';
    this.dimensions = options.dimensions ?? 128;
    this.deterministic = options.deterministic !== false;
    this.delayMs = options.delayMs ?? 0;
    this.clock = options.clock ?? new SystemClock();
    this.shouldFail = options.shouldFail ?? false;
    this.failureError = options.failureError;

    this.canned = new Map();
    if (options.cannedEmbeddings) {
      for (const [k, v] of Object.entries(options.cannedEmbeddings)) {
        this.canned.set(k, v);
      }
    }
  }

  setShouldFail(shouldFail: boolean, error?: Error): void {
    this.shouldFail = shouldFail;
    this.failureError = error;
  }

  setCanned(text: string, vector: number[]): void {
    this.canned.set(text, vector);
  }

  private async simulateLatency(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new AirError('CANCELLED', 'Embedding request aborted', { retryable: false });
    }
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (signal?.aborted) {
            reject(new AirError('CANCELLED', 'Embedding request aborted', { retryable: false }));
          } else {
            resolve();
          }
        }, this.delayMs);

        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new AirError('CANCELLED', 'Embedding request aborted', { retryable: false }));
          },
          { once: true },
        );
      });
    }
  }

  private generateVector(text: string): number[] {
    const canned = this.canned.get(text);
    if (canned) {
      if (canned.length !== this.dimensions) {
        throw new AirError(
          'INVALID_ARGUMENT',
          `Canned vector for "${text}" has dimension ${canned.length}, expected ${this.dimensions}`,
        );
      }
      return canned;
    }

    if (!this.deterministic) {
      // Return simple normalized unit vector with 1 at first element
      const raw: number[] = Array.from({ length: this.dimensions }, (): number => 0);
      raw[0] = 1;
      return raw;
    }

    // Deterministic pseudo-random generation using Mulberry32 seeded by FNV-1a hash
    const seed = hashFnv1a(text);
    const rng = createMulberry32(seed);

    const raw: number[] = Array.from({ length: this.dimensions }, (): number => 0);
    for (let i = 0; i < this.dimensions; i++) {
      // Map rng [0, 1] to [-1, 1]
      raw[i] = rng() * 2 - 1;
    }

    return normalizeVector(raw);
  }

  async embed(text: string, options?: EmbeddingOptions): Promise<EmbeddingVector> {
    if (this.shouldFail) {
      throw (
        this.failureError ??
        new AirError('EMBEDDING_FAILED', `Mock embedding failed for input: "${text}"`, {
          retryable: true,
        })
      );
    }

    await this.simulateLatency(options?.signal);

    if (!text || text.trim().length === 0) {
      throw new AirError('INVALID_ARGUMENT', 'Text to embed cannot be empty');
    }

    return this.generateVector(text);
  }

  async embedBatch(
    texts: string[],
    options?: EmbeddingBatchOptions,
  ): Promise<EmbeddingVector[]> {
    if (this.shouldFail) {
      throw (
        this.failureError ??
        new AirError('EMBEDDING_FAILED', 'Mock embedding batch failed', { retryable: true })
      );
    }

    await this.simulateLatency(options?.signal);

    const results: EmbeddingVector[] = [];
    for (const text of texts) {
      if (options?.signal?.aborted) {
        throw new AirError('CANCELLED', 'Embedding batch request aborted', { retryable: false });
      }
      if (!text || text.trim().length === 0) {
        throw new AirError('INVALID_ARGUMENT', 'Text in embedding batch cannot be empty');
      }
      results.push(this.generateVector(text));
    }

    return results;
  }
}

// ============================================================================
// RemoteEmbeddingProvider (OpenAI-Compatible & Ollama /v1/embeddings)
// ============================================================================

const RemoteEmbeddingApiResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()),
      index: z.number().int().nonnegative().optional(),
    }),
  ),
  model: z.string().optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});

export interface RemoteEmbeddingProviderOptions {
  id?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  model: string;
  dimensions?: number | undefined;
  timeoutMs?: number | undefined;
  maxBatchSize?: number | undefined;
  fetcher?: typeof fetch | undefined;
  clock?: Clock | undefined;
}

export class RemoteEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  readonly baseUrl: string;
  readonly model: string;

  private readonly apiKey?: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly maxBatchSize: number;
  private readonly fetcher: typeof fetch;

  constructor(options: RemoteEmbeddingProviderOptions) {
    this.id = options.id ?? 'remote-embeddings';
    this.model = options.model;
    this.dimensions = options.dimensions ?? 1536;
    this.apiKey = options.apiKey;
    this.defaultTimeoutMs = options.timeoutMs ?? 30000;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.fetcher = options.fetcher ?? globalThis.fetch;

    const base = options.baseUrl ?? 'https://api.openai.com/v1';
    this.baseUrl = base.endsWith('/') ? base.slice(0, -1) : base;
  }

  async embed(text: string, options?: EmbeddingOptions): Promise<EmbeddingVector> {
    if (!text || text.trim().length === 0) {
      throw new AirError('INVALID_ARGUMENT', 'Text to embed cannot be empty');
    }
    const [result] = await this.embedBatch([text], options);
    if (!result) {
      throw new AirError('EMBEDDING_FAILED', 'No embedding returned from remote provider');
    }
    return result;
  }

  async embedBatch(
    texts: string[],
    options?: EmbeddingBatchOptions,
  ): Promise<EmbeddingVector[]> {
    if (texts.length === 0) {
      return [];
    }

    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (!t || t.trim().length === 0) {
        throw new AirError(
          'INVALID_ARGUMENT',
          `Text at index ${i} in embedding batch cannot be empty`,
        );
      }
    }

    const maxBatch = options?.maxBatchSize ?? this.maxBatchSize;
    const allResults: EmbeddingVector[] = [];

    // Split texts into chunks of maxBatch size
    for (let i = 0; i < texts.length; i += maxBatch) {
      if (options?.signal?.aborted) {
        throw new AirError('CANCELLED', 'Embedding batch request aborted', { retryable: false });
      }

      const chunk = texts.slice(i, i + maxBatch);
      const chunkVectors = await this.embedChunk(chunk, options);
      for (const vec of chunkVectors) {
        allResults.push(vec);
      }
    }

    return allResults;
  }

  private async embedChunk(
    chunk: string[],
    options?: EmbeddingOptions,
  ): Promise<EmbeddingVector[]> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();

    const onCallerAbort = () => {
      controller.abort();
    };

    if (options?.signal) {
      if (options.signal.aborted) {
        throw new AirError('CANCELLED', 'Embedding request aborted', { retryable: false });
      }
      options.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    const timeoutHandle = setTimeout(() => {
      controller.abort(new Error(`Embedding request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const bodyPayload = {
      model: this.model,
      input: chunk,
      dimensions: this.dimensions,
    };

    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyPayload),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        if (options?.signal?.aborted) {
          throw new AirError('CANCELLED', 'Embedding request aborted', {
            retryable: false,
            cause: err instanceof Error ? err : undefined,
          });
        }
        throw new AirError(
          'DEADLINE_EXCEEDED',
          `Embedding request to ${this.baseUrl}/embeddings timed out after ${timeoutMs}ms`,
          { retryable: true, cause: err instanceof Error ? err : undefined },
        );
      }
      throw new AirError(
        'PROVIDER_UNAVAILABLE',
        `Failed to reach embedding provider at ${this.baseUrl}: ${String(err)}`,
        { retryable: true, cause: err instanceof Error ? err : undefined },
      );
    } finally {
      clearTimeout(timeoutHandle);
      if (options?.signal) {
        options.signal.removeEventListener('abort', onCallerAbort);
      }
    }

    if (!response.ok) {
      let errBodyText = '';
      try {
        errBodyText = await response.text();
      } catch {
        // ignore body read failure
      }

      if (response.status === 401 || response.status === 403) {
        throw new AirError(
          'PROVIDER_AUTH_FAILED',
          `Embedding authentication failed (${response.status}): ${errBodyText}`,
          { retryable: false },
        );
      }
      if (response.status === 429) {
        throw new AirError(
          'PROVIDER_RATE_LIMITED',
          `Embedding provider rate limit exceeded: ${errBodyText}`,
          { retryable: true },
        );
      }
      if (response.status >= 500) {
        throw new AirError(
          'PROVIDER_UNAVAILABLE',
          `Embedding provider error (${response.status}): ${errBodyText}`,
          { retryable: true },
        );
      }
      if (response.status === 400) {
        throw new AirError(
          'PROVIDER_INVALID_REQUEST',
          `Embedding provider rejected request (${response.status}): ${errBodyText}`,
          { retryable: false },
        );
      }
      throw new AirError(
        'EMBEDDING_FAILED',
        `Embedding HTTP request failed with status ${response.status}: ${errBodyText}`,
        { retryable: response.status >= 500 },
      );
    }

    let rawJson: unknown;
    try {
      rawJson = await response.json();
    } catch (err) {
      throw new AirError(
        'DESERIALIZATION_FAILED',
        `Failed to parse embedding response JSON: ${String(err)}`,
        { retryable: false, cause: err instanceof Error ? err : undefined },
      );
    }

    const parseResult = RemoteEmbeddingApiResponseSchema.safeParse(rawJson);
    if (!parseResult.success) {
      throw new AirError(
        'VALIDATION_FAILED',
        `Invalid embedding response structure: ${parseResult.error.message}`,
        { retryable: false },
      );
    }

    const items = parseResult.data.data;
    if (items.length !== chunk.length) {
      throw new AirError(
        'EMBEDDING_FAILED',
        `Remote provider returned ${items.length} embeddings for ${chunk.length} inputs`,
        { retryable: false },
      );
    }

    // Sort by index if provided by the API
    const sorted = [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((d) => d.embedding);
  }
}

// ============================================================================
// Factory
// ============================================================================

export interface CreateEmbeddingProviderOptions {
  fetcher?: typeof fetch | undefined;
  clock?: Clock | undefined;
}

/**
 * Creates an EmbeddingProvider from configuration.
 */
export function createEmbeddingProvider(
  config: MemoryEmbeddingsConfig,
  options?: CreateEmbeddingProviderOptions,
): EmbeddingProvider {
  switch (config.provider) {
    case 'mock':
      return new MockEmbeddingProvider({
        id: 'mock-embeddings',
        dimensions: config.dimensions,
        clock: options?.clock,
      });
    case 'openai-compat':
    case 'ollama':
      return new RemoteEmbeddingProvider({
        id: `${config.provider}-embeddings`,
        model: config.model,
        dimensions: config.dimensions,
        baseUrl: config.baseUrl,
        apiKey: config.apiKeySecret,
        fetcher: options?.fetcher,
        clock: options?.clock,
      });
    default:
      return new MockEmbeddingProvider({
        id: 'mock-embeddings',
        dimensions: config.dimensions,
        clock: options?.clock,
      });
  }
}
