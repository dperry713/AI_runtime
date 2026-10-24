/**
 * Safe filesystem operations constrained to an allowed root jail (Rule R2).
 * Enforces jail boundaries before all I/O, performs atomic writes, and handles Windows locking retries.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AirError } from '../errors/index.js';
import { assertInside, isInside, validatePathSyntax } from './paths.js';
import { SystemRandom } from './random.js';
import { sleep } from './sleep.js';

const random = new SystemRandom();

async function retryOnWindowsLock<T>(
  operation: () => Promise<T>,
  maxRetries: number = 5,
  initialDelayMs: number = 20,
): Promise<T> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await operation();
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      const isLockError = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
      if (isLockError && attempt < maxRetries - 1) {
        attempt += 1;
        await sleep(initialDelayMs * Math.pow(2, attempt - 1));
        continue;
      }
      throw err;
    }
  }
  return operation();
}

function toFullPath(root: string, relativeOrSubPath: string): string {
  return path.isAbsolute(relativeOrSubPath)
    ? relativeOrSubPath
    : path.resolve(root, relativeOrSubPath);
}

function resolveInJail(root: string, relativeOrSubPath: string): string {
  if (relativeOrSubPath && relativeOrSubPath !== '.') {
    validatePathSyntax(relativeOrSubPath);
  }
  const target = toFullPath(root, relativeOrSubPath);
  return assertInside(root, target);
}

/**
 * Checks if a path exists within the root jail.
 */
export async function existsIn(root: string, targetPath: string): Promise<boolean> {
  const target = toFullPath(root, targetPath);
  if (!isInside(root, target)) {
    return false;
  }
  try {
    const verifiedPath = resolveInJail(root, targetPath);
    await fs.promises.access(verifiedPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a text file safely from within the root jail.
 */
export async function readFileIn(
  root: string,
  targetPath: string,
  encoding: BufferEncoding = 'utf-8',
): Promise<string> {
  const verifiedPath = resolveInJail(root, targetPath);
  try {
    return await retryOnWindowsLock(() => fs.promises.readFile(verifiedPath, { encoding }));
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      throw new AirError('NOT_FOUND', `File not found: "${targetPath}"`, {
        cause: nodeErr,
        context: { root, targetPath },
      });
    }
    if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
      throw new AirError('PERMISSION_DENIED', `Permission denied reading: "${targetPath}"`, {
        cause: nodeErr,
        context: { root, targetPath },
      });
    }
    throw new AirError('TOOL_EXECUTION_FAILED', `Failed to read file: "${targetPath}"`, {
      cause: nodeErr,
      context: { root, targetPath },
    });
  }
}

/**
 * Reads binary content safely from within the root jail.
 */
export async function readBufferIn(root: string, targetPath: string): Promise<Buffer> {
  const verifiedPath = resolveInJail(root, targetPath);
  try {
    return await retryOnWindowsLock(() => fs.promises.readFile(verifiedPath));
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      throw new AirError('NOT_FOUND', `File not found: "${targetPath}"`, {
        cause: nodeErr,
        context: { root, targetPath },
      });
    }
    throw new AirError('TOOL_EXECUTION_FAILED', `Failed to read buffer: "${targetPath}"`, {
      cause: nodeErr,
      context: { root, targetPath },
    });
  }
}

/**
 * Atomically writes data to a file within the root jail by writing to a temporary file
 * in the same directory, syncing to disk, and renaming with Windows lock retries.
 */
export async function writeFileAtomicIn(
  root: string,
  targetPath: string,
  data: string | Uint8Array,
): Promise<void> {
  const verifiedPath = resolveInJail(root, targetPath);
  const dir = path.dirname(verifiedPath);

  // Ensure parent directory exists within jail
  await fs.promises.mkdir(dir, { recursive: true });

  const tempSuffix = `tmp-${String(random.nextInt(100000, 999999))}`;
  const tempPath = `${verifiedPath}.${tempSuffix}`;

  try {
    // Write and flush temp file
    const handle = await fs.promises.open(tempPath, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }

    // Atomic replace with retry for Windows AV/file-lock interference.
    // On Windows, rename cannot atomically replace an existing file, so remove
    // the target first (if present) before renaming the temp file into place.
    await retryOnWindowsLock(async () => {
      try {
        await fs.promises.unlink(verifiedPath);
      } catch {
        // Target does not exist; proceed with rename.
      }
      await fs.promises.rename(tempPath, verifiedPath);
    });
  } catch (err) {
    // Clean up temporary file on failure
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // Ignore temp file cleanup failure
    }
    throw new AirError('TOOL_EXECUTION_FAILED', `Failed atomic write to "${targetPath}"`, {
      cause: err instanceof Error ? err : undefined,
      context: { root, targetPath },
    });
  }
}

/**
 * Creates a directory within the root jail.
 */
export async function mkdirIn(root: string, targetPath: string): Promise<void> {
  const verifiedPath = resolveInJail(root, targetPath);
  try {
    await fs.promises.mkdir(verifiedPath, { recursive: true });
  } catch (err) {
    throw new AirError('TOOL_EXECUTION_FAILED', `Failed to create directory: "${targetPath}"`, {
      cause: err instanceof Error ? err : undefined,
      context: { root, targetPath },
    });
  }
}

/**
 * Removes a file or directory within the root jail.
 */
export async function removeIn(root: string, targetPath: string): Promise<void> {
  const verifiedPath = resolveInJail(root, targetPath);
  try {
    await retryOnWindowsLock(() =>
      fs.promises.rm(verifiedPath, { recursive: true, force: true }),
    );
  } catch (err) {
    throw new AirError('TOOL_EXECUTION_FAILED', `Failed to remove: "${targetPath}"`, {
      cause: err instanceof Error ? err : undefined,
      context: { root, targetPath },
    });
  }
}

/**
 * Lists filenames within a directory in the root jail.
 */
export async function listIn(root: string, subPath: string = ''): Promise<string[]> {
  const verifiedPath = resolveInJail(root, subPath);
  try {
    const entries = await fs.promises.readdir(verifiedPath);
    return entries.sort();
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      throw new AirError('NOT_FOUND', `Directory not found: "${subPath}"`, {
        cause: nodeErr,
        context: { root, subPath },
      });
    }
    throw new AirError('TOOL_EXECUTION_FAILED', `Failed to list directory: "${subPath}"`, {
      cause: nodeErr,
      context: { root, subPath },
    });
  }
}

/**
 * Retrieves file stats within the root jail.
 */
export async function statIn(root: string, targetPath: string): Promise<fs.Stats> {
  const verifiedPath = resolveInJail(root, targetPath);
  try {
    return await fs.promises.stat(verifiedPath);
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      throw new AirError('NOT_FOUND', `Path not found: "${targetPath}"`, {
        cause: nodeErr,
        context: { root, targetPath },
      });
    }
    throw new AirError('TOOL_EXECUTION_FAILED', `Failed to stat path: "${targetPath}"`, {
      cause: nodeErr,
      context: { root, targetPath },
    });
  }
}

/**
 * Safely moves or renames a file or directory within the root jail.
 */
export async function moveIn(root: string, sourcePath: string, destPath: string): Promise<void> {
  const verifiedSrc = resolveInJail(root, sourcePath);
  const verifiedDest = resolveInJail(root, destPath);

  // Ensure parent directory of destination exists
  await fs.promises.mkdir(path.dirname(verifiedDest), { recursive: true });

  try {
    await retryOnWindowsLock(() => fs.promises.rename(verifiedSrc, verifiedDest));
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      throw new AirError('NOT_FOUND', `Source path not found for move: "${sourcePath}"`, {
        cause: nodeErr,
        context: { root, sourcePath, destPath },
      });
    }
    throw new AirError('TOOL_EXECUTION_FAILED', `Failed to move "${sourcePath}" to "${destPath}"`, {
      cause: nodeErr,
      context: { root, sourcePath, destPath },
    });
  }
}

export interface DetailedEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly size: number;
  readonly modifiedMs: number;
}

/**
 * Lists detailed file and directory entries in the root jail.
 */
export async function listDetailedIn(
  root: string,
  subPath: string = '',
): Promise<readonly DetailedEntry[]> {
  const verifiedPath = resolveInJail(root, subPath);
  try {
    const entries = await fs.promises.readdir(verifiedPath, { withFileTypes: true });
    const results: DetailedEntry[] = [];

    for (const entry of entries) {
      const fullChild = path.join(verifiedPath, entry.name);
      let size = 0;
      let modifiedMs = 0;

      try {
        const s = await fs.promises.stat(fullChild);
        size = s.size;
        modifiedMs = s.mtimeMs;
      } catch {
        // Skip un-statted entry details
      }

      results.push({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        size,
        modifiedMs,
      });
    }

    return results.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      throw new AirError('NOT_FOUND', `Directory not found: "${subPath}"`, {
        cause: nodeErr,
        context: { root, subPath },
      });
    }
    throw new AirError('TOOL_EXECUTION_FAILED', `Failed to list directory: "${subPath}"`, {
      cause: nodeErr,
      context: { root, subPath },
    });
  }
}

/**
 * Converts a glob pattern (e.g. "*.ts", "src/** /*.json") to a regular expression.
 */
function globToRegex(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/');
  let regexStr = '^';
  let i = 0;

  while (i < normalized.length) {
    const c = normalized[i];
    if (c === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          regexStr += '(?:.+/)?';
          i += 3;
          continue;
        } else {
          regexStr += '.*';
          i += 2;
          continue;
        }
      } else {
        regexStr += '[^/]*';
        i += 1;
        continue;
      }
    } else if (c === '?') {
      regexStr += '[^/]';
      i += 1;
    } else if (c !== undefined && './+^$()[]{}|\\'.includes(c)) {
      regexStr += `\\${c}`;
      i += 1;
    } else if (c !== undefined) {
      regexStr += c;
      i += 1;
    }
  }

  regexStr += '$';
  return new RegExp(regexStr, 'i');
}

/**
 * Finds files matching a glob pattern within the root jail.
 */
export async function globIn(
  root: string,
  pattern: string,
  subPath: string = '',
  maxResults: number = 1000,
): Promise<readonly string[]> {
  const verifiedRoot = resolveInJail(root, subPath);
  const regex = globToRegex(pattern);
  const matches: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    if (matches.length >= maxResults) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= maxResults) return;

      const fullPath = path.join(currentDir, entry.name);
      const relative = path.relative(verifiedRoot, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (regex.test(relative) || regex.test(entry.name)) {
          matches.push(relative);
        }
      }
    }
  }

  await walk(verifiedRoot);
  return matches.sort();
}

export interface GrepMatch {
  readonly path: string;
  readonly line: number;
  readonly content: string;
}

/**
 * Searches text files within the root jail for lines matching a query.
 */
export async function grepIn(
  root: string,
  query: string,
  subPath: string = '',
  options?: {
    isRegex?: boolean | undefined;
    caseInsensitive?: boolean | undefined;
    maxMatches?: number | undefined;
  },
): Promise<readonly GrepMatch[]> {
  const verifiedRoot = resolveInJail(root, subPath);
  const maxMatches = options?.maxMatches ?? 500;
  const isRegex = options?.isRegex ?? false;
  const caseInsensitive = options?.caseInsensitive ?? false;

  let matcher: (line: string) => boolean;
  if (isRegex) {
    try {
      const flags = caseInsensitive ? 'i' : '';
      const reg = new RegExp(query, flags);
      matcher = (l) => reg.test(l);
    } catch (e) {
      throw new AirError('INVALID_ARGUMENT', `Invalid regular expression for grep: ${(e as Error).message}`);
    }
  } else {
    const target = caseInsensitive ? query.toLowerCase() : query;
    matcher = (l) => {
      const lineStr = caseInsensitive ? l.toLowerCase() : l;
      return lineStr.includes(target);
    };
  }

  const results: GrepMatch[] = [];

  async function walk(currentDir: string): Promise<void> {
    if (results.length >= maxMatches) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxMatches) return;

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        const relative = path.relative(verifiedRoot, fullPath).replace(/\\/g, '/');
        try {
          // Read up to 2MB to prevent memory exhaustion
          const buf = await fs.promises.readFile(fullPath);
          if (buf.length > 2 * 1024 * 1024) continue;

          // Check for binary content (null bytes in first 512 bytes)
          const probeLen = Math.min(buf.length, 512);
          let isBinary = false;
          for (let b = 0; b < probeLen; b++) {
            if (buf[b] === 0) {
              isBinary = true;
              break;
            }
          }
          if (isBinary) continue;

          const text = buf.toString('utf-8');
          const lines = text.split('\n');

          for (let l = 0; l < lines.length; l++) {
            if (results.length >= maxMatches) break;
            const lineContent = lines[l] ?? '';
            if (matcher(lineContent)) {
              results.push({
                path: relative,
                line: l + 1,
                content: lineContent.trimEnd(),
              });
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await walk(verifiedRoot);
  return results;
}

