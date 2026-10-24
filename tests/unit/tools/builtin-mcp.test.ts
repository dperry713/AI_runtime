/**
 * Unit tests for MCP Client (Phase W10 - P10-T01).
 *
 * Tests the MCP client that communicates with MCP servers via stdio or
 * HTTP, exposes tools as AIR tools namespaced `mcp.<server>.<tool>`, and
 * routes all executions through policy and sandbox.
 *
 * Tests use a mock MCP server (spawned process speaking the MCP JSON-RPC
 * protocol) to verify end-to-end behavior without external dependencies.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { AirError } from '../../../src/errors/index.js';
import { McpClient, createMcpClient, registerMcpTools } from '../../../src/tools/builtin/mcp.js';
import { ToolRegistry as ToolRegistryClass } from '../../../src/tools/registry.js';
import { FakeClock, FakeIdGenerator, SeededRandom } from '../../../src/util/index.js';

// ============================================================================
// Mock MCP Server
// ============================================================================

/**
 * Spawns a mock MCP server that speaks the MCP JSON-RPC protocol over stdio.
 * The server responds to initialize, initialized, tools/list, and tools/call.
 */
function spawnMockMcpServer(options: {
  serverName: string;
  tools: Record<
    string,
    { description?: string; result: (args: Record<string, unknown>) => string; isError?: boolean }
  >;
  delayMs?: number;
  failInitialize?: boolean;
}): ReturnType<typeof spawn> {
  const tools = options.tools;
  const serializable = Object.fromEntries(
    Object.entries(tools).map(([name, def]) => [
      name,
      { description: def.description, isError: def.isError, resultSrc: def.result.toString() },
    ]),
  );
  const delayMs = options.delayMs ?? 0;

  const child = spawn(
    'node',
    [
      '-e',
      `
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const tools = ${JSON.stringify(serializable)};
    const delayMs = ${delayMs};
    const failInitialize = ${options.failInitialize};

    function run(def, args) {
      return eval('(' + def.resultSrc + ')')(args);
    }

    function delay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function handleMessage(msg) {
      if (delayMs > 0) await delay(delayMs);
      const id = msg.id;
      const method = msg.method;
      const params = paramsOrEmpty(msg.params);

      if (method === 'initialize') {
        if (failInitialize) {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: 'Initialization failed' }
          }) + '\\n');
        } else {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: '${options.serverName}', version: '1.0.0' }
            }
          }) + '\\n');
        }
      } else if (method === 'initialized') {
        // Notification, no response
      } else if (method === 'tools/list') {
        const toolList = Object.entries(tools).map(([name, def]) => ({
          name,
          description: def.description || \`Tool \${name}\`,
          inputSchema: { type: 'object', properties: {} }
        }));
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { tools: toolList }
        }) + '\\n');
      } else if (method === 'tools/call') {
        const { name, arguments: args } = params;
        const def = tools[name];
        if (!def) {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: \`Unknown tool: \${name}\` }
          }) + '\\n');
        } else if (def.isError) {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: \`Error: \${run(def, args)}\` }],
              isError: true
            }
          }) + '\\n');
        } else {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: run(def, args) }]
            }
          }) + '\\n');
        }
      }
    }

    function paramsOrEmpty(p) {
      return p || {};
    }

    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        handleMessage(msg);
      } catch (e) {
        // Ignore parse errors
      }
    });
  `,
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  return child;
}

// ============================================================================
// Tests
// ============================================================================

describe('McpClient (P10-T01)', () => {
  let childProcess: ReturnType<typeof spawn> | null = null;

  afterEach(() => {
    if (childProcess) {
      try {
        childProcess.kill('SIGTERM');
      } catch {
        // Ignore
      }
      childProcess = null;
    }
  });

  it('creates an MCP client with default options', async () => {
    const client = new McpClient({
      serverName: 'test-server',
      transport: 'stdio',
      command: 'node',
      args: ['-e', 'process.stdin.resume();'],
    });
    expect(client).toBeInstanceOf(McpClient);
    await client.close();
  });

  it('initializes and lists tools from a mock MCP server', async () => {
    childProcess = spawnMockMcpServer({
      serverName: 'test-server',
      tools: {
        echo: {
          description: 'Echoes input back',
          result: (args) => `echo: ${JSON.stringify(args)}`,
        },
        add: {
          description: 'Adds two numbers',
          result: (args) => String(Number(args['a'] ?? 0) + Number(args['b'] ?? 0)),
        },
      },
    });

    const client = new McpClient({
      serverName: 'test-server',
      transport: 'stdio',
      command: 'node',
      args: ['-e', ''], // Will be replaced by mock server
      clock: new FakeClock('2026-10-24T00:00:00.000Z'),
      random: new SeededRandom(42),
      idGenerator: new FakeIdGenerator(),
      childProcess: childProcess ?? undefined,
    });

    const result = await client.initialize();

    expect(result.serverName).toBe('test-server');
    expect(result.serverInfo.name).toBe('test-server');
    expect(result.tools).toHaveLength(2);
    expect(result.tools.map((t) => t.name)).toContain('echo');
    expect(result.tools.map((t) => t.name)).toContain('add');

    // Check tool definitions are namespaced
    const echoTool = client.getTool('mcp.test-server.echo');
    expect(echoTool).toBeDefined();
    expect(echoTool?.name).toBe('mcp.test-server.echo');

    const addTool = client.getTool('mcp.test-server.add');
    expect(addTool).toBeDefined();
    expect(addTool?.name).toBe('mcp.test-server.add');

    await client.close();
  });

  it('executes an MCP tool through the client', async () => {
    childProcess = spawnMockMcpServer({
      serverName: 'test-server',
      tools: {
        echo: { description: 'Echoes input', result: (args) => `echo: ${JSON.stringify(args)}` },
      },
    });

    const client = new McpClient({
      serverName: 'test-server',
      transport: 'stdio',
      command: 'node',
      args: ['-e', ''],
      clock: new FakeClock('2026-10-24T00:00:00.000Z'),
      random: new SeededRandom(42),
      idGenerator: new FakeIdGenerator(),
      childProcess: childProcess ?? undefined,
    });

    await client.initialize();

    const tool = client.getTool('mcp.test-server.echo');
    expect(tool).toBeDefined();
    if (!tool) throw new Error('tool was not registered');

    const result = await tool.execute(
      { message: 'hello' },
      {
        callId: 'call-1',
        runId: 'run-1',
        clock: new FakeClock('2026-10-24T00:00:00.000Z'),
      },
    );

    expect(result).toBe('echo: {"message":"hello"}');

    await client.close();
  });

  it('throws AirError when calling initialize fails', async () => {
    childProcess = spawnMockMcpServer({
      serverName: 'fail-server',
      tools: {},
      failInitialize: true,
    });

    const client = new McpClient({
      serverName: 'fail-server',
      transport: 'stdio',
      command: 'node',
      args: ['-e', ''],
      clock: new FakeClock('2026-10-24T00:00:00.000Z'),
      random: new SeededRandom(42),
      idGenerator: new FakeIdGenerator(),
      childProcess: childProcess ?? undefined,
    });

    await expect(client.initialize()).rejects.toThrow(AirError);
    await client.close();
  });

  it('getResult throws before initialize', async () => {
    const client = new McpClient({
      serverName: 'test-server',
      transport: 'stdio',
      command: 'node',
      args: ['-e', ''],
      clock: new FakeClock('2026-10-24T00:00:00.000Z'),
      random: new SeededRandom(42),
      idGenerator: new FakeIdGenerator(),
      childProcess: childProcess ?? undefined,
    });

    expect(() => client.getResult()).toThrow(AirError);
    await client.close();
  });

  it('getTool returns undefined for unknown tool', async () => {
    childProcess = spawnMockMcpServer({
      serverName: 'test-server',
      tools: {},
    });

    const client = new McpClient({
      serverName: 'test-server',
      transport: 'stdio',
      command: 'node',
      args: ['-e', ''],
      clock: new FakeClock('2026-10-24T00:00:00.000Z'),
      random: new SeededRandom(42),
      idGenerator: new FakeIdGenerator(),
      childProcess: childProcess ?? undefined,
    });

    await client.initialize();

    expect(client.getTool('mcp.test-server.nonexistent')).toBeUndefined();
    await client.close();
  });

  it('registerMcpTools registers all tools with the registry', async () => {
    childProcess = spawnMockMcpServer({
      serverName: 'test-server',
      tools: {
        tool1: { description: 'Tool 1', result: () => 'result1' },
        tool2: { description: 'Tool 2', result: () => 'result2' },
      },
    });

    const client = new McpClient({
      serverName: 'test-server',
      transport: 'stdio',
      command: 'node',
      args: ['-e', ''],
      clock: new FakeClock('2026-10-24T00:00:00.000Z'),
      random: new SeededRandom(42),
      idGenerator: new FakeIdGenerator(),
      childProcess: childProcess ?? undefined,
    });

    await client.initialize();

    const registry = new ToolRegistryClass();
    registerMcpTools(registry, client);

    expect(registry.has('mcp.test-server.tool1')).toBe(true);
    expect(registry.has('mcp.test-server.tool2')).toBe(true);
    expect(registry.has('mcp.test-server.nonexistent')).toBe(false);

    await client.close();
  });

  it('createMcpClient factory works', async () => {
    childProcess = spawnMockMcpServer({
      serverName: 'factory-server',
      tools: {
        'factory-tool': { description: 'Factory tool', result: () => 'factory-result' },
      },
    });

    const client = await createMcpClient({
      serverName: 'factory-server',
      transport: 'stdio',
      command: 'node',
      args: ['-e', ''],
      clock: new FakeClock('2026-10-24T00:00:00.000Z'),
      random: new SeededRandom(42),
      idGenerator: new FakeIdGenerator(),
      childProcess: childProcess ?? undefined,
    });

    expect(client.isEnabled()).toBe(true);
    const tools = client.getTools();
    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe('mcp.factory-server.factory-tool');

    await client.close();
  });

  it('handles MCP server error responses', async () => {
    childProcess = spawnMockMcpServer({
      serverName: 'error-server',
      tools: {
        'failing-tool': { description: 'Fails', result: () => 'boom', isError: true },
      },
    });

    const client = new McpClient({
      serverName: 'error-server',
      transport: 'stdio',
      command: 'node',
      args: ['-e', ''],
      clock: new FakeClock('2026-10-24T00:00:00.000Z'),
      random: new SeededRandom(42),
      idGenerator: new FakeIdGenerator(),
      childProcess: childProcess ?? undefined,
    });

    await client.initialize();

    const tool = client.getTool('mcp.error-server.failing-tool');
    expect(tool).toBeDefined();
    if (!tool) throw new Error('tool was not registered');

    await expect(
      tool.execute(
        {},
        {
          callId: 'call-1',
          runId: 'run-1',
          clock: new FakeClock('2026-10-24T00:00:00.000Z'),
        },
      ),
    ).rejects.toThrow(AirError);

    await client.close();
  });

  it('close cleans up resources', async () => {
    childProcess = spawnMockMcpServer({
      serverName: 'close-server',
      tools: {},
    });

    const client = new McpClient({
      serverName: 'close-server',
      transport: 'stdio',
      command: 'node',
      args: ['-e', ''],
      clock: new FakeClock('2026-10-24T00:00:00.000Z'),
      random: new SeededRandom(42),
      idGenerator: new FakeIdGenerator(),
      childProcess: childProcess ?? undefined,
    });

    await client.initialize();
    expect(client.getTools().length).toBe(0);

    await client.close();
    // After close, initialize should fail
    await expect(client.initialize()).rejects.toThrow(AirError);
  });
});
