/**
 * Unit tests for embeddings, vector math, providers, and store integration (P8-T03).
 */

import { describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import { FakeClock, UlidIdGenerator } from '../../../src/util/index.js';
import {
  cosineSimilarity,
  dotProduct,
  euclideanDistance,
  vectorMagnitude,
  normalizeVector,
  rankByVector,
  MockEmbeddingProvider,
  RemoteEmbeddingProvider,
  createEmbeddingProvider,
} from '../../../src/memory/embeddings.js';
import { SqliteMemoryStore } from '../../../src/memory/index.js';

// ============================================================================
// Vector Math Tests
// ============================================================================

describe('vector math', () => {
  describe('cosineSimilarity', () => {
    it('returns 1 for identical unit vectors', () => {
      const v = [1, 0, 0];
      expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
    });

    it('returns -1 for opposite vectors', () => {
      const a = [1, 0, 0];
      const b = [-1, 0, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
    });

    it('returns 0 for orthogonal vectors', () => {
      const a = [1, 0];
      const b = [0, 1];
      expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
    });

    it('calculates accurate cosine similarity for arbitrary vectors', () => {
      const a = [1, 2, 3];
      const b = [4, 5, 6];
      // dot: 1*4 + 2*5 + 3*6 = 32
      // magA: sqrt(1+4+9) = sqrt(14)
      // magB: sqrt(16+25+36) = sqrt(77)
      // expected: 32 / sqrt(14 * 77) = 32 / sqrt(1078) ≈ 0.9746318
      const expected = 32 / Math.sqrt(14 * 77);
      expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 5);
    });

    it('returns 0 if either vector is zero-magnitude', () => {
      const a = [0, 0, 0];
      const b = [1, 2, 3];
      expect(cosineSimilarity(a, b)).toBe(0);
      expect(cosineSimilarity(b, a)).toBe(0);
    });

    it('clamps output to [-1, 1] range', () => {
      // Vectors that might slightly exceed 1 due to floating point precision
      const a = [1.0000000000000002, 0];
      const b = [1.0000000000000002, 0];
      const sim = cosineSimilarity(a, b);
      expect(sim).toBeLessThanOrEqual(1);
      expect(sim).toBeGreaterThanOrEqual(-1);
    });

    it('throws INVALID_ARGUMENT on dimension mismatch', () => {
      expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(AirError);
      expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/Vector dimension mismatch/);
    });

    it('throws INVALID_ARGUMENT on empty vector', () => {
      expect(() => cosineSimilarity([], [])).toThrow(AirError);
    });

    it('throws INVALID_ARGUMENT on non-array input', () => {
      // @ts-expect-error test invalid input
      expect(() => cosineSimilarity(null, [1])).toThrow(AirError);
      // @ts-expect-error test invalid input
      expect(() => cosineSimilarity([1], 'vector')).toThrow(AirError);
    });

    it('throws INVALID_ARGUMENT if vector contains NaN', () => {
      expect(() => cosineSimilarity([1, Number.NaN], [1, 2])).toThrow(AirError);
      expect(() => cosineSimilarity([1, 2], [1, Number.NaN])).toThrow(AirError);
    });
  });

  describe('dotProduct', () => {
    it('computes sum of products correctly', () => {
      expect(dotProduct([2, 3], [4, 5])).toBe(2 * 4 + 3 * 5);
    });

    it('throws on dimension mismatch', () => {
      expect(() => dotProduct([1], [1, 2])).toThrow(AirError);
    });
  });

  describe('euclideanDistance', () => {
    it('returns 0 for identical vectors', () => {
      expect(euclideanDistance([3, 4], [3, 4])).toBe(0);
    });

    it('calculates 3-4-5 triangle distance correctly', () => {
      expect(euclideanDistance([0, 0], [3, 4])).toBeCloseTo(5, 5);
    });

    it('throws on dimension mismatch', () => {
      expect(() => euclideanDistance([1, 2], [1])).toThrow(AirError);
    });
  });

  describe('vectorMagnitude', () => {
    it('computes magnitude correctly', () => {
      expect(vectorMagnitude([3, 4])).toBeCloseTo(5, 5);
      expect(vectorMagnitude([0, 0, 0])).toBe(0);
    });

    it('throws on non-array or NaN input', () => {
      // @ts-expect-error test invalid input
      expect(() => vectorMagnitude('bad')).toThrow(AirError);
      expect(() => vectorMagnitude([1, Number.NaN])).toThrow(AirError);
    });
  });

  describe('normalizeVector', () => {
    it('normalizes vector to unit length', () => {
      const v = [3, 4];
      const norm = normalizeVector(v);
      expect(norm).toHaveLength(2);
      expect(vectorMagnitude(norm)).toBeCloseTo(1, 5);
      expect(norm[0]).toBeCloseTo(3 / 5, 5);
      expect(norm[1]).toBeCloseTo(4 / 5, 5);
    });

    it('returns zeroes when vector is zero magnitude', () => {
      const v = [0, 0, 0];
      const norm = normalizeVector(v);
      expect(norm).toEqual([0, 0, 0]);
    });
  });

  describe('rankByVector', () => {
    const candidates = [
      { id: '1', text: 'orthogonal', embedding: [0, 1] },
      { id: '2', text: 'identical', embedding: [1, 0] },
      { id: '3', text: 'close', embedding: [0.8, 0.6] },
      { id: '4', text: 'opposite', embedding: [-1, 0] },
      { id: '5', text: 'no-embedding', embedding: null },
      { id: '6', text: 'wrong-dim', embedding: [1, 0, 0] },
    ];

    it('ranks candidates by cosine similarity in descending order', () => {
      const query = [1, 0];
      const results = rankByVector(query, candidates);

      expect(results.length).toBe(4); // 5 and 6 ignored
      expect(results[0]?.item.id).toBe('2'); // identical (sim: 1)
      expect(results[0]?.similarity).toBeCloseTo(1, 4);

      expect(results[1]?.item.id).toBe('3'); // close (sim: 0.8)
      expect(results[1]?.similarity).toBeCloseTo(0.8, 4);

      expect(results[2]?.item.id).toBe('1'); // orthogonal (sim: 0)
      expect(results[2]?.similarity).toBeCloseTo(0, 4);

      expect(results[3]?.item.id).toBe('4'); // opposite (sim: -1)
      expect(results[3]?.similarity).toBeCloseTo(-1, 4);
    });

    it('respects limit parameter', () => {
      const query = [1, 0];
      const results = rankByVector(query, candidates, { limit: 2 });
      expect(results).toHaveLength(2);
      expect(results[0]?.item.id).toBe('2');
      expect(results[1]?.item.id).toBe('3');
    });

    it('respects minSimilarity threshold', () => {
      const query = [1, 0];
      const results = rankByVector(query, candidates, { minSimilarity: 0.5 });
      expect(results).toHaveLength(2);
      expect(results[0]?.item.id).toBe('2'); // 1.0
      expect(results[1]?.item.id).toBe('3'); // 0.8
    });

    it('handles empty candidates array', () => {
      expect(rankByVector([1, 0], [])).toEqual([]);
    });
  });
});

// ============================================================================
// MockEmbeddingProvider Tests
// ============================================================================

describe('MockEmbeddingProvider', () => {
  it('generates deterministic embeddings with default dimensions (128)', async () => {
    const provider = new MockEmbeddingProvider();
    expect(provider.id).toBe('mock-embeddings');
    expect(provider.dimensions).toBe(128);

    const v1 = await provider.embed('Hello, world!');
    const v2 = await provider.embed('Hello, world!');
    const v3 = await provider.embed('Different text');

    expect(v1).toHaveLength(128);
    expect(v2).toHaveLength(128);
    expect(v1).toEqual(v2); // identical text -> identical vector
    expect(v1).not.toEqual(v3); // different text -> different vector

    // Check unit vector magnitude
    expect(vectorMagnitude(v1)).toBeCloseTo(1, 4);
  });

  it('supports custom dimensions', async () => {
    const provider = new MockEmbeddingProvider({ dimensions: 16 });
    expect(provider.dimensions).toBe(16);
    const vec = await provider.embed('test');
    expect(vec).toHaveLength(16);
  });

  it('returns canned embeddings when configured', async () => {
    const cannedVec: number[] = Array.from({ length: 4 }, (): number => 0.5);
    const provider = new MockEmbeddingProvider({
      dimensions: 4,
      cannedEmbeddings: {
        special: cannedVec,
      },
    });

    const res = await provider.embed('special');
    expect(res).toEqual(cannedVec);

    // Can set dynamically
    provider.setCanned('dynamic', [1, 0, 0, 0]);
    expect(await provider.embed('dynamic')).toEqual([1, 0, 0, 0]);
  });

  it('throws when canned embedding dimension mismatches', async () => {
    const provider = new MockEmbeddingProvider({
      dimensions: 4,
      cannedEmbeddings: {
        bad: [1, 2], // 2 dimensions instead of 4
      },
    });
    await expect(provider.embed('bad')).rejects.toThrow(AirError);
  });

  it('throws INVALID_ARGUMENT on empty text', async () => {
    const provider = new MockEmbeddingProvider();
    await expect(provider.embed('')).rejects.toThrow(AirError);
    await expect(provider.embed('   ')).rejects.toThrow(AirError);
  });

  it('embedBatch preserves order and length', async () => {
    const provider = new MockEmbeddingProvider({ dimensions: 8 });
    const batch = await provider.embedBatch(['alpha', 'beta', 'gamma']);
    expect(batch).toHaveLength(3);

    const singleAlpha = await provider.embed('alpha');
    const singleBeta = await provider.embed('beta');
    const singleGamma = await provider.embed('gamma');

    expect(batch[0]).toEqual(singleAlpha);
    expect(batch[1]).toEqual(singleBeta);
    expect(batch[2]).toEqual(singleGamma);
  });

  it('throws on empty string inside embedBatch', async () => {
    const provider = new MockEmbeddingProvider();
    await expect(provider.embedBatch(['valid', ''])).rejects.toThrow(AirError);
  });

  it('supports simulated failure', async () => {
    const provider = new MockEmbeddingProvider({ shouldFail: true });
    await expect(provider.embed('text')).rejects.toThrow(AirError);

    provider.setShouldFail(false);
    await expect(provider.embed('text')).resolves.toBeDefined();

    provider.setShouldFail(true, new Error('Custom mock error'));
    await expect(provider.embed('text')).rejects.toThrow('Custom mock error');
  });

  it('supports simulated latency and abort signal', async () => {
    const provider = new MockEmbeddingProvider({ delayMs: 50 });
    const controller = new AbortController();

    const promise = provider.embed('test', { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toThrow(AirError);
    await expect(promise).rejects.toThrow(/aborted/);
  });

  it('rejects immediately if signal already aborted', async () => {
    const provider = new MockEmbeddingProvider();
    const signal = AbortSignal.abort();
    await expect(provider.embed('test', { signal })).rejects.toThrow(AirError);
    await expect(provider.embedBatch(['test'], { signal })).rejects.toThrow(AirError);
  });
});

// ============================================================================
// RemoteEmbeddingProvider Tests
// ============================================================================

describe('RemoteEmbeddingProvider', () => {
  it('sends correct request payload and parses response', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: unknown = null;

    const mockFetcher = ((input: string | URL, init?: RequestInit): Promise<Response> => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? 'GET';
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = JSON.parse(init?.body as string);

      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { embedding: [0.1, 0.2, 0.3], index: 0 },
              { embedding: [0.4, 0.5, 0.6], index: 1 },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }) as unknown as typeof fetch;

    const provider = new RemoteEmbeddingProvider({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key-123',
      model: 'text-embedding-3-small',
      dimensions: 3,
      fetcher: mockFetcher,
    });

    const res = await provider.embedBatch(['First', 'Second']);
    expect(res).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);

    expect(capturedUrl).toBe('https://api.openai.com/v1/embeddings');
    expect(capturedMethod).toBe('POST');
    expect(capturedHeaders['Authorization']).toBe('Bearer test-key-123');
    expect(capturedBody).toEqual({
      model: 'text-embedding-3-small',
      input: ['First', 'Second'],
      dimensions: 3,
    });
  });

  it('embed single item delegates to embedBatch', async () => {
    const mockFetcher = ((): Promise<Response> => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.7, 0.8], index: 0 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }) as unknown as typeof fetch;

    const provider = new RemoteEmbeddingProvider({
      model: 'text-embedding-3-small',
      fetcher: mockFetcher,
    });

    const res = await provider.embed('Single text');
    expect(res).toEqual([0.7, 0.8]);
  });

  it('handles batch splitting when texts exceed maxBatchSize', async () => {
    let callCount = 0;
    const mockFetcher = ((_url: unknown, init?: RequestInit): Promise<Response> => {
      callCount++;
      const body = JSON.parse(init?.body as string) as { input: string[] };
      const data = body.input.map((_, i) => ({
        embedding: [callCount * 10 + i],
        index: i,
      }));
      return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));
    }) as unknown as typeof fetch;

    const provider = new RemoteEmbeddingProvider({
      model: 'text-embedding-3-small',
      maxBatchSize: 2,
      fetcher: mockFetcher,
    });

    const results = await provider.embedBatch(['a', 'b', 'c', 'd', 'e']);
    expect(callCount).toBe(3); // 2 + 2 + 1
    expect(results).toHaveLength(5);
    expect(results[0]).toEqual([10]);
    expect(results[1]).toEqual([11]);
    expect(results[2]).toEqual([20]);
    expect(results[3]).toEqual([21]);
    expect(results[4]).toEqual([30]);
  });

  it('maps HTTP 401/403 to PROVIDER_AUTH_FAILED', async () => {
    const mockFetcher = ((): Promise<Response> => {
      return Promise.resolve(new Response('Unauthorized', { status: 401 }));
    }) as unknown as typeof fetch;

    const provider = new RemoteEmbeddingProvider({
      model: 'test',
      fetcher: mockFetcher,
    });

    await expect(provider.embed('hi')).rejects.toThrow(AirError);
    await expect(provider.embed('hi')).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_FAILED',
      retryable: false,
    });
  });

  it('maps HTTP 429 to PROVIDER_RATE_LIMITED', async () => {
    const mockFetcher = ((): Promise<Response> => {
      return Promise.resolve(new Response('Rate limit reached', { status: 429 }));
    }) as unknown as typeof fetch;

    const provider = new RemoteEmbeddingProvider({
      model: 'test',
      fetcher: mockFetcher,
    });

    await expect(provider.embed('hi')).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
      retryable: true,
    });
  });

  it('maps HTTP 500+ to PROVIDER_UNAVAILABLE', async () => {
    const mockFetcher = ((): Promise<Response> => {
      return Promise.resolve(new Response('Server Error', { status: 503 }));
    }) as unknown as typeof fetch;

    const provider = new RemoteEmbeddingProvider({
      model: 'test',
      fetcher: mockFetcher,
    });

    await expect(provider.embed('hi')).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('maps network fetch rejections to PROVIDER_UNAVAILABLE', async () => {
    const mockFetcher = ((): Promise<Response> => {
      return Promise.reject(new Error('Connection refused (ECONNREFUSED)'));
    }) as unknown as typeof fetch;

    const provider = new RemoteEmbeddingProvider({
      model: 'test',
      fetcher: mockFetcher,
    });

    await expect(provider.embed('hi')).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('throws DESERIALIZATION_FAILED on invalid JSON body', async () => {
    const mockFetcher = ((): Promise<Response> => {
      return Promise.resolve(new Response('<html>not json</html>', { status: 200 }));
    }) as unknown as typeof fetch;

    const provider = new RemoteEmbeddingProvider({
      model: 'test',
      fetcher: mockFetcher,
    });

    await expect(provider.embed('hi')).rejects.toMatchObject({
      code: 'DESERIALIZATION_FAILED',
    });
  });

  it('throws VALIDATION_FAILED when API returns unexpected schema', async () => {
    const mockFetcher = ((): Promise<Response> => {
      return Promise.resolve(new Response(JSON.stringify({ result: 'wrong' }), { status: 200 }));
    }) as unknown as typeof fetch;

    const provider = new RemoteEmbeddingProvider({
      model: 'test',
      fetcher: mockFetcher,
    });

    await expect(provider.embed('hi')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('throws EMBEDDING_FAILED when count of returned embeddings mismatches input', async () => {
    const mockFetcher = ((): Promise<Response> => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ embedding: [1, 2], index: 0 }],
          }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;

    const provider = new RemoteEmbeddingProvider({
      model: 'test',
      fetcher: mockFetcher,
    });

    await expect(provider.embedBatch(['one', 'two'])).rejects.toMatchObject({
      code: 'EMBEDDING_FAILED',
    });
  });

  it('returns empty array for empty texts array', async () => {
    const provider = new RemoteEmbeddingProvider({ model: 'test' });
    const res = await provider.embedBatch([]);
    expect(res).toEqual([]);
  });

  it('throws INVALID_ARGUMENT for empty text input', async () => {
    const provider = new RemoteEmbeddingProvider({ model: 'test' });
    await expect(provider.embed('')).rejects.toThrow(AirError);
    await expect(provider.embedBatch(['valid', ' '])).rejects.toThrow(AirError);
  });
});

// ============================================================================
// createEmbeddingProvider Factory Tests
// ============================================================================

describe('createEmbeddingProvider', () => {
  it('instantiates MockEmbeddingProvider for mock config', () => {
    const p = createEmbeddingProvider({
      enabled: true,
      provider: 'mock',
      model: 'test',
      dimensions: 64,
    });
    expect(p).toBeInstanceOf(MockEmbeddingProvider);
    expect(p.dimensions).toBe(64);
  });

  it('instantiates RemoteEmbeddingProvider for openai-compat config', () => {
    const p = createEmbeddingProvider({
      enabled: true,
      provider: 'openai-compat',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(p).toBeInstanceOf(RemoteEmbeddingProvider);
    expect(p.dimensions).toBe(1536);
  });

  it('instantiates RemoteEmbeddingProvider for ollama config', () => {
    const p = createEmbeddingProvider({
      enabled: true,
      provider: 'ollama',
      model: 'nomic-embed-text',
      dimensions: 768,
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(p).toBeInstanceOf(RemoteEmbeddingProvider);
    expect(p.dimensions).toBe(768);
  });
});

// ============================================================================
// Store Integration with Vector & Hybrid Search Tests
// ============================================================================

describe('SqliteMemoryStore vector and hybrid search integration', () => {
  const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
  const idGenerator = new UlidIdGenerator(clock);

  const mockProvider = new MockEmbeddingProvider({
    dimensions: 4,
    cannedEmbeddings: {
      'doc-cats': [1, 0, 0, 0],
      'doc-dogs': [0.9, 0.1, 0, 0],
      'doc-planes': [0, 0, 1, 0],
      'query-pets': [0.95, 0.05, 0, 0],
    },
  });

  it('performs vector search using query.vector', async () => {
    const store = new SqliteMemoryStore({
      dbPath: ':memory:',
      clock,
      idGenerator,
      embeddingProvider: mockProvider,
    });

    await store.batchWrite([
      {
        kind: 'semantic',
        scope: 'global',
        title: 'doc-cats',
        content: 'Content about cats',
        embedding: [1, 0, 0, 0],
      },
      {
        kind: 'semantic',
        scope: 'global',
        title: 'doc-dogs',
        content: 'Content about dogs',
        embedding: [0.9, 0.1, 0, 0],
      },
      {
        kind: 'semantic',
        scope: 'global',
        title: 'doc-planes',
        content: 'Content about airplanes',
        embedding: [0, 0, 1, 0],
      },
    ]);

    // Vector query close to cats & dogs: [0.95, 0.05, 0, 0]
    const results = await store.search({
      query: 'pets',
      mode: 'vector',
      vector: [0.95, 0.05, 0, 0],
    });

    expect(results.length).toBe(3);
    expect(results[0]?.entry.title).toBe('doc-cats');
    expect(results[0]?.matchedBy).toBe('vector');
    expect(results[0]?.score).toBeGreaterThan(0.9);

    expect(results[1]?.entry.title).toBe('doc-dogs');
    expect(results[2]?.entry.title).toBe('doc-planes');
    expect(results[2]?.score).toBeCloseTo(0, 4);

    await store.close();
  });

  it('performs vector search embedding the query string when vector is omitted', async () => {
    const store = new SqliteMemoryStore({
      dbPath: ':memory:',
      clock,
      idGenerator,
      embeddingProvider: mockProvider,
    });

    await store.write({
      kind: 'semantic',
      scope: 'global',
      title: 'cats',
      content: 'felines',
      embedding: [1, 0, 0, 0],
    });

    // query is 'doc-cats', which mockProvider has a canned embedding for [1, 0, 0, 0]
    const results = await store.search({
      query: 'doc-cats',
      mode: 'vector',
    });

    expect(results.length).toBe(1);
    expect(results[0]?.entry.title).toBe('cats');
    expect(results[0]?.score).toBeCloseTo(1, 4);

    await store.close();
  });

  it('auto-embeds entries on write and batchWrite when autoEmbed is enabled', async () => {
    const autoEmbedProvider = new MockEmbeddingProvider({ dimensions: 4 });
    const store = new SqliteMemoryStore({
      dbPath: ':memory:',
      clock,
      idGenerator,
      embeddingProvider: autoEmbedProvider,
      autoEmbed: true,
    });

    const single = await store.write({
      kind: 'episodic',
      scope: 'global',
      title: 'Auto Embedded',
      content: 'This memory should have an embedding automatically created',
    });

    expect(single.embedding).toBeDefined();
    expect(single.embedding).toHaveLength(4);

    const batch = await store.batchWrite([
      {
        kind: 'episodic',
        scope: 'global',
        title: 'Batch 1',
        content: 'First item',
      },
      {
        kind: 'episodic',
        scope: 'global',
        title: 'Batch 2',
        content: 'Second item',
        embedding: [0, 1, 0, 0], // explicitly provided
      },
    ]);

    expect(batch[0]?.embedding).toBeDefined();
    expect(batch[0]?.embedding).toHaveLength(4);
    expect(batch[1]?.embedding).toEqual([0, 1, 0, 0]);

    await store.close();
  });

  it('performs hybrid search blending keyword and vector scores', async () => {
    const store = new SqliteMemoryStore({
      dbPath: ':memory:',
      clock,
      idGenerator,
      embeddingProvider: mockProvider,
    });

    await store.batchWrite([
      {
        kind: 'semantic',
        scope: 'global',
        title: 'TypeScript Compiler',
        content: 'TypeScript compiles to JavaScript',
        embedding: [1, 0, 0, 0],
      },
      {
        kind: 'semantic',
        scope: 'global',
        title: 'Python Interpreter',
        content: 'Python runs on CPython',
        embedding: [0, 1, 0, 0],
      },
    ]);

    const results = await store.search({
      query: 'TypeScript',
      mode: 'hybrid',
      vector: [1, 0, 0, 0],
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.matchedBy).toBe('hybrid');
    expect(results[0]?.entry.title).toBe('TypeScript Compiler');
    expect(results[0]?.highlights).toBeDefined();

    await store.close();
  });
});
