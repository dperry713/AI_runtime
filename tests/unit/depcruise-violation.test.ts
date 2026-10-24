import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

describe('dependency-cruiser layer rules', () => {
  const repoRoot = join(__dirname, '..', '..');
  const srcDir = join(repoRoot, 'src');
  const testModuleDir = join(srcDir, '_test_fixture_depcruise');

  function cleanup() {
    if (existsSync(testModuleDir)) {
      rmSync(testModuleDir, { recursive: true, force: true });
    }
  }

  afterEach(() => {
    cleanup();
  });

  function runDepcruise(): { errorCount: number; violations: string[] } {
    const result = spawnSync('npx', ['depcruise', 'src', '--config', '.dependency-cruiser.cjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: true,
    });

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const output = stdout + stderr;
    const errorMatch = output.match(/x (\d+) dependency violations?/);
    const errorCount = errorMatch && errorMatch[1] ? parseInt(errorMatch[1], 10) : 0;

    const violations: string[] = [];
    const violationLines = output.split('\n').filter(line => line.includes('error '));
    for (const line of violationLines) {
      const match = line.match(/error\s+(\S+):/);
      if (match && match[1]) {
        violations.push(match[1]);
      }
    }

    return { errorCount, violations };
  }

  it('detects child_process import outside sandbox', () => {
    mkdirSync(testModuleDir, { recursive: true });

    const violatingFile = join(testModuleDir, 'violates-child-process.ts');
    writeFileSync(violatingFile, `import { spawn } from 'node:child_process';\nexport const x = 1;\n`);

    const { errorCount, violations } = runDepcruise();

    expect(errorCount).toBeGreaterThan(0);
    expect(violations).toContain('child-process-only-in-sandbox');

    cleanup();
  });

  it('detects fs import outside designated modules', () => {
    mkdirSync(testModuleDir, { recursive: true });

    const violatingFile = join(testModuleDir, 'violates-fs.ts');
    writeFileSync(violatingFile, `import { readFile } from 'node:fs/promises';\nexport const x = 1;\n`);

    const { errorCount, violations } = runDepcruise();

    expect(errorCount).toBeGreaterThan(0);
    expect(violations).toContain('fs-only-in-designated-modules');

    cleanup();
  });

  it('detects non-index import violation', () => {
    // Create a temporary non-index file in util module for testing violation
    const utilTempFile = join(srcDir, 'util', '_temp_fixture_for_depcruise.ts');
    writeFileSync(utilTempFile, `export const tempVal = 'test';\n`);

    mkdirSync(testModuleDir, { recursive: true });

    const violatingFile = join(testModuleDir, 'violates-index-only.ts');
    writeFileSync(violatingFile, `import { tempVal } from '../util/_temp_fixture_for_depcruise';\nexport const x = 1;\n`);

    const { errorCount, violations } = runDepcruise();

    // Clean up the test file we created in util
    rmSync(utilTempFile, { force: true });

    expect(errorCount).toBeGreaterThan(0);
    expect(violations.some(v => v.includes('util-index-only'))).toBe(true);

    cleanup();
  });

  it('detects upward layer import violation', () => {
    // Create a violating file in the actual agent module (layer 5) that imports from kernel (layer 6)
    const agentDir = join(srcDir, 'agent');
    const violatingFile = join(agentDir, 'test-layer-violation.ts');
    writeFileSync(violatingFile, `import { something } from '../kernel/index';\nexport const x = 1;\n`);

    const { errorCount, violations } = runDepcruise();

    // Clean up
    rmSync(violatingFile, { force: true });

    expect(errorCount).toBeGreaterThan(0);
    expect(violations.some(v => v.includes('layer-agent-no-upward-imports'))).toBe(true);
  });

  it('passes for valid index-only import', () => {
    mkdirSync(testModuleDir, { recursive: true });

    const validFile = join(testModuleDir, 'valid-import.ts');
    writeFileSync(validFile, `import { something } from '../util/index';\nexport const x = 1;\n`);

    const { errorCount } = runDepcruise();

    expect(errorCount).toBe(0); // Valid index-only imports must not leave any dependency violations.

    cleanup();
  });
});
