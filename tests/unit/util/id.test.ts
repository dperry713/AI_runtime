import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../src/util/clock.js';
import { FakeIdGenerator, UlidIdGenerator } from '../../../src/util/id.js';

describe('UlidIdGenerator', () => {
  it('generates valid ULID strings', () => {
    const generator = new UlidIdGenerator();
    const id1 = generator.next();
    const id2 = generator.next();

    expect(typeof id1).toBe('string');
    expect(id1).toHaveLength(26);
    expect(id1).not.toBe(id2);
  });

  it('generates strongly-typed branded IDs', () => {
    const generator = new UlidIdGenerator();

    const runId = generator.nextRunId();
    const toolCallId = generator.nextToolCallId();
    const eventId = generator.nextEventId();
    const turnId = generator.nextTurnId();
    const sessionId = generator.nextSessionId();
    const agentId = generator.nextAgentId();

    expect(runId).toHaveLength(26);
    expect(toolCallId).toHaveLength(26);
    expect(eventId).toHaveLength(26);
    expect(turnId).toHaveLength(26);
    expect(sessionId).toHaveLength(26);
    expect(agentId).toHaveLength(26);
  });

  it('incorporates injected Clock timestamp into generated ULIDs', () => {
    const fakeClock = new FakeClock('2026-05-01T00:00:00.000Z');
    const generator = new UlidIdGenerator(fakeClock);

    const id = generator.next();
    expect(id).toHaveLength(26);
  });
});

describe('FakeIdGenerator', () => {
  it('generates predictable incremental sequences', () => {
    const generator = new FakeIdGenerator('test');
    expect(generator.next()).toBe('test-000001');
    expect(generator.next()).toBe('test-000002');
    expect(generator.next()).toBe('test-000003');
  });

  it('generates typed branded IDs with proper prefixes', () => {
    const generator = new FakeIdGenerator();
    expect(generator.nextRunId()).toBe('run-000001');
    expect(generator.nextToolCallId()).toBe('call-000002');
    expect(generator.nextEventId()).toBe('evt-000003');
    expect(generator.nextTurnId()).toBe('turn-000004');
    expect(generator.nextSessionId()).toBe('sess-000005');
    expect(generator.nextAgentId()).toBe('agent-000006');
  });

  it('resets counter to zero', () => {
    const generator = new FakeIdGenerator('item');
    generator.next();
    generator.next();
    generator.reset();
    expect(generator.next()).toBe('item-000001');
  });
});
