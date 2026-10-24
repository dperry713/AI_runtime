import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  PluginLoader,
  PluginManifestSchema,
  computeArtifactHash,
  computePluginManifestHash,
  createPluginLoader,
  loadPluginManifestFromFile,
  parsePluginManifest,
  verifyPluginHash,
  type PluginManifest,
} from '../../../src/plugins/index.js';
import { PolicyEngine, type PolicyDocument } from '../../../src/policy/index.js';
import {
  SkillManifestSchema,
  computeSkillArtifactHash,
  createSkillLoader,
  parseSkillManifest,
} from '../../../src/skills/index.js';
import { FakeClock, UlidIdGenerator } from '../../../src/util/index.js';

describe('Plugin Manifest Parsing & Validation', () => {
  it('parses valid JSON manifest with defaults', () => {
    const raw = JSON.stringify({
      id: 'my-plugin',
      name: 'My Plugin',
      description: 'A test plugin',
      entryPoint: 'main.js',
    });

    const loaded = parsePluginManifest(raw, 'json');
    expect(loaded.manifest.id).toBe('my-plugin');
    expect(loaded.manifest.version).toBe('1.0.0');
    expect(loaded.manifest.permissions).toEqual([]);
    expect(loaded.manifest.capabilities).toEqual([]);
    expect(loaded.manifest.enabled).toBe(true);
    expect(loaded.sha256).toBe(computePluginManifestHash(raw));
  });

  it('parses valid YAML manifest', () => {
    const yaml = `
id: yaml-plugin
name: YAML Plugin
description: YAML plugin description
entryPoint: index.js
permissions:
  - fs.read
  - exec.run
`;
    const loaded = parsePluginManifest(yaml, 'yaml');
    expect(loaded.manifest.id).toBe('yaml-plugin');
    expect(loaded.manifest.permissions).toEqual(['fs.read', 'exec.run']);
  });

  it('auto-detects JSON or YAML', () => {
    const rawJson = '{"id":"auto-json","name":"Auto","description":"desc","entryPoint":"p.js"}';
    const loadedJson = parsePluginManifest(rawJson);
    expect(loadedJson.manifest.id).toBe('auto-json');

    const rawYaml = 'id: auto-yaml\nname: Auto\ndescription: desc\nentryPoint: p.js';
    const loadedYaml = parsePluginManifest(rawYaml);
    expect(loadedYaml.manifest.id).toBe('auto-yaml');
  });

  it('throws on empty content', () => {
    expect(() => parsePluginManifest('')).toThrow(AirError);
    expect(() => parsePluginManifest('   ')).toThrow(AirError);
  });

  it('throws on invalid syntax for preferred format', () => {
    expect(() => parsePluginManifest('{ invalid json', 'json')).toThrow(AirError);
    expect(() => parsePluginManifest(':\n  - invalid: yaml: :', 'yaml')).toThrow(AirError);
  });

  it('throws on unparseable string in auto-detect mode', () => {
    expect(() => parsePluginManifest(':::\n  invalid')).toThrow(AirError);
  });

  it('validates manifest schema requirements', () => {
    // Missing description
    expect(() =>
      parsePluginManifest(JSON.stringify({ id: 'bad', name: 'Bad', entryPoint: 'main.js' })),
    ).toThrow(AirError);

    // Invalid id characters
    expect(() =>
      parsePluginManifest(
        JSON.stringify({
          id: 'bad id with spaces',
          name: 'Bad',
          description: 'Desc',
          entryPoint: 'main.js',
        }),
      ),
    ).toThrow(AirError);

    // Invalid permission
    expect(() =>
      parsePluginManifest(
        JSON.stringify({
          id: 'bad-perm',
          name: 'Bad',
          description: 'Desc',
          entryPoint: 'main.js',
          permissions: ['invalid.perm'],
        }),
      ),
    ).toThrow(AirError);
  });

  it('re-exports skill schemas matching plugin schemas', () => {
    expect(SkillManifestSchema).toBe(PluginManifestSchema);
    expect(typeof computeSkillArtifactHash).toBe('function');
    const parsed = parseSkillManifest(
      JSON.stringify({
        id: 'skill-1',
        name: 'Skill One',
        description: 'Test skill',
        entryPoint: 'skill.js',
      }),
    );
    expect(parsed.manifest.id).toBe('skill-1');
  });
});

describe('Plugin Artifact Hashing & Verification', () => {
  it('computes correct sha256 for strings and buffers', () => {
    const text = 'hello world';
    const buf = Buffer.from(text, 'utf8');
    expect(computeArtifactHash(text)).toBe(computeArtifactHash(buf));
  });

  it('verifies artifact hash successfully when matching', () => {
    const content = 'console.log("hello");';
    const hash = computeArtifactHash(content);
    const manifest: PluginManifest = {
      schemaVersion: 1,
      id: 'test',
      name: 'Test',
      description: 'Desc',
      version: '1.0.0',
      entryPoint: 'main.js',
      permissions: [],
      capabilities: [],
      artifactHash: hash,
      policyProfile: 'readonly',
      enabled: true,
    };

    expect(() => verifyPluginHash(manifest, content)).not.toThrow();
  });

  it('throws on artifact hash mismatch', () => {
    const manifest: PluginManifest = {
      schemaVersion: 1,
      id: 'tampered',
      name: 'Tampered',
      description: 'Desc',
      version: '1.0.0',
      entryPoint: 'main.js',
      permissions: [],
      capabilities: [],
      artifactHash: '0000000000000000000000000000000000000000000000000000000000000000',
      policyProfile: 'readonly',
      enabled: true,
    };

    expect(() => verifyPluginHash(manifest, 'tampered content')).toThrow(AirError);
  });

  it('skips verification if no artifactHash specified', () => {
    const manifest: PluginManifest = {
      schemaVersion: 1,
      id: 'no-hash',
      name: 'No Hash',
      description: 'Desc',
      version: '1.0.0',
      entryPoint: 'main.js',
      permissions: [],
      capabilities: [],
      policyProfile: 'readonly',
      enabled: true,
    };

    expect(() => verifyPluginHash(manifest, 'any content')).not.toThrow();
  });
});

describe('Plugin Loader & File Resolution', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'air-plugin-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('loads plugin manifest from file', async () => {
    const pluginPath = path.join(tempDir, 'plugin.json');
    await fs.writeFile(
      pluginPath,
      JSON.stringify({
        id: 'file-plugin',
        name: 'File Plugin',
        description: 'Loaded from file',
        entryPoint: 'index.js',
      }),
      'utf8',
    );

    const loaded = await loadPluginManifestFromFile(pluginPath, tempDir);
    expect(loaded.manifest.id).toBe('file-plugin');
  });

  it('loads plugin from directory and verifies entrypoint', async () => {
    const pluginDir = path.join(tempDir, 'sample-plugin');
    await fs.mkdir(pluginDir);

    const entryPointContent = 'export function run() { return 42; }';
    await fs.writeFile(path.join(pluginDir, 'index.js'), entryPointContent, 'utf8');

    const manifestContent = JSON.stringify({
      id: 'sample',
      name: 'Sample',
      description: 'Sample plugin',
      entryPoint: 'index.js',
      artifactHash: computeArtifactHash(entryPointContent),
    });
    await fs.writeFile(path.join(pluginDir, 'plugin.json'), manifestContent, 'utf8');

    const loader = createPluginLoader({ pluginDir: tempDir, rootDir: tempDir });
    const plugin = await loader.loadPlugin(pluginDir);

    expect(plugin.manifest.id).toBe('sample');
    expect(loader.getPlugin('sample')).toBeDefined();
    expect(loader.getLoadedPlugins()).toHaveLength(1);
  });

  it('loads all plugins in directory', async () => {
    const p1 = path.join(tempDir, 'p1');
    const p2 = path.join(tempDir, 'p2');
    await fs.mkdir(p1);
    await fs.mkdir(p2);

    await fs.writeFile(path.join(p1, 'p1.js'), 'export const p1 = 1;', 'utf8');
    await fs.writeFile(path.join(p2, 'p2.js'), 'export const p2 = 2;', 'utf8');

    await fs.writeFile(
      path.join(p1, 'plugin.yaml'),
      'id: p1\nname: P1\ndescription: P1 desc\nentryPoint: p1.js',
    );
    await fs.writeFile(
      path.join(p2, 'manifest.json'),
      JSON.stringify({ id: 'p2', name: 'P2', description: 'P2 desc', entryPoint: 'p2.js' }),
    );

    const loader = new PluginLoader({ pluginDir: tempDir, rootDir: tempDir });
    const plugins = await loader.loadAll();

    expect(plugins.length).toBe(2);
    expect(loader.getPlugin('p1')).toBeDefined();
    expect(loader.getPlugin('p2')).toBeDefined();
  });

  it('evaluates policy engine when configured (allow)', async () => {
    const pluginDir = path.join(tempDir, 'allowed-plugin');
    await fs.mkdir(pluginDir);
    await fs.writeFile(path.join(pluginDir, 'index.js'), 'console.log("allowed");', 'utf8');
    await fs.writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({
        id: 'allowed-plugin',
        name: 'Allowed',
        description: 'Allowed',
        entryPoint: 'index.js',
        permissions: ['fs.read'],
      }),
    );

    const clock = new FakeClock();
    const idGen = new UlidIdGenerator(clock);
    const policyDoc: PolicyDocument = {
      version: 1,
      name: 'Test Policy',
      defaultEffect: 'deny',
      rules: [
        {
          id: 'allow-plugin',
          reason: 'Allow plugin load',
          effect: 'allow',
          match: {
            tools: ['plugin.load'],
          },
        },
      ],
    };
    const policy = new PolicyEngine(policyDoc, { clock, idGenerator: idGen });

    const loader = createSkillLoader({ pluginDir: tempDir, rootDir: tempDir, policyEngine: policy });
    const plugin = await loader.loadPlugin(pluginDir);
    expect(plugin.manifest.id).toBe('allowed-plugin');
  });

  it('denies plugin load when policy engine denies it', async () => {
    const pluginDir = path.join(tempDir, 'denied-plugin');
    await fs.mkdir(pluginDir);
    await fs.writeFile(path.join(pluginDir, 'index.js'), 'console.log("denied");', 'utf8');
    await fs.writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({
        id: 'denied-plugin',
        name: 'Denied',
        description: 'Denied',
        entryPoint: 'index.js',
      }),
    );

    const clock = new FakeClock();
    const idGen = new UlidIdGenerator(clock);
    const denyDoc: PolicyDocument = {
      version: 1,
      name: 'Deny Policy',
      defaultEffect: 'deny',
      rules: [
        {
          id: 'deny-plugin',
          reason: 'Deny all plugin load',
          effect: 'deny',
          match: {
            tools: ['plugin.load'],
          },
        },
      ],
    };
    const policy = new PolicyEngine(denyDoc, { clock, idGenerator: idGen });

    const loader = new PluginLoader({ pluginDir: tempDir, rootDir: tempDir, policyEngine: policy });
    await expect(loader.loadPlugin(pluginDir)).rejects.toThrow(/load denied by policy/);
  });

  it('fails closed when requirePolicyDecision is true and no policy is configured', async () => {
    const pluginDir = path.join(tempDir, 'fail-closed-plugin');
    await fs.mkdir(pluginDir);
    await fs.writeFile(path.join(pluginDir, 'index.js'), 'console.log("fail-closed");', 'utf8');
    await fs.writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({
        id: 'fail-closed',
        name: 'Fail Closed',
        description: 'Desc',
        entryPoint: 'index.js',
      }),
    );

    const loader = new PluginLoader({
      pluginDir: tempDir,
      rootDir: tempDir,
      requirePolicyDecision: true,
    });
    await expect(loader.loadPlugin(pluginDir)).rejects.toThrow(/fail closed/);
  });

  it('throws NOT_FOUND when no manifest exists in directory', async () => {
    const emptyDir = path.join(tempDir, 'empty-plugin');
    await fs.mkdir(emptyDir);

    const loader = new PluginLoader({ pluginDir: tempDir, rootDir: tempDir });
    await expect(loader.loadPlugin(emptyDir)).rejects.toThrow(/No plugin manifest found/);
  });

  it('loadAll logs error and skips plugin when loading fails', async () => {
    const pGood = path.join(tempDir, 'good');
    const pBad = path.join(tempDir, 'bad');
    await fs.mkdir(pGood);
    await fs.mkdir(pBad);

    await fs.writeFile(path.join(pGood, 'index.js'), 'export const g = 1;', 'utf8');
    await fs.writeFile(
      path.join(pGood, 'plugin.json'),
      JSON.stringify({ id: 'good', name: 'Good', description: 'Good', entryPoint: 'index.js' }),
      'utf8',
    );
    // Bad has corrupt JSON
    await fs.writeFile(path.join(pBad, 'plugin.json'), '{ invalid json', 'utf8');

    const loader = new PluginLoader({ pluginDir: tempDir, rootDir: tempDir });
    const loaded = await loader.loadAll();
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.manifest.id).toBe('good');
  });

  it('loadAll handles scan failure on nonexistent directory', async () => {
    const nonexistent = path.join(tempDir, 'nonexistent');
    const loader = new PluginLoader({ pluginDir: nonexistent, rootDir: tempDir });
    const loaded = await loader.loadAll();
    expect(loaded).toEqual([]);
  });

  it('resolves plugin.yml and manifest.yaml manifest variants', async () => {
    const pYml = path.join(tempDir, 'p-yml');
    await fs.mkdir(pYml);
    await fs.writeFile(path.join(pYml, 'index.js'), 'export const yml = 1;', 'utf8');
    await fs.writeFile(
      path.join(pYml, 'plugin.yml'),
      'id: p-yml\nname: PYML\ndescription: desc\nentryPoint: index.js',
      'utf8',
    );

    const loader = new PluginLoader({ pluginDir: tempDir, rootDir: tempDir });
    const loaded = await loader.loadPlugin(pYml);
    expect(loaded.manifest.id).toBe('p-yml');
    expect(loader.getPlugin('unknown-id')).toBeUndefined();
  });

  it('throws on invalid YAML syntax when preferredFormat is yaml', () => {
    const invalidYaml = 'key: [unclosed';
    expect(() => parsePluginManifest(invalidYaml, 'yaml')).toThrow(AirError);
  });

  it('throws on syntax error when neither JSON nor YAML in fallback mode', () => {
    const invalidYaml = ':\n  :\n    : [unclosed';
    expect(() => parsePluginManifest(invalidYaml)).toThrow(AirError);
  });

  it('loadPluginManifestFromFile works without rootDir argument', async () => {
    const file = path.join(tempDir, 'direct-plugin.json');
    await fs.writeFile(
      file,
      JSON.stringify({ id: 'direct', name: 'Direct', description: 'Desc', entryPoint: 'index.js' }),
      'utf8',
    );
    const loaded = await loadPluginManifestFromFile(file);
    expect(loaded.manifest.id).toBe('direct');
  });

  it('evaluates policy with plugin capabilities array mapped to ids', async () => {
    const pluginDir = path.join(tempDir, 'cap-plugin');
    await fs.mkdir(pluginDir);
    await fs.writeFile(path.join(pluginDir, 'index.js'), 'export const cap = 1;', 'utf8');
    await fs.writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({
        id: 'cap-plugin',
        name: 'Cap Plugin',
        description: 'Cap Plugin',
        entryPoint: 'index.js',
        capabilities: [{ id: 'net.connect', description: 'Network' }],
      }),
    );

    const clock = new FakeClock();
    const idGen = new UlidIdGenerator(clock);
    const policyDoc: PolicyDocument = {
      version: 1,
      name: 'Allow Policy',
      defaultEffect: 'deny',
      rules: [
        {
          id: 'allow-plugin',
          reason: 'Allow plugin load',
          effect: 'allow',
          match: {
            tools: ['plugin.load'],
          },
        },
      ],
    };
    const policy = new PolicyEngine(policyDoc, { clock, idGenerator: idGen });
    const loader = new PluginLoader({ pluginDir: tempDir, rootDir: tempDir, policyEngine: policy });
    const plugin = await loader.loadPlugin(pluginDir);
    expect(plugin.manifest.id).toBe('cap-plugin');
  });
});

