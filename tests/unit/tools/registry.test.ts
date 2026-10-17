/**
 * Unit tests for ToolRegistry (Phase 4 - P4-T02).
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AirError } from '../../../src/errors/index.js';
import { type AnyTool, defineTool, toAnyTool } from '../../../src/tools/contract.js';
import { ToolRegistry } from '../../../src/tools/registry.js';

function createDummyTool(name: string, risk: 'low' | 'medium' | 'high' | 'critical' = 'low'): AnyTool {
  return toAnyTool(
    defineTool({
      name,
      description: `Description for ${name}`,
      risk,
      idempotent: true,
      inputSchema: z.object({ param: z.string().optional() }),
      execute: async () => {
        await Promise.resolve();
        return `Result from ${name}`;
      },
    }),
  );
}

describe('ToolRegistry (Registration & Conflicts)', () => {
  it('registers and retrieves tools cleanly', () => {
    const registry = new ToolRegistry();
    const tool = createDummyTool('fs.read');

    registry.register(tool);

    expect(registry.size).toBe(1);
    expect(registry.has('fs.read')).toBe(true);
    expect(registry.get('fs.read')?.name).toBe('fs.read');
    expect(registry.getOrThrow('fs.read').name).toBe('fs.read');
  });

  it('throws ALREADY_EXISTS when registering duplicate tool without overwrite', () => {
    const registry = new ToolRegistry();
    const tool1 = createDummyTool('fs.read');
    const tool2 = createDummyTool('fs.read');

    registry.register(tool1);

    expect(() => registry.register(tool2)).toThrowError(AirError);
    try {
      registry.register(tool2);
    } catch (err) {
      expect((err as AirError).code).toBe('ALREADY_EXISTS');
    }
  });

  it('allows overwrite when explicit overwrite option is true', () => {
    const registry = new ToolRegistry();
    const tool1 = defineTool({
      name: 'fs.read',
      description: 'Original description',
      risk: 'low',
      idempotent: true,
      inputSchema: z.object({}),
      execute: async () => {
        await Promise.resolve();
      },
    });

    const tool2 = defineTool({
      name: 'fs.read',
      description: 'Updated description',
      risk: 'medium',
      idempotent: false,
      inputSchema: z.object({}),
      execute: async () => {
        await Promise.resolve();
      },
    });

    registry.register(tool1);
    registry.register(tool2, { overwrite: true });

    expect(registry.size).toBe(1);
    expect(registry.get('fs.read')?.description).toBe('Updated description');
    expect(registry.get('fs.read')?.risk).toBe('medium');
  });

  it('respects default allowOverwrite constructor option', () => {
    const registry = new ToolRegistry({ allowOverwrite: true });
    const tool1 = createDummyTool('exec.run');
    const tool2 = createDummyTool('exec.run');

    registry.register(tool1);
    registry.register(tool2); // Should not throw

    expect(registry.size).toBe(1);
  });

  it('supports initial tools via constructor options and registerMany', () => {
    const t1 = createDummyTool('t1');
    const t2 = createDummyTool('t2');
    const registry = new ToolRegistry({ tools: [t1, t2] });

    expect(registry.size).toBe(2);

    const t3 = createDummyTool('t3');
    const t4 = createDummyTool('t4');
    registry.registerMany([t3, t4]);

    expect(registry.size).toBe(4);
    expect(registry.listNames()).toEqual(['t1', 't2', 't3', 't4']);
  });
});

describe('ToolRegistry (Querying & Filtering)', () => {
  it('throws NOT_FOUND from getOrThrow for missing tools', () => {
    const registry = new ToolRegistry();
    expect(() => registry.getOrThrow('nonexistent.tool')).toThrowError(AirError);
    try {
      registry.getOrThrow('nonexistent.tool');
    } catch (err) {
      expect((err as AirError).code).toBe('NOT_FOUND');
    }
  });

  it('unregisters tools correctly', () => {
    const registry = new ToolRegistry();
    registry.register(createDummyTool('fs.read'));

    expect(registry.unregister('fs.read')).toBe(true);
    expect(registry.has('fs.read')).toBe(false);
    expect(registry.size).toBe(0);

    expect(registry.unregister('fs.read')).toBe(false);
  });

  it('filters tools by namespace', () => {
    const registry = new ToolRegistry();
    registry.registerMany([
      createDummyTool('fs.read'),
      createDummyTool('fs.write'),
      createDummyTool('fs:stat'),
      createDummyTool('exec.run'),
      createDummyTool('http.fetch'),
    ]);

    const fsTools = registry.listByNamespace('fs');
    expect(fsTools.length).toBe(3);
    expect(fsTools.map((t) => t.name)).toEqual(['fs.read', 'fs.write', 'fs:stat']);

    const execTools = registry.listByNamespace('exec');
    expect(execTools.length).toBe(1);
    expect(execTools[0]?.name).toBe('exec.run');

    const empty = registry.listByNamespace('unknown');
    expect(empty.length).toBe(0);
  });

  it('filters tools by maximum risk level hierarchy', () => {
    const registry = new ToolRegistry();
    registry.registerMany([
      createDummyTool('t.low', 'low'),
      createDummyTool('t.med', 'medium'),
      createDummyTool('t.high', 'high'),
      createDummyTool('t.crit', 'critical'),
    ]);

    const lowOnly = registry.listByMaxRisk('low');
    expect(lowOnly.map((t) => t.name)).toEqual(['t.low']);

    const upToMed = registry.listByMaxRisk('medium');
    expect(upToMed.map((t) => t.name)).toEqual(['t.low', 't.med']);

    const upToHigh = registry.listByMaxRisk('high');
    expect(upToHigh.map((t) => t.name)).toEqual(['t.low', 't.med', 't.high']);

    const all = registry.listByMaxRisk('critical');
    expect(all.length).toBe(4);
  });

  it('clears all registered tools', () => {
    const registry = new ToolRegistry();
    registry.register(createDummyTool('tool1'));
    registry.register(createDummyTool('tool2'));
    expect(registry.size).toBe(2);

    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.list().length).toBe(0);
  });
});

describe('ToolRegistry (Provider Tool Export)', () => {
  it('converts all registered tools or a subset into ProviderToolDefinition list', () => {
    const registry = new ToolRegistry();
    registry.registerMany([
      createDummyTool('fs.read'),
      createDummyTool('fs.write'),
      createDummyTool('exec.run'),
    ]);

    // All tools
    const allProviderTools = registry.toProviderTools();
    expect(allProviderTools.length).toBe(3);
    expect(allProviderTools[0]?.name).toBe('fs.read');
    expect(allProviderTools[0]?.parameters.type).toBe('object');

    // Named subset
    const subset = registry.toProviderTools(['fs.read', 'exec.run']);
    expect(subset.length).toBe(2);
    expect(subset.map((t) => t.name)).toEqual(['fs.read', 'exec.run']);

    // Non-matching names are ignored safely
    const partial = registry.toProviderTools(['fs.read', 'nonexistent']);
    expect(partial.length).toBe(1);
    expect(partial[0]?.name).toBe('fs.read');
  });
});
