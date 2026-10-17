/**
 * Tool Registry (Phase 4 - P4-T02).
 *
 * Provides:
 * - Central registry for ToolDefinitions and AnyTool representations
 * - Namespacing support (e.g. 'fs.read', 'exec.run')
 * - Conflict detection on duplicate registrations with optional overwrite
 * - Filtering by namespace, risk level, or capability
 * - Conversion to ProviderToolDefinition lists for LLM prompts
 */

import { AirError } from '../errors/index.js';
import type { ProviderToolDefinition } from '../providers/index.js';
import {
  type AnyTool,
  defineTool,
  toAnyTool,
  type ToolDefinition,
  type ToolRiskLevel,
  toProviderToolDefinition,
} from './contract.js';

export interface ToolRegistryOptions {
  /** Initial tools to populate the registry with. */
  readonly tools?: Iterable<AnyTool> | undefined;
  /** Whether by default duplicate tool registrations overwrite existing ones. Default false. */
  readonly allowOverwrite?: boolean | undefined;
}

const RISK_HIERARCHY: Record<ToolRiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();
  private readonly defaultAllowOverwrite: boolean;

  public constructor(options?: ToolRegistryOptions) {
    this.defaultAllowOverwrite = options?.allowOverwrite ?? false;
    if (options?.tools) {
      this.registerMany(options.tools);
    }
  }

  /**
   * Number of tools registered.
   */
  public get size(): number {
    return this.tools.size;
  }

  /**
   * Registers a tool into the registry.
   * Accepts either a strongly-typed ToolDefinition or an erased AnyTool.
   * Throws ALREADY_EXISTS if a tool with the same name exists and overwrite is false.
   */
  public register<TInput = unknown, TOutput = unknown>(
    tool: ToolDefinition<TInput, TOutput> | AnyTool,
    options?: { overwrite?: boolean | undefined },
  ): this {
    const validated = defineTool(tool as ToolDefinition<TInput, TOutput>);
    const anyTool = toAnyTool(validated);
    const name = anyTool.name;

    const shouldOverwrite = options?.overwrite ?? this.defaultAllowOverwrite;
    if (this.tools.has(name) && !shouldOverwrite) {
      throw new AirError('ALREADY_EXISTS', `Tool "${name}" is already registered in registry`, {
        context: {
          name,
          existingVersion: this.tools.get(name)?.version,
          incomingVersion: anyTool.version,
        },
      });
    }

    this.tools.set(name, anyTool);
    return this;
  }

  /**
   * Registers multiple tools.
   */
  public registerMany(
    tools: Iterable<AnyTool>,
    options?: { overwrite?: boolean | undefined },
  ): this {
    for (const tool of tools) {
      this.register(tool, options);
    }
    return this;
  }

  /**
   * Unregisters a tool by name.
   * Returns true if a tool was removed, false otherwise.
   */
  public unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Checks whether a tool name is registered.
   */
  public has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Retrieves a tool definition by name, or undefined if not found.
   */
  public get<TInput = unknown, TOutput = unknown>(
    name: string,
  ): ToolDefinition<TInput, TOutput> | undefined {
    return this.tools.get(name) as unknown as ToolDefinition<TInput, TOutput> | undefined;
  }

  /**
   * Retrieves a tool definition by name, throwing NOT_FOUND if absent.
   */
  public getOrThrow<TInput = unknown, TOutput = unknown>(
    name: string,
  ): ToolDefinition<TInput, TOutput> {
    const tool = this.get<TInput, TOutput>(name);
    if (!tool) {
      throw new AirError('NOT_FOUND', `Tool "${name}" was not found in tool registry`, {
        context: {
          requestedName: name,
          registeredCount: this.tools.size,
        },
      });
    }
    return tool;
  }

  /**
   * Returns all registered tools.
   */
  public list(): readonly AnyTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Returns all registered tool names in insertion order.
   */
  public listNames(): readonly string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Returns all tools within a specific namespace.
   * e.g. listByNamespace('fs') matches 'fs.read', 'fs.write', 'fs:list'.
   */
  public listByNamespace(namespace: string): readonly AnyTool[] {
    const prefixDot = `${namespace}.`;
    const prefixColon = `${namespace}:`;
    return this.list().filter(
      (t) => t.name.startsWith(prefixDot) || t.name.startsWith(prefixColon) || t.name === namespace,
    );
  }

  /**
   * Returns all tools whose intrinsic risk level does not exceed the specified maximum.
   */
  public listByMaxRisk(maxRisk: ToolRiskLevel): readonly AnyTool[] {
    const maxRank = RISK_HIERARCHY[maxRisk];
    return this.list().filter((t) => RISK_HIERARCHY[t.risk] <= maxRank);
  }

  /**
   * Exports tools formatted as ProviderToolDefinition items for LLM provider requests.
   * If names are specified, only those tools are exported; otherwise exports all registered tools.
   */
  public toProviderTools(names?: readonly string[]): readonly ProviderToolDefinition[] {
    const toolsToExport: AnyTool[] = [];

    if (names) {
      for (const name of names) {
        const tool = this.tools.get(name);
        if (tool) {
          toolsToExport.push(tool);
        }
      }
    } else {
      toolsToExport.push(...this.list());
    }

    return toolsToExport.map((tool) => toProviderToolDefinition(tool));
  }

  /**
   * Removes all registered tools.
   */
  public clear(): void {
    this.tools.clear();
  }
}
