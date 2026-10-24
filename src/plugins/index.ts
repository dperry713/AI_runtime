/**
 * Plugins module entry point (Phase 10 - P10-T02).
 */
export {
  PluginPermissionSchema,
  type PluginPermission,
  PluginCapabilitySchema,
  type PluginCapability,
  PluginManifestSchema,
  type PluginManifest,
  type LoadedPluginManifest,
  computePluginManifestHash,
  computeArtifactHash,
  verifyPluginHash,
  parsePluginManifest,
  loadPluginManifestFromFile,
} from './manifest.js';

export {
  type PluginLoadOptions,
  type LoadedPlugin,
  PluginLoader,
  createPluginLoader,
} from './loader.js';
