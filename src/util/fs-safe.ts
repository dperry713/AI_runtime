/**
 * Safe filesystem operations constrained to an allowed root jail (Rule R2).
 * Enforces jail boundaries before all I/O, performs atomic writes, and handles Windows locking retries.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AirError } from '../errors/index.js';
import { assertInside, isInside } from './paths.js';
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

    // Atomic replace with retry for Windows AV/file-lock interference
    await retryOnWindowsLock(async () => {
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
