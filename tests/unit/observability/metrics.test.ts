import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Counter,
  Gauge,
  Histogram,
  metrics,
  MetricsRegistry,
  policyDecisionsCounter,
  runsTotalCounter,
  startPeriodicMetricsSnapshot,
  stopPeriodicMetricsSnapshot,
  toolDurationHistogram,
  writeMetricsSnapshot,
} from '../../../src/observability/index.js';

describe('metrics module (P1-T08)', () => {
  let tempDir: string;
  let metricsFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-metrics-test-'));
    metricsFile = path.join(tempDir, 'metrics.jsonl');
    metrics.reset();
  });

  afterEach(() => {
    stopPeriodicMetricsSnapshot();
    metrics.reset();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Counter', () => {
    it('increments monotonically with and without labels', () => {
      const c = new Counter('test_counter');
      expect(c.get()).toBe(0);

      c.inc();
      expect(c.get()).toBe(1);

      c.inc(5);
      expect(c.get()).toBe(6);

      c.inc(2, { status: 'success', method: 'GET' });
      c.inc(1, { status: 'error', method: 'GET' });

      expect(c.get({ status: 'success', method: 'GET' })).toBe(2);
      expect(c.get({ status: 'error', method: 'GET' })).toBe(1);
      expect(c.get()).toBe(6);
    });

    it('rejects negative increments', () => {
      const c = new Counter('test_counter');
      expect(() => c.inc(-1)).toThrow();
    });

    it('resets correctly', () => {
      const c = new Counter('test_counter');
      c.inc(10);
      c.reset();
      expect(c.get()).toBe(0);
    });
  });

  describe('Gauge', () => {
    it('sets, increments, and decrements values with labels', () => {
      const g = new Gauge('test_gauge');
      expect(g.get()).toBe(0);

      g.set(100);
      expect(g.get()).toBe(100);

      g.inc(10);
      expect(g.get()).toBe(110);

      g.dec(25);
      expect(g.get()).toBe(85);

      g.set(50, { pool: 'workers' });
      expect(g.get({ pool: 'workers' })).toBe(50);
      expect(g.get()).toBe(85);
    });

    it('resets correctly', () => {
      const g = new Gauge('test_gauge');
      g.set(42);
      g.reset();
      expect(g.get()).toBe(0);
    });
  });

  describe('Histogram', () => {
    it('calculates distribution statistics (count, sum, min, max, avg, percentiles)', () => {
      const h = new Histogram('latency_ms');

      // Observe values: 10, 20, 30, 40, 50, 60, 70, 80, 90, 100
      for (let i = 10; i <= 100; i += 10) {
        h.observe(i);
      }

      const summary = h.getSummary();
      expect(summary).toBeDefined();
      if (summary) {
        expect(summary.count).toBe(10);
        expect(summary.sum).toBe(550);
        expect(summary.min).toBe(10);
        expect(summary.max).toBe(100);
        expect(summary.avg).toBe(55);
        expect(summary.p50).toBe(60);
        expect(summary.p90).toBe(100);
        expect(summary.p99).toBe(100);
      }
    });

    it('isolates distributions by labels', () => {
      const h = new Histogram('tool_duration');
      h.observe(5, { tool: 'fs.read' });
      h.observe(15, { tool: 'fs.read' });

      h.observe(100, { tool: 'exec.run' });

      const fsReadSummary = h.getSummary({ tool: 'fs.read' });
      expect(fsReadSummary).toBeDefined();
      expect(fsReadSummary?.count).toBe(2);
      expect(fsReadSummary?.avg).toBe(10);

      const execSummary = h.getSummary({ tool: 'exec.run' });
      expect(execSummary).toBeDefined();
      expect(execSummary?.count).toBe(1);
      expect(execSummary?.avg).toBe(100);
    });

    it('returns undefined summary when no samples have been recorded', () => {
      const h = new Histogram('empty_h');
      expect(h.getSummary()).toBeUndefined();
    });
  });

  describe('MetricsRegistry & snapshot', () => {
    it('aggregates all counters, gauges, and histograms into snapshot', () => {
      const reg = new MetricsRegistry();
      const c = reg.counter('req_total');
      const g = reg.gauge('active_conns');
      const h = reg.histogram('resp_time');

      c.inc(10, { route: '/api' });
      g.set(5);
      h.observe(25);
      h.observe(75);

      const snap = reg.snapshot('2026-10-16T12:00:00.000Z');
      expect(snap.ts).toBe('2026-10-16T12:00:00.000Z');
      expect(snap.counters['req_total{route="/api"}']).toBe(10);
      expect(snap.gauges['active_conns']).toBe(5);
      expect(snap.histograms['resp_time']?.count).toBe(2);
      expect(snap.histograms['resp_time']?.avg).toBe(50);
    });

    it('updates standard catalogue metrics on global singleton', () => {
      runsTotalCounter.inc(1, { state: 'started' });
      policyDecisionsCounter.inc(1, { decision: 'allow' });
      toolDurationHistogram.observe(45, { tool: 'fs.read' });

      const snap = metrics.snapshot();
      expect(snap.counters['runs_total{state="started"}']).toBe(1);
      expect(snap.counters['policy_decisions_total{decision="allow"}']).toBe(1);
      expect(snap.histograms['tool_duration_ms{tool="fs.read"}']?.avg).toBe(45);
    });
  });

  describe('writeMetricsSnapshot & periodic persistence', () => {
    it('appends JSONL snapshots to disk', () => {
      runsTotalCounter.inc(3, { state: 'completed' });
      const snap = writeMetricsSnapshot(metricsFile, '2026-10-16T12:30:00.000Z');
      expect(snap.ts).toBe('2026-10-16T12:30:00.000Z');

      expect(fs.existsSync(metricsFile)).toBe(true);
      const content = fs.readFileSync(metricsFile, 'utf-8');
      expect(content).toContain('"runs_total{state=\\"completed\\"}":3');

      const parsed = JSON.parse(content.trim()) as { ts: string; counters: Record<string, number> };
      expect(parsed.ts).toBe('2026-10-16T12:30:00.000Z');
      expect(parsed.counters['runs_total{state="completed"}']).toBe(3);
    });

    it('appends multiple snapshots cleanly in JSONL format', () => {
      runsTotalCounter.inc(1);
      writeMetricsSnapshot(metricsFile);

      runsTotalCounter.inc(1);
      writeMetricsSnapshot(metricsFile);

      const lines = fs.readFileSync(metricsFile, 'utf-8').trim().split(/\r?\n/);
      expect(lines).toHaveLength(2);
      const line0 = lines[0];
      const line1 = lines[1];
      expect(line0).toBeDefined();
      expect(line1).toBeDefined();
      if (line0 && line1) {
        const first = JSON.parse(line0) as { counters: Record<string, number> };
        const second = JSON.parse(line1) as { counters: Record<string, number> };
        expect(first.counters['runs_total']).toBe(1);
        expect(second.counters['runs_total']).toBe(2);
      }
    });

    it('starts and stops periodic metrics snapshot', async () => {
      const nestedFile = path.join(tempDir, 'sub', 'metrics.jsonl');
      const stop = startPeriodicMetricsSnapshot(nestedFile, 20);
      expect(typeof stop).toBe('function');
      await new Promise((resolve) => setTimeout(resolve, 50));
      stop();
      expect(fs.existsSync(nestedFile)).toBe(true);
    });

    it('throws when incrementing counter with negative amount', () => {
      const c = new Counter('neg_test');
      expect(() => c.inc(-5)).toThrow('increment amount must be non-negative');
    });
  });
});
