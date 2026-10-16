/**
 * SQLite Schema Migrations for AIR Journal Index (P2-T03).
 *
 * Implements:
 * - Versioned schema migrations starting from v0 (empty database).
 * - Atomic execution per migration within SQLite transactions.
 * - Tracking applied migrations in `_migrations` table with UTC timestamps.
 * - Injected Clock for deterministic timestamping (Rule R6).
 */

import type Database from 'better-sqlite3';
import { AirError } from '../errors/index.js';
import { type Clock, SystemClock } from '../util/index.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: Database.Database) => void;
  readonly down?: ((db: Database.Database) => void) | undefined;
}

export interface AppliedMigration {
  version: number;
  name: string;
  appliedAt: string;
}

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  applied: AppliedMigration[];
}

/**
 * Migration 1: Initial schema for AIR Journal index.
 * Creates streams, sessions, runs, events, and performance indexes.
 */
export const migrationV1: Migration = {
  version: 1,
  name: '001_initial_schema',
  up: (db: Database.Database) => {
    // Streams table
    db.exec(`
      CREATE TABLE IF NOT EXISTS streams (
        stream_id TEXT PRIMARY KEY,
        stream_type TEXT NOT NULL,
        first_seq INTEGER NOT NULL DEFAULT 1,
        last_seq INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Sessions table
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        stream_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        run_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);
    `);

    // Runs table
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        error_code TEXT,
        error_message TEXT,
        token_usage_prompt INTEGER NOT NULL DEFAULT 0,
        token_usage_completion INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0.0,
        step_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs(session_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
      CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_agent_id ON runs(agent_id);
    `);

    // Events index table
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL REFERENCES streams(stream_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        ts TEXT NOT NULL,
        segment_index INTEGER NOT NULL,
        segment_path TEXT NOT NULL,
        offset INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        crc32 TEXT NOT NULL,
        session_id TEXT,
        run_id TEXT,
        turn_id TEXT,
        tool_call_id TEXT,
        trace_id TEXT,
        causation_id TEXT,
        correlation_id TEXT,
        UNIQUE(stream_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_events_stream_seq ON events(stream_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id) WHERE run_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id) WHERE session_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_events_tool_call_id ON events(tool_call_id) WHERE tool_call_id IS NOT NULL;
    `);
  },
  down: (db: Database.Database) => {
    db.exec(`
      DROP TABLE IF EXISTS events;
      DROP TABLE IF EXISTS runs;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS streams;
    `);
  },
};

export const ALL_MIGRATIONS: readonly Migration[] = Object.freeze([
  migrationV1,
]);

/**
 * Ensures the `_migrations` tracking table exists.
 */
export function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * Returns the current migration version of the database (0 if unmigrated).
 */
export function getCurrentMigrationVersion(db: Database.Database): number {
  ensureMigrationsTable(db);
  const row = db.prepare('SELECT MAX(version) as max_version FROM _migrations').get() as
    | { max_version: number | null }
    | undefined;
  return row?.max_version ?? 0;
}

/**
 * Returns a list of all migrations that have been applied.
 */
export function getAppliedMigrations(db: Database.Database): AppliedMigration[] {
  ensureMigrationsTable(db);
  const rows = db.prepare('SELECT version, name, applied_at as appliedAt FROM _migrations ORDER BY version ASC').all() as
    AppliedMigration[];
  return rows;
}

export interface RunMigrationsOptions {
  targetVersion?: number | undefined;
  migrations?: readonly Migration[] | undefined;
  clock?: Clock | undefined;
}

/**
 * Executes migrations from current version up to target version (or latest).
 */
export function runMigrations(
  db: Database.Database,
  options?: RunMigrationsOptions,
): MigrationResult {
  ensureMigrationsTable(db);

  const clock = options?.clock ?? new SystemClock();
  const migrations = options?.migrations ?? ALL_MIGRATIONS;
  const currentVersion = getCurrentMigrationVersion(db);

  const maxAvailable = migrations.length > 0
    ? Math.max(...migrations.map((m) => m.version))
    : 0;
  const targetVersion = options?.targetVersion ?? maxAvailable;

  const appliedList: AppliedMigration[] = [];

  if (targetVersion > currentVersion) {
    // Migrate UP
    const pending = migrations
      .filter((m) => m.version > currentVersion && m.version <= targetVersion)
      .sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      try {
        const executeMigration = db.transaction(() => {
          migration.up(db);
          const appliedAt = clock.iso();
          db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
            migration.version,
            migration.name,
            appliedAt,
          );
          appliedList.push({
            version: migration.version,
            name: migration.name,
            appliedAt,
          });
        });
        executeMigration();
      } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        throw new AirError(
          'MIGRATION_FAILED',
          `Migration ${migration.version} (${migration.name}) failed: ${String(err)}`,
          { cause },
        );
      }
    }
  } else if (targetVersion < currentVersion) {
    // Rollback DOWN
    const rollbackList = migrations
      .filter((m) => m.version <= currentVersion && m.version > targetVersion)
      .sort((a, b) => b.version - a.version);

    for (const migration of rollbackList) {
      if (!migration.down) {
        throw new AirError(
          'MIGRATION_FAILED',
          `Cannot rollback migration ${migration.version} (${migration.name}): no down() step defined`,
        );
      }
      const downFn = migration.down;
      try {
        const executeRollback = db.transaction(() => {
          downFn(db);
          db.prepare('DELETE FROM _migrations WHERE version = ?').run(migration.version);
        });
        executeRollback();
      } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        throw new AirError(
          'MIGRATION_FAILED',
          `Rollback of migration ${migration.version} (${migration.name}) failed: ${String(err)}`,
          { cause },
        );
      }
    }
  }

  const finalVersion = getCurrentMigrationVersion(db);
  return {
    fromVersion: currentVersion,
    toVersion: finalVersion,
    applied: appliedList,
  };
}
