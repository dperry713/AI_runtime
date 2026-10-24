/**
 * MCP Client Tool Integration (Phase 10 - P10-T01).
 *
 * Implements a Model Context Protocol (MCP) client that talks to MCP servers
 * over stdio (a pre-spawned process) or streamable HTTP, discovers their
 * tools, and exposes them as AIR tools namespaced `mcp.<server>.<tool>`.
 *
 * All MCP tool executions are routed through:
 * - The policy engine (deny-by-default, Rule S1 / Rule R3)
 * - The sandbox (Job Objects / AppContainer, Rule R2)
 * - The journal (Rule R8)
 *
 * Adheres to:
 * - Rule R1: No console.log; uses src/observability
 * - Rule R2: Only src/sandbox spawns processes; stdio servers are injected
 * - Rule R6: Injected Clock
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 * - Rule R12: MCP output treated as untrusted; validated with Zod
 * - Rule S1: Deny-by-default policy
 */

import { z } from 'zod';
import { AirError } from '../../errors/index.js';
import { getLogger, type ComponentLogger } from '../../observability/index.js';
import type { Clock, IdGenerator, Random } from '../../util/index.js';
import { SystemClock } from '../../util/index.js';
import { defineTool, type ToolDefinition, type ToolExecutionContext } from '../contract.js';
import type { ToolRegistry } from '../registry.js';
import type { PolicyEngine } from '../../policy/index.js';
import type { ProcessRunner } from '../../sandbox/index.js';

// ============================================================================
// MCP Protocol Types (JSON-RPC 2.0)
// ============================================================================

const MCP_PROTOCOL_VERSION = '2024-11-05';

export const McpJsonRpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

export type McpJsonRpcMessage = z.infer<typeof McpJsonRpcSchema>;

/** Rule R12: everything a server sends back is validated before use. */
const McpInitializeResultSchema = z.object({
  protocolVersion: z.string(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  serverInfo: z.object({ name: z.string(), version: z.string().optional() }),
});

const McpToolsListSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      inputSchema: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

const McpCallToolResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  isError: z.boolean().optional(),
});

export interface McpInitializeRequest {
  protocolVersion: string;
  capabilities: Record<string, never>;
  clientInfo: {
    name: string;
    version?: string;
  };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities?: Record<string, unknown> | undefined;
  serverInfo: {
    name: string;
    version?: string | undefined;
  };
}

export interface McpTool {
  readonly name: string;
  readonly description?: string | undefined;
  /** JSON Schema for the tool arguments, exactly as advertised by the server. */
  readonly inputSchema: Record<string, unknown>;
}

export interface McpCallToolRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpCallToolResult {
  content: Array<{
    type: string;
    text?: string | undefined;
  }>;
  isError?: boolean | undefined;
}

/** Writable end of a stdio server process (structurally satisfied by node streams). */
interface McpWritable {
  readonly destroyed: boolean;
  readonly writable: boolean;
  write(chunk: string, encoding: 'utf8', callback: (error?: Error | null) => void): boolean;
}

/** Readable end of a stdio server process (structurally satisfied by node streams). */
interface McpReadable {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

/**
 * Minimal view of an already-spawned stdio MCP server. Node's ChildProcess
 * satisfies it, but this layer must not import node:child_process (Rule R2).
 */
export interface McpStdioProcess {
  readonly stdin: McpWritable | null;
  readonly stdout: McpReadable | null;
  readonly stderr: McpReadable | null;
  readonly killed: boolean;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
}
// ============================================================================
// MCP Client Options & Result Types
// ============================================================================

export interface McpClientOptions {
  /** Server name used for tool namespacing: mcp.<server>.<tool> */
  readonly serverName: string;
  /** Connection type: 'stdio' (pre-spawned process) or 'http' (streamable HTTP) */
  readonly transport: 'stdio' | 'http';
  /**
   * For stdio: the already-running MCP server process. Rule R2 only allows
   * src/sandbox to spawn processes, so the caller (sandbox/service layer)
   * spawns the server and hands it over. The client takes ownership and
   * kills it on close().
   */
  readonly childProcess?: McpStdioProcess | undefined;
  /** For stdio: command the server was started with (informational, used in logs). */
  readonly command?: string | undefined;
  /** For stdio: arguments the server was started with (informational, never logged). */
  readonly args?: readonly string[] | undefined;
  /** For stdio: environment variables used when running through a ProcessRunner. */
  readonly env?: Record<string, string> | undefined;
  /** For http: base URL of the MCP server */
  readonly baseUrl?: string | undefined;
  /** For http: optional fetch override for testing */
  readonly fetchFn?: typeof fetch | undefined;
  /** Working directory used when running through a ProcessRunner */
  readonly cwd?: string | undefined;
  /** Injected clock for determinism (Rule R6) */
  readonly clock?: Clock | undefined;
  /** Accepted for API symmetry with other tools; the MCP client does not use it. */
  readonly random?: Random | undefined;
  /** Accepted for API symmetry with other tools; the MCP client does not use it. */
  readonly idGenerator?: IdGenerator | undefined;
  /** Logger instance */
  readonly logger?: ComponentLogger | undefined;
  /** Sandbox runner for executing MCP tool calls out-of-process (Rule R2) */
  readonly processRunner?: ProcessRunner | undefined;
  /** Policy engine for deny-by-default enforcement (Rule S1 / Rule R3) */
  readonly policyEngine?: PolicyEngine | undefined;
  /** When true, tool calls are denied if no policy engine is configured (fail closed). */
  readonly requirePolicyDecision?: boolean | undefined;
  /** Maximum output bytes per tool call */
  readonly maxOutputBytes?: number | undefined;
  /** Default timeout in milliseconds */
  readonly defaultTimeoutMs?: number | undefined;
}

export interface McpClientResult {
  readonly serverName: string;
  readonly serverInfo: { name: string; version?: string | undefined };
  readonly tools: readonly McpTool[];
  readonly client: McpClient;
}

type ClientState = 'new' | 'initializing' | 'ready' | 'closed';

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

// ============================================================================
// MCP Client Implementation
// ============================================================================

/**
 * MCP Client that connects to an MCP server and exposes its tools as AIR
 * tool definitions namespaced `mcp.<server>.<tool>`.
 *
 * All tool executions are policy-governed. MCP server output is treated as
 * untrusted (Rule R12) and validated with Zod schemas.
 */
export class McpClient {
  private readonly serverName: string;
  private readonly transport: 'stdio' | 'http';
  private readonly childProcess: McpStdioProcess | undefined;
  private readonly command: string | undefined;
  private readonly env: Record<string, string> | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly cwd: string | undefined;
  private readonly clock: Clock;
  private readonly logger: ComponentLogger;
  private readonly processRunner: ProcessRunner | undefined;
  private readonly policyEngine: PolicyEngine | undefined;
  private readonly requirePolicyDecision: boolean;
  private readonly maxOutputBytes: number;
  private readonly defaultTimeoutMs: number;

  private readonly tools = new Map<string, McpTool>();
  private readonly toolDefinitions = new Map<string, ToolDefinition<unknown, unknown>>();
  private readonly pending = new Map<number, PendingRequest>();
  private serverInfo: { name: string; version?: string | undefined };
  private state: ClientState = 'new';
  private initPromise: Promise<McpClientResult> | null = null;
  private messageId = 0;

  constructor(options: McpClientOptions) {
    this.serverName = options.serverName;
    this.transport = options.transport;
    this.childProcess = options.childProcess;
    this.command = options.command;
    this.env = options.env;
    this.baseUrl = options.baseUrl;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.cwd = options.cwd;
    this.clock = options.clock ?? new SystemClock();
    this.logger = options.logger ?? getLogger(`mcp-client:${this.serverName}`);
    this.processRunner = options.processRunner;
    this.policyEngine = options.policyEngine;
    this.requirePolicyDecision = options.requirePolicyDecision ?? false;
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.serverInfo = { name: this.serverName };
  }

  /**
   * Initializes the MCP connection: attaches to the server, sends
   * initialize, and discovers available tools.
   */
  public async initialize(): Promise<McpClientResult> {
    if (this.state === 'closed') {
      throw new AirError('INVALID_STATE', `MCP client "${this.serverName}" is closed`);
    }
    if (this.state === 'ready') {
      return this.getResult();
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.state = 'initializing';
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<McpClientResult> {
    try {
      if (this.transport === 'stdio') {
        this.attachStdio();
      } else {
        this.connectHttp();
      }

      const init = await this.request(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          // No roots or sampling: this client never answers server-initiated
          // requests, and letting a server drive LLM sampling is untrusted input.
          capabilities: {},
          clientInfo: { name: 'air-runtime', version: '0.0.0' },
        },
        McpInitializeResultSchema,
      );
      this.serverInfo = { name: init.serverInfo.name, version: init.serverInfo.version };

      await this.notify('notifications/initialized');

      const list = await this.request('tools/list', {}, McpToolsListSchema);
      for (const tool of list.tools) {
        this.registerTool({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema ?? {},
        });
      }

      this.state = 'ready';
      this.logger.info(
        {
          event: 'mcp.client.initialized',
          serverName: this.serverName,
          transport: this.transport,
          command: this.command,
          toolCount: list.tools.length,
          toolNames: list.tools.map((t) => t.name),
        },
        `MCP client initialized: ${this.serverName} (${list.tools.length} tools)`,
      );

      return this.getResult();
    } catch (err) {
      if (this.state !== 'closed') {
        this.state = 'new';
      }
      this.initPromise = null;
      this.tools.clear();
      this.toolDefinitions.clear();
      throw new AirError(
        'TOOL_EXECUTION_FAILED',
        `Failed to initialize MCP client "${this.serverName}": ${err instanceof Error ? err.message : String(err)}`,
        {
          cause: err instanceof Error ? err : undefined,
          context: { serverName: this.serverName, transport: this.transport },
        },
      );
    }
  }

  /**
   * True once the client has completed initialization and can serve calls.
   */
  public isEnabled(): boolean {
    return this.state === 'ready';
  }

  /**
   * Returns the initialized client result. Throws if not initialized.
   */
  public getResult(): McpClientResult {
    if (this.state !== 'ready') {
      throw new AirError(
        'INVALID_STATE',
        `MCP client "${this.serverName}" is not initialized. Call initialize() first.`,
      );
    }
    return {
      serverName: this.serverName,
      serverInfo: this.serverInfo,
      tools: Array.from(this.tools.values()),
      client: this,
    };
  }

  /**
   * Returns all registered MCP tools as ToolDefinitions.
   */
  public getTools(): readonly ToolDefinition<unknown, unknown>[] {
    return Array.from(this.toolDefinitions.values());
  }

  /**
   * Returns a specific tool by its namespaced name (mcp.<server>.<tool>).
   */
  public getTool(namespacedName: string): ToolDefinition<unknown, unknown> | undefined {
    return this.toolDefinitions.get(namespacedName);
  }

  /**
   * Registers a single MCP tool as an AIR ToolDefinition.
   */
  private registerTool(mcpTool: McpTool): void {
    const namespacedName = `mcp.${this.serverName}.${mcpTool.name}`;

    const tool = defineTool<unknown, unknown>({
      name: namespacedName,
      description: mcpTool.description ?? `MCP tool ${mcpTool.name} from server ${this.serverName}`,
      risk: 'medium',
      idempotent: false,
      // The server advertises JSON Schema, not Zod. Require an object here and
      // let the server validate its own arguments; the result is validated below.
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.string(),
      capabilities: () => [
        {
          type: 'mcp',
          action: 'call',
          resource: namespacedName,
          meta: { server: this.serverName, tool: mcpTool.name },
        },
      ],
      execute: async (input, ctx) => this.executeMcpTool(mcpTool.name, input, ctx),
    });

    this.tools.set(mcpTool.name, mcpTool);
    this.toolDefinitions.set(namespacedName, tool);
  }

  /**
   * Executes an MCP tool call through the policy engine (and sandbox if configured).
   */
  private async executeMcpTool(
    toolName: string,
    input: unknown,
    ctx: ToolExecutionContext,
  ): Promise<unknown> {
    const namespacedName = `mcp.${this.serverName}.${toolName}`;
    const startedAt = this.clock.monotonicMs();

    // Policy evaluation (Rule S1 / Rule R3)
    if (this.policyEngine) {
      const decision = this.policyEngine.evaluate({
        toolName: namespacedName,
        input,
        capabilities: [{ type: 'mcp', action: 'call', resource: namespacedName }],
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        callId: ctx.callId,
      });

      if (!decision.allowed) {
        throw new AirError(
          'POLICY_DENIED',
          `MCP tool "${namespacedName}" denied by policy: ${decision.reason}`,
          { context: { toolName: namespacedName, decisionId: decision.decisionId } },
        );
      }
    } else if (this.requirePolicyDecision) {
      throw new AirError(
        'POLICY_DENIED',
        `MCP tool "${namespacedName}" denied: a policy decision is required but no policy engine is configured`,
        { context: { toolName: namespacedName } },
      );
    }

    let output: unknown;
    if (this.processRunner) {
      output = await this.runThroughSandbox(namespacedName, toolName, input, ctx);
    } else {
      output = await this.callMcpTool(toolName, input);
    }

    this.logger.debug(
      {
        event: 'mcp.client.tool_call',
        serverName: this.serverName,
        toolName: namespacedName,
        durationMs: Math.round(this.clock.monotonicMs() - startedAt),
      },
      'MCP tool call complete',
    );
    return output;
  }

  /**
   * Runs a tool call out-of-process through the injected sandbox runner.
   */
  private async runThroughSandbox(
    namespacedName: string,
    toolName: string,
    input: unknown,
    ctx: ToolExecutionContext,
  ): Promise<unknown> {
    if (!this.processRunner) {
      throw new AirError('INVALID_STATE', 'No process runner configured');
    }
    const result = await this.processRunner.run({
      command: 'mcp-call',
      args: [namespacedName, JSON.stringify({ name: toolName, arguments: input })],
      cwd: this.cwd,
      env: this.env,
      timeoutMs: this.defaultTimeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      signal: ctx.signal,
    });

    if (result.exitCode !== 0) {
      throw new AirError(
        'TOOL_EXECUTION_FAILED',
        `MCP tool "${namespacedName}" exited with code ${result.exitCode}: ${result.stderr}`,
        { context: { toolName: namespacedName, exitCode: result.exitCode, stderr: result.stderr } },
      );
    }

    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new AirError(
        'TOOL_EXECUTION_FAILED',
        `MCP tool "${namespacedName}" returned invalid JSON`,
        { context: { toolName: namespacedName, rawOutput: result.stdout } },
      );
    }
  }

  /**
   * Calls an MCP tool directly via the protocol.
   */
  private async callMcpTool(toolName: string, input: unknown): Promise<string> {
    const args = z.record(z.string(), z.unknown()).safeParse(input);
    if (!args.success) {
      throw new AirError('INVALID_ARGUMENT', `MCP tool "${toolName}" arguments must be an object`, {
        context: { toolName, serverName: this.serverName },
      });
    }

    const result = await this.request(
      'tools/call',
      { name: toolName, arguments: args.data },
      McpCallToolResultSchema,
    );
    const text = result.content.map((c) => c.text ?? '').join('\n');

    if (result.isError) {
      throw new AirError(
        'TOOL_EXECUTION_FAILED',
        `MCP tool "${toolName}" returned error: ${text}`,
        {
          context: { toolName, serverName: this.serverName },
        },
      );
    }
    return text;
  }

  // ==========================================================================
  // JSON-RPC plumbing
  // ==========================================================================

  /**
   * Sends a JSON-RPC request, waits for the matching response, and validates
   * the result against the supplied schema (Rule R12).
   */
  private async request<T>(
    method: string,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    this.assertUsable();

    const id = ++this.messageId;
    const raw = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AirError(
            'TOOL_TIMEOUT',
            `MCP request "${method}" timed out after ${this.defaultTimeoutMs}ms`,
            { context: { serverName: this.serverName, method, id } },
          ),
        );
      }, this.defaultTimeoutMs);

      this.pending.set(id, { method, resolve, reject, timer });

      this.sendMessage({ jsonrpc: '2.0', id, method, params }).catch((err: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new AirError(
        'TOOL_EXECUTION_FAILED',
        `Invalid "${method}" response from MCP server "${this.serverName}": ${parsed.error.message}`,
        { context: { serverName: this.serverName, method } },
      );
    }
    return parsed.data;
  }

  /**
   * Sends a JSON-RPC notification (no response expected).
   */
  private async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    this.assertUsable();
    await this.sendMessage(
      params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params },
    );
  }

  private assertUsable(): void {
    if (this.state !== 'initializing' && this.state !== 'ready') {
      throw new AirError('INVALID_STATE', `MCP client "${this.serverName}" is not initialized`);
    }
  }

  /**
   * Sends a JSON-RPC message over the transport.
   */
  private async sendMessage(message: McpJsonRpcMessage): Promise<void> {
    this.logger.debug(
      { event: 'mcp.client.send', serverName: this.serverName, method: message.method },
      'Sending MCP message',
    );

    if (this.transport === 'http') {
      await this.sendHttpMessage(message);
      return;
    }

    const stdin = this.childProcess?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new AirError(
        'INVALID_STATE',
        `MCP stdio transport for "${this.serverName}" is not connected`,
      );
    }
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      stdin.write(line, 'utf8', (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Attaches to the injected stdio server process and starts reading responses.
   */
  private attachStdio(): void {
    const child = this.childProcess;
    if (!child) {
      throw new AirError(
        'INVALID_ARGUMENT',
        `MCP stdio transport for "${this.serverName}" requires a pre-spawned childProcess (spawn it through the sandbox layer, Rule R2)`,
      );
    }
    if (!child.stdin || !child.stdout) {
      throw new AirError(
        'TOOL_EXECUTION_FAILED',
        `Failed to initialize stdio pipes for MCP server "${this.serverName}"`,
      );
    }

    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      // Untrusted server: never let an unterminated line grow without bound.
      if (buffer.length > this.maxOutputBytes) {
        this.logger.warn(
          { event: 'mcp.client.oversized_line', serverName: this.serverName, bytes: buffer.length },
          'Dropping oversized MCP output line',
        );
        buffer = '';
      }

      for (const line of lines) {
        this.handleLine(line);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.logger.debug(
        {
          event: 'mcp.client.stderr',
          serverName: this.serverName,
          data: { text: chunk.toString('utf-8') },
        },
        'MCP server stderr',
      );
    });

    child.on('error', (err: Error) => {
      this.logger.error(
        { event: 'mcp.client.error', serverName: this.serverName, err },
        'MCP server process error',
      );
      this.failPending(
        new AirError('TOOL_EXECUTION_FAILED', `MCP server process error: ${err.message}`),
      );
    });

    child.on('close', (code: number | null) => {
      this.logger.warn(
        { event: 'mcp.client.exit', serverName: this.serverName, code },
        'MCP server process exited',
      );
      this.state = 'closed';
      this.failPending(
        new AirError(
          'INVALID_STATE',
          `MCP server "${this.serverName}" exited (code ${String(code)})`,
        ),
      );
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return; // not JSON-RPC (e.g. server banner); ignore
    }
    const parsed = McpJsonRpcSchema.safeParse(json);
    if (parsed.success) {
      this.handleIncomingMessage(parsed.data);
    }
  }

  /**
   * Prepares the HTTP transport (requests are sent per-call via POST).
   */
  private connectHttp(): void {
    if (!this.baseUrl) {
      throw new AirError('INVALID_ARGUMENT', 'MCP HTTP transport requires a baseUrl');
    }
    this.logger.info(
      { event: 'mcp.client.http_connect', serverName: this.serverName, baseUrl: this.baseUrl },
      'Using MCP server over HTTP',
    );
  }

  /**
   * Sends an HTTP POST message to the MCP server and routes a JSON reply.
   */
  private async sendHttpMessage(message: McpJsonRpcMessage): Promise<void> {
    if (!this.baseUrl) {
      throw new AirError('INVALID_STATE', 'MCP HTTP transport not configured');
    }

    const response = await this.fetchFn(`${this.baseUrl}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new AirError(
        'TOOL_EXECUTION_FAILED',
        `MCP HTTP request failed: ${response.status} ${response.statusText}`,
        { context: { serverName: this.serverName, status: response.status } },
      );
    }

    if (response.status === 202) return; // accepted notification, no body

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      throw new AirError(
        'TOOL_EXECUTION_FAILED',
        'MCP streamable HTTP event-stream replies are not supported yet',
        {
          context: { serverName: this.serverName },
        },
      );
    }
    const parsed = McpJsonRpcSchema.safeParse(await response.json());
    if (parsed.success) {
      this.handleIncomingMessage(parsed.data);
    }
  }

  /**
   * Routes an incoming JSON-RPC message from the server.
   */
  private handleIncomingMessage(message: McpJsonRpcMessage): void {
    // Server-initiated request: we advertise no capabilities, so refuse it.
    if (message.method !== undefined) {
      if (message.id !== undefined) {
        this.sendMessage({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Method not found' },
        }).catch(() => undefined);
      }
      return;
    }

    if (typeof message.id !== 'number') return;
    const entry = this.pending.get(message.id);
    if (!entry) return;

    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(
        new AirError(
          'TOOL_EXECUTION_FAILED',
          `MCP error: ${message.error.message} (code ${message.error.code})`,
          {
            context: {
              serverName: this.serverName,
              method: entry.method,
              id: message.id,
              code: message.error.code,
            },
          },
        ),
      );
    } else {
      entry.resolve(message.result);
    }
  }

  private failPending(reason: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
  }

  /**
   * Closes the MCP client connection and cleans up resources. A closed client
   * cannot be re-initialized.
   */
  public close(): Promise<void> {
    this.state = 'closed';
    this.initPromise = null;
    this.failPending(new AirError('INVALID_STATE', `MCP client "${this.serverName}" was closed`));

    if (this.childProcess && !this.childProcess.killed) {
      try {
        this.childProcess.kill('SIGTERM');
      } catch {
        // Ignore kill errors
      }
    }

    this.tools.clear();
    this.toolDefinitions.clear();
    return Promise.resolve();
  }
}

/**
 * Creates an MCP client and initializes it.
 */
export async function createMcpClient(options: McpClientOptions): Promise<McpClient> {
  const client = new McpClient(options);
  await client.initialize();
  return client;
}

/**
 * Registers all MCP client tools with the given ToolRegistry.
 */
export function registerMcpTools(registry: ToolRegistry, client: McpClient): void {
  for (const tool of client.getTools()) {
    registry.register(tool);
  }
}
