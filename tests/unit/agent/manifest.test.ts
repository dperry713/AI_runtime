/**
 * Agent Manifest Unit Tests (Phase 6 - P6-T01).
 *
 * Verifies:
 * - AgentManifestSchema validation, field constraints, and default values.
 * - JSON and YAML parsing with SHA-256 integrity hash calculation.
 * - Safe filesystem loading inside root jail (`loadAgentManifestFromFile`).
 * - System prompt template variable substitution (`renderSystemPrompt`).
 * - Policy profile binding (`resolvePolicyForManifest`) for built-in and custom profiles.
 * - Built-in agent catalog (`developer`, `reviewer`, `dev-shell`, `auditor`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentManifestSchema,
  BUILTIN_AGENTS,
  computeManifestHash,
  DEFAULT_AUDITOR_AGENT,
  DEFAULT_DEV_SHELL_AGENT,
  DEFAULT_DEVELOPER_AGENT,
  DEFAULT_REVIEWER_AGENT,
  getBuiltinAgent,
  listBuiltinAgents,
  loadAgentManifestFromFile,
  parseAgentManifest,
  renderSystemPrompt,
  resolvePolicyForManifest,
} from '../../../src/agent/manifest.js';
import { AirError } from '../../../src/errors/index.js';
import {
  DEV_SHELL_PROFILE,
  LOCKED_DOWN_PROFILE,
  PROJECT_WRITE_PROFILE,
  READONLY_PROFILE,
} from '../../../src/policy/index.js';

describe('Agent Manifest (P6-T01)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'air-agent-manifest-'));
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // ==========================================================================
  // 1. Schema Validation
  // ==========================================================================
  describe('AgentManifestSchema Validation', () => {
    it('validates a complete valid agent manifest', () => {
      const valid = {
        id: 'test-agent',
        name: 'Test Agent',
        description: 'Test agent for unit tests',
        model: {
          model: 'claude-3-5-sonnet',
          provider: 'anthropic',
          temperature: 0.2,
          maxTokens: 4096,
        },
        systemPrompt: 'You are a test assistant in {{workspaceRoot}}.',
        tools: ['fs.read', 'exec.run'],
        policyProfile: 'project-write',
        budgets: {
          maxSteps: 30,
          maxTokens: 200_000,
          maxCostUsd: 5.0,
          maxWallClockSeconds: 900,
        },
      };

      const parsed = AgentManifestSchema.parse(valid);
      expect(parsed.id).toBe('test-agent');
      expect(parsed.version).toBe('1.0.0'); // default
      expect(parsed.maxContextTokens).toBe(100_000); // default
      expect(parsed.maxParallelTools).toBe(4); // default
      expect(parsed.policyProfile).toBe('project-write');
    });

    it('rejects manifest with invalid ID characters', () => {
      expect(() =>
        AgentManifestSchema.parse({
          id: 'invalid id with spaces!',
          name: 'Invalid',
          description: 'Invalid',
          model: { model: 'gpt-4o' },
          systemPrompt: 'Prompt',
        }),
      ).toThrow();
    });

    it('rejects manifest with out-of-range temperature', () => {
      expect(() =>
        AgentManifestSchema.parse({
          id: 'hot-agent',
          name: 'Hot',
          description: 'Hot',
          model: { model: 'gpt-4o', temperature: 2.5 },
          systemPrompt: 'Prompt',
        }),
      ).toThrow();
    });

    it('rejects manifest with empty system prompt', () => {
      expect(() =>
        AgentManifestSchema.parse({
          id: 'promptless',
          name: 'No Prompt',
          description: 'No Prompt',
          model: { model: 'gpt-4o' },
          systemPrompt: '',
        }),
      ).toThrow();
    });
  });

  // ==========================================================================
  // 2. Parser & Integrity Hash
  // ==========================================================================
  describe('parseAgentManifest', () => {
    it('parses valid JSON manifest and calculates correct SHA-256', () => {
      const jsonContent = JSON.stringify({
        id: 'json-agent',
        name: 'JSON Agent',
        description: 'Parsed from JSON',
        model: { model: 'mock-model' },
        systemPrompt: 'Hello JSON',
      });

      const loaded = parseAgentManifest(jsonContent, 'json');
      expect(loaded.manifest.id).toBe('json-agent');
      expect(loaded.sha256).toBe(computeManifestHash(jsonContent));
      expect(loaded.rawText).toBe(jsonContent);
    });

    it('parses valid YAML manifest', () => {
      const yamlContent = `
id: yaml-agent
name: YAML Agent
description: Parsed from YAML
model:
  model: gpt-4o
  temperature: 0.5
systemPrompt: "You are a YAML agent"
tools:
  - fs.read
  - fs.write
policyProfile: dev-shell
`;

      const loaded = parseAgentManifest(yamlContent, 'yaml');
      expect(loaded.manifest.id).toBe('yaml-agent');
      expect(loaded.manifest.model.temperature).toBe(0.5);
      expect(loaded.manifest.tools).toEqual(['fs.read', 'fs.write']);
      expect(loaded.manifest.policyProfile).toBe('dev-shell');
    });

    it('auto-detects format if preferredFormat is omitted', () => {
      const yamlContent = `
id: auto-agent
name: Auto Agent
description: Auto-detected YAML
model:
  model: claude-3-opus
systemPrompt: Auto prompt
`;

      const loaded = parseAgentManifest(yamlContent);
      expect(loaded.manifest.id).toBe('auto-agent');
    });

    it('throws VALIDATION_FAILED on invalid syntax or empty string', () => {
      expect(() => parseAgentManifest('')).toThrowError(AirError);
      expect(() => parseAgentManifest('not-valid-anything: :::')).toThrowError(AirError);
      expect(() => parseAgentManifest('{ bad json', 'json')).toThrowError(AirError);
      expect(() => parseAgentManifest('bad: [yaml: unclosed', 'yaml')).toThrowError(AirError);
    });

    it('formats schema validation errors clearly', () => {
      const incomplete = JSON.stringify({ id: 'only-id' });
      expect(() => parseAgentManifest(incomplete)).toThrowError(/Agent manifest validation failed/);
    });
  });

  // ==========================================================================
  // 3. System Prompt Template Substitution
  // ==========================================================================
  describe('renderSystemPrompt', () => {
    it('replaces tokens cleanly with variables', () => {
      const template = 'Agent {{agentId}} operating in {{workspaceRoot}} with goal {{goal}}.';
      const rendered = renderSystemPrompt(template, {
        agentId: 'coder-01',
        workspaceRoot: 'C:\\projects\\air',
        goal: 'Implement Phase 6',
      });

      expect(rendered).toBe('Agent coder-01 operating in C:\\projects\\air with goal Implement Phase 6.');
    });

    it('preserves tokens if variable is missing', () => {
      const template = 'Hello {{name}}, your role is {{role}}.';
      const rendered = renderSystemPrompt(template, { name: 'Alice' });
      expect(rendered).toBe('Hello Alice, your role is {{role}}.');
    });
  });

  // ==========================================================================
  // 4. Filesystem Loading
  // ==========================================================================
  describe('loadAgentManifestFromFile', () => {
    it('loads manifest safely from disk within root jail', async () => {
      const filePath = path.join(tempDir, 'coder.yaml');
      const manifestYaml = `
id: disk-coder
name: Disk Coder
description: Coder from disk
model:
  model: claude-3-5-sonnet
systemPrompt: "Code in {{workspaceRoot}}"
policyProfile: project-write
`;
      await fs.promises.writeFile(filePath, manifestYaml, 'utf8');

      const loaded = await loadAgentManifestFromFile(tempDir, 'coder.yaml');
      expect(loaded.manifest.id).toBe('disk-coder');
      expect(loaded.manifest.policyProfile).toBe('project-write');
      expect(loaded.sha256.length).toBe(64);
    });

    it('throws NOT_FOUND when file does not exist', async () => {
      await expect(
        loadAgentManifestFromFile(tempDir, 'missing.yaml'),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(AirError);
        expect((err as AirError).code).toBe('NOT_FOUND');
        return true;
      });
    });

    it('throws PATH_ESCAPE when path traverses outside root jail', async () => {
      await expect(
        loadAgentManifestFromFile(tempDir, '../outside.yaml'),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(AirError);
        expect((err as AirError).code).toBe('PATH_ESCAPE');
        return true;
      });
    });
  });

  // ==========================================================================
  // 5. Policy Profile Binding
  // ==========================================================================
  describe('resolvePolicyForManifest', () => {
    it('resolves built-in policy profiles directly', async () => {
      const p1 = await resolvePolicyForManifest({
        ...DEFAULT_DEVELOPER_AGENT,
        policyProfile: 'project-write',
      });
      expect(p1.name).toBe(PROJECT_WRITE_PROFILE.name);

      const p2 = await resolvePolicyForManifest({
        ...DEFAULT_REVIEWER_AGENT,
        policyProfile: 'readonly',
      });
      expect(p2.name).toBe(READONLY_PROFILE.name);

      const p3 = await resolvePolicyForManifest({
        ...DEFAULT_DEV_SHELL_AGENT,
        policyProfile: 'dev-shell',
      });
      expect(p3.name).toBe(DEV_SHELL_PROFILE.name);

      const p4 = await resolvePolicyForManifest({
        ...DEFAULT_AUDITOR_AGENT,
        policyProfile: 'locked-down',
      });
      expect(p4.name).toBe(LOCKED_DOWN_PROFILE.name);
    });

    it('invokes custom loader when referencing custom policy document', async () => {
      const customManifest = {
        ...DEFAULT_DEVELOPER_AGENT,
        policyProfile: 'custom-corporate-policy.yaml',
      };

      const customPolicy = {
        ...PROJECT_WRITE_PROFILE,
        name: 'custom-corp',
      };

      const resolved = await resolvePolicyForManifest(customManifest, async (ref) => {
        expect(ref).toBe('custom-corporate-policy.yaml');
        await Promise.resolve();
        return customPolicy;
      });

      expect(resolved.name).toBe('custom-corp');
    });

    it('throws CONFIG_INVALID if custom profile referenced without loader', async () => {
      const customManifest = {
        ...DEFAULT_DEVELOPER_AGENT,
        policyProfile: 'custom-corporate-policy.yaml',
      };

      await expect(resolvePolicyForManifest(customManifest)).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(AirError);
        expect((err as AirError).code).toBe('CONFIG_INVALID');
        return true;
      });
    });
  });

  // ==========================================================================
  // 6. Built-in Agent Catalog
  // ==========================================================================
  describe('Built-in Agent Manifests', () => {
    it.each([
      ['developer', DEFAULT_DEVELOPER_AGENT],
      ['reviewer', DEFAULT_REVIEWER_AGENT],
      ['dev-shell', DEFAULT_DEV_SHELL_AGENT],
      ['auditor', DEFAULT_AUDITOR_AGENT],
    ])('validates built-in agent %s against AgentManifestSchema', (_id, manifest) => {
      const validated = AgentManifestSchema.parse(manifest);
      expect(validated.id).toBe(manifest.id);
      expect(validated.tools.length).toBeGreaterThan(0);
      expect(validated.systemPrompt.length).toBeGreaterThan(0);
    });

    it('retrieves agent by id via getBuiltinAgent', () => {
      expect(getBuiltinAgent('developer')).toBe(DEFAULT_DEVELOPER_AGENT);
      expect(getBuiltinAgent('reviewer')).toBe(DEFAULT_REVIEWER_AGENT);
      expect(getBuiltinAgent('non-existent')).toBeUndefined();
    });

    it('lists all 4 built-in agents via listBuiltinAgents', () => {
      const agents = listBuiltinAgents();
      expect(agents).toHaveLength(4);
      const ids = agents.map((a) => a.id);
      expect(ids).toContain('developer');
      expect(ids).toContain('reviewer');
      expect(ids).toContain('dev-shell');
      expect(ids).toContain('auditor');
      expect(Object.keys(BUILTIN_AGENTS)).toHaveLength(4);
    });
  });
});
