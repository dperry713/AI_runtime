import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { LogRecord } from './streams.js';
import { type Clock, SystemClock } from '../util/index.js';
export const GENESIS_HASH = '0'.repeat(64);

export interface AuditRecord extends LogRecord {
  seq: number;
  prev: string;
  hash: string;
}

export interface AuditVerificationSuccess {
  valid: true;
  recordCount: number;
  headHash: string;
  firstSeq: number;
  lastSeq: number;
}

export interface AuditVerificationFailure {
  valid: false;
  brokenSeq: number;
  brokenLine: number;
  reason:
    | 'EMPTY_LOG'
    | 'CORRUPT_JSON'
    | 'MISSING_FIELDS'
    | 'SEQUENCE_MISMATCH'
    | 'PREV_HASH_MISMATCH'
    | 'HASH_MISMATCH';
  expected?: string | number | undefined;
  actual?: string | number | undefined;
  rawLine?: string | undefined;
}

export type AuditVerificationResult =
  | AuditVerificationSuccess
  | AuditVerificationFailure;

/**
 * Deterministic JSON stringifier sorting keys lexicographically
 * so cryptographic hashes are invariant to object key insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`,
  );
  return `{${pairs.join(',')}}`;
}

/**
 * Calculates SHA256(prev || canonicalJson(recordWithoutHash)).
 */
export function computeAuditHash(
  prevHash: string,
  recordWithoutHash: Record<string, unknown>,
): string {
  const cjson = canonicalJson(recordWithoutHash);
  return createHash('sha256')
    .update(prevHash)
    .update(cjson)
    .digest('hex');
}

/**
 * Append-only, cryptographically chained Audit Log.
 */
export class AuditLog {
  private currentSeq = 0;
  private headHash: string = GENESIS_HASH;
  private fd: number | null = null;
  private readonly clock: Clock;

  constructor(public readonly filePath: string, clock?: Clock) {
    this.clock = clock ?? new SystemClock();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.recoverHead();
    this.fd = fs.openSync(filePath, 'a');
  }

  private recoverHead(): void {
    if (!fs.existsSync(this.filePath)) {
      this.currentSeq = 0;
      this.headHash = GENESIS_HASH;
      return;
    }

    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const lines = content.trim().split(/\r?\n/).filter((l) => l.length > 0);

      if (lines.length === 0) {
        this.currentSeq = 0;
        this.headHash = GENESIS_HASH;
        return;
      }

      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        const parsed = JSON.parse(lastLine) as AuditRecord;
        if (typeof parsed.seq === 'number' && typeof parsed.hash === 'string') {
          this.currentSeq = parsed.seq;
          this.headHash = parsed.hash;
          return;
        }
      }
    } catch {
      // If reading fails, start fresh or keep defaults
    }

    this.currentSeq = 0;
    this.headHash = GENESIS_HASH;
  }

  public getHeadSeq(): number {
    return this.currentSeq;
  }

  public getHeadHash(): string {
    return this.headHash;
  }

  /**
   * Appends an audit entry into the hash chain.
   */
  public append(entry: Omit<AuditRecord, 'seq' | 'prev' | 'hash'>): AuditRecord {
    const nextSeq = this.currentSeq + 1;
    const prev = this.headHash;

    const recordWithoutHash: Record<string, unknown> = {
      ...entry,
      stream: 'audit',
      seq: nextSeq,
      prev,
    };

    const hash = computeAuditHash(prev, recordWithoutHash);
    const fullRecord: AuditRecord = {
      ...(recordWithoutHash as unknown as AuditRecord),
      hash,
    };

    const line = `${JSON.stringify(fullRecord)}\n`;
    if (this.fd !== null) {
      fs.writeSync(this.fd, Buffer.from(line, 'utf-8'));
      fs.fsyncSync(this.fd);
    }

    this.currentSeq = nextSeq;
    this.headHash = hash;

    return fullRecord;
  }

  /**
   * Writes a sealing record closing the current chain segment.
   */
  public seal(): AuditRecord {
    return this.append({
      v: 1,
      ts: this.clock.iso(),
      level: 'info',
      stream: 'audit',
      component: 'observability.audit',
      event: 'chain.seal',
      msg: 'Audit chain segment sealed',
      pid: process.pid,
      host: 'localhost',
      data: {
        sealedSeq: this.currentSeq,
        sealedHash: this.headHash,
      },
    });
  }

  public close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // Ignore close error
      }
      this.fd = null;
    }
  }
}

/**
 * Verifies the integrity of an audit log hash chain.
 * Walks records in sequence, recomputing each hash and checking prev links.
 */
export async function verifyAuditChain(
  filePath: string,
): Promise<AuditVerificationResult> {
  if (!fs.existsSync(filePath)) {
    return {
      valid: false,
      brokenSeq: 0,
      brokenLine: 0,
      reason: 'EMPTY_LOG',
      actual: 'File does not exist',
    };
  }

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  let expectedSeq = 1;
  let previousHash = GENESIS_HASH;
  let firstSeq = 0;
  let recordCount = 0;

  for await (const rawLine of rl) {
    lineNumber++;
    const line = rawLine.trim();
    if (line.length === 0) continue;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return {
        valid: false,
        brokenSeq: expectedSeq,
        brokenLine: lineNumber,
        reason: 'CORRUPT_JSON',
        rawLine: line,
      };
    }

    const { seq, prev, hash, ...rest } = record;

    if (
      typeof seq !== 'number' ||
      typeof prev !== 'string' ||
      typeof hash !== 'string'
    ) {
      return {
        valid: false,
        brokenSeq: expectedSeq,
        brokenLine: lineNumber,
        reason: 'MISSING_FIELDS',
        rawLine: line,
      };
    }

    if (recordCount === 0) {
      firstSeq = seq;
      expectedSeq = seq;
    }

    if (seq !== expectedSeq) {
      return {
        valid: false,
        brokenSeq: seq,
        brokenLine: lineNumber,
        reason: 'SEQUENCE_MISMATCH',
        expected: expectedSeq,
        actual: seq,
      };
    }

    if (prev !== previousHash) {
      return {
        valid: false,
        brokenSeq: seq,
        brokenLine: lineNumber,
        reason: 'PREV_HASH_MISMATCH',
        expected: previousHash,
        actual: prev,
      };
    }

    const recordToHash: Record<string, unknown> = {
      ...rest,
      seq,
      prev,
    };

    const calculatedHash = computeAuditHash(prev, recordToHash);
    if (hash !== calculatedHash) {
      return {
        valid: false,
        brokenSeq: seq,
        brokenLine: lineNumber,
        reason: 'HASH_MISMATCH',
        expected: calculatedHash,
        actual: hash,
      };
    }

    previousHash = hash;
    expectedSeq = seq + 1;
    recordCount++;
  }

  if (recordCount === 0) {
    return {
      valid: false,
      brokenSeq: 0,
      brokenLine: 0,
      reason: 'EMPTY_LOG',
      actual: 'File contains 0 records',
    };
  }

  return {
    valid: true,
    recordCount,
    headHash: previousHash,
    firstSeq,
    lastSeq: expectedSeq - 1,
  };
}
