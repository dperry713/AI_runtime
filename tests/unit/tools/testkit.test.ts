import { describe, expect, it } from 'vitest';
import {
  createToolTestKit,
  fuzzToolSchema,
  SSRF_TEST_CORPUS,
  WINDOWS_PATH_TRAVERSAL_CORPUS,
} from '../../../src/tools/index.js';

describe('Tool Test Kit & Fuzz Harness (P4-T08 / Exit Gate P4)', () => {
  describe('ToolTestKit Environment', () => {
    it('executes tools cleanly under fake clock, random, and policy hooks', async () => {
      const kit = createToolTestKit();

      expect(kit.clock.iso()).toBe('2026-10-17T12:00:00.000Z');
      expect(kit.workspaceRoot).toContain('air-test');

      // Test executing a tool with default allow policy
      const result = await kit.execute({
        toolName: 'plan.update',
        runId: 'run-000001',
        input: {
          plan: 'Test plan under testkit',
          steps: [{ id: '1', description: 'Step 1', status: 'completed' }],
        },
      });

      expect(result.output).toBeDefined();
      expect(kit.recordedDecisions.length).toBeGreaterThanOrEqual(1);

      // Now set policy to deny and verify executor blocks execution
      kit.setPolicyDecision('deny', 'Administrative block in testkit');

      await expect(
        kit.execute({
          toolName: 'plan.update',
          runId: 'run-000001',
          input: {
            plan: 'Test plan under denied policy',
            steps: [{ id: '1', description: 'Step 1', status: 'completed' }],
          },
        }),
      ).rejects.toThrow(/Administrative block in testkit/);
    });
  });

  describe('Schema Fuzz Harness', () => {
    it('fuzzes input schemas of all built-in tools without unhandled crashes', () => {
      const kit = createToolTestKit();

      // 1. Fuzz fs.read
      const fsRead = kit.registry.get('fs.read');
      expect(fsRead).toBeDefined();
      if (fsRead) {
        const res = fuzzToolSchema(fsRead, { path: 'test.txt' });
        expect(res.testedMutations).toBeGreaterThan(10);
        expect(res.rejectedCount).toBeGreaterThan(0);
        expect(res.unexpectedErrors).toEqual([]);
      }

      // 2. Fuzz exec.run
      const execRun = kit.registry.get('exec.run');
      expect(execRun).toBeDefined();
      if (execRun) {
        const res = fuzzToolSchema(execRun, { command: 'node -v' });
        expect(res.testedMutations).toBeGreaterThan(10);
        expect(res.rejectedCount).toBeGreaterThan(0);
        expect(res.unexpectedErrors).toEqual([]);
      }

      // 3. Fuzz http.fetch
      const httpFetch = kit.registry.get('http.fetch');
      expect(httpFetch).toBeDefined();
      if (httpFetch) {
        const res = fuzzToolSchema(httpFetch, { url: 'https://example.com/api' });
        expect(res.testedMutations).toBeGreaterThan(10);
        expect(res.rejectedCount).toBeGreaterThan(0);
        expect(res.unexpectedErrors).toEqual([]);
      }

      // 4. Fuzz user.ask
      const userAsk = kit.registry.get('user.ask');
      expect(userAsk).toBeDefined();
      if (userAsk) {
        const res = fuzzToolSchema(userAsk, { question: 'Continue?' });
        expect(res.testedMutations).toBeGreaterThan(10);
        expect(res.rejectedCount).toBeGreaterThan(0);
        expect(res.unexpectedErrors).toEqual([]);
      }

      // 5. Fuzz plan.update
      const planUpdate = kit.registry.get('plan.update');
      expect(planUpdate).toBeDefined();
      if (planUpdate) {
        const res = fuzzToolSchema(planUpdate, {
          plan: 'A',
          steps: [{ id: '1', description: 'Step 1', status: 'completed' }],
        });
        expect(res.testedMutations).toBeGreaterThan(10);
        expect(res.rejectedCount).toBeGreaterThan(0);
        expect(res.unexpectedErrors).toEqual([]);
      }

      // 6. Fuzz run.finish
      const runFinish = kit.registry.get('run.finish');
      expect(runFinish).toBeDefined();
      if (runFinish) {
        const res = fuzzToolSchema(runFinish, {
          status: 'success',
          summary: 'Done',
        });
        expect(res.testedMutations).toBeGreaterThan(10);
        expect(res.rejectedCount).toBeGreaterThan(0);
        expect(res.unexpectedErrors).toEqual([]);
      }
    });
  });

  describe('Windows Path Traversal Corpus (≥ 100 Cases)', () => {
    it('contains at least 100 Windows-specific traversal patterns', () => {
      expect(WINDOWS_PATH_TRAVERSAL_CORPUS.length).toBeGreaterThanOrEqual(100);
    });

    it('rejects every single traversal case in the corpus across filesystem tools', async () => {
      const kit = createToolTestKit();

      for (const traversalPath of WINDOWS_PATH_TRAVERSAL_CORPUS) {
        // Test fs.read
        await expect(
          kit.execute({
            toolName: 'fs.read',
            runId: 'run-000001',
            input: { path: traversalPath },
          }),
        ).rejects.toThrow();

        // Test fs.write
        await expect(
          kit.execute({
            toolName: 'fs.write',
            runId: 'run-000001',
            input: { path: traversalPath, content: 'exploit' },
          }),
        ).rejects.toThrow();
      }
    });
  });

  describe('SSRF Attack Corpus', () => {
    it('contains comprehensive SSRF vectors', () => {
      expect(SSRF_TEST_CORPUS.length).toBeGreaterThanOrEqual(25);
    });

    it('blocks every single SSRF vector in the corpus via http.fetch', async () => {
      const kit = createToolTestKit();

      for (const ssrfUrl of SSRF_TEST_CORPUS) {
        await expect(
          kit.execute({
            toolName: 'http.fetch',
            runId: 'run-000001',
            input: { url: ssrfUrl },
          }),
        ).rejects.toThrow();
      }
    });
  });

  describe('Output Truncation & Boundary Tests', () => {
    it('truncates outputs that exceed maxOutputBytes with notice marker', async () => {
      const kit = createToolTestKit();

      // Write a 10KB file
      await kit.execute({
        toolName: 'fs.write',
        runId: 'run-000001',
        input: {
          path: 'large.txt',
          content: 'Z'.repeat(10_000),
        },
      });

      // Read with small maxOutputBytes limit on execution request
      const readRes = await kit.execute({
        toolName: 'fs.read',
        runId: 'run-000001',
        maxOutputBytes: 500,
        input: {
          path: 'large.txt',
        },
      });

      expect(readRes.truncated).toBe(true);
      const strOutput = typeof readRes.output === 'string' ? readRes.output : JSON.stringify(readRes.output);
      expect(strOutput).toContain('[TRUNCATED: maxOutputBytes exceeded]');
      expect(Buffer.byteLength(strOutput, 'utf8')).toBeLessThanOrEqual(500);
    });
  });
});
