/**
 * Built-in Filesystem Tools (Phase 4 - P4-T04).
 *
 * Implements 10 safe filesystem tools constrained to the workspace jail:
 * - fs.read: safe text/slice reading with encoding support
 * - fs.write: safe atomic file writing (temp + rename)
 * - fs.edit: exact-match single-chunk patch tool
 * - fs.list: safe directory listing with optional detailed metadata
 * - fs.glob: safe recursive glob file search
 * - fs.grep: safe text search across files
 * - fs.stat: safe metadata retrieval (size, modified time, directory/file flags)
 * - fs.mkdir: safe recursive directory creation
 * - fs.move: safe atomic file/directory move
 * - fs.delete: safe removal (high risk)
 *
 * Adheres to:
 * - Rule R2: No direct node:fs imports; all I/O via src/util/fs-safe.ts
 * - Rule R5: Strict Windows path jail validation
 * - Rule R11: Typed AirError errors
 * - Rule R12: Zod argument schema validation
 */

import { z } from 'zod';
import { AirError } from '../../errors/index.js';
import {
  globIn,
  grepIn,
  listDetailedIn,
  listIn,
  mkdirIn,
  moveIn,
  readFileIn,
  removeIn,
  statIn,
  writeFileAtomicIn,
} from '../../util/index.js';
import {
  type AnyTool,
  defineTool,
  toAnyTool,
  type ToolCapability,
  type ToolDefinition,
  type ToolExecutionContext,
} from '../contract.js';
import type { ToolRegistry } from '../registry.js';

function getWorkspaceRoot(ctx: ToolExecutionContext): string {
  if (!ctx.workspaceRoot || ctx.workspaceRoot.trim().length === 0) {
    return process.cwd();
  }
  return ctx.workspaceRoot;
}

// ============================================================================
// 1. fs.read
// ============================================================================

export const FsReadInputSchema = z.object({
  path: z.string().min(1).describe('Relative or absolute file path within workspace jail'),
  encoding: z.enum(['utf-8', 'ascii', 'base64']).optional().default('utf-8').describe('File encoding format'),
  offset: z.number().int().nonnegative().optional().describe('Byte offset to start reading from'),
  length: z.number().int().positive().optional().describe('Number of characters/bytes to read'),
});

export type FsReadInput = z.infer<typeof FsReadInputSchema>;

export const FsReadOutputSchema = z.object({
  content: z.string().describe('File content read'),
  totalBytes: z.number().int().nonnegative().describe('Total byte length of full file'),
  isTruncated: z.boolean().describe('Whether output was sliced via offset/length'),
});

export type FsReadOutput = z.infer<typeof FsReadOutputSchema>;

export const fsReadTool: ToolDefinition<FsReadInput, FsReadOutput> = defineTool({
  name: 'fs.read',
  description: 'Reads text content or slices from a file within the workspace boundary.',
  risk: 'low',
  idempotent: true,
  inputSchema: FsReadInputSchema,
  outputSchema: FsReadOutputSchema,
  capabilities: (args): readonly ToolCapability[] => [
    { type: 'fs', action: 'read', resource: args.path },
  ],
  execute: async (args: FsReadInput, ctx: ToolExecutionContext): Promise<FsReadOutput> => {
    const root = getWorkspaceRoot(ctx);
    const content = await readFileIn(root, args.path, args.encoding);
    const totalBytes = Buffer.byteLength(content, args.encoding);

    if (args.offset !== undefined || args.length !== undefined) {
      const start = args.offset ?? 0;
      const end = args.length !== undefined ? start + args.length : undefined;
      const sliced = content.slice(start, end);
      return {
        content: sliced,
        totalBytes,
        isTruncated: true,
      };
    }

    return {
      content,
      totalBytes,
      isTruncated: false,
    };
  },
});

// ============================================================================
// 2. fs.write
// ============================================================================

export const FsWriteInputSchema = z.object({
  path: z.string().min(1).describe('Target file path within workspace jail'),
  content: z.string().describe('Text or base64 encoded content to write'),
  encoding: z.enum(['utf-8', 'base64']).optional().default('utf-8').describe('Content encoding'),
});

export type FsWriteInput = z.infer<typeof FsWriteInputSchema>;

export const FsWriteOutputSchema = z.object({
  path: z.string().describe('File path written'),
  bytesWritten: z.number().int().nonnegative().describe('Number of bytes written'),
});

export type FsWriteOutput = z.infer<typeof FsWriteOutputSchema>;

export const fsWriteTool: ToolDefinition<FsWriteInput, FsWriteOutput> = defineTool({
  name: 'fs.write',
  description: 'Atomically writes content to a file within the workspace boundary (temp file + atomic rename).',
  risk: 'medium',
  idempotent: true,
  inputSchema: FsWriteInputSchema,
  outputSchema: FsWriteOutputSchema,
  capabilities: (args): readonly ToolCapability[] => [
    { type: 'fs', action: 'write', resource: args.path },
  ],
  execute: async (args: FsWriteInput, ctx: ToolExecutionContext): Promise<FsWriteOutput> => {
    const root = getWorkspaceRoot(ctx);
    const data = args.encoding === 'base64'
      ? Buffer.from(args.content, 'base64')
      : args.content;

    await writeFileAtomicIn(root, args.path, data);
    const bytesWritten = typeof data === 'string'
      ? Buffer.byteLength(data, 'utf8')
      : data.byteLength;

    return {
      path: args.path,
      bytesWritten,
    };
  },
});

// ============================================================================
// 3. fs.edit
// ============================================================================

export const FsEditInputSchema = z.object({
  path: z.string().min(1).describe('File path to edit within workspace jail'),
  oldText: z.string().min(1).describe('Exact text to be replaced (must match uniquely)'),
  newText: z.string().describe('Replacement text to substitute in place of oldText'),
});

export type FsEditInput = z.infer<typeof FsEditInputSchema>;

export const FsEditOutputSchema = z.object({
  path: z.string().describe('File path modified'),
  modified: z.boolean().describe('Whether file was modified'),
  occurrencesReplaced: z.number().int().positive().describe('Count of matches replaced'),
});

export type FsEditOutput = z.infer<typeof FsEditOutputSchema>;

export const fsEditTool: ToolDefinition<FsEditInput, FsEditOutput> = defineTool({
  name: 'fs.edit',
  description: 'Applies an exact-match chunk replacement to an existing file. Fails if oldText is not unique.',
  risk: 'medium',
  idempotent: false,
  inputSchema: FsEditInputSchema,
  outputSchema: FsEditOutputSchema,
  capabilities: (args): readonly ToolCapability[] => [
    { type: 'fs', action: 'edit', resource: args.path },
  ],
  execute: async (args: FsEditInput, ctx: ToolExecutionContext): Promise<FsEditOutput> => {
    const root = getWorkspaceRoot(ctx);
    const existing = await readFileIn(root, args.path, 'utf-8');

    const firstIndex = existing.indexOf(args.oldText);
    if (firstIndex === -1) {
      throw new AirError('NOT_FOUND', `Target text to replace was not found in "${args.path}"`, {
        context: { path: args.path, oldTextLength: args.oldText.length },
      });
    }

    const secondIndex = existing.indexOf(args.oldText, firstIndex + args.oldText.length);
    if (secondIndex !== -1) {
      throw new AirError(
        'INVALID_ARGUMENT',
        `Target text occurs multiple times in "${args.path}". Provide more surrounding context for unique matching.`,
        { context: { path: args.path } },
      );
    }

    const updated = existing.slice(0, firstIndex) + args.newText + existing.slice(firstIndex + args.oldText.length);
    await writeFileAtomicIn(root, args.path, updated);

    return {
      path: args.path,
      modified: true,
      occurrencesReplaced: 1,
    };
  },
});

// ============================================================================
// 4. fs.list
// ============================================================================

export const FsListInputSchema = z.object({
  path: z.string().optional().default('.').describe('Directory path within workspace jail'),
  detailed: z.boolean().optional().default(false).describe('Whether to return size and modification metadata'),
});

export type FsListInput = z.infer<typeof FsListInputSchema>;

export const FsListOutputSchema = z.object({
  path: z.string().describe('Directory path listed'),
  entries: z.array(
    z.object({
      name: z.string(),
      isDirectory: z.boolean(),
      isFile: z.boolean(),
      size: z.number().int().nonnegative().optional(),
      modifiedMs: z.number().nonnegative().optional(),
    }),
  ),
  count: z.number().int().nonnegative().describe('Number of entries returned'),
});

export type FsListOutput = z.infer<typeof FsListOutputSchema>;

export const fsListTool: ToolDefinition<FsListInput, FsListOutput> = defineTool({
  name: 'fs.list',
  description: 'Lists file and folder entries inside a directory within the workspace.',
  risk: 'low',
  idempotent: true,
  inputSchema: FsListInputSchema,
  outputSchema: FsListOutputSchema,
  capabilities: (args): readonly ToolCapability[] => [
    { type: 'fs', action: 'list', resource: args.path ?? '.' },
  ],
  execute: async (args: FsListInput, ctx: ToolExecutionContext): Promise<FsListOutput> => {
    const root = getWorkspaceRoot(ctx);
    const subPath = args.path ?? '.';

    if (args.detailed) {
      const detailed = await listDetailedIn(root, subPath);
      return {
        path: subPath,
        entries: detailed.map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory,
          isFile: e.isFile,
          size: e.size,
          modifiedMs: e.modifiedMs,
        })),
        count: detailed.length,
      };
    }

    const names = await listIn(root, subPath);
    return {
      path: subPath,
      entries: names.map((name) => ({
        name,
        isDirectory: false,
        isFile: true,
      })),
      count: names.length,
    };
  },
});

// ============================================================================
// 5. fs.glob
// ============================================================================

export const FsGlobInputSchema = z.object({
  pattern: z.string().min(1).describe('Glob pattern (e.g. "*.ts", "**/*.json")'),
  path: z.string().optional().default('.').describe('Base directory to search from'),
  maxResults: z.number().int().positive().optional().default(1000).describe('Maximum results to return'),
});

export type FsGlobInput = z.infer<typeof FsGlobInputSchema>;

export const FsGlobOutputSchema = z.object({
  pattern: z.string().describe('Glob pattern queried'),
  matches: z.array(z.string()).describe('Matching relative file paths'),
  count: z.number().int().nonnegative().describe('Count of matches found'),
});

export type FsGlobOutput = z.infer<typeof FsGlobOutputSchema>;

export const fsGlobTool: ToolDefinition<FsGlobInput, FsGlobOutput> = defineTool({
  name: 'fs.glob',
  description: 'Finds files matching a glob pattern recursively within the workspace.',
  risk: 'low',
  idempotent: true,
  inputSchema: FsGlobInputSchema,
  outputSchema: FsGlobOutputSchema,
  capabilities: (args): readonly ToolCapability[] => [
    { type: 'fs', action: 'glob', resource: args.path ?? '.' },
  ],
  execute: async (args: FsGlobInput, ctx: ToolExecutionContext): Promise<FsGlobOutput> => {
    const root = getWorkspaceRoot(ctx);
    const matches = await globIn(root, args.pattern, args.path ?? '.', args.maxResults);

    return {
      pattern: args.pattern,
      matches: [...matches],
      count: matches.length,
    };
  },
});

// ============================================================================
// 6. fs.grep
// ============================================================================

export const FsGrepInputSchema = z.object({
  query: z.string().min(1).describe('Substring or regular expression to search for'),
  path: z.string().optional().default('.').describe('Base directory to search in'),
  isRegex: z.boolean().optional().default(false).describe('Whether query is a regex'),
  caseInsensitive: z.boolean().optional().default(false).describe('Whether search is case-insensitive'),
  maxMatches: z.number().int().positive().optional().default(500).describe('Maximum matches to return'),
});

export type FsGrepInput = z.infer<typeof FsGrepInputSchema>;

export const FsGrepOutputSchema = z.object({
  query: z.string().describe('Search query executed'),
  matches: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().positive(),
      content: z.string(),
    }),
  ),
  count: z.number().int().nonnegative().describe('Number of line matches found'),
});

export type FsGrepOutput = z.infer<typeof FsGrepOutputSchema>;

export const fsGrepTool: ToolDefinition<FsGrepInput, FsGrepOutput> = defineTool({
  name: 'fs.grep',
  description: 'Searches for text or regex patterns across files within the workspace.',
  risk: 'low',
  idempotent: true,
  inputSchema: FsGrepInputSchema,
  outputSchema: FsGrepOutputSchema,
  capabilities: (args): readonly ToolCapability[] => [
    { type: 'fs', action: 'grep', resource: args.path ?? '.' },
  ],
  execute: async (args: FsGrepInput, ctx: ToolExecutionContext): Promise<FsGrepOutput> => {
    const root = getWorkspaceRoot(ctx);
    const matches = await grepIn(root, args.query, args.path ?? '.', {
      isRegex: args.isRegex,
      caseInsensitive: args.caseInsensitive,
      maxMatches: args.maxMatches,
    });

    return {
      query: args.query,
      matches: matches.map((m) => ({
        path: m.path,
        line: m.line,
        content: m.content,
      })),
      count: matches.length,
    };
  },
});

// ============================================================================
// 7. fs.stat
// ============================================================================

export const FsStatInputSchema = z.object({
  path: z.string().min(1).describe('Path within workspace jail to inspect'),
});

export type FsStatInput = z.infer<typeof FsStatInputSchema>;

export const FsStatOutputSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  isDirectory: z.boolean(),
  isFile: z.boolean(),
  size: z.number().int().nonnegative(),
  modifiedMs: z.number().nonnegative(),
});

export type FsStatOutput = z.infer<typeof FsStatOutputSchema>;

export const fsStatTool: ToolDefinition<FsStatInput, FsStatOutput> = defineTool({
  name: 'fs.stat',
  description: 'Retrieves file metadata (size, directory/file type, modification timestamp) in the workspace.',
  risk: 'low',
  idempotent: true,
  inputSchema: FsStatInputSchema,
  outputSchema: FsStatOutputSchema,
  capabilities: (args): readonly ToolCapability[] => [
    { type: 'fs', action: 'stat', resource: args.path },
  ],
  execute: async (args: FsStatInput, ctx: ToolExecutionContext): Promise<FsStatOutput> => {
    const root = getWorkspaceRoot(ctx);
    const s = await statIn(root, args.path);

    return {
      path: args.path,
      exists: true,
      isDirectory: s.isDirectory(),
      isFile: s.isFile(),
      size: s.size,
      modifiedMs: s.mtimeMs,
    };
  },
});

// ============================================================================
// 8. fs.mkdir
// ============================================================================

export const FsMkdirInputSchema = z.object({
  path: z.string().min(1).describe('Directory path to create within workspace jail'),
});

export type FsMkdirInput = z.infer<typeof FsMkdirInputSchema>;

export const FsMkdirOutputSchema = z.object({
  path: z.string(),
  created: z.boolean(),
});

export type FsMkdirOutput = z.infer<typeof FsMkdirOutputSchema>;

export const fsMkdirTool: ToolDefinition<FsMkdirInput, FsMkdirOutput> = defineTool({
  name: 'fs.mkdir',
  description: 'Recursively creates directories within the workspace boundary.',
  risk: 'medium',
  idempotent: true,
  inputSchema: FsMkdirInputSchema,
  outputSchema: FsMkdirOutputSchema,
  capabilities: (args): readonly ToolCapability[] => [
    { type: 'fs', action: 'mkdir', resource: args.path },
  ],
  execute: async (args: FsMkdirInput, ctx: ToolExecutionContext): Promise<FsMkdirOutput> => {
    const root = getWorkspaceRoot(ctx);
    await mkdirIn(root, args.path);
    return {
      path: args.path,
      created: true,
    };
  },
});

// ============================================================================
// 9. fs.move
// ============================================================================

export const FsMoveInputSchema = z.object({
  source: z.string().min(1).describe('Source path to move'),
  destination: z.string().min(1).describe('Destination target path within workspace jail'),
});

export type FsMoveInput = z.infer<typeof FsMoveInputSchema>;

export const FsMoveOutputSchema = z.object({
  source: z.string(),
  destination: z.string(),
  moved: z.boolean(),
});

export type FsMoveOutput = z.infer<typeof FsMoveOutputSchema>;

export const fsMoveTool: ToolDefinition<FsMoveInput, FsMoveOutput> = defineTool({
  name: 'fs.move',
  description: 'Moves or renames a file or directory within the workspace boundary.',
  risk: 'medium',
  idempotent: false,
  inputSchema: FsMoveInputSchema,
  outputSchema: FsMoveOutputSchema,
  capabilities: (args): readonly ToolCapability[] => [
    {
      type: 'fs',
      action: 'move',
      resource: args.source,
      meta: { destination: args.destination },
    },
  ],
  execute: async (args: FsMoveInput, ctx: ToolExecutionContext): Promise<FsMoveOutput> => {
    const root = getWorkspaceRoot(ctx);
    await moveIn(root, args.source, args.destination);
    return {
      source: args.source,
      destination: args.destination,
      moved: true,
    };
  },
});

// ============================================================================
// 10. fs.delete
// ============================================================================

export const FsDeleteInputSchema = z.object({
  path: z.string().min(1).describe('File or directory path to delete within workspace jail'),
  recursive: z.boolean().optional().default(false).describe('Whether to recursively delete directories'),
});

export type FsDeleteInput = z.infer<typeof FsDeleteInputSchema>;

export const FsDeleteOutputSchema = z.object({
  path: z.string(),
  deleted: z.boolean(),
});

export type FsDeleteOutput = z.infer<typeof FsDeleteOutputSchema>;

export const fsDeleteTool: ToolDefinition<FsDeleteInput, FsDeleteOutput> = defineTool({
  name: 'fs.delete',
  description: 'Deletes a file or directory within the workspace boundary (high risk).',
  risk: 'high',
  idempotent: true,
  inputSchema: FsDeleteInputSchema,
  outputSchema: FsDeleteOutputSchema,
  capabilities: (args): readonly ToolCapability[] => [
    { type: 'fs', action: 'delete', resource: args.path },
  ],
  execute: async (args: FsDeleteInput, ctx: ToolExecutionContext): Promise<FsDeleteOutput> => {
    const root = getWorkspaceRoot(ctx);
    await removeIn(root, args.path);
    return {
      path: args.path,
      deleted: true,
    };
  },
});

// ============================================================================
// Catalogue & Registration Helper
// ============================================================================

export const BUILTIN_FS_TOOLS: readonly AnyTool[] = [
  toAnyTool(fsReadTool),
  toAnyTool(fsWriteTool),
  toAnyTool(fsEditTool),
  toAnyTool(fsListTool),
  toAnyTool(fsGlobTool),
  toAnyTool(fsGrepTool),
  toAnyTool(fsStatTool),
  toAnyTool(fsMkdirTool),
  toAnyTool(fsMoveTool),
  toAnyTool(fsDeleteTool),
];

/**
 * Registers all 10 built-in filesystem tools into a ToolRegistry.
 */
export function registerBuiltinFsTools(registry: ToolRegistry): void {
  registry.registerMany(BUILTIN_FS_TOOLS);
}
