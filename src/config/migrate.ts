import { AirError } from '../errors/index.js';

export const CURRENT_CONFIG_VERSION = 1;

export type ConfigMigrator = (raw: Record<string, unknown>) => Record<string, unknown>;

/**
 * Registry of forward migrations: fromVersion -> migrator that produces fromVersion + 1.
 */
const MIGRATORS: Record<number, ConfigMigrator> = {
  0: (raw) => {
    // Migrate v0 (unversioned legacy) to v1
    const { ...rest } = raw;
    return {
      ...rest,
      version: 1,
    };
  },
};

/**
 * Migrates a raw configuration object to the current version.
 * Throws AirError(CONFIG_INVALID) if the config is invalid or version is unsupported.
 */
export function migrateConfig(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AirError('CONFIG_INVALID', 'Configuration root must be a JSON object', {
      context: { rawType: typeof raw },
    });
  }

  let current = { ...(raw as Record<string, unknown>) };
  let version = current['version'];

  if (version === undefined || version === null) {
    version = 0;
  }

  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new AirError('CONFIG_INVALID', `Configuration 'version' must be a non-negative integer, got: ${String(version)}`, {
      context: { version },
    });
  }

  if (version > CURRENT_CONFIG_VERSION) {
    throw new AirError(
      'CONFIG_INVALID',
      `Unsupported configuration version ${version}. Current supported version is ${CURRENT_CONFIG_VERSION}.`,
      { context: { version, currentSupportedVersion: CURRENT_CONFIG_VERSION } },
    );
  }

  while (version < CURRENT_CONFIG_VERSION) {
    const migrator = MIGRATORS[version];
    if (!migrator) {
      throw new AirError('MIGRATION_FAILED', `No migrator found for configuration version ${version} -> ${version + 1}`, {
        context: { fromVersion: version, targetVersion: CURRENT_CONFIG_VERSION },
      });
    }
    current = migrator(current);
    version += 1;
    current['version'] = version;
  }

  return current;
}
