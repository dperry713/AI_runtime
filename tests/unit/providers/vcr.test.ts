/**
 * Unit tests for Provider VCR Record & Replay Harness (P3-T08).
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import { MockProvider } from '../../../src/providers/mock.js';
import { extractText, type NormalizedRequest, type ProviderStreamEvent } from '../../../src/providers/types.js';
import {
  loadCassette,
  sanitizeVcrData,
  saveCassette,
  type VcrCassette,
  VcrProvider,
} from '../../../src/providers/vcr.js';
import { redactor } from '../../../src/secrets/index.js';
import { FakeClock } from '../../../src/util/clock.js';
import { existsIn, mkdirIn, removeIn } from '../../../src/util/fs-safe.js';

describe('sanitizeVcrData', () => {
  beforeEach(() => {
    redactor.register('OAUTH_CLIENT_SECRET', 'super_secret_oauth_token_12345');
  });

  afterEach(() => {
    redactor.clear();
  });

  it('redacts registered secrets and common API key patterns from text and objects', () => {
    const input = {
      apiKey: 'sk-ant-api03-abcdef1234567890_test',
      openAiKey: 'sk-proj-12345678901234567890abcdef',
      nvidiaKey: 'nvapi-abcdef1234567890',
      authHeader: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token',
      registered: 'Secret token: super_secret_oauth_token_12345',
      nested: {
        safe: 'normal content',
        innerKey: 'sk-ant-test_key_here_123',
      },
      array: ['sk-12345678901234567890_sample', 'clean item'],
    };

    const sanitized = sanitizeVcrData(input);

    expect(sanitized.apiKey).toContain('[REDACTED');
    expect(sanitized.openAiKey).toContain('[REDACTED');
    expect(sanitized.nvidiaKey).toContain('[REDACTED');
    expect(sanitized.authHeader).toContain('Bearer [REDACTED');
    expect(sanitized.registered).toContain('[REDACTED:');
    expect(sanitized.nested.innerKey).toContain('[REDACTED');
    expect(sanitized.nested.safe).toBe('normal content');
    expect(sanitized.array[0]).toContain('[REDACTED');
    expect(sanitized.array[1]).toBe('clean item');
  });

  it('handles primitive values safely', () => {
    expect(sanitizeVcrData(42)).toBe(42);
    expect(sanitizeVcrData(true)).toBe(true);
    expect(sanitizeVcrData(null)).toBe(null);
    expect(sanitizeVcrData(undefined)).toBe(undefined);
  });
});

describe('VcrProvider (In-Memory Record and Replay)', () => {
  const dummyRequest: NormalizedRequest = {
    model: 'claude-3-5-sonnet',
    system: 'You are an AI assistant.',
    messages: [{ role: 'user', content: 'What is 2 + 2?' }],
  };

  it('records a complete() call and then replays it identically', async () => {
    const underlying = new MockProvider({ id: 'underlying-mock' });
    underlying.enqueueResponse('4');

    const clock = new FakeClock('2026-10-17T03:00:00.000Z');

    // 1. Record mode
    const recorder = new VcrProvider({
      mode: 'record',
      underlying,
      clock,
      autoSave: false,
    });

    expect(recorder.getMode()).toBe('record');
    const recordedResponse = await recorder.complete(dummyRequest);
    expect(extractText(recordedResponse.message)).toBe('4');

    const cassette = recorder.getCassette();
    expect(cassette.interactions.length).toBe(1);
    expect(cassette.interactions[0]?.request.model).toBe('claude-3-5-sonnet');
    expect(cassette.interactions[0]?.response?.message ? extractText(cassette.interactions[0].response.message) : '').toBe('4');

    // 2. Replay mode with recorded cassette (no underlying provider!)
    const replayer = new VcrProvider({
      mode: 'replay',
      cassette,
    });

    expect(replayer.getMode()).toBe('replay');
    const replayedResponse = await replayer.complete(dummyRequest);
    expect(extractText(replayedResponse.message)).toBe('4');
    expect(replayedResponse.id).toBe(recordedResponse.id);
  });

  it('records a streaming call and replays all events in exact order', async () => {
    const underlying = new MockProvider({ id: 'underlying-stream' });
    underlying.enqueueResponse('Streaming reply chunk by chunk');

    // 1. Record stream
    const recorder = new VcrProvider({
      mode: 'record',
      underlying,
      autoSave: false,
    });

    const recordedEvents: ProviderStreamEvent[] = [];
    for await (const event of recorder.stream(dummyRequest)) {
      recordedEvents.push(event);
    }

    expect(recordedEvents.length).toBeGreaterThan(0);
    const cassette = recorder.getCassette();
    expect(cassette.interactions.length).toBe(1);
    expect(cassette.interactions[0]?.streamEvents?.length).toBe(recordedEvents.length);

    // 2. Replay stream without underlying provider
    const replayer = new VcrProvider({
      mode: 'replay',
      cassette,
    });

    const replayedEvents: ProviderStreamEvent[] = [];
    for await (const event of replayer.stream(dummyRequest)) {
      replayedEvents.push(event);
    }

    expect(replayedEvents.length).toBe(recordedEvents.length);
    expect(replayedEvents).toEqual(recordedEvents);
  });

  it('throws NOT_FOUND when replaying with no matching interaction', async () => {
    const cassette: VcrCassette = {
      version: 1,
      providerId: 'vcr',
      recordedAt: '2026-10-17T03:00:00.000Z',
      interactions: [],
    };

    const replayer = new VcrProvider({
      mode: 'replay',
      cassette,
    });

    let completeError: unknown;
    try {
      await replayer.complete(dummyRequest);
    } catch (err) {
      completeError = err;
    }

    expect(completeError).toBeInstanceOf(AirError);
    expect((completeError as AirError).code).toBe('NOT_FOUND');

    let streamError: unknown;
    try {
      const stream = replayer.stream(dummyRequest);
      await stream[Symbol.asyncIterator]().next();
    } catch (err) {
      streamError = err;
    }

    expect(streamError).toBeInstanceOf(AirError);
    expect((streamError as AirError).code).toBe('NOT_FOUND');
  });

  it('supports exact matching strategy', async () => {
    const cassette: VcrCassette = {
      version: 1,
      providerId: 'vcr',
      recordedAt: '2026-10-17T03:00:00.000Z',
      interactions: [
        {
          id: 'int_1',
          timestamp: '2026-10-17T03:00:00.000Z',
          request: {
            model: 'model-a',
            messages: [{ role: 'user', content: 'Prompt A' }],
          },
          response: {
            id: 'resp_a',
            model: 'model-a',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Answer A' }] },
            stopReason: 'stop',
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          },
        },
        {
          id: 'int_2',
          timestamp: '2026-10-17T03:00:01.000Z',
          request: {
            model: 'model-b',
            messages: [{ role: 'user', content: 'Prompt B' }],
          },
          response: {
            id: 'resp_b',
            model: 'model-b',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Answer B' }] },
            stopReason: 'stop',
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          },
        },
      ],
    };

    const replayer = new VcrProvider({
      mode: 'replay',
      cassette,
      matchStrategy: 'exact',
    });

    // Requesting Model B should match int_2 directly, not int_1
    const resB = await replayer.complete({
      model: 'model-b',
      messages: [{ role: 'user', content: 'Prompt B' }],
    });
    expect(resB.id).toBe('resp_b');

    // Requesting Model A should match int_1
    const resA = await replayer.complete({
      model: 'model-a',
      messages: [{ role: 'user', content: 'Prompt A' }],
    });
    expect(resA.id).toBe('resp_a');
  });

  it('supports model_and_messages matching strategy', async () => {
    const cassette: VcrCassette = {
      version: 1,
      providerId: 'vcr',
      recordedAt: '2026-10-17T03:00:00.000Z',
      interactions: [
        {
          id: 'int_1',
          timestamp: '2026-10-17T03:00:00.000Z',
          request: {
            model: 'model-test',
            messages: [{ role: 'user', content: 'Hello' }],
            system: 'Strict recorded system prompt',
          },
          response: {
            id: 'resp_1',
            model: 'model-test',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Hello human!' }] },
            stopReason: 'stop',
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          },
        },
      ],
    };

    const replayer = new VcrProvider({
      mode: 'replay',
      cassette,
      matchStrategy: 'model_and_messages',
    });

    // Calling with a slightly different system prompt still matches because model & messages match
    const res = await replayer.complete({
      model: 'model-test',
      system: 'Different system prompt',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(res.id).toBe('resp_1');
  });

  it('forwards directly in passthrough mode', async () => {
    const underlying = new MockProvider({ id: 'underlying-passthrough' });
    underlying.enqueueResponse('Passthrough direct response');

    const vcr = new VcrProvider({
      mode: 'passthrough',
      underlying,
    });

    const res = await vcr.complete(dummyRequest);
    expect(extractText(res.message)).toBe('Passthrough direct response');
    expect(vcr.getCassette().interactions.length).toBe(0); // Not recorded

    // Passthrough streaming
    underlying.enqueueResponse('Passthrough stream chunk');
    const streamEvents: ProviderStreamEvent[] = [];
    for await (const event of vcr.stream(dummyRequest)) {
      streamEvents.push(event);
    }
    expect(streamEvents.length).toBeGreaterThan(0);
  });

  it('throws FAILED_PRECONDITION when record mode is invoked without underlying provider', async () => {
    const vcr = new VcrProvider({ mode: 'record' });
    await expect(vcr.complete(dummyRequest)).rejects.toThrow('VCR in record mode requires an underlying provider');
    const stream = vcr.stream(dummyRequest);
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow('VCR in record mode requires an underlying provider');
  });

  it('aborts replay stream cleanly when user signal is triggered', async () => {
    const cassette: VcrCassette = {
      version: 1,
      providerId: 'vcr',
      recordedAt: '2026-10-17T03:00:00.000Z',
      interactions: [
        {
          id: 'int_stream',
          timestamp: '2026-10-17T03:00:00.000Z',
          request: { model: 'test', messages: [] },
          streamEvents: [
            { type: 'stream_start', id: 's1', model: 'test' },
            { type: 'text_delta', text: 'Chunk 1' },
            { type: 'text_delta', text: 'Chunk 2' },
          ],
        },
      ],
    };

    const replayer = new VcrProvider({ mode: 'replay', cassette });
    const controller = new AbortController();
    controller.abort(new AirError('CANCELLED', 'Stop stream'));

    const stream = replayer.stream({ model: 'test', messages: [] }, { signal: controller.signal });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow('Replay stream was aborted');
  });

  it('resets replay index allowing multiple runs over the same cassette', async () => {
    const cassette: VcrCassette = {
      version: 1,
      providerId: 'vcr',
      recordedAt: '2026-10-17T03:00:00.000Z',
      interactions: [
        {
          id: 'int_1',
          timestamp: '2026-10-17T03:00:00.000Z',
          request: { model: 'test', messages: [] },
          response: {
            id: 'r1',
            model: 'test',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Repeat me' }] },
            stopReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          },
        },
      ],
    };

    const replayer = new VcrProvider({ mode: 'replay', cassette, matchStrategy: 'fifo' });
    const res1 = await replayer.complete({ model: 'test', messages: [] });
    expect(res1.id).toBe('r1');

    // Second call exhausts fifo
    await expect(replayer.complete({ model: 'test', messages: [] })).rejects.toThrow('no matching interaction found');

    // Reset allows replaying again
    replayer.resetReplayIndex();
    const res2 = await replayer.complete({ model: 'test', messages: [] });
    expect(res2.id).toBe('r1');
  });
});

describe('VcrProvider (Disk Persistence & Auto Mode)', () => {
  const testRoot = process.cwd();
  const testDir = path.join('var', 'test-transcripts');
  const cassetteRelativePath = path.join(testDir, 'cassette-auto-test.json');

  beforeEach(async () => {
    await mkdirIn(testRoot, testDir);
    if (await existsIn(testRoot, cassetteRelativePath)) {
      await removeIn(testRoot, cassetteRelativePath);
    }
  });

  afterEach(async () => {
    if (await existsIn(testRoot, cassetteRelativePath)) {
      await removeIn(testRoot, cassetteRelativePath);
    }
  });

  it('auto-records to disk when cassette file is missing, then auto-replays on next instance', async () => {
    const underlying = new MockProvider({ id: 'underlying-auto' });
    underlying.enqueueResponse('Generated on real provider');

    const request: NormalizedRequest = {
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'Generate tape' }],
    };

    // 1. First run: file does not exist -> auto mode switches to RECORD
    const vcr1 = new VcrProvider({
      mode: 'auto',
      cassettePath: cassetteRelativePath,
      cassetteRoot: testRoot,
      underlying,
    });

    const res1 = await vcr1.complete(request);
    expect(extractText(res1.message)).toBe('Generated on real provider');
    expect(vcr1.getMode()).toBe('record');

    // Verify cassette file was written to disk
    const fileExists = await existsIn(testRoot, cassetteRelativePath);
    expect(fileExists).toBe(true);

    // 2. Second run: file exists -> auto mode switches to REPLAY (no underlying provider provided!)
    const vcr2 = new VcrProvider({
      mode: 'auto',
      cassettePath: cassetteRelativePath,
      cassetteRoot: testRoot,
    });

    const res2 = await vcr2.complete(request);
    expect(extractText(res2.message)).toBe('Generated on real provider');
    expect(vcr2.getMode()).toBe('replay');
  });

  it('saveCassette and loadCassette round-trip data with schema verification', async () => {
    const cassette: VcrCassette = {
      version: 1,
      providerId: 'test-p',
      recordedAt: '2026-10-17T03:00:00.000Z',
      interactions: [
        {
          id: 'int_sample',
          timestamp: '2026-10-17T03:00:00.000Z',
          request: {
            model: 'sample-model',
            messages: [{ role: 'user', content: 'test message' }],
          },
          response: {
            id: 'resp_sample',
            model: 'sample-model',
            message: { role: 'assistant', content: [{ type: 'text', text: 'test output' }] },
            stopReason: 'stop',
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
        },
      ],
    };

    const filePath = path.join(testDir, 'roundtrip-cassette.json');
    await saveCassette(filePath, cassette, testRoot);

    const loaded = await loadCassette(filePath, testRoot);
    expect(loaded.version).toBe(1);
    expect(loaded.providerId).toBe('test-p');
    expect(loaded.interactions.length).toBe(1);
    expect(loaded.interactions[0]?.id).toBe('int_sample');

    await removeIn(testRoot, filePath);
  });

  it('throws SERIALIZATION_FAILED when loading corrupted or invalid cassette file', async () => {
    const corruptPath = path.join(testDir, 'corrupt-cassette.json');
    const { writeFileAtomicIn } = await import('../../../src/util/fs-safe.js');
    await writeFileAtomicIn(testRoot, corruptPath, '{ not valid json');

    await expect(loadCassette(corruptPath, testRoot)).rejects.toThrow('Failed to parse VCR cassette');

    await writeFileAtomicIn(testRoot, corruptPath, JSON.stringify({ version: 2 }));
    await expect(loadCassette(corruptPath, testRoot)).rejects.toThrow('Failed to parse VCR cassette');

    await removeIn(testRoot, corruptPath);
  });
});

describe('VcrProvider exact matching branches', () => {
  it('correctly discriminates differing system prompts, messages, and tools under exact matching', async () => {
    const cassette: VcrCassette = {
      version: 1,
      providerId: 'vcr',
      recordedAt: '2026-10-17T03:00:00.000Z',
      interactions: [
        {
          id: 'int_base',
          timestamp: '2026-10-17T03:00:00.000Z',
          request: {
            model: 'test-model',
            system: 'Sys 1',
            messages: [{ role: 'user', content: 'Msg 1' }],
            tools: [
              {
                name: 'tool_a',
                description: 'test tool',
                parameters: { type: 'object', properties: {} },
              },
            ],
          },
          response: {
            id: 'resp_base',
            model: 'test-model',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Matched exact' }] },
            stopReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          },
        },
      ],
    };

    const replayer = new VcrProvider({ mode: 'replay', cassette, matchStrategy: 'exact' });

    const firstInteraction = cassette.interactions[0];
    const toolsCopy = firstInteraction?.request.tools ? [...firstInteraction.request.tools] : [];

    // Different system
    await expect(
      replayer.complete({
        model: 'test-model',
        system: 'Different Sys',
        messages: [{ role: 'user', content: 'Msg 1' }],
        tools: toolsCopy,
      }),
    ).rejects.toThrow('no matching interaction found');

    // Different message
    await expect(
      replayer.complete({
        model: 'test-model',
        system: 'Sys 1',
        messages: [{ role: 'user', content: 'Different Msg' }],
        tools: toolsCopy,
      }),
    ).rejects.toThrow('no matching interaction found');

    // Different tools
    await expect(
      replayer.complete({
        model: 'test-model',
        system: 'Sys 1',
        messages: [{ role: 'user', content: 'Msg 1' }],
        tools: [],
      }),
    ).rejects.toThrow('no matching interaction found');

    // Exact match passes
    const res = await replayer.complete({
      model: 'test-model',
      system: 'Sys 1',
      messages: [{ role: 'user', content: 'Msg 1' }],
      tools: toolsCopy,
    });
    expect(res.id).toBe('resp_base');
  });
});
