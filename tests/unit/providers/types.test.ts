import { describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  assembleStreamResponse,
  extractText,
  extractThinking,
  extractToolCalls,
  ImagePartSchema,
  isImagePart,
  isTextPart,
  isThinkingPart,
  isToolCallPart,
  isToolResultPart,
  type MessagePart,
  MessagePartSchema,
  MessageRoleSchema,
  NormalizedMessageSchema,
  NormalizedRequestSchema,
  NormalizedResponseSchema,
  ProviderCapabilitiesSchema,
  type ProviderStreamEvent,
  ProviderToolDefinitionSchema,
  StopReasonSchema,
  type TextPart,
  TextPartSchema,
  type ThinkingPart,
  ThinkingPartSchema,
  TokenUsageSchema,
  ToolCallEndEventSchema,
  type ToolCallPart,
  ToolCallPartSchema,
  ToolCallStartEventSchema,
  ToolChoiceSchema,
  ToolResultPartSchema,
} from '../../../src/providers/index.js';

describe('Provider Normalized Types & Contracts (P3-T01)', () => {
  describe('Message Roles & Parts', () => {
    it('validates supported message roles', () => {
      expect(MessageRoleSchema.parse('system')).toBe('system');
      expect(MessageRoleSchema.parse('user')).toBe('user');
      expect(MessageRoleSchema.parse('assistant')).toBe('assistant');
      expect(MessageRoleSchema.parse('tool')).toBe('tool');

      expect(() => MessageRoleSchema.parse('unknown_role')).toThrow();
    });

    it('validates TextPart schema', () => {
      const part = TextPartSchema.parse({ type: 'text', text: 'Hello, model!' });
      expect(part.type).toBe('text');
      expect(part.text).toBe('Hello, model!');
      expect(isTextPart(part)).toBe(true);
      expect(isThinkingPart(part)).toBe(false);
    });

    it('validates ThinkingPart schema', () => {
      const part = ThinkingPartSchema.parse({
        type: 'thinking',
        thinking: 'Let me reason through this...',
        signature: 'sig_123',
      });
      expect(part.type).toBe('thinking');
      expect(part.thinking).toContain('reason');
      expect(part.signature).toBe('sig_123');
      expect(isThinkingPart(part)).toBe(true);
      expect(isTextPart(part)).toBe(false);
    });

    it('validates ImagePart schema', () => {
      const part = ImagePartSchema.parse({
        type: 'image',
        mediaType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      });
      expect(part.type).toBe('image');
      expect(part.mediaType).toBe('image/png');
      expect(isImagePart(part)).toBe(true);
      expect(isTextPart(part)).toBe(false);
    });

    it('validates ToolCallPart schema with object or string arguments', () => {
      const part1 = ToolCallPartSchema.parse({
        type: 'tool_call',
        id: 'call_1',
        name: 'fs.read',
        arguments: { path: 'README.md' },
      });
      expect(part1.type).toBe('tool_call');
      expect(part1.name).toBe('fs.read');
      expect(isToolCallPart(part1)).toBe(true);

      const part2 = ToolCallPartSchema.parse({
        type: 'tool_call',
        id: 'call_2',
        name: 'exec.run',
        arguments: '{"cmd":"dir"}',
      });
      expect(part2.arguments).toBe('{"cmd":"dir"}');
      expect(isToolCallPart(part2)).toBe(true);
      expect(isToolResultPart(part2)).toBe(false);
    });

    it('validates ToolResultPart schema', () => {
      const part1 = ToolResultPartSchema.parse({
        type: 'tool_result',
        toolCallId: 'call_1',
        content: 'File contents...',
      });
      expect(part1.type).toBe('tool_result');
      expect(part1.content).toBe('File contents...');
      expect(isToolResultPart(part1)).toBe(true);

      const part2 = ToolResultPartSchema.parse({
        type: 'tool_result',
        toolCallId: 'call_2',
        content: { error: 'Not found' },
        isError: true,
      });
      expect(part2.isError).toBe(true);
      expect(isToolResultPart(part2)).toBe(true);
    });

    it('validates discriminated MessagePartSchema union', () => {
      const parsed = MessagePartSchema.parse({ type: 'text', text: 'union test' });
      expect(parsed.type).toBe('text');

      expect(() => MessagePartSchema.parse({ type: 'invalid_part', foo: 'bar' })).toThrow();
    });

    it('validates NormalizedMessageSchema with string and parts', () => {
      const msg1 = NormalizedMessageSchema.parse({
        role: 'user',
        content: 'Hello world',
      });
      expect(msg1.role).toBe('user');
      expect(typeof msg1.content).toBe('string');

      const msg2 = NormalizedMessageSchema.parse({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Pondering' },
          { type: 'text', text: 'Answer' },
        ],
        name: 'claude',
      });
      expect(msg2.name).toBe('claude');
      expect(Array.isArray(msg2.content)).toBe(true);
    });
  });

  describe('Tool Definitions & Choices', () => {
    it('validates ProviderToolDefinitionSchema', () => {
      const tool = ProviderToolDefinitionSchema.parse({
        name: 'fs.read',
        description: 'Read file contents from safe jail',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      });

      expect(tool.name).toBe('fs.read');
      expect(tool.description).toContain('Read file');
      expect(tool.parameters['type']).toBe('object');
    });

    it('validates ToolChoiceSchema options', () => {
      expect(ToolChoiceSchema.parse('auto')).toBe('auto');
      expect(ToolChoiceSchema.parse('none')).toBe('none');
      expect(ToolChoiceSchema.parse('required')).toBe('required');
      expect(ToolChoiceSchema.parse({ type: 'tool', name: 'fs.read' })).toEqual({
        type: 'tool',
        name: 'fs.read',
      });

      expect(() => ToolChoiceSchema.parse('invalid')).toThrow();
    });
  });

  describe('Normalized Request & Response', () => {
    it('validates minimal NormalizedRequestSchema', () => {
      const req = NormalizedRequestSchema.parse({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Hi' }],
      });
      expect(req.model).toBe('claude-3-7-sonnet');
      expect(req.messages.length).toBe(1);
    });

    it('validates rich NormalizedRequestSchema with all options', () => {
      const req = NormalizedRequestSchema.parse({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'What files are in this repo?' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                id: 'call_1',
                name: 'fs.list',
                arguments: { path: '.' },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                toolCallId: 'call_1',
                content: ['src', 'tests', 'package.json'],
              },
            ],
          },
        ],
        system: ['You are a helpful AI engineer.', 'Be concise.'],
        tools: [
          {
            name: 'fs.list',
            description: 'List files in directory',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
        toolChoice: 'auto',
        temperature: 0.7,
        topP: 0.95,
        maxTokens: 4096,
        stopSequences: ['<|stop|>'],
        thinking: { budgetTokens: 1024 },
        metadata: { runId: 'run_123', turnIndex: 1 },
      });

      expect(req.system).toEqual(['You are a helpful AI engineer.', 'Be concise.']);
      expect(req.temperature).toBe(0.7);
      expect(req.thinking?.budgetTokens).toBe(1024);
      expect(req.tools?.length).toBe(1);
    });

    it('rejects invalid request parameters', () => {
      expect(() =>
        NormalizedRequestSchema.parse({
          model: 'claude-3-5',
          messages: [],
          temperature: 2.5, // > 2
        }),
      ).toThrow();

      expect(() =>
        NormalizedRequestSchema.parse({
          model: 'claude-3-5',
          messages: [],
          topP: -0.1, // < 0
        }),
      ).toThrow();

      expect(() =>
        NormalizedRequestSchema.parse({
          model: 'claude-3-5',
          messages: [],
          maxTokens: 0, // must be positive
        }),
      ).toThrow();
    });

    it('validates TokenUsageSchema & StopReasonSchema', () => {
      const usage = TokenUsageSchema.parse({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        thinkingTokens: 25,
      });

      expect(usage.totalTokens).toBe(150);
      expect(usage.thinkingTokens).toBe(25);

      expect(StopReasonSchema.parse('stop')).toBe('stop');
      expect(StopReasonSchema.parse('tool_calls')).toBe('tool_calls');
      expect(StopReasonSchema.parse('max_tokens')).toBe('max_tokens');
      expect(StopReasonSchema.parse('content_filter')).toBe('content_filter');
      expect(StopReasonSchema.parse('cancelled')).toBe('cancelled');
      expect(StopReasonSchema.parse('error')).toBe('error');
    });

    it('validates NormalizedResponseSchema', () => {
      const res = NormalizedResponseSchema.parse({
        id: 'msg_01ABC',
        model: 'claude-3-7-sonnet',
        message: {
          role: 'assistant',
          content: 'Here is your answer.',
        },
        stopReason: 'stop',
        usage: {
          promptTokens: 15,
          completionTokens: 6,
          totalTokens: 21,
        },
      });

      expect(res.id).toBe('msg_01ABC');
      expect(res.stopReason).toBe('stop');
      expect(res.usage.totalTokens).toBe(21);
    });
  });

  describe('Provider Capabilities', () => {
    it('validates ProviderCapabilitiesSchema', () => {
      const caps = ProviderCapabilitiesSchema.parse({
        streaming: true,
        toolCalling: true,
        imageInput: true,
        systemPrompt: true,
        extendedThinking: true,
        promptCaching: true,
        maxContextWindow: 200000,
      });

      expect(caps.streaming).toBe(true);
      expect(caps.extendedThinking).toBe(true);
      expect(caps.maxContextWindow).toBe(200000);
    });
  });

  describe('Extraction Helpers', () => {
    it('extractText extracts text from string and part arrays', () => {
      expect(extractText({ role: 'user', content: 'Plain string' })).toBe('Plain string');

      expect(
        extractText({
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Hidden' },
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'World' },
          ],
        }),
      ).toBe('Hello World');
    });

    it('extractThinking extracts thinking tokens or returns empty', () => {
      expect(extractThinking({ role: 'user', content: 'Plain string' })).toBe('');

      expect(
        extractThinking({
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Step 1' },
            { type: 'thinking', thinking: 'Step 2' },
            { type: 'text', text: 'Final Answer' },
          ],
        }),
      ).toBe('Step 1\nStep 2');
    });

    it('extractToolCalls returns all invoked tool calls', () => {
      expect(extractToolCalls({ role: 'user', content: 'No tools' })).toEqual([]);

      const calls = extractToolCalls({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check' },
          { type: 'tool_call', id: 'c1', name: 'fs.read', arguments: { path: 'a.txt' } },
          { type: 'tool_call', id: 'c2', name: 'fs.stat', arguments: { path: 'b.txt' } },
        ],
      });

      expect(calls.length).toBe(2);
      expect(calls[0]?.name).toBe('fs.read');
      expect(calls[1]?.name).toBe('fs.stat');
    });
  });

  describe('assembleStreamResponse', () => {
    it('assembles a simple text response from stream deltas', async () => {
      async function* stream(): AsyncIterable<ProviderStreamEvent> {
        await Promise.resolve();
        yield { type: 'stream_start', id: 'res_1', model: 'test-model' };
        yield { type: 'text_delta', text: 'Hello, ' };
        yield { type: 'text_delta', text: 'world!' };
        yield {
          type: 'usage',
          usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        };
        yield { type: 'stream_end', stopReason: 'stop' };
      }

      const res = await assembleStreamResponse(stream());

      expect(res.id).toBe('res_1');
      expect(res.model).toBe('test-model');
      expect(res.message.role).toBe('assistant');
      expect(res.message.content).toBe('Hello, world!');
      expect(res.stopReason).toBe('stop');
      expect(res.usage.totalTokens).toBe(8);
    });

    it('assembles thinking and tool calls from streaming events', async () => {
      async function* stream(): AsyncIterable<ProviderStreamEvent> {
        await Promise.resolve();
        yield { type: 'stream_start', id: 'res_2', model: 'claude-3-7' };
        yield { type: 'thinking_delta', text: 'Thinking step 1... ' };
        yield { type: 'thinking_delta', text: 'Thinking step 2.' };
        yield { type: 'text_delta', text: 'I will list the files.' };
        yield { type: 'tool_call_start', index: 0, id: 'call_99', name: 'fs.list' };
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"pa' };
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: 'th":"."}' };
        yield {
          type: 'tool_call_end',
          index: 0,
          toolCall: { id: 'call_99', name: 'fs.list', arguments: { path: '.' } },
        };
        yield {
          type: 'stream_end',
          stopReason: 'tool_calls',
          usage: { promptTokens: 20, completionTokens: 15, totalTokens: 35 },
        };
      }

      const res = await assembleStreamResponse(stream());

      expect(res.id).toBe('res_2');
      expect(res.stopReason).toBe('tool_calls');
      expect(res.usage.totalTokens).toBe(35);

      const parts = res.message.content as MessagePart[];
      expect(Array.isArray(parts)).toBe(true);
      expect(parts.length).toBe(3);

      expect(parts[0]?.type).toBe('thinking');
      expect((parts[0] as ThinkingPart).thinking).toBe('Thinking step 1... Thinking step 2.');

      expect(parts[1]?.type).toBe('text');
      expect((parts[1] as TextPart).text).toBe('I will list the files.');

      expect(parts[2]?.type).toBe('tool_call');
      const toolCall = parts[2] as ToolCallPart;
      expect(toolCall.id).toBe('call_99');
      expect(toolCall.name).toBe('fs.list');
      expect(toolCall.arguments).toEqual({ path: '.' });
    });

    it('assembles tool call when argumentsDelta is JSON and no tool_call_end arguments provided', async () => {
      const toolStart = ToolCallStartEventSchema.parse({
        type: 'tool_call_start',
        index: 0,
        id: 'call_raw',
        name: 'exec.run',
      });
      expect(toolStart.name).toBe('exec.run');

      const toolEnd = ToolCallEndEventSchema.parse({
        type: 'tool_call_end',
        index: 0,
        toolCall: { id: 'call_raw', name: 'exec.run', arguments: '{"command":"echo test"}' },
      });
      expect(toolEnd.toolCall.arguments).toBe('{"command":"echo test"}');

      async function* stream(): AsyncIterable<ProviderStreamEvent> {
        await Promise.resolve();
        yield { type: 'stream_start', id: 'res_3', model: 'gpt-4o' };
        yield { type: 'tool_call_start', index: 0, id: 'call_raw', name: 'exec.run' };
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"command":"' };
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: 'echo test"}' };
        yield { type: 'stream_end', stopReason: 'tool_calls' };
      }

      const res = await assembleStreamResponse(stream());
      const parts = res.message.content as MessagePart[];
      expect(parts.length).toBe(1);
      const call = parts[0] as ToolCallPart;
      expect(call.name).toBe('exec.run');
      expect(call.arguments).toEqual({ command: 'echo test' });
    });

    it('throws AirError with code PROVIDER_ERROR on stream error event', async () => {
      async function* stream(): AsyncIterable<ProviderStreamEvent> {
        await Promise.resolve();
        yield { type: 'stream_start', id: 'res_err', model: 'fail-model' };
        yield { type: 'error', error: new Error('Rate limit exceeded') };
      }

      await expect(assembleStreamResponse(stream())).rejects.toThrow(AirError);
      try {
        await assembleStreamResponse(stream());
      } catch (err) {
        expect((err as AirError).code).toBe('PROVIDER_ERROR');
        expect((err as AirError).message).toContain('Rate limit exceeded');
      }
    });
  });
});
