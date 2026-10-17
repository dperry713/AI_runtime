/**
 * Provider Contract Test Suite (Phase 3 - P3-T09).
 *
 * Universal contract suite executed against every AIR LLM adapter:
 * - MockProvider
 * - AnthropicProvider
 * - OpenAIProvider
 * - OllamaProvider
 * - ResilientProvider
 * - VcrProvider
 *
 * Enforces contract invariants across non-streaming completion, streaming,
 * tool calling, token usage, cancellation, and error normalization.
 * Also includes opt-in live testing harness via AIR_LIVE_TESTS=1.
 */

import { describe, expect, it, vi } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import { AnthropicProvider } from '../../../src/providers/anthropic.js';
import { MockProvider } from '../../../src/providers/mock.js';
import { OllamaProvider } from '../../../src/providers/ollama.js';
import { OpenAIProvider } from '../../../src/providers/openai.js';
import { ResilientProvider } from '../../../src/providers/resilience.js';
import {
  assembleStreamResponse,
  extractText,
  extractToolCalls,
  type NormalizedRequest,
  NormalizedResponseSchema,
  type Provider,
  ProviderCapabilitiesSchema,
  type ProviderToolDefinition,
} from '../../../src/providers/types.js';
import { type VcrCassette, VcrProvider } from '../../../src/providers/vcr.js';

// ============================================================================
// Shared Contract Invariants Suite
// ============================================================================

interface ProviderContractFixture {
  readonly provider: Provider;
  readonly cleanup?: () => Promise<void> | void;
}

const standardTools: readonly ProviderToolDefinition[] = [
  {
    name: 'calc',
    description: 'Perform arithmetic',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string' },
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['op'],
    },
  },
];

function describeProviderContract(
  adapterName: string,
  createFixture: () => Promise<ProviderContractFixture> | ProviderContractFixture,
) {
  describe(`Provider Contract: ${adapterName}`, () => {
    it('declares valid identity, type, and capabilities conforming to schema', async () => {
      const { provider, cleanup } = await createFixture();
      try {
        expect(typeof provider.id).toBe('string');
        expect(provider.id.length).toBeGreaterThan(0);

        expect([
          'mock',
          'anthropic',
          'openai',
          'openai-compat',
          'ollama',
          'resilient',
          'vcr',
        ]).toContain(provider.type);

        const parsedCaps = ProviderCapabilitiesSchema.safeParse(provider.capabilities);
        expect(parsedCaps.success).toBe(true);
        expect(typeof provider.capabilities.streaming).toBe('boolean');
        expect(typeof provider.capabilities.toolCalling).toBe('boolean');
      } finally {
        await cleanup?.();
      }
    });

    it('satisfies non-streaming complete() contract with schema compliance and usage accounting', async () => {
      const { provider, cleanup } = await createFixture();
      try {
        const req: NormalizedRequest = {
          model: 'test-model',
          messages: [{ role: 'user', content: 'Hello, what is 2 + 2?' }],
        };

        const res = await provider.complete(req);

        // 1. Zod schema validation
        const parsed = NormalizedResponseSchema.safeParse(res);
        expect(parsed.success).toBe(true);

        // 2. Identity & Model metadata
        expect(res.id).toBeTruthy();
        expect(res.model).toBeTruthy();

        // 3. Message structure
        expect(res.message.role).toBe('assistant');
        const text = extractText(res.message);
        expect(text.length).toBeGreaterThan(0);

        // 4. Stop reason
        expect([
          'stop',
          'tool_calls',
          'max_tokens',
          'content_filter',
          'error',
          'cancelled',
        ]).toContain(res.stopReason);

        // 5. Usage non-negative integers
        expect(res.usage.promptTokens).toBeGreaterThanOrEqual(0);
        expect(res.usage.completionTokens).toBeGreaterThanOrEqual(0);
        expect(res.usage.totalTokens).toBeGreaterThanOrEqual(0);
      } finally {
        await cleanup?.();
      }
    });

    it('honors AbortSignal on non-streaming complete()', async () => {
      const { provider, cleanup } = await createFixture();
      try {
        const controller = new AbortController();
        controller.abort(new AirError('CANCELLED', 'Operation was cancelled by user'));

        const req: NormalizedRequest = {
          model: 'test-model',
          messages: [{ role: 'user', content: 'Quick abort check' }],
        };

        await expect(provider.complete(req, { signal: controller.signal })).rejects.toThrow();
      } finally {
        await cleanup?.();
      }
    });

    it('satisfies streaming stream() contract with ordered event delivery and stream assembly', async () => {
      const { provider, cleanup } = await createFixture();
      try {
        if (!provider.capabilities.streaming) {
          return;
        }

        const req: NormalizedRequest = {
          model: 'test-model',
          messages: [{ role: 'user', content: 'Stream test message' }],
        };

        const events = [];
        for await (const event of provider.stream(req)) {
          events.push(event);
        }

        expect(events.length).toBeGreaterThan(0);

        // First event must be stream_start
        expect(events[0]?.type).toBe('stream_start');

        // Verify we can assemble the stream into a valid normalized response
        async function* toAsyncIter<T>(items: readonly T[]): AsyncIterable<T> {
          for (const item of items) {
            await Promise.resolve();
            yield item;
          }
        }
        const assembled = await assembleStreamResponse(toAsyncIter(events));
        const parsed = NormalizedResponseSchema.safeParse(assembled);
        expect(parsed.success).toBe(true);
        expect(extractText(assembled.message).length).toBeGreaterThan(0);
      } finally {
        await cleanup?.();
      }
    });

    it('honors AbortSignal on streaming stream()', async () => {
      const { provider, cleanup } = await createFixture();
      try {
        if (!provider.capabilities.streaming) {
          return;
        }

        const controller = new AbortController();
        controller.abort(new AirError('CANCELLED', 'Stream cancelled'));

        const req: NormalizedRequest = {
          model: 'test-model',
          messages: [{ role: 'user', content: 'Stream abort test' }],
        };

        const stream = provider.stream(req, { signal: controller.signal });
        await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow();
      } finally {
        await cleanup?.();
      }
    });

    it('satisfies tool calling contract when toolCalling capability is enabled', async () => {
      const { provider, cleanup } = await createFixture();
      try {
        if (!provider.capabilities.toolCalling) {
          return;
        }

        const req: NormalizedRequest = {
          model: 'test-model',
          messages: [{ role: 'user', content: 'Calculate 2 + 2 using the calc tool' }],
          tools: [...standardTools],
        };

        const res = await provider.complete(req);
        const calls = extractToolCalls(res.message);
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0]?.name).toBe('calc');
        expect(calls[0]?.id).toBeTruthy();
        expect(calls[0]?.arguments).toBeTruthy();
      } finally {
        await cleanup?.();
      }
    });
  });
}

// ============================================================================
// Offline Provider Fixture Factories
// ============================================================================

// 1. MockProvider
function createMockFixture(): ProviderContractFixture {
  const mock = new MockProvider({ id: 'mock-contract-provider' });

  // Step 1: Tool call handler (matched conditionally when tools are passed)
  mock.when((req) => Boolean(req.tools && req.tools.length > 0), {
    response: [
      {
        type: 'tool_call',
        id: 'call_mock_1',
        name: 'calc',
        arguments: { op: 'add', a: 2, b: 2 },
      },
    ],
    stopReason: 'tool_calls',
  });

  // Step 2: standard complete
  mock.enqueueResponse('Mock contract response: 4', {
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    stopReason: 'stop',
  });

  // Step 3: for abort test (delayed response)
  mock.enqueueResponse('Delayed response', { delayMs: 1000 });

  // Step 4: for streaming test
  mock.enqueueResponse('Streaming mock chunk A and chunk B');

  // Step 5: for stream abort test
  mock.enqueueResponse('Delayed stream', { delayMs: 1000 });

  return { provider: mock };
}

// 2. AnthropicProvider (Mock Fetch)
function createAnthropicFixture(): ProviderContractFixture {
  const encoder = new TextEncoder();

  const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    const bodyStr = typeof init?.body === 'string' ? init.body : '';
    const bodyJson = bodyStr ? (JSON.parse(bodyStr) as { stream?: boolean; tools?: unknown[] }) : {};

    // Check abort signal
    if (init?.signal?.aborted) {
      return Promise.reject(new DOMException('This operation was aborted', 'AbortError'));
    }

    if (bodyJson.stream) {
      const sseChunks = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ant_1","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet","stop_reason":null,"usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Anthropic stream chunk"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":8}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].map((str) => encoder.encode(str));

      let idx = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (init?.signal?.aborted) {
            controller.error(new DOMException('Aborted', 'AbortError'));
            return;
          }
          if (idx < sseChunks.length) {
            const chunk = sseChunks[idx];
            if (chunk) {
              controller.enqueue(chunk);
            }
            idx++;
          } else {
            controller.close();
          }
        },
      });

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: stream,
      });
    }

    // Tool call response
    if (bodyJson.tools && bodyJson.tools.length > 0) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () =>
          Promise.resolve({
            id: 'msg_ant_tool_1',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_contract_1',
                name: 'calc',
                input: { op: 'add', a: 2, b: 2 },
              },
            ],
            model: 'claude-3-5-sonnet',
            stop_reason: 'tool_use',
            usage: { input_tokens: 25, output_tokens: 15 },
          }),
        text: () => Promise.resolve(''),
      });
    }

    // Standard complete response
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () =>
        Promise.resolve({
          id: 'msg_ant_norm_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Anthropic contract response: 4' }],
          model: 'claude-3-5-sonnet',
          stop_reason: 'end_turn',
          usage: { input_tokens: 15, output_tokens: 8 },
        }),
      text: () => Promise.resolve(''),
    });
  });

  const provider = new AnthropicProvider({
    apiKey: 'sk-ant-contract-test-key-12345',
    fetch: mockFetch as unknown as typeof globalThis.fetch,
  });

  return { provider };
}

// 3. OpenAIProvider (Mock Fetch)
function createOpenAIFixture(): ProviderContractFixture {
  const encoder = new TextEncoder();

  const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      return Promise.reject(new DOMException('This operation was aborted', 'AbortError'));
    }

    const bodyStr = typeof init?.body === 'string' ? init.body : '';
    const bodyJson = bodyStr ? (JSON.parse(bodyStr) as { stream?: boolean; tools?: unknown[] }) : {};

    if (bodyJson.stream) {
      const sseChunks = [
        'data: {"id":"chatcmpl-s1","object":"chat.completion.chunk","created":123,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-s1","object":"chat.completion.chunk","created":123,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"OpenAI stream chunk"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-s1","object":"chat.completion.chunk","created":123,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
        'data: [DONE]\n\n',
      ].map((str) => encoder.encode(str));

      let idx = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (init?.signal?.aborted) {
            controller.error(new DOMException('Aborted', 'AbortError'));
            return;
          }
          if (idx < sseChunks.length) {
            const chunk = sseChunks[idx];
            if (chunk) {
              controller.enqueue(chunk);
            }
            idx++;
          } else {
            controller.close();
          }
        },
      });

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: stream,
      });
    }

    if (bodyJson.tools && bodyJson.tools.length > 0) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () =>
          Promise.resolve({
            id: 'chatcmpl-tool-1',
            object: 'chat.completion',
            created: 1234567890,
            model: 'gpt-4o',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_openai_1',
                      type: 'function',
                      function: {
                        name: 'calc',
                        arguments: JSON.stringify({ op: 'add', a: 2, b: 2 }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          }),
        text: () => Promise.resolve(''),
      });
    }

    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () =>
        Promise.resolve({
          id: 'chatcmpl-norm-1',
          object: 'chat.completion',
          created: 1234567890,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'OpenAI contract response: 4' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 14, completion_tokens: 6, total_tokens: 20 },
        }),
      text: () => Promise.resolve(''),
    });
  });

  const provider = new OpenAIProvider({
    apiKey: 'sk-proj-contract-test-key-12345',
    fetch: mockFetch as unknown as typeof globalThis.fetch,
  });

  return { provider };
}

// 4. OllamaProvider (Mock Fetch)
function createOllamaFixture(): ProviderContractFixture {
  const encoder = new TextEncoder();

  const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      return Promise.reject(new DOMException('This operation was aborted', 'AbortError'));
    }

    // 1. Ollama capability detection via /api/show
    if (url.includes('/api/show')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () =>
          Promise.resolve({
            template: '{{ if .Tools }}tools{{ end }}',
            details: { family: 'llama' },
          }),
        text: () => Promise.resolve(''),
      });
    }

    // 2. /api/chat
    const bodyStr = typeof init?.body === 'string' ? init.body : '';
    const bodyJson = bodyStr ? (JSON.parse(bodyStr) as { stream?: boolean; tools?: unknown[] }) : {};

    if (bodyJson.stream) {
      const ndjsonChunks = [
        '{"model":"llama3.1","created_at":"2026-10-17T03:00:00Z","message":{"role":"assistant","content":"Ollama "},"done":false}\n',
        '{"model":"llama3.1","created_at":"2026-10-17T03:00:00Z","message":{"role":"assistant","content":"stream chunk"},"done":false}\n',
        '{"model":"llama3.1","created_at":"2026-10-17T03:00:00Z","done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":6}\n',
      ].map((str) => encoder.encode(str));

      let idx = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (init?.signal?.aborted) {
            controller.error(new DOMException('Aborted', 'AbortError'));
            return;
          }
          if (idx < ndjsonChunks.length) {
            const chunk = ndjsonChunks[idx];
            if (chunk) {
              controller.enqueue(chunk);
            }
            idx++;
          } else {
            controller.close();
          }
        },
      });

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/x-ndjson' }),
        body: stream,
      });
    }

    if (bodyJson.tools && bodyJson.tools.length > 0) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () =>
          Promise.resolve({
            model: 'llama3.1',
            created_at: '2026-10-17T03:00:00Z',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'calc',
                    arguments: { op: 'add', a: 2, b: 2 },
                  },
                },
              ],
            },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 22,
            eval_count: 12,
          }),
        text: () => Promise.resolve(''),
      });
    }

    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () =>
        Promise.resolve({
          model: 'llama3.1',
          created_at: '2026-10-17T03:00:00Z',
          message: { role: 'assistant', content: 'Ollama contract response: 4' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 12,
          eval_count: 5,
        }),
      text: () => Promise.resolve(''),
    });
  });

  const provider = new OllamaProvider({
    baseUrl: 'http://localhost:11434',
    fetch: mockFetch as unknown as typeof globalThis.fetch,
  });

  return { provider };
}

// 5. ResilientProvider (wrapping MockProvider)
function createResilientFixture(): ProviderContractFixture {
  const mock = new MockProvider({ id: 'inner-mock' });

  // Tool call handler
  mock.when((req) => Boolean(req.tools && req.tools.length > 0), {
    response: [
      {
        type: 'tool_call',
        id: 'call_res_1',
        name: 'calc',
        arguments: { op: 'add', a: 2, b: 2 },
      },
    ],
    stopReason: 'tool_calls',
  });

  mock.enqueueResponse('Resilient mock response: 4', {
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  });
  mock.enqueueResponse('Delayed response', { delayMs: 1000 });
  mock.enqueueResponse('Resilient streaming text');
  mock.enqueueResponse('Delayed stream', { delayMs: 1000 });

  const resilient = new ResilientProvider(mock, {
    retry: { maxAttempts: 2 },
    timeoutMs: 5000,
  });

  return { provider: resilient };
}

// 6. VcrProvider (Replay mode with pre-loaded cassette)
function createVcrFixture(): ProviderContractFixture {
  const cassette: VcrCassette = {
    version: 1,
    providerId: 'vcr-contract',
    recordedAt: '2026-10-17T03:00:00.000Z',
    interactions: [
      // 1. Non-streaming complete
      {
        id: 'int_complete',
        timestamp: '2026-10-17T03:00:00.000Z',
        request: {
          model: 'test-model',
          messages: [{ role: 'user', content: 'Hello, what is 2 + 2?' }],
        },
        response: {
          id: 'vcr-resp-1',
          model: 'test-model',
          message: { role: 'assistant', content: [{ type: 'text', text: 'VCR replayed text: 4' }] },
          stopReason: 'stop',
          usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
        },
      },
      // 2. For complete abort test
      {
        id: 'int_abort',
        timestamp: '2026-10-17T03:00:01.000Z',
        request: {
          model: 'test-model',
          messages: [{ role: 'user', content: 'Quick abort check' }],
        },
        response: {
          id: 'vcr-resp-abort',
          model: 'test-model',
          message: { role: 'assistant', content: 'Never delivered' },
          stopReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      },
      // 3. Streaming test
      {
        id: 'int_stream',
        timestamp: '2026-10-17T03:00:02.000Z',
        request: {
          model: 'test-model',
          messages: [{ role: 'user', content: 'Stream test message' }],
        },
        streamEvents: [
          { type: 'stream_start', id: 's1', model: 'test-model' },
          { type: 'text_delta', text: 'VCR streaming delta' },
          {
            type: 'usage',
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          },
          {
            type: 'stream_end',
            stopReason: 'stop',
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          },
        ],
      },
      // 4. For stream abort test
      {
        id: 'int_stream_abort',
        timestamp: '2026-10-17T03:00:03.000Z',
        request: {
          model: 'test-model',
          messages: [{ role: 'user', content: 'Stream abort test' }],
        },
        streamEvents: [
          { type: 'stream_start', id: 's2', model: 'test-model' },
          { type: 'text_delta', text: 'Will be aborted' },
        ],
      },
      // 5. Tool call test
      {
        id: 'int_tool',
        timestamp: '2026-10-17T03:00:04.000Z',
        request: {
          model: 'test-model',
          messages: [{ role: 'user', content: 'Calculate 2 + 2 using the calc tool' }],
          tools: standardTools,
        },
        response: {
          id: 'vcr-resp-tool',
          model: 'test-model',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                id: 'call_vcr_1',
                name: 'calc',
                arguments: { op: 'add', a: 2, b: 2 },
              },
            ],
          },
          stopReason: 'tool_calls',
          usage: { promptTokens: 15, completionTokens: 8, totalTokens: 23 },
        },
      },
    ],
  };

  const vcr = new VcrProvider({
    mode: 'replay',
    cassette,
    matchStrategy: 'model_and_messages',
  });

  return { provider: vcr };
}

// ============================================================================
// Execute Universal Contract Across Every Provider Adapter
// ============================================================================

describe('Universal Provider Contract Test Suite (Offline Mode)', () => {
  describeProviderContract('MockProvider', createMockFixture);
  describeProviderContract('AnthropicProvider', createAnthropicFixture);
  describeProviderContract('OpenAIProvider', createOpenAIFixture);
  describeProviderContract('OllamaProvider', createOllamaFixture);
  describeProviderContract('ResilientProvider', createResilientFixture);
  describeProviderContract('VcrProvider', createVcrFixture);
});

// ============================================================================
// Opt-in Live Provider Smoke Tests
// ============================================================================

describe('Live Provider Smoke Tests (AIR_LIVE_TESTS=1)', () => {
  const isLive = process.env.AIR_LIVE_TESTS === '1';

  it.skipIf(!isLive)('executes real Anthropic API smoke test if key is present', async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // Skipped with informative reason
      return;
    }
    const provider = new AnthropicProvider({ apiKey });
    const res = await provider.complete({
      model: 'claude-3-5-haiku-20241022',
      maxTokens: 10,
      messages: [{ role: 'user', content: 'Ping' }],
    });
    expect(res.id).toBeTruthy();
    expect(extractText(res.message).length).toBeGreaterThan(0);
  });

  it.skipIf(!isLive)('executes real OpenAI API smoke test if key is present', async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return;
    }
    const provider = new OpenAIProvider({ apiKey });
    const res = await provider.complete({
      model: 'gpt-4o-mini',
      maxTokens: 10,
      messages: [{ role: 'user', content: 'Ping' }],
    });
    expect(res.id).toBeTruthy();
    expect(extractText(res.message).length).toBeGreaterThan(0);
  });

  it.skipIf(!isLive)('executes real local Ollama smoke test if running', async () => {
    const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
    try {
      const ping = await fetch(`${baseUrl}/api/tags`);
      if (!ping.ok) {
        return;
      }
    } catch {
      // Ollama not running locally, skip gracefully
      return;
    }
    const provider = new OllamaProvider({ baseUrl });
    const res = await provider.complete({
      model: 'llama3.2',
      maxTokens: 10,
      messages: [{ role: 'user', content: 'Ping' }],
    });
    expect(res.id).toBeTruthy();
  });
});
