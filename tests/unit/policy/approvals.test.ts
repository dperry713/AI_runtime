/**
 * Approval Broker Tests (Phase 5 - P5-T04).
 *
 * Verifies:
 * - Request/resolve lifecycle (approved, denied).
 * - Approval scopes: 'once', 'run', 'session' caching behaviors.
 * - Headless execution: automatic instant denial under headless mode (Rule S1).
 * - Timeouts: automatic expiration of pending requests.
 * - Persistence across simulated restart: pending approvals and cached grants restore.
 * - Journal event emission: emits tool.approval_requested, tool.approved, tool.denied (Rule R8).
 * - Cancellation of pending requests for active runs.
 * - Defensive error handling: APPROVAL_NOT_FOUND, INVALID_STATE.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  ApprovalBroker,
  createFsCapability,
} from '../../../src/policy/index.js';
import { FakeClock, FakeIdGenerator, existsIn, mkdirIn, removeIn } from '../../../src/util/index.js';
import { EventBus } from '../../../src/journal/index.js';

describe('ApprovalBroker (P5-T04)', () => {
  const clock = new FakeClock(new Date('2026-10-17T12:00:00.000Z'));
  const idGen = new FakeIdGenerator();

  function mustExist<T>(val: T | undefined | null): T {
    if (val === undefined || val === null) {
      throw new Error('Expected value to be defined');
    }
    return val;
  }

  describe('Basic Request & Resolve Lifecycle', () => {
    it('requests approval, marks pending, and resolves when operator approves', async () => {
      const broker = new ApprovalBroker({ clock, idGenerator: idGen });

      const requestPromise = broker.requestApproval({
        toolCallId: '01HR0000000000000000000001',
        toolName: 'fs.write',
        input: { path: 'C:\\repo\\file.txt', content: 'hello' },
        prompt: 'Allow write to C:\\repo\\file.txt?',
        riskLevel: 'high',
        scope: 'once',
        runId: 'run-100',
      });

      const pendingList = broker.listPending();
      expect(pendingList).toHaveLength(1);
      const pendingRecord = mustExist(pendingList[0]);
      expect(pendingRecord.toolName).toBe('fs.write');
      expect(pendingRecord.status).toBe('pending');
      expect(pendingRecord.prompt).toBe('Allow write to C:\\repo\\file.txt?');

      // Operator resolves
      const resolved = await broker.resolveApproval({
        approvalId: pendingRecord.id,
        decision: 'approved',
        operator: 'alice@example.com',
      });

      expect(resolved.status).toBe('approved');
      expect(resolved.resolvedBy).toBe('alice@example.com');

      const result = await requestPromise;
      expect(result.approved).toBe(true);
      expect(result.record.status).toBe('approved');
      expect(broker.listPending()).toHaveLength(0);
    });

    it('resolves with denial when operator rejects request', async () => {
      const broker = new ApprovalBroker({ clock, idGenerator: idGen });

      const requestPromise = broker.requestApproval({
        toolCallId: '01HR0000000000000000000002',
        toolName: 'exec.run',
        prompt: 'Allow rm -rf /?',
        riskLevel: 'critical',
        scope: 'once',
        runId: 'run-101',
      });

      const pending = mustExist(broker.listPending()[0]);

      await broker.resolveApproval({
        approvalId: pending.id,
        decision: 'denied',
        operator: 'bob@example.com',
        reason: 'Dangerous command forbidden',
      });

      const result = await requestPromise;
      expect(result.approved).toBe(false);
      expect(result.record.status).toBe('denied');
      expect(result.reason).toBe('Dangerous command forbidden');
      expect(broker.listPending()).toHaveLength(0);
    });
  });

  describe('Approval Scopes (once, run, session)', () => {
    it('scope: "once" requires fresh approval for every invocation', async () => {
      const broker = new ApprovalBroker({ clock, idGenerator: idGen });

      // First call
      const req1 = broker.requestApproval({
        toolCallId: '01HR0000000000000000000001',
        toolName: 'fs.delete',
        prompt: 'Delete file?',
        scope: 'once',
        runId: 'run-scope-test',
      });

      const p1 = mustExist(broker.listPending()[0]);
      await broker.resolveApproval({ approvalId: p1.id, decision: 'approved' });
      await req1;

      // Second identical call -> Not auto-approved because scope was 'once'
      const cached = broker.checkCachedApproval({
        toolName: 'fs.delete',
        runId: 'run-scope-test',
      });
      expect(cached).toBe(false);
    });

    it('scope: "run" auto-approves subsequent matching calls in the same run', async () => {
      const broker = new ApprovalBroker({ clock, idGenerator: idGen });
      const cap = createFsCapability('write', 'C:\\repo\\data.json');

      // First call with scope: 'run'
      const req1 = broker.requestApproval({
        toolCallId: '01HR0000000000000000000001',
        toolName: 'fs.write',
        capabilities: [cap],
        prompt: 'Allow writing data.json for this run?',
        scope: 'run',
        runId: 'run-scope-run-1',
      });

      const p1 = mustExist(broker.listPending()[0]);
      await broker.resolveApproval({ approvalId: p1.id, decision: 'approved', operator: 'operator' });
      const res1 = await req1;
      expect(res1.approved).toBe(true);

      // Subsequent call in SAME run -> Auto-approved from cache
      const res2 = await broker.requestApproval({
        toolCallId: '01HR0000000000000000000002',
        toolName: 'fs.write',
        capabilities: [cap],
        prompt: 'Allow writing data.json again?',
        scope: 'run',
        runId: 'run-scope-run-1',
      });

      expect(res2.approved).toBe(true);
      expect(res2.cached).toBe(true);
      expect(broker.listPending()).toHaveLength(0); // Never created pending record

      // Call in DIFFERENT run -> Not cached
      const resDiffRun = broker.checkCachedApproval({
        toolName: 'fs.write',
        capabilities: [cap],
        runId: 'run-different',
      });
      expect(resDiffRun).toBe(false);
    });

    it('scope: "session" auto-approves calls across different runs in the same session', async () => {
      const broker = new ApprovalBroker({ clock, idGenerator: idGen });

      const req1 = broker.requestApproval({
        toolCallId: '01HR0000000000000000000001',
        toolName: 'http.fetch',
        prompt: 'Allow fetch github.com for this session?',
        scope: 'session',
        runId: 'run-1',
        sessionId: 'sess-alpha',
      });

      const p1 = mustExist(broker.listPending()[0]);
      await broker.resolveApproval({ approvalId: p1.id, decision: 'approved' });
      await req1;

      // In same session, different run -> Cached
      const sameSessionDiffRun = broker.checkCachedApproval({
        toolName: 'http.fetch',
        runId: 'run-2',
        sessionId: 'sess-alpha',
      });
      expect(sameSessionDiffRun).toBe(true);

      // In different session -> Not cached
      const diffSession = broker.checkCachedApproval({
        toolName: 'http.fetch',
        runId: 'run-2',
        sessionId: 'sess-beta',
      });
      expect(diffSession).toBe(false);
    });
  });

  describe('Headless Execution (Rule S1 headless-deny)', () => {
    it('immediately denies approval request when running in headless mode', async () => {
      const broker = new ApprovalBroker({
        clock,
        idGenerator: idGen,
        headless: true,
      });

      const result = await broker.requestApproval({
        toolCallId: '01HR0000000000000000000001',
        toolName: 'fs.delete',
        prompt: 'Delete workspace?',
        runId: 'headless-run',
      });

      expect(result.approved).toBe(false);
      expect(result.record.status).toBe('denied');
      expect(result.record.resolvedBy).toBe('headless');
      expect(result.reason).toContain('Headless execution');
      expect(broker.listPending()).toHaveLength(0);
    });
  });

  describe('Timeouts & Expiration', () => {
    it('expires pending approval after configured timeoutMs', async () => {
      const broker = new ApprovalBroker({ clock, idGenerator: idGen });

      const requestPromise = broker.requestApproval({
        toolCallId: '01HR0000000000000000000001',
        toolName: 'fs.write',
        prompt: 'Write file?',
        timeoutMs: 50,
        runId: 'timeout-run',
      });

      expect(broker.listPending()).toHaveLength(1);

      // Advance clock past expiration and trigger timeout check
      clock.advance(100);
      broker.checkTimeouts();

      const result = await requestPromise;
      expect(result.approved).toBe(false);
      expect(result.record.status).toBe('expired');
      expect(result.record.resolvedBy).toBe('timeout');
      expect(broker.listPending()).toHaveLength(0);
    });
  });

  describe('Journal Event Emission (Rule R8)', () => {
    it('publishes approval_requested, approved, and denied journal events', async () => {
      const eventBus = new EventBus({ clock, idGenerator: idGen });
      const events: unknown[] = [];

      const sub = eventBus.subscribe(
        { types: ['tool.approval_requested', 'tool.approved', 'tool.denied'] },
        (e) => {
          events.push(e);
        },
      );

      const broker = new ApprovalBroker({
        clock,
        idGenerator: idGen,
        eventBus,
      });

      // Request approval
      const reqPromise = broker.requestApproval({
        toolCallId: '01HR0000000000000000000001',
        toolName: 'fs.edit',
        prompt: 'Edit config?',
        riskLevel: 'high',
        runId: 'journal-run-1',
      });

      const pending = mustExist(broker.listPending()[0]);

      // Approve
      await broker.resolveApproval({
        approvalId: pending.id,
        decision: 'approved',
        operator: 'alice',
      });

      await reqPromise;
      await sub.drain();

      expect(events).toHaveLength(2);
      const reqEvent = events[0] as { type: string; payload: { toolCallId: string; riskLevel: string } };
      expect(reqEvent.type).toBe('tool.approval_requested');
      expect(reqEvent.payload.riskLevel).toBe('high');

      const appEvent = events[1] as { type: string; payload: { toolCallId: string; operator: string } };
      expect(appEvent.type).toBe('tool.approved');
      expect(appEvent.payload.operator).toBe('alice');
    });
  });

  describe('Cancellation of Pending Approvals', () => {
    it('cancels all pending approvals for an aborted run', async () => {
      const broker = new ApprovalBroker({ clock, idGenerator: idGen });

      const req1 = broker.requestApproval({
        toolCallId: '01HR0000000000000000000001',
        toolName: 'tool.one',
        prompt: 'Prompt 1',
        runId: 'run-cancel-target',
      });

      const req2 = broker.requestApproval({
        toolCallId: '01HR0000000000000000000002',
        toolName: 'tool.two',
        prompt: 'Prompt 2',
        runId: 'run-cancel-target',
      });

      expect(broker.listPending({ runId: 'run-cancel-target' })).toHaveLength(2);

      await broker.cancelPending('run-cancel-target', 'User aborted run');

      const res1 = await req1;
      const res2 = await req2;

      expect(res1.approved).toBe(false);
      expect(res1.record.status).toBe('denied');
      expect(res1.reason).toBe('User aborted run');

      expect(res2.approved).toBe(false);
      expect(broker.listPending()).toHaveLength(0);
    });
  });

  describe('Persistence Across Simulated Restart', () => {
    const testRoot = path.resolve('var', 'test-approvals');
    const stateFile = 'approvals-state.json';

    it('persists and restores pending requests and cached scope grants', async () => {
      await mkdirIn(testRoot, '.');

      // Clean test file if present
      if (await existsIn(testRoot, stateFile)) {
        await removeIn(testRoot, stateFile);
      }

      // 1. First broker instance before restart
      const broker1 = new ApprovalBroker({
        clock,
        idGenerator: idGen,
        storage: { root: testRoot, statePath: stateFile },
      });

      // Grant run scope
      const req1 = broker1.requestApproval({
        toolCallId: '01HR0000000000000000000001',
        toolName: 'fs.write',
        prompt: 'Allow write for run?',
        scope: 'run',
        runId: 'run-persisted-1',
      });

      const p1 = mustExist(broker1.listPending()[0]);
      await broker1.resolveApproval({ approvalId: p1.id, decision: 'approved' });
      await req1;

      // Create a pending approval with long timeout
      await broker1.createApproval({
        toolCallId: '01HR0000000000000000000002',
        toolName: 'http.fetch',
        prompt: 'Pending fetch after restart?',
        timeoutMs: 120_000,
        runId: 'run-persisted-1',
      });

      // Verify file written to disk
      expect(await existsIn(testRoot, stateFile)).toBe(true);

      // Dispose broker 1 (simulating process shutdown)
      broker1.dispose();

      // 2. Second broker instance simulating restart
      const broker2 = new ApprovalBroker({
        clock,
        idGenerator: idGen,
        storage: { root: testRoot, statePath: stateFile },
      });

      await broker2.load();

      // Verify cached grant restored across restart
      const cachedAfterRestart = broker2.checkCachedApproval({
        toolName: 'fs.write',
        runId: 'run-persisted-1',
      });
      expect(cachedAfterRestart).toBe(true);

      // Verify pending request restored across restart
      const pendingAfterRestart = broker2.listPending();
      expect(pendingAfterRestart).toHaveLength(1);
      expect(pendingAfterRestart[0]?.toolName).toBe('http.fetch');

      // Can resolve the restored pending request in broker 2
      const resolvedRestart = await broker2.resolveApproval({
        approvalId: mustExist(pendingAfterRestart[0]).id,
        decision: 'approved',
        operator: 'restored-operator',
      });
      expect(resolvedRestart.status).toBe('approved');

      broker2.dispose();
      await removeIn(testRoot, stateFile);
    });
  });

  describe('Defensive Error Handling', () => {
    it('throws APPROVAL_NOT_FOUND when resolving non-existent approval ID', async () => {
      const broker = new ApprovalBroker({ clock, idGenerator: idGen });
      await expect(
        broker.resolveApproval({
          approvalId: 'non-existent-id',
          decision: 'approved',
        }),
      ).rejects.toThrowError('not found');
    });

    it('throws INVALID_STATE when calling requestApproval after broker disposed', async () => {
      const broker = new ApprovalBroker({ clock, idGenerator: idGen });
      broker.dispose();

      await expect(
        broker.requestApproval({
          toolCallId: '01HR0000000000000000000001',
          toolName: 'fs.read',
          prompt: 'prompt',
          runId: 'run-1',
        }),
      ).rejects.toThrowError('disposed');

      await expect(
        broker.createApproval({
          toolCallId: '01HR0000000000000000000001',
          toolName: 'fs.read',
          prompt: 'prompt',
          runId: 'run-1',
        }),
      ).rejects.toThrowError('disposed');

      await expect(
        broker.resolveApproval({
          approvalId: 'test-id',
          decision: 'approved',
        }),
      ).rejects.toThrowError('disposed');
    });

    it('returns immediately with cached grant for session scope', async () => {
      const broker = new ApprovalBroker({ clock, idGenerator: idGen });
      const req1 = broker.requestApproval({
        toolCallId: '01HR0000000000000000000001',
        toolName: 'fs.read',
        prompt: 'Session read',
        scope: 'session',
        sessionId: 'session-123',
        runId: 'run-1',
      });

      const p1 = mustExist(broker.listPending()[0]);
      await broker.resolveApproval({ approvalId: p1.id, decision: 'approved' });
      const res1 = await req1;
      expect(res1.approved).toBe(true);

      // Second request in same session is immediately approved
      const res2 = await broker.requestApproval({
        toolCallId: '01HR0000000000000000000002',
        toolName: 'fs.read',
        prompt: 'Session read 2',
        sessionId: 'session-123',
        runId: 'run-2',
      });
      expect(res2.approved).toBe(true);
      expect(res2.cached).toBe(true);
    });

    it('handles listPending filtering by sessionId', async () => {
      const broker = new ApprovalBroker({ clock, idGenerator: idGen });
      await broker.createApproval({
        toolCallId: '01HR0000000000000000000001',
        toolName: 'fs.read',
        prompt: 'read 1',
        runId: 'run-1',
        sessionId: 'sess-A',
      });
      await broker.createApproval({
        toolCallId: '01HR0000000000000000000002',
        toolName: 'fs.write',
        prompt: 'write 1',
        runId: 'run-2',
        sessionId: 'sess-B',
      });

      expect(broker.listPending({ sessionId: 'sess-A' })).toHaveLength(1);
      expect(broker.listPending({ sessionId: 'sess-B' })).toHaveLength(1);
      expect(broker.listPending({ sessionId: 'sess-C' })).toHaveLength(0);
    });

    it('cancels all pending approvals when no runId provided', async () => {
      const broker = new ApprovalBroker({ clock, idGenerator: idGen });
      const p1 = broker.requestApproval({
        toolCallId: '01HR0000000000000000000001',
        toolName: 'fs.read',
        prompt: 'read',
        runId: 'run-1',
      });
      const p2 = broker.requestApproval({
        toolCallId: '01HR0000000000000000000002',
        toolName: 'fs.write',
        prompt: 'write',
        runId: 'run-2',
      });

      await broker.cancelPending(undefined, 'Global shutdown');

      const res1 = await p1;
      const res2 = await p2;
      expect(res1.approved).toBe(false);
      expect(res1.reason).toBe('Global shutdown');
      expect(res2.approved).toBe(false);
      expect(broker.listPending()).toHaveLength(0);
    });

    it('handles manual checkTimeouts and expires pending items during load downtime', async () => {
      const testRoot = path.resolve('var', 'test-approvals-downtime');
      const stateFile = 'approvals-expired.json';
      await mkdirIn(testRoot, '.');

      const broker1 = new ApprovalBroker({
        clock,
        idGenerator: idGen,
        storage: { root: testRoot, statePath: stateFile },
      });

      await broker1.createApproval({
        toolCallId: '01HR0000000000000000000001',
        toolName: 'fs.read',
        prompt: 'short timeout',
        timeoutMs: 1000,
        runId: 'run-1',
      });

      // Advance clock past expiration
      clock.advance(5000);
      broker1.checkTimeouts();
      expect(broker1.listPending()).toHaveLength(0);

      // Create another one and simulate downtime
      await broker1.createApproval({
        toolCallId: '01HR0000000000000000000002',
        toolName: 'fs.write',
        prompt: 'expires during restart',
        timeoutMs: 2000,
        runId: 'run-1',
      });
      broker1.dispose();

      // Advance clock so it's expired before restart
      clock.advance(10000);

      const broker2 = new ApprovalBroker({
        clock,
        idGenerator: idGen,
        storage: { root: testRoot, statePath: stateFile },
      });

      await broker2.load();
      expect(broker2.listPending()).toHaveLength(0);

      broker2.dispose();
      await removeIn(testRoot, stateFile);
    });
  });
});
