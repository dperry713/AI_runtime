import { describe, expect, it } from 'vitest';
import { runDevHarness } from '../../../src/agent/harness.js';
import { MockProvider } from '../../../src/providers/index.js';
import { FakeClock } from '../../../src/util/index.js';

describe('Dev Harness (P6-T09)', () => {
  const clock = new FakeClock('2026-10-17T12:00:00.000Z');

  it('runs builtin developer agent with mock provider and returns completed outcome', async () => {
    const provider = new MockProvider({ clock });
    provider.enqueue({
      response: 'Code refactored and tests passing.',
      stopReason: 'stop',
    });

    const outcome = await runDevHarness({
      agent: 'developer',
      goal: 'Refactor utility functions',
      provider,
      clock,
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.text).toBe('Code refactored and tests passing.');
    expect(outcome.totalTurns).toBe(1);
  });

  it('runs builtin reviewer agent with fallback mock when no keys present', async () => {
    const outcome = await runDevHarness({
      agent: 'reviewer',
      goal: 'Audit security rules',
      clock,
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.text).toContain('operational');
    expect(outcome.totalTurns).toBe(1);
  });
});
