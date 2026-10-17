import { describe, expect, it } from 'vitest';
import {
  computePolicyHash,
  lintPolicy,
  loadPolicyFromFile,
  parsePolicy,
  type PolicyDocument,
  PolicyDocumentSchema,
  PolicyRuleSchema,
} from '../../../src/policy/index.js';
import { AirError } from '../../../src/errors/index.js';
import { removeIn, writeFileAtomicIn } from '../../../src/util/index.js';

describe('Policy Language & Linter (P5-T02)', () => {
  const validPolicyJson = JSON.stringify({
    version: 1,
    name: 'developer-default',
    description: 'Safe dev policy',
    defaultEffect: 'deny',
    rules: [
      {
        id: 'allow-workspace-read',
        description: 'Read repo files',
        effect: 'allow',
        match: {
          tools: ['fs.read', 'fs.list'],
          capabilities: ['fs:read:C:\\repo\\**'],
        },
        reason: 'Reading repository files is safe',
      },
      {
        id: 'ask-workspace-write',
        description: 'Write repo files',
        effect: 'ask_user',
        match: {
          tools: 'fs.write',
          capabilities: 'fs:write:C:\\repo\\**',
        },
        reason: 'Writing files requires approval',
      },
    ],
  });

  const validPolicyYaml = `
version: 1
name: dev-yaml-policy
defaultEffect: deny
rules:
  - id: allow-net-github
    effect: allow
    match:
      tools:
        - http.fetch
      capabilities:
        - net:fetch:api.github.com
    reason: Accessing GitHub API is approved
`;

  describe('Policy Schema Validation', () => {
    it('validates a complete, structured policy document', () => {
      const parsed = JSON.parse(validPolicyJson) as unknown;
      const res = PolicyDocumentSchema.safeParse(parsed);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.name).toBe('developer-default');
        expect(res.data.rules.length).toBe(2);
        expect(res.data.defaultEffect).toBe('deny');
      }
    });

    it('rejects defaultEffect set to allow (Rule S1: deny-by-default)', () => {
      const parsed = {
        ...(JSON.parse(validPolicyJson) as Record<string, unknown>),
        defaultEffect: 'allow',
      };
      const res = PolicyDocumentSchema.safeParse(parsed);
      expect(res.success).toBe(false);
    });

    it('validates rule IDs against regex', () => {
      const validRule = {
        id: 'rule-01.allow_read:repo',
        effect: 'allow',
        match: { tools: 'fs.read' },
        reason: 'Safe read',
      };
      expect(PolicyRuleSchema.safeParse(validRule).success).toBe(true);

      const invalidRule = {
        id: 'bad rule with spaces!',
        effect: 'allow',
        match: { tools: 'fs.read' },
        reason: 'Safe read',
      };
      expect(PolicyRuleSchema.safeParse(invalidRule).success).toBe(false);
    });

    it('requires an explicit reason on every rule', () => {
      const missingReason = {
        id: 'rule-test',
        effect: 'allow',
        match: { tools: 'fs.read' },
        reason: '',
      };
      expect(PolicyRuleSchema.safeParse(missingReason).success).toBe(false);
    });
  });

  describe('Policy Loader', () => {
    it('parses JSON policy documents and calculates stable SHA-256 hash', () => {
      const loaded = parsePolicy(validPolicyJson);
      expect(loaded.policy.name).toBe('developer-default');
      expect(loaded.sha256).toBe(computePolicyHash(validPolicyJson));
      expect(loaded.rawText).toBe(validPolicyJson);
    });

    it('parses YAML policy documents seamlessly', () => {
      const loaded = parsePolicy(validPolicyYaml);
      expect(loaded.policy.name).toBe('dev-yaml-policy');
      expect(loaded.policy.rules[0]?.id).toBe('allow-net-github');
      expect(loaded.sha256).toBe(computePolicyHash(validPolicyYaml));
    });

    it('rejects empty or whitespace-only policy content', () => {
      expect(() => parsePolicy('')).toThrow(AirError);
      try {
        parsePolicy('');
      } catch (err) {
        expect((err as AirError).code).toBe('POLICY_INVALID');
      }
      expect(() => parsePolicy('   \n  ')).toThrow(AirError);
    });

    it('throws AirError with syntax error context on invalid JSON/YAML', () => {
      try {
        parsePolicy('{ "invalid": json ');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AirError);
        expect((err as AirError).code).toBe('POLICY_INVALID');
      }
    });

    it('throws AirError on schema validation failure', () => {
      const invalidDoc = JSON.stringify({
        version: 1,
        name: 'bad-policy',
        rules: [
          {
            id: 'rule-1',
            effect: 'invalid_effect',
            match: {},
            reason: 'test',
          },
        ],
      });
      try {
        parsePolicy(invalidDoc);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AirError);
        expect((err as AirError).code).toBe('POLICY_INVALID');
      }
    });

    it('loads policy files from disk safely within root jail', async () => {
      const tempDir = `C:\\temp\\air-policy-test-${Date.now()}`;
      try {
        await writeFileAtomicIn(tempDir, 'policy.json', validPolicyJson);
        const loaded = await loadPolicyFromFile(tempDir, 'policy.json');
        expect(loaded.policy.name).toBe('developer-default');
        expect(loaded.sha256).toBe(computePolicyHash(validPolicyJson));
      } finally {
        await removeIn(tempDir, 'policy.json').catch(() => {});
        await removeIn(tempDir, '').catch(() => {});
      }
    });
  });

  describe('Policy Linter (air policy lint)', () => {
    it('passes clean policy with zero errors or warnings', () => {
      const result = lintPolicy(validPolicyJson);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('detects duplicate rule IDs as errors', () => {
      const doc: PolicyDocument = {
        version: 1,
        name: 'duplicate-test',
        defaultEffect: 'deny',
        rules: [
          {
            id: 'shared-id',
            effect: 'allow',
            match: { tools: 'fs.read' },
            reason: 'Rule 1',
          },
          {
            id: 'shared-id',
            effect: 'deny',
            match: { tools: 'fs.write' },
            reason: 'Rule 2',
          },
        ],
      };

      const result = lintPolicy(doc);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'DUPLICATE_RULE_ID')).toBe(true);
    });

    it('detects empty match condition as warning', () => {
      const doc: PolicyDocument = {
        version: 1,
        name: 'empty-match-test',
        defaultEffect: 'deny',
        rules: [
          {
            id: 'broad-rule',
            effect: 'deny',
            match: {},
            reason: 'Matches everything',
          },
        ],
      };

      const result = lintPolicy(doc);
      expect(result.warnings.some((w) => w.code === 'EMPTY_MATCH_CONDITION')).toBe(true);
    });

    it('detects unparseable capability patterns as errors', () => {
      const doc: PolicyDocument = {
        version: 1,
        name: 'invalid-cap-test',
        defaultEffect: 'deny',
        rules: [
          {
            id: 'bad-cap-rule',
            effect: 'allow',
            match: { capabilities: '   ' },
            reason: 'Test',
          },
        ],
      };

      const result = lintPolicy(doc);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'INVALID_CAPABILITY_PATTERN')).toBe(true);
    });

    it('warns on overly permissive universal grant (*:*:*)', () => {
      const doc: PolicyDocument = {
        version: 1,
        name: 'permissive-test',
        defaultEffect: 'deny',
        rules: [
          {
            id: 'wildcard-allow',
            effect: 'allow',
            match: { capabilities: '*:*:*' },
            reason: 'Allow all',
          },
        ],
      };

      const result = lintPolicy(doc);
      expect(result.warnings.some((w) => w.code === 'OVERLY_PERMISSIVE_GRANT')).toBe(true);
    });

    it('warns on unconstrained exec:run:* grant', () => {
      const doc: PolicyDocument = {
        version: 1,
        name: 'unconstrained-exec-test',
        defaultEffect: 'deny',
        rules: [
          {
            id: 'exec-any',
            effect: 'allow',
            match: { capabilities: 'exec:run:*' },
            reason: 'Run any command',
          },
        ],
      };

      const result = lintPolicy(doc);
      expect(result.warnings.some((w) => w.code === 'UNCONSTRAINED_EXEC_GRANT')).toBe(true);
    });

    it('errors on modifying Windows system directories (C:\\Windows)', () => {
      const doc: PolicyDocument = {
        version: 1,
        name: 'system-tamper-test',
        defaultEffect: 'deny',
        rules: [
          {
            id: 'allow-modify-windows',
            effect: 'allow',
            match: { capabilities: 'fs:write:C:\\Windows\\System32\\calc.exe' },
            reason: 'Dangerous write',
          },
        ],
      };

      const result = lintPolicy(doc);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'DANGEROUS_SYSTEM_PATH_GRANT')).toBe(true);
    });

    it('allows read-only access to Windows system directories without error', () => {
      const doc: PolicyDocument = {
        version: 1,
        name: 'system-read-test',
        defaultEffect: 'deny',
        rules: [
          {
            id: 'allow-read-windows',
            effect: 'allow',
            match: { capabilities: 'fs:read:C:\\Windows\\System32\\calc.exe' },
            reason: 'Safe read',
          },
        ],
      };

      const result = lintPolicy(doc);
      expect(result.errors.filter((e) => e.code === 'DANGEROUS_SYSTEM_PATH_GRANT')).toEqual([]);
    });

    it('detects shadowed rules with identical effects', () => {
      const doc: PolicyDocument = {
        version: 1,
        name: 'shadowed-test',
        defaultEffect: 'deny',
        rules: [
          {
            id: 'broad-read',
            effect: 'allow',
            match: { tools: 'fs.*', capabilities: 'fs:read:C:\\repo\\**' },
            reason: 'Broad read',
          },
          {
            id: 'narrow-read',
            effect: 'allow',
            match: { tools: 'fs.read', capabilities: 'fs:read:C:\\repo\\src\\index.ts' },
            reason: 'Narrow read',
          },
        ],
      };

      const result = lintPolicy(doc);
      expect(result.warnings.some((w) => w.code === 'SHADOWED_RULE')).toBe(true);
    });

    it('detects unreachable allow rules when preceded by a broader deny rule', () => {
      const doc: PolicyDocument = {
        version: 1,
        name: 'unreachable-test',
        defaultEffect: 'deny',
        rules: [
          {
            id: 'deny-all-exec',
            effect: 'deny',
            match: { tools: 'exec.run', capabilities: 'exec:run:*' },
            reason: 'Deny all exec',
          },
          {
            id: 'allow-git',
            effect: 'allow',
            match: { tools: 'exec.run', capabilities: 'exec:run:git status' },
            reason: 'Allow git',
          },
        ],
      };

      const result = lintPolicy(doc);
      expect(result.warnings.some((w) => w.code === 'UNREACHABLE_ALLOW_RULE')).toBe(true);
    });

    it('handles syntax errors when string content is passed directly to lintPolicy', () => {
      const result = lintPolicy('invalid: { yaml: [');
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.code).toBe('SYNTAX_ERROR');
    });
  });
});
