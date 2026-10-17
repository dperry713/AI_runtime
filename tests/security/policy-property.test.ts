/**
 * Security Property-Based Tests for Policy Engine (Exit Gate P5).
 *
 * Verifies mathematical properties of policy evaluation using fast-check:
 * 1. Deny Precedence: At the highest matching priority tier, explicit 'deny'
 *    strictly beats 'allow' and 'ask_user'.
 * 2. Monotonic Specificity: At equal priority and effect, higher specificity
 *    candidate rules strictly win.
 * 3. Determinism: Identical inputs produce identical effects, specificity,
 *    and matching rules across repeated evaluations.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../../src/policy/engine.js';
import type { PolicyDocument, PolicyEffect, PolicyRule } from '../../src/policy/schema.js';
import { FakeClock, FakeIdGenerator } from '../../src/util/index.js';

describe('Policy Engine Security Property Tests (Exit Gate P5)', () => {
  const clock = new FakeClock('2026-10-17T12:00:00.000Z');
  const idGen = new FakeIdGenerator();

  // Arbitrary generator for tool names
  const arbToolName = fc.constantFrom(
    'fs.read',
    'fs.write',
    'fs.delete',
    'exec.run',
    'http.fetch',
    'user.ask',
  );

  // Arbitrary generator for policy effects
  const arbEffect = fc.constantFrom<PolicyEffect>('allow', 'deny', 'ask_user');

  // Arbitrary generator for priorities
  const arbPriority = fc.integer({ min: 0, max: 100 });

  it('Property 1: Deny Precedence — At highest priority tier, deny always beats allow and ask_user', () => {
    fc.assert(
      fc.property(
        arbToolName,
        arbPriority,
        fc.array(
          fc.record({
            id: fc.stringMatching(/^[a-z0-9_-]{3,10}$/),
            effect: arbEffect,
            priority: arbPriority,
          }),
          { minLength: 2, maxLength: 10 },
        ),
        (targetTool, sharedPriority, generatedRules) => {
          // Ensure there is at least one allow and one deny at sharedPriority
          const rules: PolicyRule[] = [
            {
              id: 'rule-allow-target',
              effect: 'allow',
              priority: sharedPriority,
              match: { tools: [targetTool] },
              reason: 'Permit target tool',
            },
            {
              id: 'rule-deny-target',
              effect: 'deny',
              priority: sharedPriority,
              match: { tools: [targetTool] },
              reason: 'Block target tool',
            },
            ...generatedRules.map((r, idx) => ({
              id: `rule-extra-${idx}`,
              effect: r.effect,
              priority: r.priority,
              match: { tools: [targetTool] },
              reason: `Extra rule ${idx}`,
            })),
          ];

          const doc: PolicyDocument = {
            version: 1,
            name: 'property-deny-precedence',
            defaultEffect: 'deny',
            rules,
          };

          const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });
          const decision = engine.evaluate({ toolName: targetTool });

          // Highest priority matching candidate rules
          const maxPriority = Math.max(...rules.map((r) => r.priority ?? 0));
          const topTierRules = rules.filter((r) => (r.priority ?? 0) === maxPriority);
          const topTierHasDeny = topTierRules.some((r) => r.effect === 'deny');

          if (topTierHasDeny) {
            expect(decision.allowed).toBe(false);
            expect(decision.effect).toBe('deny');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 2: Specificity Monotonicity — Higher specificity wins at equal priority tier with same effect', () => {
    fc.assert(
      fc.property(
        arbPriority,
        arbEffect,
        (priority, effect) => {
          // Exact tool match (specificity 100) vs prefix tool match (specificity 50) vs wildcard tool match (specificity 0)
          const rules: PolicyRule[] = [
            {
              id: 'wildcard-rule',
              effect,
              priority,
              match: { tools: ['*'] },
              reason: 'Wildcard match',
            },
            {
              id: 'prefix-rule',
              effect,
              priority,
              match: { tools: ['fs.*'] },
              reason: 'Prefix match',
            },
            {
              id: 'exact-rule',
              effect,
              priority,
              match: { tools: ['fs.read'] },
              reason: 'Exact match',
            },
          ];

          const doc: PolicyDocument = {
            version: 1,
            name: 'property-specificity',
            defaultEffect: 'deny',
            rules,
          };

          const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });
          const decision = engine.evaluate({ toolName: 'fs.read' });

          // Exact rule has highest specificity (100) and must win
          expect(decision.ruleId).toBe('exact-rule');
          expect(decision.effect).toBe(effect);
          expect(decision.specificity).toBe(100);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('Property 3: Determinism — Identical requests yield identical decisions across 50 evaluations', () => {
    const doc: PolicyDocument = {
      version: 1,
      name: 'property-determinism',
      defaultEffect: 'deny',
      rules: [
        {
          id: 'rule-deny-dangerous',
          effect: 'deny',
          priority: 80,
          match: { tools: ['exec.run'], args: { command: '*rm -rf*' } },
          reason: 'Prevent recursive deletion',
        },
        {
          id: 'rule-allow-read',
          effect: 'allow',
          priority: 10,
          match: { tools: ['fs.read'] },
          reason: 'Allow reading files',
        },
      ],
    };

    const engine = new PolicyEngine(doc, { clock, idGenerator: idGen });

    fc.assert(
      fc.property(
        fc.constantFrom(
          { toolName: 'fs.read', input: { path: 'C:\\test\\data.txt' } },
          { toolName: 'exec.run', input: { command: 'rm -rf /' } },
          { toolName: 'http.fetch', input: { url: 'https://example.com' } },
        ),
        (req) => {
          const baseline = engine.evaluate(req);

          for (let i = 0; i < 20; i++) {
            const subsequent = engine.evaluate(req);
            expect(subsequent.allowed).toBe(baseline.allowed);
            expect(subsequent.effect).toBe(baseline.effect);
            expect(subsequent.ruleId).toBe(baseline.ruleId);
            expect(subsequent.specificity).toBe(baseline.specificity);
            expect(subsequent.priority).toBe(baseline.priority);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
