import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/index.ts',
        'src/secrets/store.ts',
        // Future phases stubs not yet implemented (P3-P12)
        'src/ipc/**',
        'src/kernel/**',
        'src/mcp/**',
        'src/memory/**',
        'src/policy/**',
        'src/providers/**',
        'src/sandbox/**',
        'src/service/**',
        'src/shell/**',
        'src/tools/**',
      ],
      reporter: ['text', 'lcov', 'json-summary'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
        // Critical module thresholds per docs/TESTING.md §4 and docs/BUILD_PLAN.md P1-T10
        'src/util/paths.ts': {
          lines: 95,
          branches: 90,
          functions: 95,
          statements: 95,
        },
        'src/journal/**': {
          lines: 95,
          branches: 90,
          functions: 95,
          statements: 95,
        },
      },
    },
  },
});
