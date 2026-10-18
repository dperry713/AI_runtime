/**
 * Real-world task simulation: an agent must create a project artifact.
 *
 * The mock model makes the same tool calls every run. The test oracle checks
 * the filesystem directly rather than trusting the model's final answer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentManifest } from '../../src/agent/manifest.js';
import { AgentRunner } from '../../src/agent/runner.js';
import { EventBus } from '../../src/journal/index.js';
import { PolicyEngine, type PolicyDocument } from '../../src/policy/index.js';
import { MockProvider } from '../../src/providers/index.js';
import { registerBuiltinFsTools, ToolRegistry } from '../../src/tools/index.js';
import { FakeClock, FakeIdGenerator } from '../../src/util/index.js';

describe('Real-world task simulation: create and verify an artifact', () => {
  let tempDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-realworld-task-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('verifies externally that the requested report was actually written and read', async () => {
    const clock = new FakeClock('2026-10-18T12:00:00.000Z');
    const idGenerator = new FakeIdGenerator();
    const eventBus = new EventBus({ clock, idGenerator });
    const artifactPath = path.join(workspaceRoot, 'release-report.md');
    const expectedContent = '# Release Readiness\n\n- Build: passed\n- Tests: passed\n- Security review: pending\n';

    const provider = new MockProvider({ clock });
    provider.enqueue({
      response: [{
        type: 'tool_call',
        id: 'realworld-write-001',
        name: 'fs.write',
        arguments: { path: artifactPath, content: expectedContent },
      }],
      stopReason: 'tool_calls',
    });
    provider.enqueue({
      response: [{
        type: 'tool_call',
        id: 'realworld-read-002',
        name: 'fs.read',
        arguments: { path: artifactPath },
      }],
      stopReason: 'tool_calls',
    });
    provider.enqueue({
      response: 'The release report was created and verified.',
      stopReason: 'stop',
    });

    const manifest: AgentManifest = {
      schemaVersion: 1,
      id: 'realworld-simulation',
      name: 'Real-world Simulation Agent',
      description: 'Deterministic task simulation for runtime verification.',
      version: '1.0.0',
      model: { model: 'mock-model', temperature: 0, maxTokens: 1024 },
      systemPrompt: 'Perform the requested task using available tools. Never claim a file was written unless the tool succeeds.',
      tools: ['fs.write', 'fs.read'],
      policyProfile: 'project-write',
      maxContextTokens: 16_000,
      maxParallelTools: 1,
    };

    const policyDocument: PolicyDocument = {
      version: 1,
      name: 'realworld-simulation-policy',
      defaultEffect: 'deny',
      rules: [{
        id: 'allow-scenario-workspace-file-io',
        effect: 'allow',
        priority: 10,
        match: { tools: ['fs.write', 'fs.read'] },
        reason: 'Permit file IO in this isolated simulation workspace.',
      }],
    };

    const toolRegistry = new ToolRegistry();
    registerBuiltinFsTools(toolRegistry);

    const runner = new AgentRunner({
      manifest,
      runId: 'run-realworld-simulation-001',
      provider,
      toolRegistry,
      policyEngine: new PolicyEngine(policyDocument, { clock, idGenerator }),
      eventBus,
      clock,
      idGenerator,
      workspaceRoot,
      maxTurns: 4,
    });

    const outcome = await runner.run({ initialGoal: 'Create release-report.md with the release readiness checklist, then read it back to verify it.' });

    // Independent oracle: do not accept the model's self-reported completion as proof.
    expect(outcome.status).toBe('completed');
    expect(fs.existsSync(artifactPath)).toBe(true);
    expect(fs.readFileSync(artifactPath, 'utf8')).toBe(expectedContent);
    expect(outcome.totalTurns).toBe(3);
  });
});
