import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  createEnvelope,
  createUpcaster,
  defaultVersionExtractor,
  type EventEnvelope,
  foldEvents,
  IndexStore,
  JournalReader,
  replayStream,
  SegmentWriter,
  type SyntheticV1Payload,
  SyntheticV1PayloadSchema,
  type SyntheticV2Payload,
  SyntheticV2PayloadSchema,
  type SyntheticV3Payload,
  SyntheticV3PayloadSchema,
  syntheticV1ToV2Upcaster,
  syntheticV2ToV3Upcaster,
  type Upcaster,
  UpcasterRegistry,
} from '../../../src/journal/index.js';
import { FakeClock, FakeIdGenerator } from '../../../src/util/index.js';

describe('Upcasters Framework (P2-T07)', () => {
  let tempDir: string;
  let clock: FakeClock;
  let idGen: FakeIdGenerator;

  beforeEach(() => {
    tempDir = path.join(process.cwd(), 'var', 'test-scratch', `upcasters-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tempDir, { recursive: true });
    clock = new FakeClock('2026-10-16T12:00:00.000Z');
    idGen = new FakeIdGenerator();
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors on Windows
    }
  });

  describe('createUpcaster & validation', () => {
    it('creates a validated upcaster with default toVersion = fromVersion + 1', () => {
      const upcaster = createUpcaster({
        eventType: 'test.event',
        fromVersion: 1,
        upcast: (env) => env,
      });

      expect(upcaster.eventType).toBe('test.event');
      expect(upcaster.fromVersion).toBe(1);
      expect(upcaster.toVersion).toBe(2);
      expect(Object.isFrozen(upcaster)).toBe(true);
    });

    it('creates an upcaster with custom toVersion and description', () => {
      const upcaster = createUpcaster({
        eventType: 'test.event',
        fromVersion: 1,
        toVersion: 3,
        description: 'Multi-version leap',
        upcast: (env) => env,
      });

      expect(upcaster.eventType).toBe('test.event');
      expect(upcaster.fromVersion).toBe(1);
      expect(upcaster.toVersion).toBe(3);
      expect(upcaster.description).toBe('Multi-version leap');
    });

    it('throws on empty eventType', () => {
      expect(() =>
        createUpcaster({
          eventType: '   ',
          fromVersion: 1,
          upcast: (env) => env,
        }),
      ).toThrow(AirError);
    });

    it('throws on non-positive fromVersion', () => {
      expect(() =>
        createUpcaster({
          eventType: 'test.event',
          fromVersion: 0,
          upcast: (env) => env,
        }),
      ).toThrow(AirError);

      expect(() =>
        createUpcaster({
          eventType: 'test.event',
          fromVersion: -1,
          upcast: (env) => env,
        }),
      ).toThrow(AirError);
    });

    it('throws on toVersion <= fromVersion', () => {
      expect(() =>
        createUpcaster({
          eventType: 'test.event',
          fromVersion: 2,
          toVersion: 2,
          upcast: (env) => env,
        }),
      ).toThrow(AirError);

      expect(() =>
        createUpcaster({
          eventType: 'test.event',
          fromVersion: 3,
          toVersion: 1,
          upcast: (env) => env,
        }),
      ).toThrow(AirError);
    });

    it('throws on non-function upcast argument', () => {
      expect(() =>
        createUpcaster({
          eventType: 'test.event',
          fromVersion: 1,
          upcast: 'invalid' as unknown as (env: EventEnvelope) => EventEnvelope,
        }),
      ).toThrow(AirError);
    });
  });

  describe('defaultVersionExtractor', () => {
    it('extracts version from meta.schemaVersion', () => {
      const env = createEnvelope({
        stream: 's1',
        seq: 1,
        type: 'test.event',
        payload: { something: 123 },
        meta: { schemaVersion: 4 },
        clock,
        idGenerator: idGen,
      });

      expect(defaultVersionExtractor(env)).toBe(4);
    });

    it('extracts version from payload.schemaVersion', () => {
      const env = createEnvelope({
        stream: 's1',
        seq: 1,
        type: 'test.event',
        payload: { schemaVersion: 2, data: 'test' },
        clock,
        idGenerator: idGen,
      });

      expect(defaultVersionExtractor(env)).toBe(2);
    });

    it('extracts version from payload.version', () => {
      const env = createEnvelope({
        stream: 's1',
        seq: 1,
        type: 'test.event',
        payload: { version: 3, data: 'test' },
        clock,
        idGenerator: idGen,
      });

      expect(defaultVersionExtractor(env)).toBe(3);
    });

    it('extracts version from payload.v', () => {
      const env = createEnvelope({
        stream: 's1',
        seq: 1,
        type: 'test.event',
        payload: { v: 5, data: 'test' },
        clock,
        idGenerator: idGen,
      });

      expect(defaultVersionExtractor(env)).toBe(5);
    });

    it('defaults to 1 if payload has no valid version fields', () => {
      const env = createEnvelope({
        stream: 's1',
        seq: 1,
        type: 'test.event',
        payload: { foo: 'bar', version: 'invalid' },
        clock,
        idGenerator: idGen,
      });

      expect(defaultVersionExtractor(env)).toBe(1);
    });

    it('defaults to 1 if payload is primitive or null', () => {
      const env = createEnvelope({
        stream: 's1',
        seq: 1,
        type: 'test.event',
        payload: 'string-payload',
        clock,
        idGenerator: idGen,
      });

      expect(defaultVersionExtractor(env)).toBe(1);
    });
  });

  describe('UpcasterRegistry', () => {
    it('registers upcasters and manages query methods', () => {
      const registry = new UpcasterRegistry();

      expect(registry.has('synthetic.action')).toBe(false);
      registry.register(syntheticV1ToV2Upcaster);

      expect(registry.has('synthetic.action')).toBe(true);
      expect(registry.has('synthetic.action', 1)).toBe(true);
      expect(registry.has('synthetic.action', 2)).toBe(false);

      expect(registry.getRegisteredTypes()).toEqual(['synthetic.action']);
      expect(registry.getTargetVersion('synthetic.action')).toBe(2);
      expect(registry.getTargetVersion('unknown.event')).toBe(1);

      const list = registry.getUpcastersFor('synthetic.action');
      expect(list.length).toBe(1);
      expect(list[0]?.fromVersion).toBe(1);
    });

    it('supports registerFn helper', () => {
      const registry = new UpcasterRegistry();
      registry.registerFn('custom.event', 1, (env) => ({
        ...env,
        payload: { migrated: true },
      }));

      expect(registry.has('custom.event', 1)).toBe(true);
      expect(registry.getTargetVersion('custom.event')).toBe(2);
    });

    it('throws when registering invalid or duplicate upcasters', () => {
      const registry = new UpcasterRegistry();
      expect(() => registry.register(null as unknown as Upcaster)).toThrow(AirError);
      expect(() => registry.register({} as unknown as Upcaster)).toThrow(AirError);
      expect(() => registry.register({ eventType: 'test', fromVersion: 0, toVersion: 1, upcast: () => ({}) } as unknown as Upcaster)).toThrow(AirError);
      expect(() => registry.register({ eventType: 'test', fromVersion: 1, toVersion: 1, upcast: () => ({}) } as unknown as Upcaster)).toThrow(AirError);
      expect(() => registry.register({ eventType: 'test', fromVersion: 1, toVersion: 2 } as unknown as Upcaster)).toThrow(AirError);

      registry.register(syntheticV1ToV2Upcaster);
      expect(() => registry.register(syntheticV1ToV2Upcaster)).toThrow(AirError);
    });

    it('clears registered upcasters', () => {
      const registry = new UpcasterRegistry();
      registry.register(syntheticV1ToV2Upcaster);
      expect(registry.has('synthetic.action')).toBe(true);

      registry.clear();
      expect(registry.has('synthetic.action')).toBe(false);
      expect(registry.getRegisteredTypes()).toEqual([]);
    });

    it('handles custom versionExtractor', () => {
      const customExtractor = (env: EventEnvelope) => {
        return (env.payload as { myVer?: number })?.myVer ?? 1;
      };

      const registry = new UpcasterRegistry({ versionExtractor: customExtractor });
      registry.register(syntheticV1ToV2Upcaster);

      const env = createEnvelope({
        stream: 's1',
        seq: 1,
        type: 'synthetic.action',
        payload: { myVer: 2, user: 'alice', action: 'login', timestamp: 12345 },
        clock,
        idGenerator: idGen,
      });

      // Since customExtractor reports version 2, and targetVersion is 2, no upcasting needed
      const result = registry.upcast(env);
      expect(result).toBe(env);
    });
  });

  describe('Synthetic v1 -> v2 schema migration (P2-T07)', () => {
    it('successfully upcasts SyntheticV1 to SyntheticV2', () => {
      const registry = new UpcasterRegistry();
      registry.register(syntheticV1ToV2Upcaster);

      const v1Payload: SyntheticV1Payload = {
        user: 'user-42',
        action: 'order.placed',
        timestamp: 1729080000000,
      };
      SyntheticV1PayloadSchema.parse(v1Payload);

      const v1Envelope = createEnvelope({
        stream: 'run:100',
        seq: 1,
        type: 'synthetic.action',
        payload: v1Payload,
        clock,
        idGenerator: idGen,
      });

      const v2Envelope = registry.upcast<SyntheticV2Payload>(v1Envelope);

      expect(v2Envelope.id).toBe(v1Envelope.id);
      expect(v2Envelope.stream).toBe(v1Envelope.stream);
      expect(v2Envelope.seq).toBe(v1Envelope.seq);
      expect(v2Envelope.ts).toBe(v1Envelope.ts);
      expect(v2Envelope.type).toBe('synthetic.action');
      expect(v2Envelope.meta?.schemaVersion).toBe(2);

      const v2 = v2Envelope.payload;
      expect(v2.userId).toBe('user-42');
      expect(v2.actionType).toBe('order.placed');
      expect(v2.performedAt).toBe(new Date(1729080000000).toISOString());
      expect(v2.metadata.migratedFromV1).toBe(true);

      // Verify conforms to Zod schema
      expect(() => SyntheticV2PayloadSchema.parse(v2)).not.toThrow();
    });

    it('chains multiple migrations sequentially (v1 -> v2 -> v3)', () => {
      const registry = new UpcasterRegistry();
      registry.register(syntheticV1ToV2Upcaster);
      registry.register(syntheticV2ToV3Upcaster);

      expect(registry.getTargetVersion('synthetic.action')).toBe(3);

      const v1Payload: SyntheticV1Payload = {
        user: 'user-99',
        action: 'system.boot',
        timestamp: 1729081111000,
      };

      const v1Envelope = createEnvelope({
        stream: 'run:200',
        seq: 5,
        type: 'synthetic.action',
        payload: v1Payload,
        clock,
        idGenerator: idGen,
      });

      const v3Envelope = registry.upcast<SyntheticV3Payload>(v1Envelope);

      expect(v3Envelope.meta?.schemaVersion).toBe(3);
      expect(v3Envelope.payload.userId).toBe('user-99');
      expect(v3Envelope.payload.actionType).toBe('system.boot');
      expect(v3Envelope.payload.tenantId).toBe('default');
      expect(v3Envelope.payload.tags).toEqual(['migrated']);
      expect(v3Envelope.payload.metadata.migratedFromV1).toBe(true);
      expect(v3Envelope.payload.metadata.migratedFromV2).toBe(true);

      expect(() => SyntheticV3PayloadSchema.parse(v3Envelope.payload)).not.toThrow();
    });

    it('upcasts partially from intermediate version (v2 -> v3)', () => {
      const registry = new UpcasterRegistry();
      registry.register(syntheticV1ToV2Upcaster);
      registry.register(syntheticV2ToV3Upcaster);

      const v2Payload: SyntheticV2Payload = {
        userId: 'user-already-v2',
        actionType: 'task.exec',
        performedAt: '2026-10-16T12:30:00.000Z',
        metadata: {
          migratedFromV1: false,
        },
      };

      const v2Envelope = createEnvelope({
        stream: 'run:300',
        seq: 1,
        type: 'synthetic.action',
        payload: v2Payload,
        meta: { schemaVersion: 2 },
        clock,
        idGenerator: idGen,
      });

      const v3Envelope = registry.upcast<SyntheticV3Payload>(v2Envelope);

      expect(v3Envelope.meta?.schemaVersion).toBe(3);
      expect(v3Envelope.payload.userId).toBe('user-already-v2');
      expect(v3Envelope.payload.metadata.migratedFromV1).toBe(false);
      expect(v3Envelope.payload.metadata.migratedFromV2).toBe(true);
    });

    it('returns envelope untouched if already at or above latest target version', () => {
      const registry = new UpcasterRegistry();
      registry.register(syntheticV1ToV2Upcaster);

      const v2Envelope = createEnvelope({
        stream: 'run:400',
        seq: 1,
        type: 'synthetic.action',
        payload: { something: true },
        meta: { schemaVersion: 2 },
        clock,
        idGenerator: idGen,
      });

      const result = registry.upcast(v2Envelope);
      expect(result).toBe(v2Envelope);
    });

    it('returns envelope untouched if event type has no registered upcasters', () => {
      const registry = new UpcasterRegistry();
      registry.register(syntheticV1ToV2Upcaster);

      const otherEnvelope = createEnvelope({
        stream: 'system',
        seq: 1,
        type: 'unregistered.event',
        payload: { msg: 'hello' },
        clock,
        idGenerator: idGen,
      });

      const result = registry.upcast(otherEnvelope);
      expect(result).toBe(otherEnvelope);
    });
  });

  describe('Error conditions & edge cases', () => {
    it('throws on invalid envelope input', () => {
      const registry = new UpcasterRegistry();
      expect(() => registry.upcast(null as unknown as EventEnvelope)).toThrow(AirError);
      expect(() => registry.upcast({} as unknown as EventEnvelope)).toThrow(AirError);
    });

    it('throws when migration chain has a gap', () => {
      const registry = new UpcasterRegistry();
      // Register 1 -> 2
      registry.register(syntheticV1ToV2Upcaster);
      // Register 3 -> 4 without 2 -> 3
      registry.registerFn('synthetic.action', 3, (env) => env, { toVersion: 4 });

      const v1Envelope = createEnvelope({
        stream: 'run:500',
        seq: 1,
        type: 'synthetic.action',
        payload: { user: 'u', action: 'a', timestamp: 123 },
        clock,
        idGenerator: idGen,
      });

      expect(() => registry.upcast(v1Envelope)).toThrow(AirError);
      try {
        registry.upcast(v1Envelope);
      } catch (err) {
        expect((err as AirError).code).toBe('INVALID_STATE');
      }
    });

    it('wraps throwing upcasters in AirError with UPCASTER_FAILED', () => {
      const registry = new UpcasterRegistry();
      registry.registerFn('failing.event', 1, () => {
        throw new Error('Something went terribly wrong');
      });

      const env = createEnvelope({
        stream: 'run:600',
        seq: 1,
        type: 'failing.event',
        payload: { data: 'test' },
        clock,
        idGenerator: idGen,
      });

      expect(() => registry.upcast(env)).toThrow(AirError);
      try {
        registry.upcast(env);
      } catch (err) {
        const airErr = err as AirError;
        expect(airErr.code).toBe('UPCASTER_FAILED');
        expect(airErr.message).toContain('Something went terribly wrong');
      }
    });

    it('throws UPCASTER_FAILED if upcaster returns invalid envelope', () => {
      const registry = new UpcasterRegistry();
      registry.registerFn('corrupt.event', 1, () => {
        return null as unknown as EventEnvelope;
      });

      const env = createEnvelope({
        stream: 'run:700',
        seq: 1,
        type: 'corrupt.event',
        payload: { data: 'test' },
        clock,
        idGenerator: idGen,
      });

      expect(() => registry.upcast(env)).toThrow(AirError);
      try {
        registry.upcast(env);
      } catch (err) {
        expect((err as AirError).code).toBe('UPCASTER_FAILED');
      }
    });
  });

  describe('Batch and Stream Upcasting', () => {
    it('upcasts multiple envelopes via upcastAll', () => {
      const registry = new UpcasterRegistry();
      registry.register(syntheticV1ToV2Upcaster);

      const env1 = createEnvelope({
        stream: 's1',
        seq: 1,
        type: 'synthetic.action',
        payload: { user: 'user1', action: 'act1', timestamp: 1000 },
        clock,
        idGenerator: idGen,
      });
      const env2 = createEnvelope({
        stream: 's1',
        seq: 2,
        type: 'other.event',
        payload: { untouched: true },
        clock,
        idGenerator: idGen,
      });

      const results = registry.upcastAll([env1, env2]);
      expect(results.length).toBe(2);
      expect((results[0]?.payload as SyntheticV2Payload).userId).toBe('user1');
      expect((results[1]?.payload as { untouched: boolean }).untouched).toBe(true);
    });

    it('streams upcasted envelopes via upcastStream', async () => {
      const registry = new UpcasterRegistry();
      registry.register(syntheticV1ToV2Upcaster);

      async function* generateEnvelopes() {
        await Promise.resolve();
        yield createEnvelope({
          stream: 's1',
          seq: 1,
          type: 'synthetic.action',
          payload: { user: 'streamUser', action: 'actStream', timestamp: 2000 },
          clock,
          idGenerator: idGen,
        });
      }

      const results: EventEnvelope[] = [];
      for await (const env of registry.upcastStream(generateEnvelopes())) {
        results.push(env);
      }

      expect(results.length).toBe(1);
      expect((results[0]?.payload as SyntheticV2Payload).userId).toBe('streamUser');
    });
  });

  describe('Integration with JournalReader', () => {
    it('automatically upcasts events read from segment files via JournalReader', async () => {
      const journalDir = path.join(tempDir, 'journal');
      fs.mkdirSync(journalDir, { recursive: true });

      const writer = new SegmentWriter({
        journalDir,
        fsync: 'always',
        clock,
      });

      const v1Payload: SyntheticV1Payload = {
        user: 'readerUser',
        action: 'login',
        timestamp: 1729000000000,
      };

      const v1Envelope = createEnvelope({
        stream: 'run:reader-test',
        seq: 1,
        type: 'synthetic.action',
        payload: v1Payload,
        clock,
        idGenerator: idGen,
      });

      await writer.append(v1Envelope);
      await writer.close();

      const registry = new UpcasterRegistry();
      registry.register(syntheticV1ToV2Upcaster);

      const reader = new JournalReader({
        journalDir,
        upcasters: registry,
      });

      // 1. Point lookup by stream + seq
      const bySeq = await reader.getEventByStreamSeq('run:reader-test', 1);
      expect(bySeq).not.toBeNull();
      expect(bySeq?.type).toBe('synthetic.action');
      expect((bySeq?.payload as SyntheticV2Payload).userId).toBe('readerUser');
      expect((bySeq?.payload as SyntheticV2Payload).metadata.migratedFromV1).toBe(true);

      // 2. Point lookup by id
      const byId = await reader.getEvent(v1Envelope.id);
      expect(byId).not.toBeNull();
      expect((byId?.payload as SyntheticV2Payload).userId).toBe('readerUser');

      // 3. Range read
      const streamEvents = await reader.readStream('run:reader-test');
      expect(streamEvents.length).toBe(1);
      expect((streamEvents[0]?.payload as SyntheticV2Payload).userId).toBe('readerUser');
    });

    it('automatically upcasts events read via IndexStore-backed JournalReader', async () => {
      const journalDir = path.join(tempDir, 'journal-indexed');
      fs.mkdirSync(journalDir, { recursive: true });

      const dbPath = path.join(tempDir, 'index.db');
      const indexStore = new IndexStore({ dbPath, clock });

      const writer = new SegmentWriter({
        journalDir,
        fsync: 'always',
        clock,
      });

      const v1Envelope = createEnvelope({
        stream: 'run:index-test',
        seq: 1,
        type: 'synthetic.action',
        payload: { user: 'indexedUser', action: 'click', timestamp: 1729000001000 },
        clock,
        idGenerator: idGen,
      });

      const appendRes = await writer.append(v1Envelope);
      await writer.close();

      indexStore.indexEvent(v1Envelope, appendRes);

      const registry = new UpcasterRegistry();
      registry.register(syntheticV1ToV2Upcaster);

      const reader = new JournalReader({
        journalDir,
        indexStore,
        upcasters: registry,
      });

      const event = await reader.getEvent(v1Envelope.id);
      expect(event).not.toBeNull();
      expect((event?.payload as SyntheticV2Payload).userId).toBe('indexedUser');

      indexStore.close();
    });
  });

  describe('Integration with ReplayEngine and foldEvents', () => {
    it('folds upcasted events into projection via foldEvents', () => {
      const registry = new UpcasterRegistry();
      registry.register(syntheticV1ToV2Upcaster);

      const events: EventEnvelope[] = [
        createEnvelope({
          stream: 'run:fold',
          seq: 1,
          type: 'synthetic.action',
          payload: { user: 'userA', action: 'view', timestamp: 1000 },
          clock,
          idGenerator: idGen,
        }),
        createEnvelope({
          stream: 'run:fold',
          seq: 2,
          type: 'synthetic.action',
          payload: { user: 'userB', action: 'buy', timestamp: 2000 },
          clock,
          idGenerator: idGen,
        }),
      ];

      interface AggregatedState {
        users: string[];
        migratedCount: number;
      }

      const initialState: AggregatedState = { users: [], migratedCount: 0 };
      const reducer = (state: AggregatedState, event: EventEnvelope): AggregatedState => {
        const payload = event.payload as SyntheticV2Payload;
        return {
          users: [...state.users, payload.userId],
          migratedCount: state.migratedCount + (payload.metadata.migratedFromV1 ? 1 : 0),
        };
      };

      const finalState = foldEvents(initialState, events, reducer, registry);
      expect(finalState.users).toEqual(['userA', 'userB']);
      expect(finalState.migratedCount).toBe(2);
    });

    it('replays stream and folds upcasted events via replayStream', async () => {
      const journalDir = path.join(tempDir, 'journal-replay');
      fs.mkdirSync(journalDir, { recursive: true });

      const writer = new SegmentWriter({
        journalDir,
        fsync: 'always',
        clock,
      });

      await writer.append(
        createEnvelope({
          stream: 'run:replay-test',
          seq: 1,
          type: 'synthetic.action',
          payload: { user: 'replayUser', action: 'checkout', timestamp: 3000 },
          clock,
          idGenerator: idGen,
        }),
      );
      await writer.close();

      const registry = new UpcasterRegistry();
      registry.register(syntheticV1ToV2Upcaster);

      const reader = new JournalReader({ journalDir });

      const result = await replayStream(reader, 'run:replay-test', {
        initialState: { userIds: [] as string[] },
        upcasters: registry,
        reducer: (state, event) => {
          const p = event.payload as SyntheticV2Payload;
          return { userIds: [...state.userIds, p.userId] };
        },
      });

      expect(result.eventsReplayed).toBe(1);
      expect(result.state.userIds).toEqual(['replayUser']);
    });
  });
});
