/**
 * Policy Decision Engine Tests (Phase 5 - P5-T03).
 *
 * Verifies:
 * - Rule S1: Strict deny-by-default on empty policy and unmatched requests.
 * - Deny precedence: Explicit deny always beats allow and ask_user.
 * - Specificity ordering: Exact file/tool ranks higher than wildcard patterns (monotonicity).
 * - Priority tiers: Higher explicit priority overrides lower tiers.
 * - Scope filtering: Agent, session, profile constraints.
 * - Capability matching: Windows paths, hostnames, command trees.
 * - Argument pattern constraints: Deep equality and globs.
 * - Taint tracking constraints: Clean vs tainted input rejection.
 * - Explain output: Structured trace and human-readable formatting.
 * - Journal event emission: Emits tool.policy_decided via EventBus (Rule R8).
 * - ToolPolicyHook adapter: Duck-types to ToolExecutor.
 * - Replay determinism: Injected Clock and IdGenerator (Rule R6).
 */

import { describe, expect, it } from 'vitest';
import {
  PolicyEngine,
  type PolicyDocument,
  type PolicyRule,
} from '../../../src/policy/index.js';
import { FakeClock, FakeIdGenerator } from '../../../src/util/index.js';
import { EventBus } from '../../../src/journal/index.js';

function makeDoc(partial: {
  name: string;
  defaultEffect?: 'deny' | 'ask_user';
  rules?: PolicyRule[];
  description?: string;
}): PolicyDocument {
  return {
    version: 1,
    name: partial.name,
    defaultEffect: partial.defaultEffect ?? 'deny',
    rules: partial.rules ?? [],
    description: partial.description,
  };
}

describe('PolicyEngine (P5-T03)', () => {
  const clock = new FakeClock(new Date('2026-10-17T12:00:00.000Z'));
  const idGen = new FakeIdGenerator();

  describe('Deny-by-default (Rule S1)', () => {
    it('denies by default when policy document has no rules', () => {
      const doc = makeDoc({
        name: 'empty-policy',
        defaultEffect: 'deny',
        rules: [],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });
      const decision = engine.evaluate({
        toolName: 'fs.read',
      });

      expect(decision.allowed).toBe(false);
      expect(decision.effect).toBe('deny');
      expect(decision.ruleId).toBe('default');
      expect(decision.reason).toContain('denied by default');
      expect(decision.toolName).toBe('fs.read');
      expect(decision.candidateRulesCount).toBe(0);
      expect(decision.evaluatedAt).toBe('2026-10-17T12:00:00.000Z');
    });

    it('denies when rules exist but none match the requested tool', () => {
      const doc = makeDoc({
        name: 'git-only-policy',
        defaultEffect: 'deny',
        rules: [
          {
            id: 'allow-git',
            effect: 'allow',
            match: { tools: 'exec.run' },
            reason: 'Git execution is permitted',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });
      const decision = engine.evaluate({
        toolName: 'fs.delete',
      });

      expect(decision.allowed).toBe(false);
      expect(decision.effect).toBe('deny');
      expect(decision.ruleId).toBe('default');
    });

    it('falls back to ask_user if document specifies defaultEffect: ask_user', () => {
      const doc = makeDoc({
        name: 'prompt-default-policy',
        defaultEffect: 'ask_user',
        rules: [],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });
      const decision = engine.evaluate({
        toolName: 'http.fetch',
      });

      expect(decision.allowed).toBe(false);
      expect(decision.effect).toBe('ask_user');
      expect(decision.ruleId).toBe('default');
      expect(decision.reason).toContain('requiring approval by default');
    });
  });

  describe('Deny Precedence ("deny always beats allow")', () => {
    it('enforces deny precedence when matching allow and deny rules overlap', () => {
      const doc = makeDoc({
        name: 'precedence-test',
        defaultEffect: 'deny',
        rules: [
          {
            id: 'allow-all-fs',
            effect: 'allow',
            match: { tools: 'fs.*' },
            reason: 'Allow all filesystem operations',
          },
          {
            id: 'deny-system-dirs',
            effect: 'deny',
            match: {
              tools: 'fs.*',
              capabilities: 'fs:*:C:\\Windows\\**',
            },
            reason: 'Protect Windows directory',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });

      // Request inside Windows directory matches both rules -> Deny MUST win
      const decision = engine.evaluate({
        toolName: 'fs.read',
        capabilities: ['fs:read:C:\\Windows\\System32\\calc.exe'],
      });

      expect(decision.allowed).toBe(false);
      expect(decision.effect).toBe('deny');
      expect(decision.ruleId).toBe('deny-system-dirs');
      expect(decision.reason).toBe('Protect Windows directory');
    });

    it('enforces deny precedence regardless of document order', () => {
      const docWithDenyFirst = makeDoc({
        name: 'deny-first',
        rules: [
          {
            id: 'deny-rule',
            effect: 'deny',
            match: { tools: 'fs.read' },
            reason: 'Deny read',
          },
          {
            id: 'allow-rule',
            effect: 'allow',
            match: { tools: 'fs.read' },
            reason: 'Allow read',
          },
        ],
      });

      const docWithAllowFirst = makeDoc({
        name: 'allow-first',
        rules: [
          {
            id: 'allow-rule',
            effect: 'allow',
            match: { tools: 'fs.read' },
            reason: 'Allow read',
          },
          {
            id: 'deny-rule',
            effect: 'deny',
            match: { tools: 'fs.read' },
            reason: 'Deny read',
          },
        ],
      });

      const engine1 = new PolicyEngine(docWithDenyFirst, { clock, idGenerator: idGen });
      const engine2 = new PolicyEngine(docWithAllowFirst, { clock, idGenerator: idGen });

      expect(engine1.evaluate({ toolName: 'fs.read' }).effect).toBe('deny');
      expect(engine2.evaluate({ toolName: 'fs.read' }).effect).toBe('deny');
    });

    it('property test: in random rule collections, any matching deny strictly overrides allow', () => {
      const effects: ('allow' | 'deny' | 'ask_user')[] = ['allow', 'allow', 'deny', 'allow', 'ask_user'];

      for (let iteration = 0; iteration < 20; iteration++) {
        const shuffledEffects = [...effects].sort(() => Math.random() - 0.5);
        const rules: PolicyRule[] = shuffledEffects.map((eff, i) => ({
          id: `rule-${i}-${eff}`,
          effect: eff,
          match: { tools: 'fs.read' },
          reason: `Reason for ${eff}`,
        }));

        const doc = makeDoc({
          name: `prop-test-${iteration}`,
          rules,
        });

        const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });
        const decision = engine.evaluate({ toolName: 'fs.read' });

        expect(decision.effect).toBe('deny');
        expect(decision.allowed).toBe(false);
      }
    });
  });

  describe('Specificity Ordering', () => {
    it('ranks exact tool match higher than namespace wildcard and universal wildcard', () => {
      const doc = makeDoc({
        name: 'tool-specificity',
        rules: [
          {
            id: 'wildcard-tool',
            effect: 'allow',
            match: { tools: '*' },
            reason: 'Universal tool match',
          },
          {
            id: 'namespace-tool',
            effect: 'allow',
            match: { tools: 'fs.*' },
            reason: 'Namespace tool match',
          },
          {
            id: 'exact-tool',
            effect: 'allow',
            match: { tools: 'fs.read' },
            reason: 'Exact tool match',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });
      const decision = engine.evaluate({ toolName: 'fs.read' });

      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('exact-tool');
      expect(decision.specificity).toBe(100);
    });

    it('ranks exact file path higher than directory glob and recursive glob', () => {
      const doc = makeDoc({
        name: 'path-specificity',
        rules: [
          {
            id: 'recursive-glob-rule',
            effect: 'allow',
            match: {
              tools: 'fs.read',
              capabilities: 'fs:read:C:\\repo\\**',
            },
            reason: 'Recursive repo read',
          },
          {
            id: 'exact-file-rule',
            effect: 'allow',
            match: {
              tools: 'fs.read',
              capabilities: 'fs:read:C:\\repo\\package.json',
            },
            reason: 'Exact package.json read',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });

      const decisionExact = engine.evaluate({
        toolName: 'fs.read',
        capabilities: ['fs:read:C:\\repo\\package.json'],
      });

      expect(decisionExact.ruleId).toBe('exact-file-rule');
      expect(decisionExact.specificity).toBeGreaterThan(160);

      const decisionOther = engine.evaluate({
        toolName: 'fs.read',
        capabilities: ['fs:read:C:\\repo\\src\\index.ts'],
      });

      expect(decisionOther.ruleId).toBe('recursive-glob-rule');
    });

    it('monotonically ranks specificity from most generic to most specific', () => {
      const doc = makeDoc({
        name: 'monotonic-specificity',
        rules: [
          {
            id: 'generic',
            effect: 'allow',
            match: { tools: '*' },
            reason: 'generic',
          },
          {
            id: 'namespace',
            effect: 'allow',
            match: { tools: 'fs.*' },
            reason: 'namespace',
          },
          {
            id: 'tool-and-glob',
            effect: 'allow',
            match: { tools: 'fs.read', capabilities: 'fs:read:C:\\repo\\**' },
            reason: 'glob',
          },
          {
            id: 'tool-and-exact',
            effect: 'allow',
            match: { tools: 'fs.read', capabilities: 'fs:read:C:\\repo\\secret.env' },
            reason: 'exact',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });
      const trace = engine.explain({
        toolName: 'fs.read',
        capabilities: ['fs:read:C:\\repo\\secret.env'],
      });

      const matchedRules = trace.evaluatedRules.filter((r) => r.matched);
      expect(matchedRules.length).toBe(4);

      const scores = matchedRules.map((r) => r.specificity);
      for (let i = 0; i < scores.length - 1; i++) {
        const current = scores[i];
        const next = scores[i + 1];
        expect(current).toBeDefined();
        expect(next).toBeDefined();
        if (current !== undefined && next !== undefined) {
          expect(current).toBeLessThan(next);
        }
      }

      expect(trace.decision.ruleId).toBe('tool-and-exact');
    });
  });

  describe('Explicit Priority Tiers', () => {
    it('evaluates higher priority tier before lower priority tier', () => {
      const doc = makeDoc({
        name: 'priority-test',
        rules: [
          {
            id: 'low-prio-deny',
            priority: 10,
            effect: 'deny',
            match: { tools: 'exec.run' },
            reason: 'General deny exec',
          },
          {
            id: 'high-prio-allow',
            priority: 100,
            effect: 'allow',
            match: { tools: 'exec.run' },
            reason: 'Emergency override allow exec',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });
      const decision = engine.evaluate({ toolName: 'exec.run' });

      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('high-prio-allow');
      expect(decision.priority).toBe(100);
    });

    it('enforces deny-precedence within the same priority tier', () => {
      const doc = makeDoc({
        name: 'priority-deny-test',
        rules: [
          {
            id: 'tier100-allow',
            priority: 100,
            effect: 'allow',
            match: { tools: 'exec.run' },
            reason: 'Tier 100 allow',
          },
          {
            id: 'tier100-deny',
            priority: 100,
            effect: 'deny',
            match: { tools: 'exec.run' },
            reason: 'Tier 100 deny',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });
      const decision = engine.evaluate({ toolName: 'exec.run' });

      expect(decision.allowed).toBe(false);
      expect(decision.effect).toBe('deny');
      expect(decision.ruleId).toBe('tier100-deny');
    });
  });

  describe('Scope Filtering', () => {
    it('matches agent scope with wildcards', () => {
      const doc = makeDoc({
        name: 'agent-scope-test',
        rules: [
          {
            id: 'coder-only-rule',
            effect: 'allow',
            scope: { agents: ['coder-*', 'architect'] },
            match: { tools: 'fs.write' },
            reason: 'Coders may write',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });

      const decision1 = engine.evaluate({
        toolName: 'fs.write',
        agentId: 'coder-alpha',
      });
      expect(decision1.allowed).toBe(true);

      const decision2 = engine.evaluate({
        toolName: 'fs.write',
        agentId: 'reviewer',
      });
      expect(decision2.allowed).toBe(false);

      const decision3 = engine.evaluate({
        toolName: 'fs.write',
      });
      expect(decision3.allowed).toBe(false);
    });

    it('matches session and profile scopes', () => {
      const doc = makeDoc({
        name: 'session-profile-test',
        rules: [
          {
            id: 'prod-profile-rule',
            effect: 'allow',
            scope: { profiles: ['production'], sessions: ['sess-123'] },
            match: { tools: 'http.fetch' },
            reason: 'Production fetch',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });

      const ok = engine.evaluate({
        toolName: 'http.fetch',
        profile: 'production',
        sessionId: 'sess-123',
      });
      expect(ok.allowed).toBe(true);

      const wrongProfile = engine.evaluate({
        toolName: 'http.fetch',
        profile: 'staging',
        sessionId: 'sess-123',
      });
      expect(wrongProfile.allowed).toBe(false);
    });
  });

  describe('Capability Matching & Normalization', () => {
    it('normalizes Windows paths across forward and backward slashes', () => {
      const doc = makeDoc({
        name: 'path-norm-test',
        rules: [
          {
            id: 'allow-repo',
            effect: 'allow',
            match: {
              capabilities: 'fs:read:C:\\Users\\dev\\project\\**',
            },
            reason: 'Repo access',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });

      const forwardSlashDecision = engine.evaluate({
        toolName: 'fs.read',
        capabilities: ['fs:read:C:/Users/dev/project/src/app.ts'],
      });

      expect(forwardSlashDecision.allowed).toBe(true);
      expect(forwardSlashDecision.ruleId).toBe('allow-repo');
    });

    it('matches network capability hosts with subdomains and ports', () => {
      const doc = makeDoc({
        name: 'net-test',
        rules: [
          {
            id: 'allow-github-api',
            effect: 'allow',
            match: {
              capabilities: 'net:fetch:*.github.com:443',
            },
            reason: 'GitHub API access',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });

      const ok = engine.evaluate({
        toolName: 'http.fetch',
        capabilities: ['net:fetch:api.github.com:443'],
      });
      expect(ok.allowed).toBe(true);

      const deniedPort = engine.evaluate({
        toolName: 'http.fetch',
        capabilities: ['net:fetch:api.github.com:8080'],
      });
      expect(deniedPort.allowed).toBe(false);

      const deniedDomain = engine.evaluate({
        toolName: 'http.fetch',
        capabilities: ['net:fetch:evil.com:443'],
      });
      expect(deniedDomain.allowed).toBe(false);
    });

    it('matches command capabilities with executable normalization', () => {
      const doc = makeDoc({
        name: 'exec-test',
        rules: [
          {
            id: 'allow-git-status',
            effect: 'allow',
            match: {
              capabilities: 'exec:run:git status',
            },
            reason: 'Git status allowed',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });

      const ok = engine.evaluate({
        toolName: 'exec.run',
        capabilities: ['exec:run:git.exe status'],
      });
      expect(ok.allowed).toBe(true);

      const denied = engine.evaluate({
        toolName: 'exec.run',
        capabilities: ['exec:run:git push origin main'],
      });
      expect(denied.allowed).toBe(false);
    });

    it('requires all capabilities to be permitted for allow rules', () => {
      const doc = makeDoc({
        name: 'multi-cap-test',
        rules: [
          {
            id: 'allow-read',
            effect: 'allow',
            match: {
              capabilities: 'fs:read:C:\\repo\\**',
            },
            reason: 'Read repo',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });

      const multi = engine.evaluate({
        toolName: 'fs.edit',
        capabilities: [
          'fs:read:C:\\repo\\file.txt',
          'fs:write:C:\\repo\\file.txt',
        ],
      });

      expect(multi.allowed).toBe(false);
      expect(multi.effect).toBe('deny');
    });
  });

  describe('Argument Pattern Matching', () => {
    it('matches exact and glob argument patterns', () => {
      const doc = makeDoc({
        name: 'args-test',
        rules: [
          {
            id: 'allow-ts-glob',
            effect: 'allow',
            match: {
              tools: 'fs.glob',
              args: {
                pattern: '**/*.ts',
                recursive: true,
              },
            },
            reason: 'TypeScript glob query',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });

      const ok = engine.evaluate({
        toolName: 'fs.glob',
        input: { pattern: 'src/**/*.ts', recursive: true },
      });
      expect(ok.allowed).toBe(true);

      const wrongArg = engine.evaluate({
        toolName: 'fs.glob',
        input: { pattern: 'src/**/*.py', recursive: true },
      });
      expect(wrongArg.allowed).toBe(false);
    });
  });

  describe('Taint Constraints', () => {
    it('rejects tainted execution when rule specifies disallowTainted: true', () => {
      const doc = makeDoc({
        name: 'taint-test',
        rules: [
          {
            id: 'clean-only-write',
            effect: 'allow',
            match: {
              tools: 'fs.write',
              taint: { disallowTainted: true },
            },
            reason: 'Write only on clean data',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });

      const cleanReq = engine.evaluate({
        toolName: 'fs.write',
        tainted: false,
      });
      expect(cleanReq.allowed).toBe(true);

      const taintedReq = engine.evaluate({
        toolName: 'fs.write',
        tainted: true,
      });
      expect(taintedReq.allowed).toBe(false);
    });

    it('escalates tainted execution to ask_user when configured', () => {
      const doc = makeDoc({
        name: 'taint-escalation',
        rules: [
          {
            id: 'ask-on-tainted',
            effect: 'ask_user',
            match: {
              tools: 'fs.write',
              taint: { disallowTainted: true },
            },
            reason: 'Tainted write requires operator approval',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });

      const decision = engine.evaluate({
        toolName: 'fs.write',
        tainted: true,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.effect).toBe('ask_user');
      expect(decision.ruleId).toBe('ask-on-tainted');
    });
  });

  describe('Explain Output', () => {
    it('produces structured trace and formatted explanation string', () => {
      const doc = makeDoc({
        name: 'explain-test',
        rules: [
          {
            id: 'allow-read',
            effect: 'allow',
            match: { tools: 'fs.read' },
            reason: 'Read files',
          },
          {
            id: 'deny-write',
            effect: 'deny',
            match: { tools: 'fs.write' },
            reason: 'Deny write',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });
      const explainResult = engine.explain({
        toolName: 'fs.read',
        agentId: 'coder-1',
      });

      expect(explainResult.decision.allowed).toBe(true);
      expect(explainResult.candidateRulesCount).toBe(2);
      expect(explainResult.evaluatedRules).toHaveLength(2);

      const allowTrace = explainResult.evaluatedRules.find((r) => r.ruleId === 'allow-read');
      expect(allowTrace?.matched).toBe(true);
      expect(allowTrace?.selected).toBe(true);

      const denyTrace = explainResult.evaluatedRules.find((r) => r.ruleId === 'deny-write');
      expect(denyTrace?.matched).toBe(false);
      expect(denyTrace?.rejectReason).toContain('fs.read');

      expect(explainResult.explanation).toContain('=== Policy Evaluation Explanation ===');
      expect(explainResult.explanation).toContain('Decision:     ALLOW');
      expect(explainResult.explanation).toContain('Rule ID:      allow-read');
      expect(explainResult.explanation).toContain('SELECTED');
      expect(explainResult.explanation).toContain('REJECTED');
    });
  });

  describe('Journal Event Emission (Rule R8)', () => {
    it('publishes tool.policy_decided event when EventBus is provided', async () => {
      const eventBus = new EventBus({ clock, idGenerator: idGen });
      const recordedEvents: unknown[] = [];

      const sub = eventBus.subscribe(
        { types: ['tool.policy_decided'] },
        (event) => {
          recordedEvents.push(event);
        },
      );

      const doc = makeDoc({
        name: 'event-bus-test',
        rules: [
          {
            id: 'allow-ping',
            effect: 'allow',
            match: { tools: 'net.ping' },
            reason: 'Ping allowed',
          },
        ],
      });

      const engine = new PolicyEngine(doc, {
        clock,
        idGenerator: idGen,
        eventBus,
      });

      const decision = engine.evaluate({
        toolName: 'net.ping',
        runId: 'run-123',
        callId: '01HR0000000000000000000001',
      });

      await sub.drain();

      expect(decision.allowed).toBe(true);
      expect(recordedEvents).toHaveLength(1);

      const envelope = recordedEvents[0] as {
        type: string;
        payload: { toolCallId: string; decision: string; ruleId: string; reason: string };
      };
      expect(envelope.type).toBe('tool.policy_decided');
      expect(envelope.payload.toolCallId).toBe('01HR0000000000000000000001');
      expect(envelope.payload.decision).toBe('allow');
      expect(envelope.payload.ruleId).toBe('allow-ping');
      expect(envelope.payload.reason).toBe('Ping allowed');
    });
  });

  describe('ToolPolicyHook Adapter', () => {
    it('duck-types to ToolExecutor hook and evaluates context accurately', async () => {
      const doc = makeDoc({
        name: 'hook-test',
        rules: [
          {
            id: 'allow-fs-stat',
            effect: 'allow',
            match: { tools: 'fs.stat' },
            reason: 'Stat allowed',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });
      const hook = engine.asToolPolicyHook();

      const result = await hook.evaluate({
        tool: { name: 'fs.stat' },
        input: { path: 'C:\\test.txt' },
        capabilities: [],
        executionContext: {
          callId: 'call-1',
          runId: 'run-1',
          sessionId: 'sess-1',
          agentId: 'agent-1',
        },
      });

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('Stat allowed');
      expect(result.metadata?.['ruleId']).toBe('allow-fs-stat');
      expect(result.metadata?.['effect']).toBe('allow');
    });
  });

  describe('decide() alias per docs/MODULES.md', () => {
    it('decide() delegates to evaluate()', () => {
      const doc = makeDoc({
        name: 'decide-alias',
        rules: [
          {
            id: 'allow-any',
            effect: 'allow',
            match: { tools: '*' },
            reason: 'Allow all',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });
      const decision = engine.decide({ toolName: 'test.tool' });

      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('allow-any');
    });
  });

  describe('Edge Cases & Defensive Error Handling', () => {
    it('throws POLICY_INVALID when instantiated with invalid document', () => {
      // @ts-expect-error Testing invalid runtime input
      expect(() => new PolicyEngine(null)).toThrowError();
    });

    it('getDocument returns the underlying PolicyDocument', () => {
      const doc = makeDoc({ name: 'get-doc-test', rules: [] });
      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });
      expect(engine.getDocument().name).toBe('get-doc-test');
    });

    it('handles eventBus publication error gracefully without crashing evaluation', () => {
      const brokenBus = {
        publish: () => {
          throw new Error('Bus failure simulated');
        },
      } as unknown as EventBus;

      const doc = makeDoc({
        name: 'bus-err-test',
        rules: [
          {
            id: 'allow-tool',
            effect: 'allow',
            match: { tools: 'safe.tool' },
            reason: 'Safe',
          },
        ],
      });

      const engine = new PolicyEngine(doc, {
        clock,
        idGenerator: idGen,
        eventBus: brokenBus,
      });

      const decision = engine.evaluate({
        toolName: 'safe.tool',
        callId: '01HR0000000000000000000001',
      });

      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('allow-tool');
    });

    it('rejects rule requiring capabilities when request provides empty capabilities array', () => {
      const doc = makeDoc({
        name: 'empty-caps-test',
        rules: [
          {
            id: 'cap-rule',
            effect: 'allow',
            match: {
              capabilities: 'fs:read:C:\\repo\\**',
            },
            reason: 'Needs capabilities',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });
      const trace = engine.explain({
        toolName: 'fs.read',
        capabilities: [],
      });

      expect(trace.decision.allowed).toBe(false);
      expect(trace.evaluatedRules[0]?.rejectReason).toContain('Rule requires capabilities');
    });

    it('rejects match.args when input is null or non-object', () => {
      const doc = makeDoc({
        name: 'non-object-args',
        rules: [
          {
            id: 'args-rule',
            effect: 'allow',
            match: {
              args: { flag: true },
            },
            reason: 'Requires flag',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });

      const traceNull = engine.explain({
        toolName: 'test.tool',
        input: null,
      });
      expect(traceNull.decision.allowed).toBe(false);
      expect(traceNull.evaluatedRules[0]?.rejectReason).toContain('input is not an object');

      const traceString = engine.explain({
        toolName: 'test.tool',
        input: 'a-string-not-an-object',
      });
      expect(traceString.decision.allowed).toBe(false);
    });

    it('rejects match.args when required argument is missing or deep pattern mismatches', () => {
      const doc = makeDoc({
        name: 'deep-args',
        rules: [
          {
            id: 'deep-args-rule',
            effect: 'allow',
            match: {
              args: {
                tags: ['urgent', 'prod'],
                config: { nested: 'ok' },
                count: 42,
              },
            },
            reason: 'Deep args required',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });

      // Missing count
      const missingKey = engine.evaluate({
        toolName: 'test.tool',
        input: { tags: ['urgent', 'prod'], config: { nested: 'ok' } },
      });
      expect(missingKey.allowed).toBe(false);

      // Wrong array length
      const wrongArray = engine.evaluate({
        toolName: 'test.tool',
        input: { tags: ['urgent'], config: { nested: 'ok' }, count: 42 },
      });
      expect(wrongArray.allowed).toBe(false);

      // Wrong nested object
      const wrongNested = engine.evaluate({
        toolName: 'test.tool',
        input: { tags: ['urgent', 'prod'], config: { nested: 'bad' }, count: 42 },
      });
      expect(wrongNested.allowed).toBe(false);

      // Exactly matching
      const exactMatch = engine.evaluate({
        toolName: 'test.tool',
        input: { tags: ['urgent', 'prod'], config: { nested: 'ok' }, count: 42 },
      });
      expect(exactMatch.allowed).toBe(true);
    });

    it('rejects tainted request when maxTaintLevel is clean', () => {
      const doc = makeDoc({
        name: 'max-taint-test',
        rules: [
          {
            id: 'clean-only',
            effect: 'allow',
            match: {
              tools: 'db.query',
              taint: { maxTaintLevel: 'clean' },
            },
            reason: 'Clean query only',
          },
        ],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });

      const tainted = engine.evaluate({
        toolName: 'db.query',
        taintLevel: 'tainted',
      });
      expect(tainted.allowed).toBe(false);

      const clean = engine.evaluate({
        toolName: 'db.query',
        taintLevel: 'clean',
      });
      expect(clean.allowed).toBe(true);
    });

    it('formats explain output with session, profile, and taint details', () => {
      const doc = makeDoc({
        name: 'verbose-explain',
        rules: [],
      });

      const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });
      const trace = engine.explain({
        toolName: 'system.info',
        agentId: 'agent-x',
        sessionId: 'session-y',
        profile: 'dev-profile',
        taintLevel: 'tainted',
      });

      expect(trace.explanation).toContain('Agent:        agent-x');
      expect(trace.explanation).toContain('Session:      session-y');
      expect(trace.explanation).toContain('Profile:      dev-profile');
      expect(trace.explanation).toContain('Taint:        tainted');
    });
  });
});
