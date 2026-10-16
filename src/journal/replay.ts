/**
 * Replay Engine & Projections for the AIR runtime (Phase 2 - P2-T05).
 *
 * Implements:
 * - State = fold(events) deterministic reconstruction.
 * - Snapshots every N events with pluggable SnapshotStore (Memory, File).
 * - Live RunStateProjection reducer for verifying replay equivalence:
 *   fold(replay(events)) == live projection.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AirError } from '../errors/index.js';
import { canonicalize, type Clock, SystemClock } from '../util/index.js';
import type { EventEnvelope } from './envelope.js';
import type { JournalReader } from './reader.js';
import { sanitizeStream } from './segment-writer.js';
import type { UpcasterRegistry } from './upcasters.js';

export type EventReducer<S, E extends EventEnvelope = EventEnvelope> = (
  state: S,
  event: E,
) => S;

// ============================================================================
// Snapshot Store Abstractions
// ============================================================================

export interface Snapshot<S = unknown> {
  streamId: string;
  seq: number;
  state: S;
  createdAt: string;
}

export interface SnapshotStore<S = unknown> {
  getLatestSnapshot(streamId: string): Promise<Snapshot<S> | null>;
  saveSnapshot(snapshot: Snapshot<S>): Promise<void>;
  listSnapshots?(streamId: string): Promise<Snapshot<S>[]>;
}

/**
 * In-memory snapshot store for tests and short-lived execution.
 */
export class MemorySnapshotStore<S = unknown> implements SnapshotStore<S> {
  private readonly snapshots = new Map<string, Snapshot<S>[]>();

  public getLatestSnapshot(streamId: string): Promise<Snapshot<S> | null> {
    const list = this.snapshots.get(streamId);
    if (!list || list.length === 0) return Promise.resolve(null);
    const last = list[list.length - 1];
    return Promise.resolve(last ?? null);
  }

  public saveSnapshot(snapshot: Snapshot<S>): Promise<void> {
    const list = this.snapshots.get(snapshot.streamId) ?? [];
    list.push(snapshot);
    list.sort((a, b) => a.seq - b.seq);
    this.snapshots.set(snapshot.streamId, list);
    return Promise.resolve();
  }

  public listSnapshots(streamId: string): Promise<Snapshot<S>[]> {
    return Promise.resolve([...(this.snapshots.get(streamId) ?? [])]);
  }

  public clear(): void {
    this.snapshots.clear();
  }
}

/**
 * File-backed snapshot store saving snapshots as JSON files on disk.
 */
export class FileSnapshotStore<S = unknown> implements SnapshotStore<S> {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = canonicalize(dir);
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  public async getLatestSnapshot(streamId: string): Promise<Snapshot<S> | null> {
    const snapshots = await this.listSnapshots(streamId);
    if (snapshots.length === 0) return null;
    const last = snapshots[snapshots.length - 1];
    return last ?? null;
  }

  public async saveSnapshot(snapshot: Snapshot<S>): Promise<void> {
    const sanitized = sanitizeStream(snapshot.streamId);
    const seqStr = String(snapshot.seq).padStart(8, '0');
    const fileName = `${sanitized}.${seqStr}.snapshot.json`;
    const fullPath = path.join(this.dir, fileName);

    const json = JSON.stringify(snapshot, null, 2);
    await fs.promises.writeFile(fullPath, json, 'utf8');
  }

  public async listSnapshots(streamId: string): Promise<Snapshot<S>[]> {
    if (!fs.existsSync(this.dir)) return [];
    const entries = await fs.promises.readdir(this.dir, { withFileTypes: true });
    const sanitized = sanitizeStream(streamId);
    const prefix = `${sanitized}.`;

    const snapshots: Snapshot<S>[] = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.snapshot.json')) {
        const fullPath = path.join(this.dir, entry.name);
        try {
          const content = await fs.promises.readFile(fullPath, 'utf8');
          const parsed = JSON.parse(content) as Snapshot<S>;
          snapshots.push(parsed);
        } catch {
          // Ignore corrupt snapshot files
        }
      }
    }

    snapshots.sort((a, b) => a.seq - b.seq);
    return snapshots;
  }
}

// ============================================================================
// Run State Lifecycle Projection & Reducer
// ============================================================================

export type RunLifecycleStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'waiting_approval'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RunStateProjection {
  runId: string;
  sessionId: string | null;
  agentId: string | null;
  status: RunLifecycleStatus;
  stepCount: number;
  toolCallCount: number;
  modelRequestCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastSeq: number;
}

export function createInitialRunState(runId: string): RunStateProjection {
  return {
    runId,
    sessionId: null,
    agentId: null,
    status: 'created',
    stepCount: 0,
    toolCallCount: 0,
    modelRequestCount: 0,
    errorCode: null,
    errorMessage: null,
    createdAt: '',
    updatedAt: '',
    completedAt: null,
    lastSeq: 0,
  };
}

/**
 * Pure reducer folding journal events into a RunStateProjection.
 */
export function reduceRunState(state: RunStateProjection, event: EventEnvelope): RunStateProjection {
  const payload = event.payload as Record<string, unknown> | undefined;
  const meta = event.meta;

  const next: RunStateProjection = {
    ...state,
    lastSeq: event.seq,
    updatedAt: event.ts,
  };

  switch (event.type) {
    case 'run.created': {
      next.createdAt = event.ts;
      if (payload && typeof payload['agentId'] === 'string') {
        next.agentId = payload['agentId'];
      }
      const sId = meta?.sessionId ?? (payload && typeof payload['sessionId'] === 'string' ? payload['sessionId'] : null);
      if (sId) next.sessionId = sId;
      next.status = 'created';
      break;
    }

    case 'run.starting':
    case 'run.running': {
      next.status = 'running';
      break;
    }

    case 'run.paused': {
      next.status = 'paused';
      break;
    }

    case 'run.resumed': {
      next.status = 'running';
      break;
    }

    case 'run.waiting_approval': {
      next.status = 'waiting_approval';
      break;
    }

    case 'run.waiting_user': {
      next.status = 'waiting_user';
      break;
    }

    case 'turn.completed': {
      next.stepCount += 1;
      break;
    }

    case 'model.requested': {
      next.modelRequestCount += 1;
      break;
    }

    case 'tool.requested':
    case 'tool.started': {
      next.toolCallCount += 1;
      break;
    }

    case 'run.completed': {
      next.status = 'completed';
      next.completedAt = event.ts;
      break;
    }

    case 'run.failed': {
      next.status = 'failed';
      next.completedAt = event.ts;
      if (payload && typeof payload['error'] === 'object' && payload['error'] !== null) {
        const errObj = payload['error'] as Record<string, unknown>;
        if (typeof errObj['code'] === 'string') next.errorCode = errObj['code'];
        if (typeof errObj['message'] === 'string') next.errorMessage = errObj['message'];
      }
      break;
    }

    case 'run.cancelled': {
      next.status = 'cancelled';
      next.completedAt = event.ts;
      break;
    }

    default:
      // Other events update lastSeq and updatedAt
      break;
  }

  return next;
}

// ============================================================================
// Fold & Replay Operations
// ============================================================================

/**
 * Folds a synchronous iterable of events into state using the provided reducer.
 */
export function foldEvents<S>(
  initialState: S,
  events: Iterable<EventEnvelope>,
  reducer: EventReducer<S>,
  upcasters?: UpcasterRegistry,
): S {
  let state = initialState;
  for (const event of events) {
    const ev = upcasters ? upcasters.upcast(event) : event;
    state = reducer(state, ev);
  }
  return state;
}

export interface ReplayOptions<S> {
  initialState: S;
  reducer: EventReducer<S>;
  fromSeq?: number | undefined;
  toSeq?: number | undefined;
  snapshotStore?: SnapshotStore<S> | undefined;
  snapshotInterval?: number | undefined;
  clock?: Clock | undefined;
  upcasters?: UpcasterRegistry | undefined;
}

export interface ReplayResult<S> {
  streamId: string;
  state: S;
  fromSeq: number;
  toSeq: number;
  eventsReplayed: number;
  snapshotLoaded: boolean;
  snapshotCreated: boolean;
}

/**
 * Replays a stream from a journal reader, loading snapshots if available and
 * updating snapshots as events are folded.
 */
export async function replayStream<S>(
  reader: JournalReader,
  streamId: string,
  options: ReplayOptions<S>,
): Promise<ReplayResult<S>> {
  if (!streamId || streamId.trim().length === 0) {
    throw new AirError('INVALID_ARGUMENT', 'streamId cannot be empty');
  }

  const clock = options.clock ?? new SystemClock();
  const snapshotStore = options.snapshotStore;
  const snapshotInterval = options.snapshotInterval;

  let currentState = options.initialState;
  let startSeq = options.fromSeq ?? 1;
  let snapshotLoaded = false;
  let snapshotCreated = false;

  // Check if we can resume from a snapshot
  if (snapshotStore && options.fromSeq === undefined) {
    const latestSnapshot = await snapshotStore.getLatestSnapshot(streamId);
    if (latestSnapshot && (options.toSeq === undefined || latestSnapshot.seq < options.toSeq)) {
      currentState = latestSnapshot.state;
      startSeq = latestSnapshot.seq + 1;
      snapshotLoaded = true;
    }
  }

  let eventsReplayed = 0;
  let lastProcessedSeq = startSeq > 1 ? startSeq - 1 : 0;

  for await (const rawEvent of reader.readStreamIter(streamId, {
    fromSeq: startSeq,
    toSeq: options.toSeq,
    order: 'asc',
  })) {
    const event = options.upcasters ? options.upcasters.upcast(rawEvent) : rawEvent;
    currentState = options.reducer(currentState, event);
    eventsReplayed++;
    lastProcessedSeq = event.seq;

    if (
      snapshotStore &&
      snapshotInterval !== undefined &&
      snapshotInterval > 0 &&
      eventsReplayed % snapshotInterval === 0
    ) {
      await snapshotStore.saveSnapshot({
        streamId,
        seq: event.seq,
        state: currentState,
        createdAt: clock.iso(),
      });
      snapshotCreated = true;
    }
  }

  return {
    streamId,
    state: currentState,
    fromSeq: startSeq,
    toSeq: lastProcessedSeq,
    eventsReplayed,
    snapshotLoaded,
    snapshotCreated,
  };
}
