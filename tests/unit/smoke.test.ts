import { describe, expect, it } from 'vitest';
import { AIR_VERSION } from '../../src/index.js';

describe('skeleton smoke test', () => {
  it('exposes a semver version string', () => {
    expect(AIR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
