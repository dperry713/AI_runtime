import * as fs from 'node:fs';
import * as path from 'node:path';
import { RotatingFileStream } from './rotation.js';

export type MetricLabels = Record<string, string | number | boolean>;

function formatMetricKey(name: string, labels?: MetricLabels): string {
  if (!labels || Object.keys(labels).length === 0) {
    return name;
  }
  const sorted = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k])}"`)
    .join(',');
  return `${name}{${sorted}}`;
}

export class Counter {
  private values = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly help?: string,
  ) {}

  public inc(amount = 1, labels?: MetricLabels): void {
    if (amount < 0) {
      throw new Error(`Counter ${this.name} increment amount must be non-negative, got ${amount}`);
    }
    const key = formatMetricKey(this.name, labels);
    const curr = this.values.get(key) ?? 0;
    this.values.set(key, curr + amount);
  }

  public get(labels?: MetricLabels): number {
    const key = formatMetricKey(this.name, labels);
    return this.values.get(key) ?? 0;
  }

  public getAll(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [k, v] of this.values.entries()) {
      result[k] = v;
    }
    return result;
  }

  public reset(): void {
    this.values.clear();
  }
}

export class Gauge {
  private values = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly help?: string,
  ) {}

  public set(value: number, labels?: MetricLabels): void {
    const key = formatMetricKey(this.name, labels);
    this.values.set(key, value);
  }

  public inc(amount = 1, labels?: MetricLabels): void {
    const key = formatMetricKey(this.name, labels);
    const curr = this.values.get(key) ?? 0;
    this.values.set(key, curr + amount);
  }

  public dec(amount = 1, labels?: MetricLabels): void {
    const key = formatMetricKey(this.name, labels);
    const curr = this.values.get(key) ?? 0;
    this.values.set(key, curr - amount);
  }

  public get(labels?: MetricLabels): number {
    const key = formatMetricKey(this.name, labels);
    return this.values.get(key) ?? 0;
  }

  public getAll(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [k, v] of this.values.entries()) {
      result[k] = v;
    }
    return result;
  }

  public reset(): void {
    this.values.clear();
  }
}

export interface HistogramSummary {
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p90: number;
  p99: number;
}

export class Histogram {
  private samples = new Map<string, number[]>();

  constructor(
    public readonly name: string,
    public readonly help?: string,
  ) {}

  public observe(value: number, labels?: MetricLabels): void {
    const key = formatMetricKey(this.name, labels);
    let list = this.samples.get(key);
    if (!list) {
      list = [];
      this.samples.set(key, list);
    }
    list.push(value);
  }

  public getSummary(labels?: MetricLabels): HistogramSummary | undefined {
    const key = formatMetricKey(this.name, labels);
    const list = this.samples.get(key);
    if (!list || list.length === 0) return undefined;

    return this.calculateSummary(list);
  }

  public getAll(): Record<string, HistogramSummary> {
    const result: Record<string, HistogramSummary> = {};
    for (const [k, list] of this.samples.entries()) {
      if (list.length > 0) {
        result[k] = this.calculateSummary(list);
      }
    }
    return result;
  }

  private calculateSummary(values: number[]): HistogramSummary {
    const sorted = [...values].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const min = sorted[0] ?? 0;
    const max = sorted[sorted.length - 1] ?? 0;
    const avg = count > 0 ? sum / count : 0;

    const quantile = (q: number): number => {
      if (count === 0) return 0;
      const index = Math.min(Math.floor(q * count), count - 1);
      return sorted[index] ?? 0;
    };

    return {
      count,
      sum,
      min,
      max,
      avg: Number(avg.toFixed(2)),
      p50: quantile(0.5),
      p90: quantile(0.9),
      p99: quantile(0.99),
    };
  }

  public reset(): void {
    this.samples.clear();
  }
}

export interface MetricSnapshot {
  ts: string;
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, HistogramSummary>;
}

export class MetricsRegistry {
  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();
  private histograms = new Map<string, Histogram>();

  public counter(name: string, help?: string): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter(name, help);
      this.counters.set(name, c);
    }
    return c;
  }

  public gauge(name: string, help?: string): Gauge {
    let g = this.gauges.get(name);
    if (!g) {
      g = new Gauge(name, help);
      this.gauges.set(name, g);
    }
    return g;
  }

  public histogram(name: string, help?: string): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram(name, help);
      this.histograms.set(name, h);
    }
    return h;
  }

  public snapshot(nowIso = new Date().toISOString()): MetricSnapshot {
    const countersOut: Record<string, number> = {};
    for (const c of this.counters.values()) {
      Object.assign(countersOut, c.getAll());
    }

    const gaugesOut: Record<string, number> = {};
    for (const g of this.gauges.values()) {
      Object.assign(gaugesOut, g.getAll());
    }

    const histogramsOut: Record<string, HistogramSummary> = {};
    for (const h of this.histograms.values()) {
      Object.assign(histogramsOut, h.getAll());
    }

    return {
      ts: nowIso,
      counters: countersOut,
      gauges: gaugesOut,
      histograms: histogramsOut,
    };
  }

  public reset(): void {
    for (const c of this.counters.values()) c.reset();
    for (const g of this.gauges.values()) g.reset();
    for (const h of this.histograms.values()) h.reset();
  }
}

/**
 * Singleton global metrics registry.
 */
export const metrics = new MetricsRegistry();

// Initialize standard metrics catalogue per docs/LOGGING.md §7
export const runsTotalCounter = metrics.counter('runs_total', 'Total agent runs by state');
export const turnsTotalCounter = metrics.counter('turns_total', 'Total turns executed');
export const toolCallsTotalCounter = metrics.counter('tool_calls_total', 'Total tool invocations by tool and outcome');
export const policyDecisionsCounter = metrics.counter('policy_decisions_total', 'Total policy decisions by decision');
export const providerRequestsCounter = metrics.counter('provider_requests_total', 'Total LLM provider requests');
export const tokensTotalCounter = metrics.counter('tokens_total', 'Total LLM tokens by provider, model, kind');
export const costUsdTotalCounter = metrics.counter('cost_usd_total', 'Total USD cost of LLM requests');
export const errorsTotalCounter = metrics.counter('errors_total', 'Total errors by error code');
export const journalEventsCounter = metrics.counter('journal_events_total', 'Total journal events by type');

export const toolDurationHistogram = metrics.histogram('tool_duration_ms', 'Duration of tool executions in ms');
export const modelLatencyHistogram = metrics.histogram('model_latency_ms', 'LLM model latency in ms');
export const turnDurationHistogram = metrics.histogram('turn_duration_ms', 'Turn duration in ms');
export const journalAppendHistogram = metrics.histogram('journal_append_ms', 'Journal append latency in ms');
export const ipcRequestHistogram = metrics.histogram('ipc_request_ms', 'IPC request duration in ms');

export const activeRunsGauge = metrics.gauge('active_runs', 'Currently active agent runs');
export const pendingApprovalsGauge = metrics.gauge('pending_approvals', 'Currently pending approvals');
export const eventbusQueueDepthGauge = metrics.gauge('eventbus_queue_depth', 'Current event bus queue depth');
export const rssBytesGauge = metrics.gauge('rss_bytes', 'Process Resident Set Size in bytes');
export const openHandlesGauge = metrics.gauge('open_handles', 'Open handles count');
export const childProcessesGauge = metrics.gauge('child_processes', 'Active sandboxed child processes');

let snapshotStream: RotatingFileStream | undefined;
let snapshotTimer: NodeJS.Timeout | undefined;

/**
 * Appends current metrics snapshot to metrics.jsonl.
 */
export function writeMetricsSnapshot(
  filePath: string,
  nowIso?: string,
): MetricSnapshot {
  const snap = metrics.snapshot(nowIso);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!snapshotStream || snapshotStream.destroyed) {
    snapshotStream = new RotatingFileStream({
      filePath,
      maxSizeBytes: 20 * 1024 * 1024, // 20 MB retention per docs/LOGGING.md
      keep: 5,
    });
  }

  snapshotStream.writeLine(`${JSON.stringify(snap)}\n`);
  snapshotStream.flushSync();
  return snap;
}

/**
 * Starts periodic metrics snapshots (every 60s by default).
 * Unrefs timer so process exit is not blocked.
 */
export function startPeriodicMetricsSnapshot(
  filePath: string,
  intervalMs = 60000,
): () => void {
  stopPeriodicMetricsSnapshot();

  snapshotTimer = setInterval(() => {
    try {
      // Sample standard system gauge
      rssBytesGauge.set(process.memoryUsage().rss);
      writeMetricsSnapshot(filePath);
    } catch {
      // Ignore background snapshot error
    }
  }, intervalMs);

  snapshotTimer.unref();

  return stopPeriodicMetricsSnapshot;
}

export function stopPeriodicMetricsSnapshot(): void {
  if (snapshotTimer) {
    clearInterval(snapshotTimer);
    snapshotTimer = undefined;
  }
  if (snapshotStream) {
    snapshotStream.end();
    snapshotStream = undefined;
  }
}
