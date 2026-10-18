/**
 * Unit tests for Orphan Process Reaper (Phase 7 - P7-T05).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  OrphanReaper,
  isProcessAlive,
  CHILDREN_REGISTRY_FILENAME,
  CHILDREN_REGISTRY_VERSION,
} from '../../../src/sandbox/orphan-reaper.js';
import { StandardProcessRunner } from '../../../src/sandbox/process-runner.js';
import { FakeClock } from '../../../src/util/index.js';

describe('Orphan Process Reaper (P7-T05)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-orphan-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe('isProcessAlive helper', () => {
    it('returns true for currently running process (process.pid)', () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it('returns false for non-existent PID', () => {
      // Typically 99999999 is unused
      expect(isProcessAlive(99_999_999)).toBe(false);
    });

    it('returns false for non-positive or invalid PIDs', () => {
      expect(isProcessAlive(0)).toBe(false);
      expect(isProcessAlive(-1)).toBe(false);
      expect(isProcessAlive(NaN)).toBe(false);
    });
  });

  describe('Child Registration & Atomic Persistence', () => {
    it('registers children and atomically persists run/children.json', async () => {
      const clock = new FakeClock(new Date('2026-10-17T12:00:00Z'));
      const reaper = new OrphanReaper({ airHome: tempDir, clock });

      await reaper.registerChild({
        pid: 1234,
        command: 'node worker.js',
        startTime: 1000,
      });

      const active = await reaper.getActiveChildren();
      expect(active).toHaveLength(1);
      expect(active[0]?.pid).toBe(1234);
      expect(active[0]?.command).toBe('node worker.js');

      // Verify file on disk
      const filePath = path.join(tempDir, CHILDREN_REGISTRY_FILENAME);
      expect(fs.existsSync(filePath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(parsed.version).toBe(CHILDREN_REGISTRY_VERSION);
      expect(parsed.updatedAt).toBe('2026-10-17T12:00:00.000Z');
      expect(parsed.processes).toHaveLength(1);
      expect(parsed.processes[0].pid).toBe(1234);
    });

    it('re-reads persisted records across new OrphanReaper instance', async () => {
      const reaper1 = new OrphanReaper({ airHome: tempDir });
      await reaper1.registerChild({ pid: 2001, command: 'worker1', startTime: 100 });
      await reaper1.registerChild({ pid: 2002, command: 'worker2', startTime: 200 });

      // Second instance pointing to same airHome
      const reaper2 = new OrphanReaper({ airHome: tempDir });
      const active = await reaper2.getActiveChildren();
      expect(active).toHaveLength(2);
      expect(active.map((p) => p.pid)).toEqual([2001, 2002]);
    });

    it('unregisters completed child processes', async () => {
      const reaper = new OrphanReaper({ airHome: tempDir });
      await reaper.registerChild({ pid: 3001, command: 'proc1', startTime: 100 });
      await reaper.registerChild({ pid: 3002, command: 'proc2', startTime: 200 });

      await reaper.unregisterChild(3001);

      const active = await reaper.getActiveChildren();
      expect(active).toHaveLength(1);
      expect(active[0]?.pid).toBe(3002);

      // Verify disk reflects unregistration
      const filePath = path.join(tempDir, CHILDREN_REGISTRY_FILENAME);
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(parsed.processes).toHaveLength(1);
      expect(parsed.processes[0].pid).toBe(3002);
    });

    it('rejects invalid PID during registration', async () => {
      const reaper = new OrphanReaper({ airHome: tempDir });
      await expect(
        reaper.registerChild({ pid: -5, command: 'bad', startTime: 0 }),
      ).rejects.toThrow('Invalid child PID');
    });

    it('clears registry completely', async () => {
      const reaper = new OrphanReaper({ airHome: tempDir });
      await reaper.registerChild({ pid: 4001, command: 'proc', startTime: 100 });
      await reaper.clearRegistry();

      const active = await reaper.getActiveChildren();
      expect(active).toHaveLength(0);
    });
  });

  describe('Orphan Process Reaping on Startup', () => {
    it('detects and reaps orphan processes from prior session', async () => {
      const killedPids: number[] = [];
      const mockKill = (pid: number): void => {
        killedPids.push(pid);
      };

      // Mock liveness: PID 5001 is alive, PID 5002 is dead
      const mockIsAlive = (pid: number): boolean => pid === 5001;

      // Seed registry as if left over from a previous crashed run
      const seedReaper = new OrphanReaper({ airHome: tempDir });
      await seedReaper.registerChild({ pid: 5001, command: 'hung-worker', startTime: 100 });
      await seedReaper.registerChild({ pid: 5002, command: 'finished-worker', startTime: 200 });

      // Startup reaper
      const startupReaper = new OrphanReaper({
        airHome: tempDir,
        isProcessAliveFn: mockIsAlive,
        killProcessTreeFn: mockKill,
      });

      const result = await startupReaper.reapOrphans();

      expect(result.totalTracked).toBe(2);
      expect(result.cleanedPids).toEqual([5001, 5002]);
      expect(killedPids).toEqual([5001]); // Only the alive one was killed

      expect(result.reaped).toHaveLength(2);
      const reaped5001 = result.reaped.find((r) => r.pid === 5001);
      const reaped5002 = result.reaped.find((r) => r.pid === 5002);

      expect(reaped5001?.terminated).toBe(true);
      expect(reaped5001?.reason).toBe('alive_and_terminated');

      expect(reaped5002?.terminated).toBe(false);
      expect(reaped5002?.reason).toBe('already_dead');

      // Verify registry file is cleaned
      const remaining = await startupReaper.getActiveChildren();
      expect(remaining).toHaveLength(0);
    });

    it('handles kill failures gracefully and records error', async () => {
      const mockKill = (): void => {
        throw new Error('Access denied to process tree');
      };

      const seedReaper = new OrphanReaper({ airHome: tempDir });
      await seedReaper.registerChild({ pid: 6001, command: 'protected-proc', startTime: 100 });

      const startupReaper = new OrphanReaper({
        airHome: tempDir,
        isProcessAliveFn: () => true,
        killProcessTreeFn: mockKill,
      });

      const result = await startupReaper.reapOrphans();
      expect(result.reaped).toHaveLength(1);
      expect(result.reaped[0]?.terminated).toBe(false);
      expect(result.reaped[0]?.reason).toBe('kill_failed');
      expect(result.reaped[0]?.error).toContain('Access denied to process tree');
    });

    it('handles corrupted or non-existent children.json gracefully', async () => {
      const reaper = new OrphanReaper({ airHome: tempDir });

      // 1. Non-existent file
      const res1 = await reaper.reapOrphans();
      expect(res1.totalTracked).toBe(0);

      // 2. Corrupt non-JSON file
      const filePath = path.join(tempDir, CHILDREN_REGISTRY_FILENAME);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'CORRUPTED_GARBAGE{{{', 'utf-8');

      const res2 = await reaper.reapOrphans();
      expect(res2.totalTracked).toBe(0);
    });
  });

  describe('Integration with StandardProcessRunner', () => {
    it('registers child process on spawn and unregisters upon normal exit', async () => {
      const reaper = new OrphanReaper({ airHome: tempDir });
      const runner = new StandardProcessRunner({
        orphanReaper: reaper,
      });

      const result = await runner.run({
        command: 'node',
        args: ['-e', 'process.stdout.write("hello-orphan")'],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello-orphan');

      // Process exited cleanly; registry should be empty
      const active = await reaper.getActiveChildren();
      expect(active).toHaveLength(0);
    });
  });
});
