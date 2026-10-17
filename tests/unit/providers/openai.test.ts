import { describe, it, expect, vi } from 'vitest';
import {
  OpenAIProvider,
  mapOpenAiHttpError,
  type NormalizedRequest,
  type NormalizedResponse,
  type ProviderStreamEvent,
} from '../../../src/providers/index.js';
import { AirError } from '../../../src/errors/index.js';
import { FakeClock } from '../../../src/util/index.js';

describe('OpenAIProvider (P3-T04)', () => {
  const dummyApiKey = 'sk-proj-test-secret-key-12345';

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
    it('declares correct provider ID and capabilities by default', () => {
      const provider = new OpenAIProvider({ apiKey: dummyApiKey });
      expect(provider.id).toBe('openai');
      expect(provider.type).toBe('openai-compat');
      expect(provider.capabilities).toEqual({
        streaming: true,
        toolCalling: true,
        imageInput: true,
        systemPrompt: true,
        extendedThinking: true,
        promptCaching: true,
        maxContextWindow: 128000,
      });
    });

    it('supports custom id for alternate OpenAI-compatible backends like nvidia or lmstudio', () => {
      const provider = new OpenAIProvider({
        id: 'nvidia',
        type: 'nvidia',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        apiKey: 'nvapi-test-key',
      });
      expect(provider.id).toBe('nvidia');
      expect(provider.type).toBe('nvidia');
    });

    it('works without apiKey for local servers (LM Studio, llama.cpp)', async () => {
      const mockFetch = createMockFetch({
        body: {
          id: 'chatcmpl-local',
          object: 'chat.completion',
          model: 'qwen2.5-coder',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'local model response' },
              finish_reason: 'stop',
            },
          ],
        },
      });

      const provider = new OpenAIProvider({
        id: 'lmstudio',
        baseUrl: 'http://localhost:1234/v1',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const res = await provider.complete({
        model: 'qwen2.5-coder',
        messages: [{ role: 'user', content: 'hello local' }],
      });

      expect(res.id).toBe('chatcmpl-local');
      expect(res.message.content).toEqual([{ type: 'text', text: 'local model response' }]);
      const callInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
      const callHeaders = callInit?.headers as Record<string, string> | undefined;
      expect(callHeaders?.['authorization']).toBeUndefined();
    });

    it('resolves async apiKey resolver function and includes Authorization header', async () => {
      const mockFetch = createMockFetch({
        body: {
          id: 'chatcmpl-1',
          object: 'chat.completion',
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'response' },
              finish_reason: 'stop',
            },
          ],
        },
      });

      const resolver = vi.fn().mockResolvedValue('async-openai-key');
      const provider = new OpenAIProvider({
        apiKey: resolver,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await provider.complete({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(resolver).toHaveBeenCalled();
      const callInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
      const callHeaders = callInit?.headers as Record<string, string> | undefined;
      expect(callHeaders?.['authorization']).toBe('Bearer async-openai-key');
    });
  });

  describe('Request Translation & Parameters', () => {
    it('translates messages, system prompts, organization/project, and extra headers/body', async () => {
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
              id: 'chatcmpl-99',
              object: 'chat.completion',
              model: 'gpt-4o',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'done' },
                  finish_reason: 'stop',
                },
              ],
            }),
        });
      });

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        baseUrl: 'https://api.openai.com/v1///',
        organization: 'org-test-123',
        project: 'proj-air-456',
        extraHeaders: { 'X-Custom-Client': 'AIR-test' },
        extraBody: { custom_param: 'value' },
        fetch: customFetch as unknown as typeof fetch,
      });

      const req: NormalizedRequest = {
        model: 'gpt-4o',
        system: ['System line 1', 'System line 2'],
        maxTokens: 1024,
        temperature: 0.8,
        topP: 0.9,
        stopSequences: ['STOP'],
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'System msg from messages' }] },
          { role: 'user', content: 'What is AIR?' },
        ],
      };

      await provider.complete(req);

      expect(capturedUrl).toBe('https://api.openai.com/v1/chat/completions');
      expect(capturedHeaders).toEqual({
        'content-type': 'application/json',
        authorization: `Bearer ${dummyApiKey}`,
        'openai-organization': 'org-test-123',
        'openai-project': 'proj-air-456',
        'X-Custom-Client': 'AIR-test',
      });
      expect(capturedBody).toEqual({
        model: 'gpt-4o',
        system_or_extra: undefined,
        custom_param: 'value',
        max_tokens: 1024,
        temperature: 0.8,
        top_p: 0.9,
        stop: ['STOP'],
        messages: [
          { role: 'system', content: 'System line 1\n\nSystem line 2' },
          { role: 'system', content: 'System msg from messages' },
          { role: 'user', content: 'What is AIR?' },
        ],
      });
    });

    it('formats multi-part user messages with image data URLs', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      const customFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () =>
            Promise.resolve({
              id: 'chatcmpl-vision',
              object: 'chat.completion',
              model: 'gpt-4o',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'I see a dot' },
                  finish_reason: 'stop',
                },
              ],
            }),
        });
      });

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        fetch: customFetch as unknown as typeof fetch,
      });

      await provider.complete({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe image:' },
              {
                type: 'image',
                mediaType: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
              },
            ],
          },
        ],
      });

      const msgs = (capturedBody as unknown as { messages: unknown[] }).messages;
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'Describe image:' },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            },
          },
        ],
      });
    });

    it('formats tool definitions, tool choices, assistant tool_calls, and tool role messages', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      const customFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () =>
            Promise.resolve({
              id: 'chatcmpl-tools',
              object: 'chat.completion',
              model: 'gpt-4o',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Result handled' },
                  finish_reason: 'stop',
                },
              ],
            }),
        });
      });

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        fetch: customFetch as unknown as typeof fetch,
      });

      await provider.complete({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'search query' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Searching' },
              {
                type: 'tool_call',
                id: 'call_search_1',
                name: 'search',
                arguments: { q: 'AIR runtime' },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                toolCallId: 'call_search_1',
                content: { result: 'found 4 items' },
              },
            ],
          },
        ],
        tools: [
          {
            name: 'search',
            description: 'Search documents',
            parameters: {
              type: 'object',
              properties: { q: { type: 'string' } },
              required: ['q'],
            },
          },
        ],
        toolChoice: { type: 'tool', name: 'search' },
      });

      expect(capturedBody).not.toBeNull();
      const msgs = (capturedBody as unknown as { messages: unknown[] }).messages;
      expect(msgs).toHaveLength(3);
      expect(msgs[1]).toEqual({
        role: 'assistant',
        content: 'Searching',
        tool_calls: [
          {
            id: 'call_search_1',
            type: 'function',
            function: {
              name: 'search',
              arguments: JSON.stringify({ q: 'AIR runtime' }),
            },
          },
        ],
      });
      expect(msgs[2]).toEqual({
        role: 'tool',
        tool_call_id: 'call_search_1',
        content: JSON.stringify({ result: 'found 4 items' }),
      });

      expect((capturedBody as unknown as { tools: unknown[] }).tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'search',
            description: 'Search documents',
            parameters: {
              type: 'object',
              properties: { q: { type: 'string' } },
              required: ['q'],
            },
          },
        },
      ]);
      expect((capturedBody as unknown as { tool_choice: unknown }).tool_choice).toEqual({
        type: 'function',
        function: { name: 'search' },
      });
    });

    it('maps reasoning budget to reasoning_effort (low/medium/high)', async () => {
      const budgetCases = [
        { budget: 500, expected: 'low' },
        { budget: 2048, expected: 'medium' },
        { budget: 8000, expected: 'high' },
      ];

      for (const { budget, expected } of budgetCases) {
        let capturedBody: Record<string, unknown> | null = null;
        const customFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
          capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () =>
              Promise.resolve({
                id: 'chatcmpl-reason',
                object: 'chat.completion',
                model: 'o1',
                choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              }),
          });
        });

        const provider = new OpenAIProvider({
          apiKey: dummyApiKey,
          fetch: customFetch as unknown as typeof fetch,
        });

        await provider.complete({
          model: 'o1',
          thinking: { budgetTokens: budget },
          messages: [{ role: 'user', content: 'solve' }],
        });

        expect((capturedBody as unknown as { reasoning_effort: string }).reasoning_effort).toBe(expected);
      }
    });

    it('uses max_completion_tokens when useMaxCompletionTokens is set to true', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      const customFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () =>
            Promise.resolve({
              id: 'chatcmpl-o3',
              object: 'chat.completion',
              model: 'o3-mini',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            }),
        });
      });

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        useMaxCompletionTokens: true,
        fetch: customFetch as unknown as typeof fetch,
      });

      await provider.complete({
        model: 'o3-mini',
        maxTokens: 5000,
        messages: [{ role: 'user', content: 'code' }],
      });

      expect((capturedBody as unknown as { max_completion_tokens: number }).max_completion_tokens).toBe(5000);
      expect((capturedBody as unknown as { max_tokens?: number }).max_tokens).toBeUndefined();
    });

    it('supports toolChoice auto, required, and none', async () => {
      for (const choice of ['auto', 'required', 'none'] as const) {
        let capturedBody: Record<string, unknown> | null = null;
        const customFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
          capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () =>
              Promise.resolve({
                id: 'chatcmpl-choice',
                object: 'chat.completion',
                model: 'gpt-4o',
                choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              }),
          });
        });

        const provider = new OpenAIProvider({
          apiKey: dummyApiKey,
          fetch: customFetch as unknown as typeof fetch,
        });

        await provider.complete({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [{ name: 't', description: 'd', parameters: {} }],
          toolChoice: choice,
        });

        expect((capturedBody as unknown as { tool_choice: string }).tool_choice).toBe(choice);
      }
    });
  });

  describe('Non-streaming Complete Translation', () => {
    it('translates full OpenAI response with reasoning content, tool calls, and cached token usage', async () => {
      const mockFetch = createMockFetch({
        body: {
          id: 'chatcmpl-full',
          object: 'chat.completion',
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                reasoning_content: 'Thought carefully about the question',
                content: 'Here is the answer.',
                tool_calls: [
                  {
                    id: 'call_abc_1',
                    type: 'function',
                    function: {
                      name: 'fetch_data',
                      arguments: '{"key":"value"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 60,
            total_tokens: 180,
            prompt_tokens_details: {
              cached_tokens: 64,
            },
          },
        },
      });

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      const res: NormalizedResponse = await provider.complete({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'fetch data' }],
      });

      expect(res.id).toBe('chatcmpl-full');
      expect(res.model).toBe('gpt-4o');
      expect(res.stopReason).toBe('tool_calls');
      expect(res.usage).toEqual({
        promptTokens: 120,
        completionTokens: 60,
        totalTokens: 180,
        cacheReadTokens: 64,
      });

      const content = res.message.content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content).toHaveLength(3);
        expect(content[0]).toEqual({
          type: 'thinking',
          thinking: 'Thought carefully about the question',
        });
        expect(content[1]).toEqual({
          type: 'text',
          text: 'Here is the answer.',
        });
        expect(content[2]).toEqual({
          type: 'tool_call',
          id: 'call_abc_1',
          name: 'fetch_data',
          arguments: { key: 'value' },
        });
      }
    });

    it('maps finish reasons correctly', async () => {
      const reasons = [
        { raw: 'stop', expected: 'stop' },
        { raw: 'tool_calls', expected: 'tool_calls' },
        { raw: 'function_call', expected: 'tool_calls' },
        { raw: 'length', expected: 'max_tokens' },
        { raw: 'content_filter', expected: 'content_filter' },
        { raw: 'other_reason', expected: 'stop' },
      ];

      for (const { raw, expected } of reasons) {
        const mockFetch = createMockFetch({
          body: {
            id: 'chatcmpl-stop',
            object: 'chat.completion',
            model: 'gpt-4o',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'hi' },
                finish_reason: raw,
              },
            ],
          },
        });

        const provider = new OpenAIProvider({
          apiKey: dummyApiKey,
          fetch: mockFetch as unknown as typeof fetch,
        });

        const res = await provider.complete({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
        });

        expect(res.stopReason).toBe(expected);
      }
    });

    it('throws PROVIDER_ERROR when choices array is empty', async () => {
      const mockFetch = createMockFetch({
        body: {
          id: 'chatcmpl-empty',
          object: 'chat.completion',
          model: 'gpt-4o',
          choices: [],
        },
      });

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
        })
      ).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
        message: 'OpenAI response contained no choices',
      });
    });
  });

  describe('Streaming (SSE) & Parallel Tool-Call Delta Assembly', () => {
    it('assembles parallel tool call deltas and yields text/thinking/usage stream events', async () => {
      const encoder = new TextEncoder();
      const ssePayload = [
        'data: {"id":"chatcmpl-stream-01","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-stream-01","model":"gpt-4o","choices":[{"index":0,"delta":{"reasoning_content":"Thinking about steps..."},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-stream-01","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Let me execute two tools."},"finish_reason":null}]}\n\n',
        // Tool call 0 start
        'data: {"id":"chatcmpl-stream-01","model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_111","type":"function","function":{"name":"tool_a","arguments":""}}]},"finish_reason":null}]}\n\n',
        // Tool call 1 start
        'data: {"id":"chatcmpl-stream-01","model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_222","type":"function","function":{"name":"tool_b","arguments":""}}]},"finish_reason":null}]}\n\n',
        // Interleaved argument deltas
        'data: {"id":"chatcmpl-stream-01","model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"paramA\\":\\"val1\\""}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-stream-01","model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"paramB\\":\\"val2\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-stream-01","model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":null}]}\n\n',
        // Finish reason and usage chunk
        'data: {"id":"chatcmpl-stream-01","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":25,"completion_tokens":55,"total_tokens":80,"prompt_tokens_details":{"cached_tokens":10}}}\n\n',
        'data: [DONE]\n\n',
      ].join('');

      // Split into fragmented chunks to test cross-chunk buffer reassembly
      const mid = Math.floor(ssePayload.length / 2);
      const chunk1 = encoder.encode(ssePayload.slice(0, mid));
      const chunk2 = encoder.encode(ssePayload.slice(mid));

      const mockFetch = createMockFetch({
        headers: { 'content-type': 'text/event-stream' },
        streamChunks: [chunk1, chunk2],
      });

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      const events: ProviderStreamEvent[] = [];
      for await (const event of provider.stream({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'run tools' }],
      })) {
        events.push(event);
      }

      expect(events).toEqual([
        {
          type: 'stream_start',
          id: 'chatcmpl-stream-01',
          model: 'gpt-4o',
        },
        {
          type: 'thinking_delta',
          text: 'Thinking about steps...',
        },
        {
          type: 'text_delta',
          text: 'Let me execute two tools.',
        },
        // Tool call 0 started
        {
          type: 'tool_call_start',
          index: 0,
          id: 'call_111',
          name: 'tool_a',
        },
        // Tool call 1 started
        {
          type: 'tool_call_start',
          index: 1,
          id: 'call_222',
          name: 'tool_b',
        },
        // Argument deltas
        {
          type: 'tool_call_delta',
          index: 0,
          argumentsDelta: '{"paramA":"val1"',
        },
        {
          type: 'tool_call_delta',
          index: 1,
          argumentsDelta: '{"paramB":"val2"}',
        },
        {
          type: 'tool_call_delta',
          index: 0,
          argumentsDelta: '}',
        },
        // Usage event
        {
          type: 'usage',
          usage: {
            promptTokens: 25,
            completionTokens: 55,
            totalTokens: 80,
            cacheReadTokens: 10,
          },
        },
        // Assembled tool calls ended
        {
          type: 'tool_call_end',
          index: 0,
          toolCall: {
            id: 'call_111',
            name: 'tool_a',
            arguments: { paramA: 'val1' },
          },
        },
        {
          type: 'tool_call_end',
          index: 1,
          toolCall: {
            id: 'call_222',
            name: 'tool_b',
            arguments: { paramB: 'val2' },
          },
        },
        // Stream end event
        {
          type: 'stream_end',
          stopReason: 'tool_calls',
          usage: {
            promptTokens: 25,
            completionTokens: 55,
            totalTokens: 80,
            cacheReadTokens: 10,
          },
        },
      ]);
    });

    it('emits error event and throws when streaming chunk contains error object', async () => {
      const encoder = new TextEncoder();
      const ssePayload = [
        'data: {"error":{"message":"Model is currently overloaded","type":"server_error","code":"server_overloaded"}}\n\n',
      ].join('');

      const mockFetch = createMockFetch({
        headers: { 'content-type': 'text/event-stream' },
        streamChunks: [encoder.encode(ssePayload)],
      });

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      const iter = provider.stream({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      });

      const events: ProviderStreamEvent[] = [];
      await expect(async () => {
        for await (const ev of iter) {
          events.push(ev);
        }
      }).rejects.toMatchObject({
        code: 'PROVIDER_INVALID_REQUEST',
        message: 'Model is currently overloaded',
      });

      expect(events.some((ev) => ev.type === 'error')).toBe(true);
    });

    it('throws PROVIDER_UNAVAILABLE when response body is null in stream', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          body: null,
        });
      });

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      const iter = provider.stream({
        model: 'gpt-4o',
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

  describe('Error Mapping & Network Faults', () => {
    it('maps 400 Bad Request to PROVIDER_INVALID_REQUEST', async () => {
      const mockFetch = createMockFetch({
        status: 400,
        body: {
          error: {
            type: 'invalid_request_error',
            message: 'max_tokens exceeds model context',
          },
        },
      });

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'test' }],
        })
      ).rejects.toMatchObject({
        code: 'PROVIDER_INVALID_REQUEST',
        message: 'max_tokens exceeds model context',
        retryable: false,
      });
    });

    it('maps 401 Unauthorized to PROVIDER_AUTH_FAILED', async () => {
      const mockFetch = createMockFetch({
        status: 401,
        body: {
          error: {
            type: 'invalid_api_key',
            message: 'Incorrect API key provided',
          },
        },
      });

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'test' }],
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
          error: { message: 'Country or region not supported' },
        },
      });

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'test' }],
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
          error: { message: 'The model gpt-fake does not exist' },
        },
      });

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'gpt-fake',
          messages: [{ role: 'user', content: 'test' }],
        })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        retryable: false,
      });
    });

    it('maps 429 Rate Limit to PROVIDER_RATE_LIMITED with retry-after header', async () => {
      const mockFetch = createMockFetch({
        status: 429,
        headers: { 'retry-after': '30' },
        body: {
          error: { message: 'Rate limit reached for requests' },
        },
      });

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      try {
        await provider.complete({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'test' }],
        });
        expect.unreachable('Should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AirError);
        const airErr = err as AirError;
        expect(airErr.code).toBe('PROVIDER_RATE_LIMITED');
        expect(airErr.retryable).toBe(true);
        expect(airErr.context['retryAfterMs']).toBe(30000);
      }
    });

    it('maps 500, 502, 503, 504 to PROVIDER_UNAVAILABLE with retryable true', async () => {
      for (const status of [500, 502, 503, 504]) {
        const mockFetch = createMockFetch({
          status,
          body: { error: { message: 'Server error' } },
        });

        const provider = new OpenAIProvider({
          apiKey: dummyApiKey,
          fetch: mockFetch as unknown as typeof fetch,
        });

        await expect(
          provider.complete({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'test' }],
          })
        ).rejects.toMatchObject({
          code: 'PROVIDER_UNAVAILABLE',
          retryable: true,
        });
      }
    });

    it('maps network connection errors to PROVIDER_UNAVAILABLE', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.reject(new TypeError('fetch failed to connect'));
      });

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'test' }],
        })
      ).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
    });

    it('maps caller cancellation or AbortError to CANCELLED', async () => {
      const abortCtrl = new AbortController();
      const mockFetch = vi.fn().mockImplementation(() => {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        return Promise.reject(err);
      });

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      abortCtrl.abort();

      await expect(
        provider.complete(
          { model: 'gpt-4o', messages: [{ role: 'user', content: 'test' }] },
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

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        timeoutMs: 20,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'test' }],
        })
      ).rejects.toMatchObject({
        code: 'CANCELLED',
      });
    });

    it('handles non-JSON error body in HTTP response', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: false,
          status: 502,
          headers: new Headers(),
          json: () => Promise.reject(new Error('not json')),
          text: () => Promise.resolve('502 Bad Gateway Nginx'),
        });
      });

      const provider = new OpenAIProvider({
        apiKey: dummyApiKey,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        provider.complete({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'test' }],
        })
      ).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        message: '502 Bad Gateway Nginx',
      });
    });

    it('parses HTTP date in retry-after header using injected FakeClock', () => {
      const fakeClock = new FakeClock('2026-10-17T03:00:00.000Z');
      const targetDate = new Date('2026-10-17T03:01:00.000Z').toUTCString();
      const headers = new Headers({ 'retry-after': targetDate });

      const err = mapOpenAiHttpError(429, { error: { message: 'slow down' } }, headers, fakeClock);
      expect(err.code).toBe('PROVIDER_RATE_LIMITED');
      expect(err.context['retryAfterMs']).toBe(60000);
    });

    it('falls back to PROVIDER_ERROR on unclassified 4xx codes', () => {
      const err = mapOpenAiHttpError(418, 'I am a teapot');
      expect(err.code).toBe('PROVIDER_ERROR');
      expect(err.retryable).toBe(false);
    });
  });
});
