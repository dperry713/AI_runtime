/**
 * Unit tests for Built-in Filesystem Tools (Phase 4 - P4-T04).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  BUILTIN_FS_TOOLS,
  fsDeleteTool,
  fsEditTool,
  fsGlobTool,
  fsGrepTool,
  fsListTool,
  fsMkdirTool,
  fsMoveTool,
  fsReadTool,
  fsStatTool,
  fsWriteTool,
  registerBuiltinFsTools,
} from '../../../src/tools/builtin/fs.js';
import { ToolExecutor } from '../../../src/tools/executor.js';
import { ToolRegistry } from '../../../src/tools/registry.js';

describe('Built-in FS Tools (P4-T04)', () => {
  let rootJail: string;
  let registry: ToolRegistry;
  let executor: ToolExecutor;

  beforeEach(async () => {
    rootJail = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'air-tools-fs-'));
    registry = new ToolRegistry();
    registerBuiltinFsTools(registry);
    executor = new ToolExecutor({
      registry,
      defaultWorkspaceRoot: rootJail,
    });
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(rootJail, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe('fs.read and fs.write', () => {
    it('writes and reads a text file within workspace jail', async () => {
      const writeResult = await executor.execute({
        tool: fsWriteTool,
        runId: 'run-000001',
        input: { path: 'notes.txt', content: 'Hello World!' },
        workspaceRoot: rootJail,
      });

      expect(writeResult.output).toEqual({
        path: 'notes.txt',
        bytesWritten: 12,
      });

      const readResult = await executor.execute({
        tool: fsReadTool,
        runId: 'run-000001',
        input: { path: 'notes.txt' },
        workspaceRoot: rootJail,
      });

      expect(readResult.output).toEqual({
        content: 'Hello World!',
        totalBytes: 12,
        isTruncated: false,
      });
    });

    it('supports reading slices via offset and length', async () => {
      await executor.execute({
        tool: fsWriteTool,
        runId: 'run-000001',
        input: { path: 'alphabet.txt', content: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
        workspaceRoot: rootJail,
      });

      const sliceResult = await executor.execute({
        tool: fsReadTool,
        runId: 'run-000001',
        input: { path: 'alphabet.txt', offset: 3, length: 5 },
        workspaceRoot: rootJail,
      });

      expect(sliceResult.output).toEqual({
        content: 'DEFGH',
        totalBytes: 26,
        isTruncated: true,
      });
    });

    it('supports base64 encoded writing and reading', async () => {
      const base64Data = Buffer.from('Binary Payload 123').toString('base64');

      await executor.execute({
        tool: fsWriteTool,
        runId: 'run-000001',
        input: { path: 'data.bin', content: base64Data, encoding: 'base64' },
        workspaceRoot: rootJail,
      });

      const readResult = await executor.execute({
        tool: fsReadTool,
        runId: 'run-000001',
        input: { path: 'data.bin', encoding: 'utf-8' },
        workspaceRoot: rootJail,
      });

      expect((readResult.output as { content: string }).content).toBe('Binary Payload 123');
    });

    it('rejects path traversal attempts escaping the workspace jail', async () => {
      await expect(
        executor.execute({
          tool: fsReadTool,
          runId: 'run-000001',
          input: { path: '../../outside.txt' },
          workspaceRoot: rootJail,
        }),
      ).rejects.toThrowError(AirError);

      await expect(
        executor.execute({
          tool: fsWriteTool,
          runId: 'run-000001',
          input: { path: '../escape.txt', content: 'escape' },
          workspaceRoot: rootJail,
        }),
      ).rejects.toThrowError(AirError);
    });

    it('throws NOT_FOUND when reading missing file', async () => {
      await expect(
        executor.execute({
          tool: fsReadTool,
          runId: 'run-000001',
          input: { path: 'nonexistent.txt' },
          workspaceRoot: rootJail,
        }),
      ).rejects.toThrowError(AirError);
    });
  });

  describe('fs.edit', () => {
    it('applies exact-match single-chunk patch to existing file', async () => {
      await executor.execute({
        tool: fsWriteTool,
        runId: 'run-000001',
        input: { path: 'code.ts', content: 'function greet() {\n  return "hi";\n}\n' },
        workspaceRoot: rootJail,
      });

      const editResult = await executor.execute({
        tool: fsEditTool,
        runId: 'run-000001',
        input: {
          path: 'code.ts',
          oldText: 'return "hi";',
          newText: 'return "hello world";',
        },
        workspaceRoot: rootJail,
      });

      expect(editResult.output).toEqual({
        path: 'code.ts',
        modified: true,
        occurrencesReplaced: 1,
      });

      const verifyResult = await executor.execute({
        tool: fsReadTool,
        runId: 'run-000001',
        input: { path: 'code.ts' },
        workspaceRoot: rootJail,
      });

      expect((verifyResult.output as { content: string }).content).toBe('function greet() {\n  return "hello world";\n}\n');
    });

    it('throws NOT_FOUND when target text does not exist', async () => {
      await executor.execute({
        tool: fsWriteTool,
        runId: 'run-000001',
        input: { path: 'doc.txt', content: 'Some existing text.' },
        workspaceRoot: rootJail,
      });

      await expect(
        executor.execute({
          tool: fsEditTool,
          runId: 'run-000001',
          input: { path: 'doc.txt', oldText: 'missing text', newText: 'replacement' },
          workspaceRoot: rootJail,
        }),
      ).rejects.toThrowError(AirError);
    });

    it('throws INVALID_ARGUMENT when target text occurs multiple times', async () => {
      await executor.execute({
        tool: fsWriteTool,
        runId: 'run-000001',
        input: { path: 'duplicate.txt', content: 'repeat repeat repeat' },
        workspaceRoot: rootJail,
      });

      await expect(
        executor.execute({
          tool: fsEditTool,
          runId: 'run-000001',
          input: { path: 'duplicate.txt', oldText: 'repeat', newText: 'single' },
          workspaceRoot: rootJail,
        }),
      ).rejects.toThrowError(AirError);
    });
  });

  describe('fs.list and fs.stat', () => {
    it('lists entries and reports detailed metadata', async () => {
      await executor.execute({
        tool: fsWriteTool,
        runId: 'run-000001',
        input: { path: 'file1.txt', content: 'content 1' },
        workspaceRoot: rootJail,
      });

      await executor.execute({
        tool: fsWriteTool,
        runId: 'run-000001',
        input: { path: 'file2.txt', content: 'content 22' },
        workspaceRoot: rootJail,
      });

      const listSimple = await executor.execute({
        tool: fsListTool,
        runId: 'run-000001',
        input: { path: '.' },
        workspaceRoot: rootJail,
      });

      const simpleOutput = listSimple.output as { entries: Array<{ name: string }>; count: number };
      expect(simpleOutput.count).toBe(2);
      expect(simpleOutput.entries.map((e) => e.name)).toEqual(['file1.txt', 'file2.txt']);

      const listDetailed = await executor.execute({
        tool: fsListTool,
        runId: 'run-000001',
        input: { path: '.', detailed: true },
        workspaceRoot: rootJail,
      });

      const detailedOutput = listDetailed.output as {
        entries: Array<{ name: string; isFile: boolean; isDirectory: boolean; size?: number }>;
        count: number;
      };
      expect(detailedOutput.count).toBe(2);
      expect(detailedOutput.entries[0]?.size).toBe(9);
      expect(detailedOutput.entries[1]?.size).toBe(10);
    });

    it('stats file properties accurately', async () => {
      await executor.execute({
        tool: fsWriteTool,
        runId: 'run-000001',
        input: { path: 'sample.txt', content: 'sample content' },
        workspaceRoot: rootJail,
      });

      const statResult = await executor.execute({
        tool: fsStatTool,
        runId: 'run-000001',
        input: { path: 'sample.txt' },
        workspaceRoot: rootJail,
      });

      const output = statResult.output as {
        exists: boolean;
        isFile: boolean;
        isDirectory: boolean;
        size: number;
      };
      expect(output.exists).toBe(true);
      expect(output.isFile).toBe(true);
      expect(output.isDirectory).toBe(false);
      expect(output.size).toBe(14);
    });
  });

  describe('fs.mkdir, fs.move, and fs.delete', () => {
    it('creates directories recursively', async () => {
      const mkdirResult = await executor.execute({
        tool: fsMkdirTool,
        runId: 'run-000001',
        input: { path: 'src/components/ui' },
        workspaceRoot: rootJail,
      });

      expect((mkdirResult.output as { created: boolean }).created).toBe(true);

      const stat = await executor.execute({
        tool: fsStatTool,
        runId: 'run-000001',
        input: { path: 'src/components/ui' },
        workspaceRoot: rootJail,
      });

      expect((stat.output as { isDirectory: boolean }).isDirectory).toBe(true);
    });

    it('moves files and creates destination directories automatically', async () => {
      await executor.execute({
        tool: fsWriteTool,
        runId: 'run-000001',
        input: { path: 'original.txt', content: 'Move me' },
        workspaceRoot: rootJail,
      });

      const moveResult = await executor.execute({
        tool: fsMoveTool,
        runId: 'run-000001',
        input: { source: 'original.txt', destination: 'archive/moved.txt' },
        workspaceRoot: rootJail,
      });

      expect((moveResult.output as { moved: boolean }).moved).toBe(true);

      // Original should no longer exist
      await expect(
        executor.execute({
          tool: fsStatTool,
          runId: 'run-000001',
          input: { path: 'original.txt' },
          workspaceRoot: rootJail,
        }),
      ).rejects.toThrowError(AirError);

      // Destination should exist
      const readDest = await executor.execute({
        tool: fsReadTool,
        runId: 'run-000001',
        input: { path: 'archive/moved.txt' },
        workspaceRoot: rootJail,
      });
      expect((readDest.output as { content: string }).content).toBe('Move me');
    });

    it('deletes files and directories cleanly', async () => {
      await executor.execute({
        tool: fsWriteTool,
        runId: 'run-000001',
        input: { path: 'trash.txt', content: 'delete me' },
        workspaceRoot: rootJail,
      });

      const deleteResult = await executor.execute({
        tool: fsDeleteTool,
        runId: 'run-000001',
        input: { path: 'trash.txt' },
        workspaceRoot: rootJail,
      });

      expect((deleteResult.output as { deleted: boolean }).deleted).toBe(true);

      await expect(
        executor.execute({
          tool: fsStatTool,
          runId: 'run-000001',
          input: { path: 'trash.txt' },
          workspaceRoot: rootJail,
        }),
      ).rejects.toThrowError(AirError);
    });

    it('deletes directories recursively when recursive: true', async () => {
      await executor.execute({
        tool: fsMkdirTool,
        runId: 'run-000001',
        input: { path: 'dir/nested' },
        workspaceRoot: rootJail,
      });

      await executor.execute({
        tool: fsWriteTool,
        runId: 'run-000001',
        input: { path: 'dir/nested/file.txt', content: 'test' },
        workspaceRoot: rootJail,
      });

      const del = await executor.execute({
        tool: fsDeleteTool,
        runId: 'run-000001',
        input: { path: 'dir', recursive: true },
        workspaceRoot: rootJail,
      });

      expect((del.output as { deleted: boolean }).deleted).toBe(true);
    });

    it('falls back to process.cwd when workspaceRoot is not specified', async () => {
      const executorNoRoot = new ToolExecutor();
      const statCwd = await executorNoRoot.execute({
        tool: fsStatTool,
        runId: 'run-000001',
        input: { path: 'package.json' },
      });

      expect((statCwd.output as { isFile: boolean }).isFile).toBe(true);
    });

    it('reads ascii encoded files', async () => {
      await executor.execute({
        tool: fsWriteTool,
        runId: 'run-000001',
        input: { path: 'ascii.txt', content: 'ascii text' },
        workspaceRoot: rootJail,
      });

      const res = await executor.execute({
        tool: fsReadTool,
        runId: 'run-000001',
        input: { path: 'ascii.txt', encoding: 'ascii' },
        workspaceRoot: rootJail,
      });

      expect((res.output as { content: string }).content).toBe('ascii text');
    });
  });

  describe('fs.glob and fs.grep', () => {
    beforeEach(async () => {
      await executor.execute({
        tool: fsWriteTool,
        runId: 'run-000001',
        input: { path: 'src/index.ts', content: 'console.log("hello world");\nconst x = 1;\n' },
        workspaceRoot: rootJail,
      });

      await executor.execute({
        tool: fsWriteTool,
        runId: 'run-000001',
        input: { path: 'src/util/math.ts', content: 'export function add(a: number, b: number) { return a + b; }\n' },
        workspaceRoot: rootJail,
      });

      await executor.execute({
        tool: fsWriteTool,
        runId: 'run-000001',
        input: { path: 'docs/readme.md', content: '# Readme\nThis is a sample project.\nhello again\n' },
        workspaceRoot: rootJail,
      });
    });

    it('matches files recursively using glob patterns', async () => {
      const globTs = await executor.execute({
        tool: fsGlobTool,
        runId: 'run-000001',
        input: { pattern: '**/*.ts' },
        workspaceRoot: rootJail,
      });

      const output = globTs.output as { matches: string[]; count: number };
      expect(output.count).toBe(2);
      expect(output.matches).toContain('src/index.ts');
      expect(output.matches).toContain('src/util/math.ts');

      const globMd = await executor.execute({
        tool: fsGlobTool,
        runId: 'run-000001',
        input: { pattern: '*.md', path: 'docs' },
        workspaceRoot: rootJail,
      });

      expect((globMd.output as { matches: string[] }).matches).toEqual(['readme.md']);
    });

    it('searches text files using literal grep', async () => {
      const grepResult = await executor.execute({
        tool: fsGrepTool,
        runId: 'run-000001',
        input: { query: 'hello' },
        workspaceRoot: rootJail,
      });

      const output = grepResult.output as {
        matches: Array<{ path: string; line: number; content: string }>;
        count: number;
      };
      expect(output.count).toBe(2);
      expect(output.matches[0]?.path).toBe('docs/readme.md');
      expect(output.matches[0]?.line).toBe(3);
      expect(output.matches[1]?.path).toBe('src/index.ts');
      expect(output.matches[1]?.line).toBe(1);
    });

    it('supports regex and case-insensitive grep search', async () => {
      const grepRegex = await executor.execute({
        tool: fsGrepTool,
        runId: 'run-000001',
        input: { query: 'README', isRegex: true, caseInsensitive: true },
        workspaceRoot: rootJail,
      });

      const output = grepRegex.output as { matches: Array<{ path: string; line: number }>; count: number };
      expect(output.count).toBe(1);
      expect(output.matches[0]?.path).toBe('docs/readme.md');
      expect(output.matches[0]?.line).toBe(1);
    });
  });

  describe('Catalogue and Registry Integration', () => {
    it('registers all 10 built-in fs tools into registry', () => {
      expect(BUILTIN_FS_TOOLS.length).toBe(10);
      expect(registry.size).toBe(10);

      const expectedNames = [
        'fs.read',
        'fs.write',
        'fs.edit',
        'fs.list',
        'fs.glob',
        'fs.grep',
        'fs.stat',
        'fs.mkdir',
        'fs.move',
        'fs.delete',
      ];

      for (const name of expectedNames) {
        expect(registry.has(name)).toBe(true);
      }

      // Executes seamlessly via registry resolution
      return expect(
        executor.execute({
          toolName: 'fs.read',
          runId: 'run-000001',
          input: { path: 'nonexistent.txt' },
          workspaceRoot: rootJail,
        }),
      ).rejects.toThrowError(AirError);
    });
  });
});
