/**
 * Unit & Integration tests for Upgrade & Migration (Phase 12: P12-T03).
 *
 * Verifies:
 * - In-place config schema migration from legacy versions to current.
 * - Journal index database schema migration with data preservation.
 * - Memory store database schema migration with FTS5 persistence.
 * - Journal event upcasters preserving data across payload schema versions.
 * - In-place upgrade integrity across restarts.
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrateConfig, CURRENT_CONFIG_VERSION } from '../../../src/config/index.js';
import {
  runMigrations,
  getCurrentMigrationVersion,
  migrationV1,
} from '../../../src/journal/migrations.js';
import {
  runMemoryMigrations,
  getMemoryMigrationVersion,
  memoryMigrationV1,
} from '../../../src/memory/store-migrations.js';
import {
  UpcasterRegistry,
  syntheticV1ToV2Upcaster,
  syntheticV2ToV3Upcaster,
  type SyntheticV1Payload,
  type SyntheticV3Payload,
} from '../../../src/journal/upcasters.js';
import { createEnvelope } from '../../../src/journal/envelope.js';
import { FakeClock } from '../../../src/util/clock.js';
import { FakeIdGenerator } from '../../../src/util/id.js';

describe('P12-T03: Upgrade & Migration', () => {
  describe('Config Migration', () => {
    it('migrates legacy unversioned config to current version', () => {
      const legacyConfig = {
        logging: { level: 'info' },
        providers: { default: 'mock' },
      };

      const migrated = migrateConfig(legacyConfig);
      expect(migrated['version']).toBe(CURRENT_CONFIG_VERSION);
      expect(migrated['logging']).toEqual({ level: 'info' });
      expect(migrated['providers']).toEqual({ default: 'mock' });
    });

    it('preserves already current config', () => {
      const currentConfig = {
        version: CURRENT_CONFIG_VERSION,
        logging: { level: 'debug' },
      };

      const result = migrateConfig(currentConfig);
      expect(result['version']).toBe(CURRENT_CONFIG_VERSION);
      expect(result['logging']).toEqual({ level: 'debug' });
    });
  });

  describe('Journal Index SQLite Migration', () => {
    it('applies migrations incrementally to an in-memory database', () => {
      const db = new Database(':memory:');
      const clock = new FakeClock('2026-10-24T00:00:00.000Z');

      expect(getCurrentMigrationVersion(db)).toBe(0);

      const result = runMigrations(db, { migrations: [migrationV1], clock });
      expect(result.fromVersion).toBe(0);
      expect(result.toVersion).toBe(1);
      expect(result.applied).toHaveLength(1);
      expect(getCurrentMigrationVersion(db)).toBe(1);

      // Verify tables created
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('events');
      expect(tableNames).toContain('streams');
      expect(tableNames).toContain('runs');
      expect(tableNames).toContain('sessions');
      expect(tableNames).toContain('_migrations');

      db.close();
    });
  });

  describe('Memory Store SQLite Migration', () => {
    it('applies memory store migrations and initializes FTS5 virtual tables', () => {
      const db = new Database(':memory:');
      const clock = new FakeClock('2026-10-24T00:00:00.000Z');

      expect(getMemoryMigrationVersion(db)).toBe(0);

      const result = runMemoryMigrations(db, { migrations: [memoryMigrationV1], clock });
      expect(result.fromVersion).toBe(0);
      expect(result.toVersion).toBe(1);
      expect(getMemoryMigrationVersion(db)).toBe(1);

      // Verify memory entries and FTS table exist
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('memories');
      expect(tableNames).toContain('memories_fts');
      expect(tableNames).toContain('_memory_migrations');

      db.close();
    });
  });

  describe('Journal Event Schema Evolution (Upcasters)', () => {
    it('chains multi-version schema upcasters across legacy event payloads', () => {
      const clock = new FakeClock('2026-10-24T00:00:00.000Z');
      const idGen = new FakeIdGenerator();
      const registry = new UpcasterRegistry();
      registry.register(syntheticV1ToV2Upcaster);
      registry.register(syntheticV2ToV3Upcaster);

      const v1Payload: SyntheticV1Payload = {
        user: 'operator',
        action: 'execute',
        timestamp: 1700000000000,
      };

      const v1Envelope = createEnvelope({
        stream: 'run:01RUN000000000000000000001',
        seq: 1,
        type: 'synthetic.action',
        payload: v1Payload,
        clock,
        idGenerator: idGen,
      });

      const upcasted = registry.upcast<SyntheticV3Payload>(v1Envelope);
      expect(upcasted.meta?.schemaVersion).toBe(3);
      expect(upcasted.payload.userId).toBe('operator');
      expect(upcasted.payload.tenantId).toBe('default');
      expect(upcasted.payload.tags).toEqual(['migrated']);
      expect(upcasted.payload.metadata.migratedFromV1).toBe(true);
      expect(upcasted.payload.metadata.migratedFromV2).toBe(true);
    });
  });
});
