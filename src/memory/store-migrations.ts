/**
 * SQLite Schema Migrations for AIR Memory Store (P8-T02).
 *
 * Implements:
 * - Versioned schema migrations starting from v0 (empty database).
 * - FTS5 virtual table for BM25 full-text search over title + content.
 * - Vector storage column for optional embedding support (P8-T03).
 * - Atomic execution per migration within SQLite transactions.
 * - Injected Clock for deterministic timestamping (Rule R6).
 */

import type Database from 'better-sqlite3';
import { AirError } from '../errors/index.js';
import { type Clock, SystemClock } from '../util/index.js';

export interface MemoryMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: Database.Database) => void;
  readonly down?: ((db: Database.Database) => void) | undefined;
}

export interface MemoryAppliedMigration {
  version: number;
  name: string;
  appliedAt: string;
}

export interface MemoryMigrationResult {
  fromVersion: number;
  toVersion: number;
  applied: MemoryAppliedMigration[];
}

/**
 * Migration 1: Initial schema for AIR Memory store.
 * Creates the memories table and FTS5 virtual table for BM25 keyword search.
 */
export const memoryMigrationV1: MemoryMigration = {
  version: 1,
  name: '001_initial_schema',
  up: (db: Database.Database) => {
    // Main memories table
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        scope           TEXT NOT NULL,
        agent_id        TEXT,
        session_id      TEXT,
        run_id          TEXT,
        title           TEXT NOT NULL,
        content         TEXT NOT NULL,
        tags            TEXT NOT NULL DEFAULT '[]',
        metadata        TEXT NOT NULL DEFAULT '{}',
        importance      REAL NOT NULL DEFAULT 0.5,
        provenance      TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        accessed_at     TEXT,
        access_count    INTEGER NOT NULL DEFAULT 0,
        ttl_seconds     INTEGER,
        expires_at      TEXT,
        embedding       BLOB
      );
    `);

    // Performance indexes
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_kind        ON memories(kind);
      CREATE INDEX IF NOT EXISTS idx_memories_scope       ON memories(scope);
      CREATE INDEX IF NOT EXISTS idx_memories_agent_id    ON memories(agent_id) WHERE agent_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memories_session_id  ON memories(session_id) WHERE session_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memories_run_id      ON memories(run_id) WHERE run_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memories_importance  ON memories(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_created_at  ON memories(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_expires_at  ON memories(expires_at) WHERE expires_at IS NOT NULL;
    `);

    // FTS5 virtual table for BM25 full-text search (title + content)
    // content='memories' keeps the FTS index in sync with the main table.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        title,
        content,
        content='memories',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 1'
      );
    `);

    // Triggers to keep FTS index in sync with memories table
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai
        AFTER INSERT ON memories
      BEGIN
        INSERT INTO memories_fts(rowid, title, content)
          VALUES (NEW.rowid, NEW.title, NEW.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad
        AFTER DELETE ON memories
      BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content)
          VALUES ('delete', OLD.rowid, OLD.title, OLD.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au
        AFTER UPDATE ON memories
      BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content)
          VALUES ('delete', OLD.rowid, OLD.title, OLD.content);
        INSERT INTO memories_fts(rowid, title, content)
          VALUES (NEW.rowid, NEW.title, NEW.content);
      END;
    `);
  },
  down: (db: Database.Database) => {
    db.exec(`
      DROP TRIGGER IF EXISTS memories_au;
      DROP TRIGGER IF EXISTS memories_ad;
      DROP TRIGGER IF EXISTS memories_ai;
      DROP TABLE IF EXISTS memories_fts;
      DROP TABLE IF EXISTS memories;
    `);
  },
};

export const ALL_MEMORY_MIGRATIONS: readonly MemoryMigration[] = Object.freeze([
  memoryMigrationV1,
]);

/**
 * Ensures the `_memory_migrations` tracking table exists.
 */
export function ensureMemoryMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _memory_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * Returns the current migration version of the memory database (0 if unmigrated).
 */
export function getMemoryMigrationVersion(db: Database.Database): number {
  ensureMemoryMigrationsTable(db);
  const row = db.prepare('SELECT MAX(version) as max_version FROM _memory_migrations').get() as
    | { max_version: number | null }
    | undefined;
  return row?.max_version ?? 0;
}

export interface RunMemoryMigrationsOptions {
  targetVersion?: number | undefined;
  migrations?: readonly MemoryMigration[] | undefined;
  clock?: Clock | undefined;
}

/**
 * Executes memory migrations from current version up to target version (or latest).
 */
export function runMemoryMigrations(
  db: Database.Database,
  options?: RunMemoryMigrationsOptions,
): MemoryMigrationResult {
  ensureMemoryMigrationsTable(db);

  const clock = options?.clock ?? new SystemClock();
  const migrations = options?.migrations ?? ALL_MEMORY_MIGRATIONS;
  const currentVersion = getMemoryMigrationVersion(db);

  const maxAvailable = migrations.length > 0 ? Math.max(...migrations.map((m) => m.version)) : 0;
  const targetVersion = options?.targetVersion ?? maxAvailable;

  const appliedList: MemoryAppliedMigration[] = [];

  if (targetVersion > currentVersion) {
    const pending = migrations
      .filter((m) => m.version > currentVersion && m.version <= targetVersion)
      .sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      try {
        const execute = db.transaction(() => {
          migration.up(db);
          const appliedAt = clock.iso();
          db.prepare(
            'INSERT INTO _memory_migrations (version, name, applied_at) VALUES (?, ?, ?)',
          ).run(migration.version, migration.name, appliedAt);
          appliedList.push({ version: migration.version, name: migration.name, appliedAt });
        });
        execute();
      } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        throw new AirError(
          'MIGRATION_FAILED',
          `Memory migration ${migration.version} (${migration.name}) failed: ${String(err)}`,
          { cause },
        );
      }
    }
  } else if (targetVersion < currentVersion) {
    const rollbackList = migrations
      .filter((m) => m.version <= currentVersion && m.version > targetVersion)
      .sort((a, b) => b.version - a.version);

    for (const migration of rollbackList) {
      if (!migration.down) {
        throw new AirError(
          'MIGRATION_FAILED',
          `Cannot rollback memory migration ${migration.version} (${migration.name}): no down() step`,
        );
      }
      const downFn = migration.down;
      try {
        const executeRollback = db.transaction(() => {
          downFn(db);
          db.prepare('DELETE FROM _memory_migrations WHERE version = ?').run(migration.version);
        });
        executeRollback();
      } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        throw new AirError(
          'MIGRATION_FAILED',
          `Rollback of memory migration ${migration.version} (${migration.name}) failed: ${String(err)}`,
          { cause },
        );
      }
    }
  }

  const finalVersion = getMemoryMigrationVersion(db);
  return { fromVersion: currentVersion, toVersion: finalVersion, applied: appliedList };
}
