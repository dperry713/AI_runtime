import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  canonicalJson,
  computeAuditHash,
  GENESIS_HASH,
  verifyAuditChain,
} from '../../../src/observability/index.js';

describe('audit hash chain module (P1-T07)', () => {
  let tempDir: string;
  let auditFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-audit-test-'));
    auditFile = path.join(tempDir, 'audit.log');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('canonicalJson', () => {
    it('produces identical output regardless of object key insertion order', () => {
      const objA = { z: 10, a: 'apple', m: { b: 2, a: 1 } };
      const objB = { a: 'apple', m: { a: 1, b: 2 }, z: 10 };

      expect(canonicalJson(objA)).toBe(canonicalJson(objB));
      expect(canonicalJson(objA)).toBe('{"a":"apple","m":{"a":1,"b":2},"z":10}');
    });

    it('handles arrays, primitives, and nulls correctly', () => {
      expect(canonicalJson([3, 2, 1])).toBe('[3,2,1]');
      expect(canonicalJson(null)).toBe('null');
      expect(canonicalJson('hello')).toBe('"hello"');
      expect(canonicalJson(true)).toBe('true');
    });
  });

  describe('computeAuditHash', () => {
    it('is invariant to key order in record object', () => {
      const prev = GENESIS_HASH;
      const rec1 = { seq: 1, prev, event: 'policy.decision', decision: 'allow' };
      const rec2 = { decision: 'allow', event: 'policy.decision', prev, seq: 1 };

      const hash1 = computeAuditHash(prev, rec1);
      const hash2 = computeAuditHash(prev, rec2);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it('produces different hashes for different payloads', () => {
      const prev = GENESIS_HASH;
      const h1 = computeAuditHash(prev, { seq: 1, prev, status: 'ok' });
      const h2 = computeAuditHash(prev, { seq: 1, prev, status: 'error' });

      expect(h1).not.toBe(h2);
    });
  });

  describe('AuditLog append and recovery', () => {
    it('initializes genesis record and chains subsequent records correctly', () => {
      const log = new AuditLog(auditFile);

      const r1 = log.append({
        v: 1,
        ts: '2026-10-16T12:00:00.000Z',
        level: 'info',
        stream: 'audit',
        component: 'policy',
        event: 'policy.decided',
        msg: 'Policy evaluated',
        pid: process.pid,
        host: 'localhost',
        data: { rule: 'fs.read', allowed: true },
      });

      expect(r1.seq).toBe(1);
      expect(r1.prev).toBe(GENESIS_HASH);
      expect(r1.hash).toBe(computeAuditHash(GENESIS_HASH, {
        v: 1,
        ts: '2026-10-16T12:00:00.000Z',
        level: 'info',
        stream: 'audit',
        component: 'policy',
        event: 'policy.decided',
        msg: 'Policy evaluated',
        pid: process.pid,
        host: 'localhost',
        data: { rule: 'fs.read', allowed: true },
        seq: 1,
        prev: GENESIS_HASH,
      }));

      const r2 = log.append({
        v: 1,
        ts: '2026-10-16T12:00:01.000Z',
        level: 'info',
        stream: 'audit',
        component: 'tool',
        event: 'tool.executed',
        msg: 'Tool finished',
        pid: process.pid,
        host: 'localhost',
        data: { tool: 'fs.read', exitCode: 0 },
      });

      expect(r2.seq).toBe(2);
      expect(r2.prev).toBe(r1.hash);
      expect(log.getHeadSeq()).toBe(2);
      expect(log.getHeadHash()).toBe(r2.hash);

      log.close();
    });

    it('recovers sequence and head hash when reopening existing log file', () => {
      const log1 = new AuditLog(auditFile);
      log1.append({
        v: 1,
        ts: '2026-10-16T12:00:00.000Z',
        level: 'info',
        stream: 'audit',
        component: 'auth',
        event: 'user.login',
        msg: 'login',
        pid: 1,
        host: 'box',
      });
      const r2 = log1.append({
        v: 1,
        ts: '2026-10-16T12:00:01.000Z',
        level: 'info',
        stream: 'audit',
        component: 'auth',
        event: 'user.action',
        msg: 'action',
        pid: 1,
        host: 'box',
      });
      log1.close();

      // Reopen log
      const log2 = new AuditLog(auditFile);
      expect(log2.getHeadSeq()).toBe(2);
      expect(log2.getHeadHash()).toBe(r2.hash);

      const r3 = log2.append({
        v: 1,
        ts: '2026-10-16T12:00:02.000Z',
        level: 'info',
        stream: 'audit',
        component: 'auth',
        event: 'user.logout',
        msg: 'logout',
        pid: 1,
        host: 'box',
      });

      expect(r3.seq).toBe(3);
      expect(r3.prev).toBe(r2.hash);
      log2.close();
    });

    it('seals chain with chain.seal record', () => {
      const log = new AuditLog(auditFile);
      log.append({
        v: 1,
        ts: '2026-10-16T12:00:00.000Z',
        level: 'info',
        stream: 'audit',
        component: 'system',
        event: 'system.start',
        msg: 'started',
        pid: 1,
        host: 'box',
      });

      const seal = log.seal();
      expect(seal.seq).toBe(2);
      expect(seal.event).toBe('chain.seal');
      log.close();
    });
  });

  describe('verifyAuditChain & tamper tests (Exit Gate P1)', () => {
    it('verifies an untampered audit log successfully', async () => {
      const log = new AuditLog(auditFile);
      for (let i = 1; i <= 5; i++) {
        log.append({
          v: 1,
          ts: `2026-10-16T12:00:0${i}.000Z`,
          level: 'info',
          stream: 'audit',
          component: 'test',
          event: `step.${i}`,
          msg: `Step ${i}`,
          pid: process.pid,
          host: 'localhost',
          data: { index: i },
        });
      }
      log.close();

      const result = await verifyAuditChain(auditFile);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.recordCount).toBe(5);
        expect(result.firstSeq).toBe(1);
        expect(result.lastSeq).toBe(5);
        expect(result.headHash).toHaveLength(64);
      }
    });

    it('detects tampering when a payload byte is flipped', async () => {
      const log = new AuditLog(auditFile);
      for (let i = 1; i <= 3; i++) {
        log.append({
          v: 1,
          ts: `2026-10-16T12:00:0${i}.000Z`,
          level: 'info',
          stream: 'audit',
          component: 'policy',
          event: `policy.eval.${i}`,
          msg: 'Evaluation',
          pid: process.pid,
          host: 'localhost',
          data: { allowed: true },
        });
      }
      log.close();

      // Tamper: Flip 'allowed: true' to 'allowed: false' on record 2 (line 2)
      const lines = fs.readFileSync(auditFile, 'utf-8').trim().split(/\r?\n/);
      expect(lines).toHaveLength(3);

      const targetLine = lines[1];
      expect(targetLine).toBeDefined();
      if (targetLine) {
        lines[1] = targetLine.replace('"allowed":true', '"allowed":false');
      }
      fs.writeFileSync(auditFile, `${lines.join('\n')}\n`, 'utf-8');

      const result = await verifyAuditChain(auditFile);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('HASH_MISMATCH');
        expect(result.brokenSeq).toBe(2);
        expect(result.brokenLine).toBe(2);
      }
    });

    it('detects tampering when hash field is altered', async () => {
      const log = new AuditLog(auditFile);
      log.append({
        v: 1,
        ts: '2026-10-16T12:00:00.000Z',
        level: 'info',
        stream: 'audit',
        component: 'system',
        event: 'start',
        msg: 'start',
        pid: 1,
        host: 'box',
      });
      log.close();

      // Replace hash with fake hash
      const lines = fs.readFileSync(auditFile, 'utf-8').trim().split(/\r?\n/);
      const targetLine = lines[0];
      if (targetLine) {
        const parsed = JSON.parse(targetLine) as Record<string, unknown>;
        parsed['hash'] = 'f'.repeat(64);
        lines[0] = JSON.stringify(parsed);
      }
      fs.writeFileSync(auditFile, `${lines.join('\n')}\n`, 'utf-8');

      const result = await verifyAuditChain(auditFile);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('HASH_MISMATCH');
        expect(result.brokenSeq).toBe(1);
        expect(result.brokenLine).toBe(1);
      }
    });

    it('detects tampering when prev hash pointer is broken', async () => {
      const log = new AuditLog(auditFile);
      log.append({
        v: 1,
        ts: '2026-10-16T12:00:01.000Z',
        level: 'info',
        stream: 'audit',
        component: 'test',
        event: 'e1',
        msg: 'e1',
        pid: 1,
        host: 'box',
      });
      log.append({
        v: 1,
        ts: '2026-10-16T12:00:02.000Z',
        level: 'info',
        stream: 'audit',
        component: 'test',
        event: 'e2',
        msg: 'e2',
        pid: 1,
        host: 'box',
      });
      log.close();

      // Alter prev hash of record 2
      const lines = fs.readFileSync(auditFile, 'utf-8').trim().split(/\r?\n/);
      const targetLine = lines[1];
      if (targetLine) {
        const parsed = JSON.parse(targetLine) as Record<string, unknown>;
        parsed['prev'] = 'a'.repeat(64);
        lines[1] = JSON.stringify(parsed);
      }
      fs.writeFileSync(auditFile, `${lines.join('\n')}\n`, 'utf-8');

      const result = await verifyAuditChain(auditFile);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('PREV_HASH_MISMATCH');
        expect(result.brokenSeq).toBe(2);
        expect(result.brokenLine).toBe(2);
      }
    });

    it('detects record omission or sequence jumps', async () => {
      const log = new AuditLog(auditFile);
      for (let i = 1; i <= 3; i++) {
        log.append({
          v: 1,
          ts: `2026-10-16T12:00:0${i}.000Z`,
          level: 'info',
          stream: 'audit',
          component: 'test',
          event: `step.${i}`,
          msg: `Step ${i}`,
          pid: 1,
          host: 'box',
        });
      }
      log.close();

      // Delete record 2
      const lines = fs.readFileSync(auditFile, 'utf-8').trim().split(/\r?\n/);
      const tampered = [lines[0], lines[2]];
      fs.writeFileSync(auditFile, `${tampered.join('\n')}\n`, 'utf-8');

      const result = await verifyAuditChain(auditFile);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('SEQUENCE_MISMATCH');
        expect(result.brokenSeq).toBe(3);
        expect(result.brokenLine).toBe(2);
        expect(result.expected).toBe(2);
      }
    });

    it('handles empty or nonexistent audit log files', async () => {
      const nonExistent = path.join(tempDir, 'does-not-exist.log');
      const r1 = await verifyAuditChain(nonExistent);
      expect(r1.valid).toBe(false);
      if (!r1.valid) {
        expect(r1.reason).toBe('EMPTY_LOG');
      }

      const emptyFile = path.join(tempDir, 'empty.log');
      fs.writeFileSync(emptyFile, '', 'utf-8');
      const r2 = await verifyAuditChain(emptyFile);
      expect(r2.valid).toBe(false);
      if (!r2.valid) {
        expect(r2.reason).toBe('EMPTY_LOG');
      }
    });

    it('detects corrupt JSON formatting on a line', async () => {
      fs.writeFileSync(auditFile, '{"valid":true}\nnot valid json\n', 'utf-8');
      const result = await verifyAuditChain(auditFile);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('MISSING_FIELDS'); // Line 1 missing seq/prev/hash
      }
    });
  });
});
