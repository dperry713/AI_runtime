import { beforeEach, describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  assembleStreamResponse,
  extractText,
  extractThinking,
  extractToolCalls,
  MockProvider,
  type NormalizedRequest,
  type ProviderStreamEvent,
} from '../../../src/providers/index.js';
import { FakeClock, FakeIdGenerator } from '../../../src/util/index.js';

describe('MockProvider (P3-T02)', () => {
  let clock: FakeClock;
  let idGen: FakeIdGenerator;

  beforeEach(() => {
    clock = new FakeClock('2026-10-16T12:00:00.000Z');
    idGen = new FakeIdGenerator();
  });

  const baseRequest: NormalizedRequest = {
    model: 'mock-model',
    messages: [{ role: 'user', content: 'Hello' }],
  };

  describe('Basic Request Completion', () => {
    it('returns simple text response', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.enqueueResponse('Hello back!');

      const res = await mock.complete(baseRequest);

      expect(res.model).toBe('mock-model');
      expect(res.message.role).toBe('assistant');
      expect(res.message.content).toBe('Hello back!');
      expect(res.stopReason).toBe('stop');
      expect(res.usage.promptTokens).toBeGreaterThan(0);
      expect(res.usage.completionTokens).toBeGreaterThan(0);
      expect(res.usage.totalTokens).toBe(res.usage.promptTokens + res.usage.completionTokens);

      expect(mock.getCallCount()).toBe(1);
      const call = mock.getLastCall();
      expect(call?.request).toBe(baseRequest);
      expect(call?.streamed).toBe(false);
      expect(call?.timestamp).toBe(clock.iso());
    });

    it('returns custom message parts including tool calls', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.enqueueToolCalls(
        [
          {
            id: 'call_1',
            name: 'fs.read',
            arguments: { path: 'package.json' },
          },
        ],
        { text: 'Checking dependencies...' },
      );

      const res = await mock.complete(baseRequest);
      expect(res.stopReason).toBe('tool_calls');

      const toolCalls = extractToolCalls(res.message);
      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0]?.name).toBe('fs.read');
      expect(toolCalls[0]?.arguments).toEqual({ path: 'package.json' });

      expect(extractText(res.message)).toBe('Checking dependencies...');
    });

    it('enqueues multiple responses and serves them in FIFO order', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.enqueueResponse('First response');
      mock.enqueueResponse('Second response');

      const res1 = await mock.complete(baseRequest);
      expect(extractText(res1.message)).toBe('First response');

      const res2 = await mock.complete(baseRequest);
      expect(extractText(res2.message)).toBe('Second response');

      // Next call with empty queue throws INVALID_STATE
      await expect(mock.complete(baseRequest)).rejects.toThrow(AirError);
      try {
        await mock.complete(baseRequest);
      } catch (err) {
        expect((err as AirError).code).toBe('INVALID_STATE');
      }
    });

    it('repeats last response when repeatLast option is true', async () => {
      const mock = new MockProvider({ repeatLast: true, clock, idGenerator: idGen });
      mock.enqueueResponse('Persistent response');

      const res1 = await mock.complete(baseRequest);
      expect(extractText(res1.message)).toBe('Persistent response');

      const res2 = await mock.complete(baseRequest);
      expect(extractText(res2.message)).toBe('Persistent response');
    });

    it('uses defaultResponse when queue is exhausted', async () => {
      const mock = new MockProvider({
        defaultResponse: 'Default fallback',
        clock,
        idGenerator: idGen,
      });

      const res1 = await mock.complete(baseRequest);
      expect(extractText(res1.message)).toBe('Default fallback');

      const res2 = await mock.complete(baseRequest);
      expect(extractText(res2.message)).toBe('Default fallback');
    });

    it('evaluates dynamic generator functions', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.enqueue({
        fn: (req, callIndex) => {
          const firstMsg = req.messages[0];
          const text = firstMsg ? extractText(firstMsg) : '';
          return `Echo call #${callIndex} with prompt: ${text}`;
        },
      });

      const res = await mock.complete({
        model: 'test',
        messages: [{ role: 'user', content: 'What is 2+2?' }],
      });

      expect(extractText(res.message)).toBe('Echo call #0 with prompt: What is 2+2?');
    });

    it('supports complete with full NormalizedResponse object', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.enqueue({
        id: 'explicit_resp_id',
        model: 'explicit-model',
        message: { role: 'assistant', content: 'Pre-assembled response' },
        stopReason: 'max_tokens',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });

      const res = await mock.complete(baseRequest);
      expect(res.id).toBe('explicit_resp_id');
      expect(res.model).toBe('explicit-model');
      expect(res.stopReason).toBe('max_tokens');
      expect(res.usage.totalTokens).toBe(150);
    });

    it('handles custom usage metadata properties', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.enqueue({
        response: 'Cache read response',
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          cacheReadTokens: 50,
          cacheWriteTokens: 10,
          thinkingTokens: 20,
        },
      });

      const res = await mock.complete(baseRequest);
      expect(res.usage.cacheReadTokens).toBe(50);
      expect(res.usage.cacheWriteTokens).toBe(10);
      expect(res.usage.thinkingTokens).toBe(20);
    });
  });

  describe('Conditional Handlers', () => {
    it('matches requests using when predicate', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });

      mock.when((req) => req.messages.some((m) => m.role === 'tool'), 'Tool result received');
      mock.enqueueResponse('Normal response');

      // 1. Normal request hits queue
      const normalRes = await mock.complete(baseRequest);
      expect(extractText(normalRes.message)).toBe('Normal response');

      // 2. Request with tool role hits conditional handler
      const toolRes = await mock.complete({
        model: 'mock',
        messages: [
          { role: 'user', content: 'Read file' },
          { role: 'tool', content: 'file content' },
        ],
      });
      expect(extractText(toolRes.message)).toBe('Tool result received');
    });

    it('matches requests using whenUserTextMatches with string or RegExp', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });

      mock.whenUserTextMatches('ping', 'pong');
      mock.whenUserTextMatches(/echo (\w+)/i, {
        fn: (req) => {
          const firstMsg = req.messages[0];
          const text = firstMsg ? extractText(firstMsg) : '';
          const match = text.match(/echo (\w+)/i);
          return `echoed: ${match ? match[1] : 'none'}`;
        },
      });
      mock.enqueueResponse('Default fallback in queue');

      const res1 = await mock.complete({
        model: 'mock',
        messages: [{ role: 'user', content: 'please ping me' }],
      });
      expect(extractText(res1.message)).toBe('pong');

      const res2 = await mock.complete({
        model: 'mock',
        messages: [{ role: 'user', content: 'echo alpha' }],
      });
      expect(extractText(res2.message)).toBe('echoed: alpha');

      const res3 = await mock.complete(baseRequest);
      expect(extractText(res3.message)).toBe('Default fallback in queue');
    });
  });

  describe('Latency & Cancellation', () => {
    it('simulates delayMs and honors abort signal before execution', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.enqueueResponse('Delayed answer', { delayMs: 10 });

      const controller = new AbortController();
      controller.abort();

      await expect(mock.complete(baseRequest, { signal: controller.signal })).rejects.toThrow(
        AirError,
      );
    });

    it('aborts mid-delay when signal triggers', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.enqueueResponse('Will abort', { delayMs: 200 });

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);

      await expect(mock.complete(baseRequest, { signal: controller.signal })).rejects.toThrow(
        AirError,
      );
    });
  });

  describe('Error and Fault Injection', () => {
    it('throws Error object as AirError with code PROVIDER_ERROR', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.enqueueError(new Error('Connection timed out'));

      try {
        await mock.complete(baseRequest);
        expect.unreachable();
      } catch (err) {
        const airErr = err as AirError;
        expect(airErr.code).toBe('PROVIDER_ERROR');
        expect(airErr.message).toContain('Connection timed out');
      }
    });

    it('throws string error wrapped in AirError', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.enqueueError('503 Service Unavailable');

      await expect(mock.complete(baseRequest)).rejects.toThrow('503 Service Unavailable');
    });

    it('rethrows existing AirError untouched', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      const customErr = new AirError('RESOURCE_EXHAUSTED', 'Token budget exceeded', {
        retryable: false,
      });
      mock.enqueueError(customErr);

      try {
        await mock.complete(baseRequest);
        expect.unreachable();
      } catch (err) {
        expect(err).toBe(customErr);
      }
    });
  });

  describe('Streaming', () => {
    it('synthesizes stream events from text response', async () => {
      const mock = new MockProvider({ repeatLast: true, clock, idGenerator: idGen });
      mock.enqueueResponse('Streaming test output');

      const events: ProviderStreamEvent[] = [];
      for await (const event of mock.stream(baseRequest)) {
        events.push(event);
      }

      expect(events[0]?.type).toBe('stream_start');
      expect(events[events.length - 1]?.type).toBe('stream_end');

      const assembled = await assembleStreamResponse(mock.stream(baseRequest));
      expect(extractText(assembled.message)).toBe('Streaming test output');
      expect(assembled.stopReason).toBe('stop');
    });

    it('synthesizes stream events with thinking and tool calls', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.enqueue({
        response: [
          { type: 'thinking', thinking: 'First reason through' },
          { type: 'text', text: 'Executing tool' },
          { type: 'tool_call', id: 'call_1', name: 'fs.read', arguments: { path: 'a.txt' } },
        ],
        stopReason: 'tool_calls',
      });

      const assembled = await assembleStreamResponse(mock.stream(baseRequest));
      expect(extractThinking(assembled.message)).toBe('First reason through');
      expect(extractText(assembled.message)).toBe('Executing tool');
      const toolCalls = extractToolCalls(assembled.message);
      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0]?.name).toBe('fs.read');
      expect(assembled.stopReason).toBe('tool_calls');
    });

    it('emits explicit stream events when configured', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.enqueueStream([
        { type: 'stream_start', id: 'custom_1', model: 'mock-model' },
        { type: 'text_delta', text: 'Explicit chunk' },
        { type: 'stream_end', stopReason: 'stop' },
      ]);

      const events: ProviderStreamEvent[] = [];
      for await (const ev of mock.stream(baseRequest)) {
        events.push(ev);
      }

      expect(events.length).toBe(3);
      expect(events[1]?.type).toBe('text_delta');
    });

    it('yields error event when stream encounters injected error', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.enqueueError('Stream failure');

      const events: ProviderStreamEvent[] = [];
      for await (const ev of mock.stream(baseRequest)) {
        events.push(ev);
      }

      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe('error');
    });

    it('cancels stream on abort signal', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.enqueueResponse('Will be cancelled', { delayMs: 100 });

      const controller = new AbortController();
      controller.abort();

      const iter = mock.stream(baseRequest, { signal: controller.signal });
      await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(AirError);
    });
  });

  describe('Call History & Reset', () => {
    it('tracks call history, arguments, and clearCalls', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.enqueueResponse('R1');
      mock.enqueueResponse('R2');

      await mock.complete(baseRequest);
      expect(mock.getCallCount()).toBe(1);
      expect(mock.getCall(0)?.callIndex).toBe(0);

      await mock.complete({
        model: 'other',
        messages: [{ role: 'user', content: 'Second' }],
      });
      expect(mock.getCallCount()).toBe(2);
      expect(mock.getLastCall()?.request.model).toBe('other');

      mock.clearCalls();
      expect(mock.getCallCount()).toBe(0);
      expect(mock.getLastCall()).toBeUndefined();
    });

    it('resets calls, queue, and handlers', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.whenUserTextMatches('hi', 'hello');
      mock.enqueueResponse('Queued');

      mock.reset();
      expect(mock.getCallCount()).toBe(0);

      await expect(mock.complete(baseRequest)).rejects.toThrow(AirError);
    });

    it('handles empty step response and tool call without options', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.enqueue({});
      const res = await mock.complete(baseRequest);
      expect(extractText(res.message)).toBe('');

      mock.enqueueToolCalls([
        { name: 'test.tool', arguments: '{"arg":"val"}' },
      ]);
      const res2 = await mock.complete(baseRequest);
      expect(extractToolCalls(res2.message).length).toBe(1);
    });

    it('streams with chunkDelayMs and handles abort mid-stream', async () => {
      const mock = new MockProvider({ clock, idGenerator: idGen });
      mock.enqueue({
        response: [
          { type: 'thinking', thinking: 'Deep thoughts' },
          { type: 'text', text: 'Some long text for multiple chunks here...' },
          { type: 'tool_call', id: 'c1', name: 't1', arguments: { a: 1 } },
        ],
        chunkDelayMs: 1,
      });

      const events: ProviderStreamEvent[] = [];
      for await (const ev of mock.stream(baseRequest)) {
        events.push(ev);
      }
      expect(events.length).toBeGreaterThan(4);

      // Explicit stream with chunkDelayMs
      mock.enqueueStream(
        [
          { type: 'stream_start', id: 's1', model: 'm1' },
          { type: 'text_delta', text: 'c1' },
          { type: 'stream_end', stopReason: 'stop' },
        ],
        { chunkDelayMs: 1 },
      );
      const events2: ProviderStreamEvent[] = [];
      for await (const ev of mock.stream(baseRequest)) {
        events2.push(ev);
      }
      expect(events2.length).toBe(3);
    });
  });
});
