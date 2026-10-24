/**
 * Plugin Loader (Phase 10 - P10-T02).
 */
import path from 'node:path';
import { AirError } from '../errors/index.js';
import { getLogger, type ComponentLogger } from '../observability/index.js';
import type { PolicyEngine } from '../policy/index.js';
import type { ToolRegistry } from '../tools/index.js';
import { readBufferIn } from '../util/index.js';
import { loadPluginManifestFromFile, verifyPluginHash, type PluginManifest } from './manifest.js';

export interface PluginLoadOptions {
  readonly pluginDir: string;
  readonly rootDir?: string;
  readonly policyEngine?: PolicyEngine;
  readonly toolRegistry?: ToolRegistry;
  readonly logger?: ComponentLogger;
  readonly requirePolicyDecision?: boolean;
}

export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly manifestHash: string;
  readonly pluginDir: string;
  readonly entryPoint: string;
  readonly permissions: readonly string[];
}

export class PluginLoader {
  private readonly logger: ComponentLogger;
  private readonly loadedPlugins = new Map<string, LoadedPlugin>();

  constructor(private readonly options: PluginLoadOptions) {
    this.logger = options.logger ?? getLogger('plugins');
  }

  async loadPlugin(pluginDir: string): Promise<LoadedPlugin> {
    const manifestPath = await this.findManifest(pluginDir);
    const loaded = await loadPluginManifestFromFile(manifestPath, this.options.rootDir);

    const entryPointPath = path.resolve(pluginDir, loaded.manifest.entryPoint);
    if (loaded.manifest.artifactHash) {
      const artifactContent = await readBufferIn(pluginDir, loaded.manifest.entryPoint);
      verifyPluginHash(loaded.manifest, artifactContent);
    }

    if (this.options.policyEngine) {
      const decision = this.options.policyEngine.evaluate({
        toolName: 'plugin.load',
        input: { pluginId: loaded.manifest.id },
        context: {
          permissions: loaded.manifest.permissions,
          capabilities: loaded.manifest.capabilities.map((c) => c.id),
        },
      });
      if (decision.effect === 'deny') {
        throw new AirError(
          'PERMISSION_DENIED',
          'Plugin "' + loaded.manifest.id + '" load denied by policy: ' + decision.reason,
          { context: { pluginId: loaded.manifest.id, decisionId: decision.decisionId } },
        );
      }
    } else if (this.options.requirePolicyDecision) {
      throw new AirError(
        'PERMISSION_DENIED',
        'Plugin "' + loaded.manifest.id + '" load denied: no policy engine configured (fail closed)',
        { context: { pluginId: loaded.manifest.id } },
      );
    }

    const plugin: LoadedPlugin = {
      manifest: loaded.manifest,
      manifestHash: loaded.sha256,
      pluginDir,
      entryPoint: entryPointPath,
      permissions: loaded.manifest.permissions,
    };

    this.loadedPlugins.set(loaded.manifest.id, plugin);
    this.logger.info(
      { event: 'plugin.loaded', pluginId: loaded.manifest.id, version: loaded.manifest.version },
      'Plugin loaded',
    );

    return plugin;
  }

  async loadAll(): Promise<LoadedPlugin[]> {
    const plugins: LoadedPlugin[] = [];
    try {
      const { listDetailedIn } = await import('../util/index.js');
      const entries = await listDetailedIn(this.options.pluginDir, '.');
      for (const entry of entries) {
        if (entry.isDirectory) {
          const pluginDir = path.join(this.options.pluginDir, entry.name);
          try {
            const plugin = await this.loadPlugin(pluginDir);
            plugins.push(plugin);
          } catch {
            this.logger.error({ event: 'plugin.load_failed', pluginDir }, 'Failed to load plugin');
          }
        }
      }
    } catch {
      this.logger.error({ event: 'plugin.scan_failed' }, 'Failed to scan plugins directory');
    }
    return plugins;
  }

  getLoadedPlugins(): readonly LoadedPlugin[] {
    return Array.from(this.loadedPlugins.values());
  }

  getPlugin(id: string): LoadedPlugin | undefined {
    return this.loadedPlugins.get(id);
  }

  private async findManifest(pluginDir: string): Promise<string> {
    const candidates = ['plugin.json', 'plugin.yaml', 'plugin.yml', 'manifest.json', 'manifest.yaml'];
    const { existsIn } = await import('../util/index.js');
    for (const candidate of candidates) {
      try {
        if (await existsIn(pluginDir, candidate)) {
          return path.join(pluginDir, candidate);
        }
      } catch {
        // continue
      }
    }
    throw new AirError('NOT_FOUND', 'No plugin manifest found in ' + pluginDir, { context: { pluginDir } });
  }
}

export function createPluginLoader(options: PluginLoadOptions): PluginLoader {
  return new PluginLoader(options);
}
