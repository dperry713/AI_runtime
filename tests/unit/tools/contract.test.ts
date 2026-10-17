/**
 * Unit tests for Tool Contract (Phase 4 - P4-T01).
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AirError } from '../../../src/errors/index.js';
import {
  defineTool,
  deriveJsonSchema,
  toProviderToolDefinition,
  type ToolCapability,
  ToolCapabilitySchema,
  type ToolExecutionContext,
  ToolRiskLevelSchema,
  validateToolInput,
  validateToolOutput,
} from '../../../src/tools/contract.js';
import { FakeClock } from '../../../src/util/clock.js';

describe('ToolRiskLevelSchema', () => {
  it('accepts valid risk levels', () => {
    expect(ToolRiskLevelSchema.parse('low')).toBe('low');
    expect(ToolRiskLevelSchema.parse('medium')).toBe('medium');
    expect(ToolRiskLevelSchema.parse('high')).toBe('high');
    expect(ToolRiskLevelSchema.parse('critical')).toBe('critical');
  });

  it('rejects invalid risk levels', () => {
    expect(() => ToolRiskLevelSchema.parse('safe')).toThrow();
    expect(() => ToolRiskLevelSchema.parse('extreme')).toThrow();
  });
});

describe('ToolCapabilitySchema', () => {
  it('validates capability descriptor objects', () => {
    const cap: ToolCapability = {
      type: 'fs',
      action: 'read',
      resource: 'src/main.ts',
      meta: { recursive: false },
    };

    const parsed = ToolCapabilitySchema.parse(cap);
    expect(parsed.type).toBe('fs');
    expect(parsed.action).toBe('read');
    expect(parsed.resource).toBe('src/main.ts');
  });

  it('rejects capabilities missing type', () => {
    expect(() => ToolCapabilitySchema.parse({})).toThrow();
    expect(() => ToolCapabilitySchema.parse({ action: 'read' })).toThrow();
  });
});

describe('defineTool & Validation', () => {
  const dummyInputSchema = z.object({
    path: z.string().describe('File path to read'),
    encoding: z.enum(['utf8', 'binary']).default('utf8'),
  });

  const dummyOutputSchema = z.object({
    content: z.string(),
    bytesRead: z.number().int(),
  });

  it('defines a valid tool definition with all properties intact', () => {
    const tool = defineTool({
      name: 'fs.read',
      description: 'Read file content from filesystem',
      version: '1.0.0',
      risk: 'low',
      idempotent: true,
      defaultTimeoutMs: 5000,
      maxOutputBytes: 1024 * 1024,
      inputSchema: dummyInputSchema,
      outputSchema: dummyOutputSchema,
      capabilities: (args) => [
        { type: 'fs', action: 'read', resource: args.path },
      ],
      execute: async (args) => {
        await Promise.resolve();
        return {
          content: `Content of ${args.path}`,
          bytesRead: 42,
        };
      },
    });

    expect(tool.name).toBe('fs.read');
    expect(tool.description).toBe('Read file content from filesystem');
    expect(tool.version).toBe('1.0.0');
    expect(tool.risk).toBe('low');
    expect(tool.idempotent).toBe(true);
    expect(tool.defaultTimeoutMs).toBe(5000);
    expect(tool.maxOutputBytes).toBe(1024 * 1024);

    // Dynamic capabilities
    const caps = tool.capabilities?.({ path: 'src/main.ts', encoding: 'utf8' });
    expect(caps).toEqual([
      { type: 'fs', action: 'read', resource: 'src/main.ts' },
    ]);
  });

  it('throws INVALID_ARGUMENT if tool name is empty or whitespace', () => {
    expect(() =>
      defineTool({
        name: '',
        description: 'valid description',
        risk: 'low',
        idempotent: true,
        inputSchema: z.object({}),
        execute: async () => {
          await Promise.resolve();
        },
      }),
    ).toThrow('Tool name must not be empty');

    expect(() =>
      defineTool({
        name: '   ',
        description: 'valid description',
        risk: 'low',
        idempotent: true,
        inputSchema: z.object({}),
        execute: async () => {
          await Promise.resolve();
        },
      }),
    ).toThrow('Tool name must not be empty');
  });

  it('throws INVALID_ARGUMENT if tool description is empty or whitespace', () => {
    expect(() =>
      defineTool({
        name: 'test.tool',
        description: '',
        risk: 'low',
        idempotent: true,
        inputSchema: z.object({}),
        execute: async () => {},
      }),
    ).toThrow('must have a description');
  });
});

describe('deriveJsonSchema & toProviderToolDefinition', () => {
  it('derives a clean JSON Schema from complex Zod types', () => {
    const schema = z.object({
      query: z.string().describe('Search query string'),
      limit: z.number().int().min(1).max(100).default(10).describe('Max results to return'),
      filter: z.enum(['all', 'code', 'issues']).optional().describe('Filter target'),
      tags: z.array(z.string()).optional(),
    });

    const jsonSchema = deriveJsonSchema(schema);

    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.$schema).toBeUndefined();
    expect(jsonSchema.properties).toBeDefined();

    const props = jsonSchema.properties as Record<string, { type: string; description?: string }>;
    expect(props.query?.type).toBe('string');
    expect(props.query?.description).toBe('Search query string');
    expect(props.limit?.description).toBe('Max results to return');

    expect(jsonSchema.required).toContain('query');
    expect((jsonSchema.required as string[]).includes('filter')).toBe(false);
  });

  it('converts ToolDefinition into ProviderToolDefinition', () => {
    const tool = defineTool({
      name: 'calc.add',
      description: 'Add two numbers together',
      risk: 'low',
      idempotent: true,
      inputSchema: z.object({
        a: z.number().describe('First number'),
        b: z.number().describe('Second number'),
      }),
      execute: async (args) => {
        await Promise.resolve();
        return args.a + args.b;
      },
    });

    const providerTool = toProviderToolDefinition(tool);

    expect(providerTool.name).toBe('calc.add');
    expect(providerTool.description).toBe('Add two numbers together');
    expect(providerTool.parameters.type).toBe('object');
    expect(providerTool.parameters.properties).toBeDefined();
  });
});

describe('validateToolInput', () => {
  const tool = defineTool({
    name: 'http.fetch',
    description: 'Fetch HTTP resource',
    risk: 'high',
    idempotent: false,
    inputSchema: z.object({
      url: z.string().url(),
      method: z.enum(['GET', 'POST']).default('GET'),
      timeoutMs: z.number().positive().optional(),
    }),
    execute: async () => {
      await Promise.resolve();
      return 'OK';
    },
  });

  it('validates and applies defaults for valid input', () => {
    const input = validateToolInput(tool, {
      url: 'https://example.com/api',
    });

    expect(input.url).toBe('https://example.com/api');
    expect(input.method).toBe('GET');
  });

  it('throws typed AirError with INVALID_ARGUMENT on schema failure', () => {
    let error: unknown;
    try {
      validateToolInput(tool, {
        url: 'not-a-valid-url',
        method: 'DELETE',
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(AirError);
    const airError = error as AirError;
    expect(airError.code).toBe('INVALID_ARGUMENT');
    expect(airError.message).toContain('Invalid arguments for tool "http.fetch"');
    expect(airError.context?.tool).toBe('http.fetch');
    expect(Array.isArray(airError.context?.issues)).toBe(true);
  });
});

describe('validateToolOutput', () => {
  const toolWithOutputSchema = defineTool({
    name: 'db.query',
    description: 'Execute database query',
    risk: 'medium',
    idempotent: true,
    inputSchema: z.object({ sql: z.string() }),
    outputSchema: z.object({
      rows: z.array(z.record(z.string(), z.unknown())),
      rowCount: z.number().int().min(0),
    }),
    execute: async () => {
      await Promise.resolve();
      return { rows: [], rowCount: 0 };
    },
  });

  const toolWithoutOutputSchema = defineTool({
    name: 'generic.action',
    description: 'Arbitrary action',
    risk: 'low',
    idempotent: true,
    inputSchema: z.object({}),
    execute: async () => {
      await Promise.resolve();
      return 'raw-result';
    },
  });

  it('passes valid output matching outputSchema', () => {
    const output = validateToolOutput(toolWithOutputSchema, {
      rows: [{ id: 1, name: 'alice' }],
      rowCount: 1,
    });

    expect(output.rowCount).toBe(1);
    expect(output.rows.length).toBe(1);
  });

  it('throws typed AirError with INTERNAL when output violates outputSchema', () => {
    let error: unknown;
    try {
      validateToolOutput(toolWithOutputSchema, {
        rows: 'not-an-array',
        rowCount: -5,
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(AirError);
    const airError = error as AirError;
    expect(airError.code).toBe('INTERNAL');
    expect(airError.message).toContain('Output validation failed for tool "db.query"');
  });

  it('returns raw output unchanged if no outputSchema is specified', () => {
    const res = validateToolOutput(toolWithoutOutputSchema, { any: 'data', arbitrary: 123 });
    expect(res).toEqual({ any: 'data', arbitrary: 123 });
  });
});

describe('Tool Execution with Context', () => {
  it('executes tool implementation with provided context', async () => {
    const clock = new FakeClock('2026-10-17T04:00:00.000Z');
    const controller = new AbortController();

    const tool = defineTool({
      name: 'context.inspector',
      description: 'Echoes execution context',
      risk: 'low',
      idempotent: true,
      inputSchema: z.object({ tag: z.string() }),
      execute: async (args, ctx) => {
        await Promise.resolve();
        return {
          tag: args.tag,
          callId: ctx.callId,
          runId: ctx.runId,
          now: ctx.clock.iso(),
          aborted: Boolean(ctx.signal?.aborted),
        };
      },
    });

    const ctx: ToolExecutionContext = {
      callId: 'call_test_123',
      runId: 'run_test_456',
      sessionId: 'sess_test_789',
      agentId: 'agent_coder',
      signal: controller.signal,
      clock,
      timeoutMs: 3000,
      workspaceRoot: 'C:/dev/project',
    };

    const result = await tool.execute({ tag: 'sample' }, ctx);

    expect(result.tag).toBe('sample');
    expect(result.callId).toBe('call_test_123');
    expect(result.runId).toBe('run_test_456');
    expect(result.now).toBe('2026-10-17T04:00:00.000Z');
    expect(result.aborted).toBe(false);
  });
});
