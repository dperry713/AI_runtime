/**
 * Skills module entry point (Phase 10 - P10-T02).
 * Skills are a specialized form of plugins with skill-specific metadata.
 */
export {
  PluginPermissionSchema as SkillPermissionSchema,
  type PluginPermission as SkillPermission,
  PluginCapabilitySchema as SkillCapabilitySchema,
  type PluginCapability as SkillCapability,
  PluginManifestSchema as SkillManifestSchema,
  type PluginManifest as SkillManifest,
  type LoadedPluginManifest as LoadedSkillManifest,
  computePluginManifestHash as computeSkillManifestHash,
  computeArtifactHash as computeSkillArtifactHash,
  verifyPluginHash as verifySkillHash,
  parsePluginManifest as parseSkillManifest,
  loadPluginManifestFromFile as loadSkillManifestFromFile,
  type PluginLoadOptions as SkillLoadOptions,
  type LoadedPlugin as LoadedSkill,
  PluginLoader as SkillLoader,
  createPluginLoader as createSkillLoader,
} from '../plugins/index.js';
