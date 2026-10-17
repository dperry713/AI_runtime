import { describe, it, expect, vi } from 'vitest';
import {
  OllamaProvider,
  parseNdjsonStream,
  mapOllamaHttpError,
  type NormalizedRequest,
  type NormalizedResponse,
  type ProviderStreamEvent,
} from '../../../src/providers/index.js';
import { FakeClock } from '../../../src/util/index.js';

describe('OllamaProvider (P3-T05)', () => {
  function createMockFetch(response: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
    streamChunks?: Uint8Array[];
  }) {
    const status = response.status ?? 200;
    const ok = status >= 200 && status < 300;
    const headers = new Headers(response.headers ?? { 'content-type': 'application/json' });

    let bodyStream: ReadableStream<Uint8Array> | null = null;
    if (response.streamChunks) {
      const chunks = response.streamChunks;
      let chunkIdx = 0;
      bodyStream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[chunkIdx];
          if (chunk !== undefined) {
            controller.enqueue(chunk);
            chunkIdx++;
          } else {
            controller.close();
          }
        },
      });
    }

    const mockFetch = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        ok,
        status,
        headers,
        body: bodyStream,
        json: () => Promise.resolve(response.body),
        text: () =>
          Promise.resolve(
            typeof response.body === 'string' ? response.body : JSON.stringify(response.body)
          ),
      });
    });

    return mockFetch;
  }

  describe('Capabilities & Initialization', () => {
    it('declares correct provider ID, type, and capabilities by default', () => {
      const provider = new OllamaProvider();
      expect(provider.id).toBe('ollama');
      expect(provider.type).toBe('ollama');
      expect(provider.defaultModel).toBe('llama3.1');
      expect(provider.capabilities).toEqual({
        streaming: true,
        toolCalling: true,
        imageInput: true,
        systemPrompt: true,
        extendedThinking: true,
        promptCaching: false,
        maxContextWindow: 128000,
      });
    });

    it('accepts custom id, baseUrl, defaultModel, and options', () => {
      const provider = new OllamaProvider({
        id: 'ollama-remote',
        baseUrl: 'http://192.168.1.100:11434///',
        defaultModel: 'qwen2.5:32b',
        defaultMaxTokens: 8192,
        extraHeaders: { 'X-Auth': 'local-token' },
        extraOptions: { num_ctx: 32768 },
      });
      expect(provider.id).toBe('ollama-remote');
      expect(provider.defaultModel).toBe('qwen2.5:32b');
    });
  });

  describe('Request Translation & Parameters', () => {
    it('formats messages, system prompts, options, and tools for /api/chat', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      let capturedHeaders: Record<string, string> | null = null;
      let capturedUrl = '';

      const customFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = init.headers as Record<string, string>;
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () =>
            Promise.resolve({
              model: 'llama3.1',
              created_at: '2026-10-17T03:00:00Z',
              message: { role: 'assistant', content: 'Chat response' },
              done: true,
              done_reason: 'stop',
              prompt_eval_count: 40,
              eval_count: 20,
            }),
        });
      });

      const provider = new OllamaProvider({
        baseUrl: 'http://localhost:11434',
        extraHeaders: { 'X-Custom-Header': 'val' },
        extraOptions: { num_ctx: 16384 },
        fetch: customFetch as unknown as typeof fetch,
      });

      const req: NormalizedRequest = {
        model: 'llama3.1',
        system: ['System rule 1', 'System rule 2'],
        maxTokens: 2048,
        temperature: 0.7,
        topP: 0.9,
        stopSequences: ['STOP'],
        messages: [
          { role: 'system', content: 'System line 3' },
          { role: 'user', content: 'Hello Ollama' },
        ],
        tools: [
          {
            name: 'calc',
            description: 'calculate',
            parameters: { type: 'object' },
          },
        ],
      };

      await provider.complete(req);

      expect(capturedUrl).toBe('http://localhost:11434/api/chat');
      expect(capturedHeaders).toEqual({
        'content-type': 'application/json',
        'X-Custom-Header': 'val',
      });
      expect(capturedBody).toEqual({
        model: 'llama3.1',
        stream: false,
        messages: [
          { role: 'system', content: 'System rule 1\n\nSystem rule 2' },
          { role: 'system', content: 'System line 3' },
          { role: 'user', content: 'Hello Ollama' },
        ],
        options: {
          num_ctx: 16384,
          num_predict: 2048,
          temperature: 0.7,
          top_p: 0.9,
          stop: ['STOP'],
        },
        tools: [
          {
            type: 'function',
            function: {
              name: 'calc',
              description: 'calculate',
              parameters: { type: 'object' },
            },
          },
        ],
      });
    });

    it('extracts base64 image data into images array for multimodal user messages', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      const customFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () =>
            Promise.resolve({
              model: 'llava',
              message: { role: 'assistant', content: 'I see a dot' },
              done: true,
            }),
        });
      });

      const provider = new OllamaProvider({ fetch: customFetch as unknown as typeof fetch });

      await provider.complete({
        model: 'llava',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this image:' },
              {
                type: 'image',
                mediaType: 'image/png',
                data: 'base64imagecontent123',
              },
            ],
          },
        ],
      });

      const msgs = (capturedBody as unknown as { messages: unknown[] }).messages;
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toEqual({
        role: 'user',
        content: 'Describe this image:',
        images: ['base64imagecontent123'],
      });
    });

    it('formats assistant tool_calls and tool role messages correctly', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      const customFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () =>
            Promise.resolve({
              model: 'llama3.1',
              message: { role: 'assistant', content: 'handled' },
              done: true,
            }),
        });
      });

      const provider = new OllamaProvider({ fetch: customFetch as unknown as typeof fetch });

      await provider.complete({
        model: 'llama3.1',
        messages: [
          { role: 'user', content: 'run query' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'planning step' },
              { type: 'text', text: 'calling query' },
              {
                type: 'tool_call',
                id: 'call_1',
                name: 'db_query',
                arguments: { sql: 'SELECT 1' },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                toolCallId: 'call_1',
                content: { count: 1 },
              },
            ],
          },
        ],
      });

      const msgs = (capturedBody as unknown as { messages: unknown[] }).messages;
      expect(msgs).toHaveLength(3);
      expect(msgs[1]).toEqual({
        role: 'assistant',
        content: '<think>planning step</think>calling query',
        tool_calls: [
          {
            function: {
              name: 'db_query',
              arguments: { sql: 'SELECT 1' },
            },
          },
        ],
      });
      expect(msgs[2]).toEqual({
        role: 'tool',
        content: JSON.stringify({ count: 1 }),
      });
    });
  });

  describe('Non-streaming Complete Translation', () => {
    it('translates Ollama response with embedded <think> tags, tool calls, and usage', async () => {
      const mockFetch = createMockFetch({
        body: {
          model: 'deepseek-r1:8b',
          created_at: '2026-10-17T03:00:00Z',
          message: {
            role: 'assistant',
            content: '<think>\nFirst solve the math step by step.\n</think>\nThe answer is 42.',
            tool_calls: [
              {
                function: {
                  name: 'verify',
                  arguments: '{"solution":42}',
                },
              },
            ],
          },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 50,
          eval_count: 25,
          total_duration: 1200000000,
        },
      });

      const fakeClock = new FakeClock(1700000000000);
      const provider = new OllamaProvider({
        fetch: mockFetch as unknown as typeof fetch,
        clock: fakeClock,
      });

      const res: NormalizedResponse = await provider.complete({
        model: 'deepseek-r1:8b',
        messages: [{ role: 'user', content: 'solve' }],
      });

      expect(res.id).toBe('ollama_1700000000000');
      expect(res.model).toBe('deepseek-r1:8b');
      expect(res.stopReason).toBe('tool_calls');
      expect(res.usage).toEqual({
        promptTokens: 50,
        completionTokens: 25,
        totalTokens: 75,
      });

      const content = res.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content).toHaveLength(3);
        expect(content[0]).toEqual({
          type: 'thinking',
          thinking: 'First solve the math step by step.',
        });
        expect(content[1]).toEqual({
          type: 'text',
          text: 'The answer is 42.',
        });
        expect(content[2]).toEqual({
          type: 'tool_call',
          id: 'call_0',
          name: 'verify',
          arguments: { solution: 42 },
        });
      }
    });

    it('handles direct message.thinking property and done_reason length', async () => {
      const mockFetch = createMockFetch({
        body: {
          model: 'qwen2.5:7b',
          message: {
            role: 'assistant',
            thinking: 'pondering',
            content: 'truncated response',
          },
          done: true,
          done_reason: 'length',
          prompt_eval_count: 10,
          eval_count: 100,
        },
      });

      const provider = new OllamaProvider({
        fetch: mockFetch as unknown as typeof fetch,
      });

      const res = await provider.complete({
        model: 'qwen2.5:7b',
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(res.stopReason).toBe('max_tokens');
      expect(res.message.content).toEqual([
        { type: 'thinking', thinking: 'pondering' },
        { type: 'text', text: 'truncated response' },
      ]);
    });

    it('throws when Ollama response object contains error field', async () => {
      const mockFetch = createMockFetch({
        body: {
          error: 'model "nonexistent" not found, try pulling it first',
        },
      });

      const provider = new OllamaProvider({
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'nonexistent',
          messages: [{ role: 'user', content: 'hi' }],
        })
      ).rejects.toMatchObject({
        code: 'PROVIDER_INVALID_REQUEST',
        message: 'model "nonexistent" not found, try pulling it first',
      });
    });
  });

  describe('Streaming (NDJSON)', () => {
    it('streams NDJSON chunks and parses thinking tags, text, tool calls, and usage', async () => {
      const encoder = new TextEncoder();
      const ndjsonLines = [
        '{"model":"deepseek-r1","created_at":"2026-10-17T03:00:00Z","message":{"role":"assistant","content":"<think>Thinking"},"done":false}\n',
        '{"model":"deepseek-r1","message":{"content":" deeply...</think>Here"},"done":false}\n',
        '{"model":"deepseek-r1","message":{"content":" is the answer."},"done":false}\n',
        '{"model":"deepseek-r1","message":{"tool_calls":[{"function":{"name":"search","arguments":{"q":"AIR"}}}]},"done":false}\n',
        '{"model":"deepseek-r1","done":true,"done_reason":"stop","prompt_eval_count":30,"eval_count":45}\n',
      ].join('');

      // Split into arbitrary slices to test buffer assembly across chunks
      const third = Math.floor(ndjsonLines.length / 3);
      const chunk1 = encoder.encode(ndjsonLines.slice(0, third));
      const chunk2 = encoder.encode(ndjsonLines.slice(third, third * 2));
      const chunk3 = encoder.encode(ndjsonLines.slice(third * 2));

      const mockFetch = createMockFetch({
        headers: { 'content-type': 'application/x-ndjson' },
        streamChunks: [chunk1, chunk2, chunk3],
      });

      const fakeClock = new FakeClock(1710000000000);
      const provider = new OllamaProvider({
        fetch: mockFetch as unknown as typeof fetch,
        clock: fakeClock,
      });

      const events: ProviderStreamEvent[] = [];
      for await (const event of provider.stream({
        model: 'deepseek-r1',
        messages: [{ role: 'user', content: 'solve' }],
      })) {
        events.push(event);
      }

      expect(events).toEqual([
        {
          type: 'stream_start',
          id: 'ollama_1710000000000',
          model: 'deepseek-r1',
        },
        {
          type: 'thinking_delta',
          text: 'Thinking',
        },
        {
          type: 'thinking_delta',
          text: ' deeply...',
        },
        {
          type: 'text_delta',
          text: 'Here',
        },
        {
          type: 'text_delta',
          text: ' is the answer.',
        },
        {
          type: 'tool_call_start',
          index: 0,
          id: 'call_0',
          name: 'search',
        },
        {
          type: 'tool_call_delta',
          index: 0,
          argumentsDelta: JSON.stringify({ q: 'AIR' }),
        },
        {
          type: 'tool_call_end',
          index: 0,
          toolCall: {
            id: 'call_0',
            name: 'search',
            arguments: { q: 'AIR' },
          },
        },
        {
          type: 'usage',
          usage: {
            promptTokens: 30,
            completionTokens: 45,
            totalTokens: 75,
          },
        },
        {
          type: 'stream_end',
          stopReason: 'tool_calls',
          usage: {
            promptTokens: 30,
            completionTokens: 45,
            totalTokens: 75,
          },
        },
      ]);
    });

    it('emits error and throws AirError when NDJSON stream contains an error chunk', async () => {
      const encoder = new TextEncoder();
      const ndjson = '{"error":"CUDA out of memory"}\n';

      const mockFetch = createMockFetch({
        headers: { 'content-type': 'application/x-ndjson' },
        streamChunks: [encoder.encode(ndjson)],
      });

      const provider = new OllamaProvider({
        fetch: mockFetch as unknown as typeof fetch,
      });

      const iter = provider.stream({
        model: 'llama3.1',
        messages: [{ role: 'user', content: 'hi' }],
      });

      const events: ProviderStreamEvent[] = [];
      await expect(async () => {
        for await (const ev of iter) {
          events.push(ev);
        }
      }).rejects.toMatchObject({
        code: 'PROVIDER_INVALID_REQUEST',
        message: 'CUDA out of memory',
      });

      expect(events.some((ev) => ev.type === 'error')).toBe(true);
    });

    it('throws PROVIDER_UNAVAILABLE when stream response body is null', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          body: null,
        });
      });

      const provider = new OllamaProvider({ fetch: mockFetch as unknown as typeof fetch });
      const iter = provider.stream({
        model: 'llama3.1',
        messages: [{ role: 'user', content: 'hi' }],
      });

      await expect(async () => {
        for await (const chunk of iter) {
          void chunk;
        }
      }).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
      });
    });
  });

  describe('Model Management & Tool Support Detection', () => {
    it('lists installed models via /api/tags', async () => {
      const mockFetch = createMockFetch({
        body: {
          models: [
            {
              name: 'llama3.1:8b',
              model: 'llama3.1:8b',
              modified_at: '2026-10-15T12:00:00Z',
              size: 4700000000,
              digest: 'sha256:abc123',
              details: {
                format: 'gguf',
                family: 'llama',
                families: ['llama'],
                parameter_size: '8.0B',
                quantization_level: 'Q4_K_M',
              },
            },
          ],
        },
      });

      const provider = new OllamaProvider({ fetch: mockFetch as unknown as typeof fetch });
      const models = await provider.listModels();

      expect(models).toHaveLength(1);
      expect(models[0]?.name).toBe('llama3.1:8b');
      expect(models[0]?.details?.family).toBe('llama');
    });

    it('inspects model info via /api/show', async () => {
      const mockFetch = createMockFetch({
        body: {
          modelfile: 'FROM llama3.1\nPARAMETER temperature 0.7',
          parameters: 'stop "STOP"',
          template: '{{ if .Tools }}Tool support{{ end }}',
          details: { family: 'llama' },
        },
      });

      const provider = new OllamaProvider({ fetch: mockFetch as unknown as typeof fetch });
      const show = await provider.showModel('llama3.1:8b');

      expect(show.template).toContain('.Tools');
      expect(show.details?.['family']).toBe('llama');
    });

    it('detects tool support based on template and model name', async () => {
      // 1. Template contains tool keyword
      const mockFetchToolTemplate = createMockFetch({
        body: {
          template: '{{ if .Tools }}tools{{ end }}',
          modelfile: '',
        },
      });
      const provider1 = new OllamaProvider({ fetch: mockFetchToolTemplate as unknown as typeof fetch });
      expect(await provider1.hasToolSupport('custom-model')).toBe(true);

      // 2. Model family convention (e.g. qwen2.5)
      const mockFetchNoToolsTemplate = createMockFetch({
        body: {
          template: '{{ .Prompt }}',
          modelfile: '',
        },
      });
      const provider2 = new OllamaProvider({ fetch: mockFetchNoToolsTemplate as unknown as typeof fetch });
      expect(await provider2.hasToolSupport('qwen2.5-coder:7b')).toBe(true);

      // 3. Model without tool support
      expect(await provider2.hasToolSupport('phi3:mini')).toBe(false);

      // 4. Fallback on show failure
      const mockFetchFail = vi.fn().mockImplementation(() => Promise.reject(new Error('fail')));
      const provider3 = new OllamaProvider({ fetch: mockFetchFail as unknown as typeof fetch });
      expect(await provider3.hasToolSupport('llama3.1:latest')).toBe(true);
      expect(await provider3.hasToolSupport('tinyllama:latest')).toBe(false);
    });
  });

  describe('Error Mapping & Network Faults', () => {
    it('maps 404 to NOT_FOUND with message', async () => {
      const mockFetch = createMockFetch({
        status: 404,
        body: { error: 'model "llama3.1" not found, try pulling it first' },
      });

      const provider = new OllamaProvider({ fetch: mockFetch as unknown as typeof fetch });
      await expect(
        provider.complete({
          model: 'llama3.1',
          messages: [{ role: 'user', content: 'test' }],
        })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'model "llama3.1" not found, try pulling it first',
        retryable: false,
      });
    });

    it('maps network connection errors with informative Ollama status message', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.reject(new TypeError('fetch failed to connect: ECONNREFUSED 127.0.0.1:11434'));
      });

      const provider = new OllamaProvider({ fetch: mockFetch as unknown as typeof fetch });

      try {
        await provider.complete({
          model: 'llama3.1',
          messages: [{ role: 'user', content: 'test' }],
        });
        expect.unreachable('Should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(Error);
        const error = err as Error;
        expect(error.message).toContain("Is 'ollama serve' running?");
      }
    });

    it('maps caller cancellation or AbortError to CANCELLED', async () => {
      const abortCtrl = new AbortController();
      const mockFetch = vi.fn().mockImplementation(() => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      });

      const provider = new OllamaProvider({ fetch: mockFetch as unknown as typeof fetch });
      abortCtrl.abort();

      await expect(
        provider.complete(
          { model: 'llama3.1', messages: [{ role: 'user', content: 'test' }] },
          { signal: abortCtrl.signal }
        )
      ).rejects.toMatchObject({
        code: 'CANCELLED',
        retryable: false,
      });
    });

    it('triggers timeout when timeoutMs is exceeded', async () => {
      const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_, reject) => {
          if (init.signal) {
            init.signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      });

      const provider = new OllamaProvider({
        timeoutMs: 20,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'llama3.1',
          messages: [{ role: 'user', content: 'test' }],
        })
      ).rejects.toMatchObject({
        code: 'CANCELLED',
      });
    });

    it('falls back to PROVIDER_ERROR for other non-500 status codes', () => {
      const err = mapOllamaHttpError(418, 'teapot');
      expect(err.code).toBe('PROVIDER_ERROR');
      expect(err.retryable).toBe(false);

      const err500 = mapOllamaHttpError(500, { error: 'Ollama internal crash' });
      expect(err500.code).toBe('PROVIDER_UNAVAILABLE');
      expect(err500.retryable).toBe(true);
    });
  });

  describe('parseNdjsonStream directly', () => {
    it('handles async iterable of fragmented Uint8Array chunks with trailing data', async () => {
      const encoder = new TextEncoder();
      async function* generateChunks(): AsyncIterable<Uint8Array> {
        await Promise.resolve();
        yield encoder.encode('{"a":1}\n{"b":');
        yield encoder.encode('2}\n\n{"c":3}');
      }

      const items: Record<string, unknown>[] = [];
      for await (const item of parseNdjsonStream<Record<string, unknown>>(generateChunks())) {
        items.push(item);
      }

      expect(items).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    });

    it('handles non-async-iterable stream reader fallback', async () => {
      const encoder = new TextEncoder();
      const chunks = [encoder.encode('{"foo":"bar"}\n')];
      let readIdx = 0;
      const fakeStream = {
        getReader() {
          return {
            read() {
              if (readIdx < chunks.length) {
                const value = chunks[readIdx];
                readIdx++;
                return Promise.resolve({ done: false, value });
              }
              return Promise.resolve({ done: true, value: undefined });
            },
            cancel() {
              return Promise.resolve();
            },
            releaseLock() {
              // noop
            },
          };
        },
      } as unknown as ReadableStream<Uint8Array>;

      const items: Record<string, unknown>[] = [];
      for await (const item of parseNdjsonStream<Record<string, unknown>>(fakeStream)) {
        items.push(item);
      }

      expect(items).toEqual([{ foo: 'bar' }]);
    });

    it('respects abort signal while streaming', async () => {
      const encoder = new TextEncoder();
      const abortCtrl = new AbortController();

      async function* infiniteChunks(): AsyncIterable<Uint8Array> {
        await Promise.resolve();
        yield encoder.encode('{"msg":"one"}\n');
        abortCtrl.abort();
        yield encoder.encode('{"msg":"two"}\n');
      }

      const items: Record<string, unknown>[] = [];
      await expect(async () => {
        for await (const item of parseNdjsonStream<Record<string, unknown>>(infiniteChunks(), abortCtrl.signal)) {
          items.push(item);
        }
      }).rejects.toMatchObject({
        code: 'CANCELLED',
      });

      expect(items).toEqual([{ msg: 'one' }]);
    });
  });
});
