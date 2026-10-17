import { describe, it, expect, vi } from 'vitest';
import {
  AnthropicProvider,
  mapAnthropicHttpError,
  parseSseStream,
  type NormalizedRequest,
  type NormalizedResponse,
  type ProviderStreamEvent,
} from '../../../src/providers/index.js';
import { AirError } from '../../../src/errors/index.js';

describe('AnthropicProvider (P3-T03)', () => {
  const dummyApiKey = 'sk-ant-api03-test-secret-key-12345';

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
    it('declares correct provider ID and capabilities', () => {
      const provider = new AnthropicProvider({ apiKey: dummyApiKey });
      expect(provider.id).toBe('anthropic');
      expect(provider.capabilities).toEqual({
        streaming: true,
        toolCalling: true,
        imageInput: true,
        systemPrompt: true,
        extendedThinking: true,
        promptCaching: true,
        maxContextWindow: 200000,
      });
    });

    it('throws PROVIDER_AUTH_FAILED if apiKey is not configured', async () => {
      const provider = new AnthropicProvider();
      const req: NormalizedRequest = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      };

      await expect(provider.complete(req)).rejects.toThrowError(AirError);
      await expect(provider.complete(req)).rejects.toMatchObject({
        code: 'PROVIDER_AUTH_FAILED',
        retryable: false,
      });
    });

    it('throws PROVIDER_AUTH_FAILED if apiKey is an empty string', async () => {
      const provider = new AnthropicProvider({ apiKey: '   ' });
      const req: NormalizedRequest = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      };

      await expect(provider.complete(req)).rejects.toMatchObject({
        code: 'PROVIDER_AUTH_FAILED',
      });
    });

    it('resolves async apiKey resolver function', async () => {
      const mockFetch = createMockFetch({
        body: {
          id: 'msg_123',
          model: 'claude-3-5-sonnet-20241022',
          content: [{ type: 'text', text: 'Hello!' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });

      const keyResolver = vi.fn().mockResolvedValue('async-secret-key');
      const provider = new AnthropicProvider({
        apiKey: keyResolver,
        fetch: mockFetch as unknown as typeof fetch,
      });

      const res = await provider.complete({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      });

      expect(keyResolver).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
      const callHeaders = callInit?.headers as Record<string, string> | undefined;
      expect(callHeaders?.['x-api-key']).toBe('async-secret-key');
      const contentParts = res.message.content;
      expect(Array.isArray(contentParts) && contentParts[0]).toEqual({ type: 'text', text: 'Hello!' });
    });
  });

  describe('Request Translation & Message Formatting', () => {
    it('translates messages, system prompts, and headers correctly', async () => {
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
              id: 'msg_test',
              model: 'claude-3-5-sonnet-20241022',
              content: [{ type: 'text', text: 'Response' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 50, output_tokens: 20 },
            }),
        });
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        baseUrl: 'https://api.custom-anthropic.com/v1///',
        apiVersion: '2023-06-01',
        betas: ['output-128k-2025-02-19', 'prompt-caching-2024-07-31'],
        fetch: customFetch as unknown as typeof fetch,
      });

      const req: NormalizedRequest = {
        model: 'claude-3-5-sonnet-20241022',
        maxTokens: 2048,
        temperature: 0.7,
        topP: 0.95,
        stopSequences: ['STOP', 'END'],
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'You are helpful.' }] },
          { role: 'system', content: [{ type: 'text', text: 'Follow all rules.' }] },
          { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
        ],
      };

      await provider.complete(req);

      expect(capturedUrl).toBe('https://api.custom-anthropic.com/v1/v1/messages');
      expect(capturedHeaders).toEqual({
        'content-type': 'application/json',
        'x-api-key': dummyApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'output-128k-2025-02-19,prompt-caching-2024-07-31',
      });
      expect(capturedBody).toEqual({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] }],
        max_tokens: 2048,
        stream: false,
        system: 'You are helpful.\n\nFollow all rules.',
        temperature: 0.7,
        top_p: 0.95,
        stop_sequences: ['STOP', 'END'],
      });
    });

    it('merges consecutive messages of the same role and formats tool calls and results', async () => {
      let capturedBody: Record<string, unknown> | null = null;

      const customFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () =>
            Promise.resolve({
              id: 'msg_999',
              model: 'claude-3-5-sonnet-20241022',
              content: [{ type: 'text', text: 'Success' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 10 },
            }),
        });
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: customFetch as unknown as typeof fetch,
      });

      const req: NormalizedRequest = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [
          // Two consecutive user messages
          { role: 'user', content: [{ type: 'text', text: 'Part 1' }] },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Part 2' },
              {
                type: 'image',
                mediaType: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
              },
            ],
          },
          // Assistant message with thinking and tool call
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Let us calculate' },
              {
                type: 'tool_call',
                id: 'call_calc_1',
                name: 'calculate',
                arguments: { expr: '2+2' },
              },
            ],
          },
          // Tool message (maps to user in Anthropic)
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                toolCallId: 'call_calc_1',
                content: '4',
                isError: false,
              },
            ],
          },
        ],
      };

      await provider.complete(req);

      expect(capturedBody).not.toBeNull();
      const messages = (capturedBody as unknown as { messages: unknown[] }).messages;
      expect(messages).toHaveLength(3);

      // First merged user message
      expect(messages[0]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'text', text: 'Part 2' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            },
          },
        ],
      });

      // Assistant message
      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let us calculate' },
          {
            type: 'tool_use',
            id: 'call_calc_1',
            name: 'calculate',
            input: { expr: '2+2' },
          },
        ],
      });

      // Third message (tool_result mapped to role: 'user')
      expect(messages[2]).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_calc_1',
            content: '4',
            is_error: false,
          },
        ],
      });
    });

    it('formats tool definitions and tool choices correctly', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      const customFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () =>
            Promise.resolve({
              id: 'msg_tool',
              model: 'claude-3-5-sonnet-20241022',
              content: [{ type: 'text', text: 'Tool call' }],
              stop_reason: 'end_turn',
            }),
        });
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: customFetch as unknown as typeof fetch,
      });

      // Test tool choice: required -> any
      await provider.complete({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'run tool' }] }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather for a city',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
        toolChoice: 'required',
      });

      expect((capturedBody as unknown as { tools: unknown[] }).tools).toEqual([
        {
          name: 'get_weather',
          description: 'Get weather for a city',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ]);
      expect((capturedBody as unknown as { tool_choice: unknown }).tool_choice).toEqual({
        type: 'any',
      });

      // Test specific tool choice
      await provider.complete({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'run tool' }] }],
        tools: [
          {
            name: 'get_weather',
            description: 'fetch weather',
            parameters: { type: 'object' },
          },
        ],
        toolChoice: { type: 'tool', name: 'get_weather' },
      });

      expect((capturedBody as unknown as { tool_choice: unknown }).tool_choice).toEqual({
        type: 'tool',
        name: 'get_weather',
      });
    });

    it('configures extended thinking and adjusts max_tokens and temperature', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      const customFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () =>
            Promise.resolve({
              id: 'msg_think',
              model: 'claude-3-7-sonnet-20250219',
              content: [{ type: 'text', text: 'Done thinking' }],
              stop_reason: 'end_turn',
            }),
        });
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: customFetch as unknown as typeof fetch,
      });

      await provider.complete({
        model: 'claude-3-7-sonnet-20250219',
        thinking: { budgetTokens: 4000 },
        maxTokens: 2000, // less than thinking.budgetTokens, must be bumped
        temperature: 0.2, // should be omitted/ignored when thinking enabled
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Solve riddle' }] }],
      });

      expect((capturedBody as unknown as { thinking: unknown }).thinking).toEqual({
        type: 'enabled',
        budget_tokens: 4000,
      });
      // max_tokens should be bumped above budget_tokens
      expect((capturedBody as unknown as { max_tokens: number }).max_tokens).toBe(5024);
      // temperature should not be sent
      expect((capturedBody as unknown as { temperature?: number }).temperature).toBeUndefined();
    });

    it('throws INVALID_ARGUMENT if messages array has no conversational user/assistant messages', async () => {
      const provider = new AnthropicProvider({ apiKey: dummyApiKey });
      const req: NormalizedRequest = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'system', content: [{ type: 'text', text: 'system only' }] }],
      };

      await expect(provider.complete(req)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    });
  });

  describe('Non-streaming Complete Translation', () => {
    it('translates complex multi-part Anthropic response with usage and cache stats', async () => {
      const mockFetch = createMockFetch({
        body: {
          id: 'msg_resp_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-3-5-sonnet-20241022',
          content: [
            {
              type: 'thinking',
              thinking: 'Plan step 1',
              signature: 'sig_xyz',
            },
            {
              type: 'text',
              text: 'I will call the search tool.',
            },
            {
              type: 'tool_use',
              id: 'toolu_abc_1',
              name: 'search',
              input: '{"query":"AIR agent"}',
            },
          ],
          stop_reason: 'tool_use',
          usage: {
            input_tokens: 100,
            output_tokens: 45,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 200,
          },
        },
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      const res: NormalizedResponse = await provider.complete({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Search for AIR' }] }],
      });

      expect(res.id).toBe('msg_resp_1');
      expect(res.model).toBe('claude-3-5-sonnet-20241022');
      expect(res.stopReason).toBe('tool_calls');
      expect(res.usage).toEqual({
        promptTokens: 100,
        completionTokens: 45,
        totalTokens: 145,
        cacheReadTokens: 500,
        cacheWriteTokens: 200,
      });

      const parts = res.message.content;
      expect(Array.isArray(parts)).toBe(true);
      expect(parts).toHaveLength(3);
      if (Array.isArray(parts)) {
        expect(parts[0]).toEqual({
          type: 'thinking',
          thinking: 'Plan step 1',
          signature: 'sig_xyz',
        });
        expect(parts[1]).toEqual({
          type: 'text',
          text: 'I will call the search tool.',
        });
        expect(parts[2]).toEqual({
          type: 'tool_call',
          id: 'toolu_abc_1',
          name: 'search',
          arguments: { query: 'AIR agent' },
        });
      }
    });

    it('maps stop reasons correctly', async () => {
      const stopReasons = [
        { raw: 'end_turn', expected: 'stop' },
        { raw: 'tool_use', expected: 'tool_calls' },
        { raw: 'max_tokens', expected: 'max_tokens' },
        { raw: 'stop_sequence', expected: 'stop' },
        { raw: 'unknown_future_reason', expected: 'stop' },
      ];

      for (const { raw, expected } of stopReasons) {
        const mockFetch = createMockFetch({
          body: {
            id: 'msg_stop',
            model: 'claude-3-5-sonnet-20241022',
            content: [{ type: 'text', text: 'hello' }],
            stop_reason: raw,
            usage: { input_tokens: 5, output_tokens: 5 },
          },
        });

        const provider = new AnthropicProvider({
          apiKey: dummyApiKey,
          fetch: mockFetch as unknown as typeof fetch,
        });

        const res = await provider.complete({
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        });

        expect(res.stopReason).toBe(expected);
      }
    });
  });

  describe('Streaming Translation (SSE)', () => {
    it('translates full SSE stream sequence: thinking, text, tool calls, and usage', async () => {
      const encoder = new TextEncoder();
      const ssePayload = [
        'event: message_start\n',
        'data: {"type":"message_start","message":{"id":"msg_stream_01","model":"claude-3-5-sonnet-20241022","usage":{"input_tokens":15,"cache_read_input_tokens":100}}}\n\n',
        ': ping comment line\n\n',
        'event: content_block_start\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Thinking first..."}}\n\n',
        'event: content_block_stop\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\n',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Running tool now."}}\n\n',
        'event: content_block_stop\n',
        'data: {"type":"content_block_stop","index":1}\n\n',
        'event: content_block_start\n',
        'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_987","name":"exec"}}\n\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"dir\\"}"}}\n\n',
        'event: content_block_stop\n',
        'data: {"type":"content_block_stop","index":2}\n\n',
        'event: message_delta\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}\n\n',
        'event: message_stop\n',
        'data: {"type":"message_stop"}\n\n',
      ].join('');

      // Split into multiple fragmented byte chunks to verify SSE buffer handling across arbitrary slices
      const half = Math.floor(ssePayload.length / 2);
      const chunk1 = encoder.encode(ssePayload.slice(0, half));
      const chunk2 = encoder.encode(ssePayload.slice(half));

      const mockFetch = createMockFetch({
        headers: { 'content-type': 'text/event-stream' },
        streamChunks: [chunk1, chunk2],
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      const events: ProviderStreamEvent[] = [];
      for await (const event of provider.stream({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'exec dir' }] }],
      })) {
        events.push(event);
      }

      expect(events).toEqual([
        {
          type: 'stream_start',
          id: 'msg_stream_01',
          model: 'claude-3-5-sonnet-20241022',
        },
        {
          type: 'usage',
          usage: {
            promptTokens: 15,
            completionTokens: 0,
            totalTokens: 15,
            cacheReadTokens: 100,
          },
        },
        {
          type: 'thinking_delta',
          text: 'Thinking first...',
        },
        {
          type: 'text_delta',
          text: 'Running tool now.',
        },
        {
          type: 'tool_call_start',
          index: 0,
          id: 'toolu_987',
          name: 'exec',
        },
        {
          type: 'tool_call_delta',
          index: 0,
          argumentsDelta: '{"cmd":"dir"}',
        },
        {
          type: 'tool_call_end',
          index: 0,
          toolCall: {
            id: 'toolu_987',
            name: 'exec',
            arguments: { cmd: 'dir' },
          },
        },
        {
          type: 'usage',
          usage: {
            promptTokens: 15,
            completionTokens: 42,
            totalTokens: 57,
            cacheReadTokens: 100,
          },
        },
        {
          type: 'stream_end',
          stopReason: 'tool_calls',
          usage: {
            promptTokens: 15,
            completionTokens: 42,
            totalTokens: 57,
            cacheReadTokens: 100,
          },
        },
      ]);
    });

    it('emits error and throws AirError on SSE error event', async () => {
      const encoder = new TextEncoder();
      const ssePayload = [
        'event: message_start\n',
        'data: {"type":"message_start","message":{"id":"msg_err","model":"claude","usage":{"input_tokens":5}}}\n\n',
        'event: error\n',
        'data: {"type":"error","error":{"type":"overloaded_error","message":"Anthropic is busy"}}\n\n',
      ].join('');

      const mockFetch = createMockFetch({
        headers: { 'content-type': 'text/event-stream' },
        streamChunks: [encoder.encode(ssePayload)],
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      const streamIter = provider.stream({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      });

      const received: ProviderStreamEvent[] = [];
      await expect(async () => {
        for await (const ev of streamIter) {
          received.push(ev);
        }
      }).rejects.toMatchObject({
        code: 'PROVIDER_INVALID_REQUEST',
        message: 'Anthropic is busy',
      });

      // The stream error event was yielded prior to throwing
      expect(received.some((ev) => ev.type === 'error')).toBe(true);
    });

    it('throws PROVIDER_UNAVAILABLE when response body is null in stream', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: null,
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      const iter = provider.stream({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
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

  describe('Error Mapping & Network Faults', () => {
    it('maps 400 Bad Request to PROVIDER_INVALID_REQUEST', async () => {
      const mockFetch = createMockFetch({
        status: 400,
        body: {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'max_tokens too high',
          },
        },
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })
      ).rejects.toMatchObject({
        code: 'PROVIDER_INVALID_REQUEST',
        message: 'max_tokens too high',
        retryable: false,
      });
    });

    it('maps 401 Unauthorized to PROVIDER_AUTH_FAILED', async () => {
      const mockFetch = createMockFetch({
        status: 401,
        body: {
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'invalid x-api-key',
          },
        },
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })
      ).rejects.toMatchObject({
        code: 'PROVIDER_AUTH_FAILED',
        retryable: false,
      });
    });

    it('maps 403 Forbidden to PERMISSION_DENIED', async () => {
      const mockFetch = createMockFetch({
        status: 403,
        body: {
          type: 'error',
          error: {
            type: 'permission_error',
            message: 'account suspended',
          },
        },
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })
      ).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
        retryable: false,
      });
    });

    it('maps 404 Not Found to NOT_FOUND', async () => {
      const mockFetch = createMockFetch({
        status: 404,
        body: {
          type: 'error',
          error: {
            type: 'not_found_error',
            message: 'model not found',
          },
        },
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        retryable: false,
      });
    });

    it('maps 429 Rate Limit to PROVIDER_RATE_LIMITED and parses retry-after header', async () => {
      const mockFetch = createMockFetch({
        status: 429,
        headers: {
          'retry-after': '45',
        },
        body: {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'rate limit exceeded',
          },
        },
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      try {
        await provider.complete({
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        });
        expect.unreachable('Should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AirError);
        const airErr = err as AirError;
        expect(airErr.code).toBe('PROVIDER_RATE_LIMITED');
        expect(airErr.retryable).toBe(true);
        expect(airErr.context['retryAfterMs']).toBe(45000);
      }
    });

    it('maps 529 Overloaded to PROVIDER_UNAVAILABLE with retryable true', async () => {
      const mockFetch = createMockFetch({
        status: 529,
        body: {
          type: 'error',
          error: {
            type: 'overloaded_error',
            message: 'Overloaded',
          },
        },
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })
      ).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
    });

    it('maps 500 Internal Server Error to PROVIDER_UNAVAILABLE', async () => {
      const mockFetch = createMockFetch({
        status: 500,
        body: 'Internal Server Error',
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })
      ).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
    });

    it('maps AbortError or caller cancellation to CANCELLED', async () => {
      const abortCtrl = new AbortController();
      const mockFetch = vi.fn().mockImplementation(() => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      abortCtrl.abort();

      await expect(
        provider.complete(
          {
            model: 'claude-3-5-sonnet-20241022',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          },
          { signal: abortCtrl.signal }
        )
      ).rejects.toMatchObject({
        code: 'CANCELLED',
        retryable: false,
      });
    });

    it('maps network connection errors to PROVIDER_UNAVAILABLE', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })
      ).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
    });
  });

  describe('mapAnthropicHttpError helper directly', () => {
    it('parses HTTP date formatted retry-after header', () => {
      const targetDate = new Date(Date.now() + 60000).toUTCString();
      const headers = new Headers({ 'retry-after': targetDate });
      const err = mapAnthropicHttpError(429, { error: { message: 'slow down' } }, headers);
      expect(err.code).toBe('PROVIDER_RATE_LIMITED');
      expect(typeof err.context['retryAfterMs']).toBe('number');
      expect((err.context['retryAfterMs'] as number) > 0).toBe(true);
    });

    it('falls back to generic error codes on unusual status codes', () => {
      const err418 = mapAnthropicHttpError(418, { error: { message: "I'm a teapot" } });
      expect(err418.code).toBe('PROVIDER_ERROR');
      expect(err418.retryable).toBe(false);

      const err503 = mapAnthropicHttpError(503, { error: { message: 'Service unavailable' } });
      expect(err503.code).toBe('PROVIDER_UNAVAILABLE');
      expect(err503.retryable).toBe(true);
    });
  });

  describe('parseSseStream helper directly', () => {
    it('handles async iterable of Uint8Array chunks with trailing data', async () => {
      const encoder = new TextEncoder();
      async function* generateChunks(): AsyncIterable<Uint8Array> {
        await Promise.resolve();
        yield encoder.encode('event: test\ndata: {"a":');
        yield encoder.encode('1}\n\nevent: done\ndata: finished');
      }

      const events: { event: string; data: string }[] = [];
      for await (const ev of parseSseStream(generateChunks())) {
        events.push(ev);
      }

      expect(events).toEqual([
        { event: 'test', data: '{"a":1}' },
        { event: 'done', data: 'finished' },
      ]);
    });

    it('respects abort signal while streaming', async () => {
      const encoder = new TextEncoder();
      const abortCtrl = new AbortController();

      async function* infiniteChunks(): AsyncIterable<Uint8Array> {
        await Promise.resolve();
        yield encoder.encode('event: chunk1\ndata: first\n\n');
        abortCtrl.abort();
        yield encoder.encode('event: chunk2\ndata: second\n\n');
      }

      const events: { event: string; data: string }[] = [];
      await expect(async () => {
        for await (const ev of parseSseStream(infiniteChunks(), abortCtrl.signal)) {
          events.push(ev);
        }
      }).rejects.toMatchObject({
        code: 'CANCELLED',
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ event: 'chunk1', data: 'first' });
    });

    it('handles non-async-iterable stream using getReader fallback and trailing event without blank line', async () => {
      const encoder = new TextEncoder();
      const chunks = [
        encoder.encode(': comment\n'),
        encoder.encode('event: update\ndata: value'),
      ];
      let readIndex = 0;
      const fakeStream = {
        getReader() {
          return {
            read() {
              if (readIndex < chunks.length) {
                const value = chunks[readIndex];
                readIndex++;
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

      const events: { event: string; data: string }[] = [];
      for await (const ev of parseSseStream(fakeStream)) {
        events.push(ev);
      }

      expect(events).toEqual([{ event: 'update', data: 'value' }]);
    });
  });

  describe('Edge Cases & Branch Coverage', () => {
    it('handles toolChoice auto and array system prompts', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      const customFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () =>
            Promise.resolve({
              id: 'msg_edge',
              model: 'claude-3-5-sonnet-20241022',
              content: [
                {
                  type: 'tool_use',
                  id: 'call_1',
                  name: 'test_tool',
                  input: { a: 1 },
                },
              ],
              stop_reason: 'tool_use',
            }),
        });
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: customFetch as unknown as typeof fetch,
      });

      const res = await provider.complete({
        model: 'claude-3-5-sonnet-20241022',
        system: ['System line 1', 'System line 2'],
        messages: [
          { role: 'system', content: 'System line 3' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                id: 'call_str',
                name: 'str_tool',
                arguments: '{"raw":"args"}',
              },
            ],
          },
          { role: 'user', content: 'run tool' },
        ],
        tools: [
          {
            name: 'test_tool',
            description: 'test',
            parameters: { type: 'object' },
          },
        ],
        toolChoice: 'auto',
      });

      expect(capturedBody).not.toBeNull();
      expect((capturedBody as unknown as { system: string }).system).toBe(
        'System line 1\n\nSystem line 2\n\nSystem line 3'
      );
      expect((capturedBody as unknown as { tool_choice: unknown }).tool_choice).toEqual({
        type: 'auto',
      });
      const parts = res.message.content;
      expect(Array.isArray(parts) && parts[0]).toEqual({
        type: 'tool_call',
        id: 'call_1',
        name: 'test_tool',
        arguments: { a: 1 },
      });
    });

    it('handles non-JSON error body in HTTP response', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: false,
          status: 502,
          headers: new Headers(),
          json: () => Promise.reject(new Error('not json')),
          text: () => Promise.resolve('Bad Gateway text message'),
        });
      });

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: 'hello' }],
        })
      ).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'Bad Gateway text message',
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

      const provider = new AnthropicProvider({
        apiKey: dummyApiKey,
        timeoutMs: 25,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: 'hello' }],
        })
      ).rejects.toMatchObject({
        code: 'CANCELLED',
      });
    });
  });
});
