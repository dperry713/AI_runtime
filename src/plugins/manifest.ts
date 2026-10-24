/**
 * Plugin Manifest Schema, Loader, and Validation (Phase 10 - P10-T02).
 */
import crypto from 'node:crypto';
import path from 'node:path';
import yaml from 'yaml';
import { z } from 'zod';
import { AirError } from '../errors/index.js';
import { readFileIn } from '../util/index.js';

export const PluginPermissionSchema = z.enum([
  'fs.read',
  'fs.write',
  'fs.delete',
  'exec.run',
  'net.fetch',
  'memory.read',
  'memory.write',
  'agent.spawn',
  'policy.read',
]);

export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

export const PluginCapabilitySchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  permissions: z.array(PluginPermissionSchema).default([]),
});

export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;

export const PluginManifestSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_\-.]+$/, 'Plugin ID must contain only alphanumeric, dashes, dots, or underscores'),
  name: z.string().min(1, 'Plugin display name must not be empty'),
  description: z.string().min(1, 'Plugin description must not be empty'),
  version: z.string().default('1.0.0'),
  author: z.string().optional(),
  entryPoint: z.string().min(1, 'Entry point must not be empty'),
  permissions: z.array(PluginPermissionSchema).default([]),
  capabilities: z.array(PluginCapabilitySchema).default([]),
  artifactHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, 'Artifact hash must be a 64-character hex SHA-256')
    .optional(),
  policyProfile: z.string().min(1).default('readonly'),
  enabled: z.boolean().default(true),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export interface LoadedPluginManifest {
  readonly manifest: PluginManifest;
  readonly sha256: string;
  readonly rawText: string;
}

export function computePluginManifestHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function computeArtifactHash(content: Buffer | string): string {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function verifyPluginHash(manifest: PluginManifest, artifactContent: Buffer | string): void {
  if (!manifest.artifactHash) {
    return;
  }
  const actualHash = computeArtifactHash(artifactContent);
  if (actualHash.toLowerCase() !== manifest.artifactHash.toLowerCase()) {
    throw new AirError(
      'PERMISSION_DENIED',
      'Plugin "' + manifest.id + '" artifact hash mismatch: expected ' + manifest.artifactHash + ', got ' + actualHash,
      {
        context: {
          pluginId: manifest.id,
          expectedHash: manifest.artifactHash,
          actualHash,
        },
      },
    );
  }
}

export function parsePluginManifest(
  content: string,
  preferredFormat?: 'json' | 'yaml',
): LoadedPluginManifest {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new AirError('VALIDATION_FAILED', 'Plugin manifest content must be a non-empty string');
  }

  const sha256 = computePluginManifestHash(content);
  let parsedRaw: unknown;

  if (preferredFormat === 'json') {
    try {
      parsedRaw = JSON.parse(content);
    } catch (err) {
      throw new AirError(
        'VALIDATION_FAILED',
        'Invalid JSON syntax in plugin manifest: ' + (err as Error).message,
        { cause: err instanceof Error ? err : undefined },
      );
    }
  } else if (preferredFormat === 'yaml') {
    try {
      parsedRaw = yaml.parse(content);
    } catch (err) {
      throw new AirError(
        'VALIDATION_FAILED',
        'Invalid YAML syntax in plugin manifest: ' + (err as Error).message,
        { cause: err instanceof Error ? err : undefined },
      );
    }
  } else {
    try {
      parsedRaw = JSON.parse(content);
    } catch {
      try {
        parsedRaw = yaml.parse(content);
      } catch (yamlErr) {
        throw new AirError(
          'VALIDATION_FAILED',
          'Failed to parse plugin manifest as JSON or YAML: ' + (yamlErr as Error).message,
          { cause: yamlErr instanceof Error ? yamlErr : undefined },
        );
      }
    }
  }

  const result = PluginManifestSchema.safeParse(parsedRaw);
  if (!result.success) {
    throw new AirError('VALIDATION_FAILED', 'Plugin manifest validation failed: ' + result.error.message, {
      context: { issues: result.error.issues },
    });
  }

  return {
    manifest: result.data,
    sha256,
    rawText: content,
  };
}

export async function loadPluginManifestFromFile(
  filePath: string,
  rootDir?: string,
): Promise<LoadedPluginManifest> {
  const root = rootDir ?? path.dirname(filePath);
  const subPath = rootDir ? path.relative(rootDir, filePath) : path.basename(filePath);
  const content = await readFileIn(root, subPath);
  return parsePluginManifest(content);
}

