/**
 * Windows NTFS reparse point, junction, symlink, and hardlink defenses (Phase 7 - P7-T03).
 *
 * Implements:
 * - Detection of NTFS directory junctions, mount points, and symbolic links
 * - Chain inspection of all intermediate ancestors from root jail to target
 * - Hardlink multiplicity checking (nlink > 1) to prevent hardlink overwrite attacks
 * - TOCTOU-resistant safe file opening (verify handle after open before use)
 */

import fs from 'node:fs';
import path from 'node:path';
import { AirError } from '../errors/index.js';
import { canonicalize, isInside, normalizeSeparators, validatePathSyntax } from './paths.js';

export type ReparseType = 'symlink' | 'junction' | 'none';

export interface ReparseNode {
  readonly path: string;
  readonly exists: boolean;
  readonly isReparse: boolean;
  readonly type: ReparseType;
  readonly target: string | null;
  readonly targetCanonical: string | null;
  readonly escapesJail: boolean;
  readonly isDirectory: boolean;
}

export interface ReparseInspectionResult {
  readonly safe: boolean;
  readonly rootJail: string;
  readonly targetPath: string;
  readonly canonicalPath: string;
  readonly hasReparsePoints: boolean;
  readonly nodes: readonly ReparseNode[];
  readonly violations: readonly string[];
}

export interface HardlinkInfo {
  readonly path: string;
  readonly nlink: number;
  readonly hasMultipleLinks: boolean;
}

export interface OpenSafelyOptions {
  readonly allowIntraJailSymlinks?: boolean | undefined;
  readonly allowHardlinks?: boolean | undefined;
}

export interface SafeFileHandle {
  readonly handle: fs.promises.FileHandle;
  readonly verifiedPath: string;
  readonly canonicalPath: string;
  readonly nlink: number;
  read(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  readFile(options?: { encoding?: BufferEncoding }): Promise<string | Buffer>;
  write(data: string | Uint8Array, position?: number | null): Promise<void>;
  stat(): Promise<fs.Stats>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

function toFullPath(root: string, relOrAbs: string): string {
  return path.isAbsolute(relOrAbs) ? path.resolve(relOrAbs) : path.resolve(root, relOrAbs);
}

/**
 * Rebase an absolute target onto the canonical jail spelling when an existing
 * ancestor is an equivalent Windows 8.3 short path. Only ancestors up to the
 * jail root are canonicalized; components below the jail remain lexical so
 * junctions and symlinks inside the jail stay visible to the chain inspection.
 */
function rebaseTargetToCanonicalRoot(fullRoot: string, fullTarget: string): string {
  const parsed = path.parse(fullTarget);
  const segments = fullTarget.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;

  for (let consumed = 0; consumed <= segments.length; consumed++) {
    if (consumed > 0) {
      const segment = segments[consumed - 1];
      if (segment !== undefined) current = path.join(current, segment);
    }

    try {
      if (canonicalize(current).toLowerCase() === fullRoot.toLowerCase()) {
        return path.join(fullRoot, ...segments.slice(consumed));
      }
    } catch {
      // Continue walking lexical ancestors until the jail root is found.
    }
  }

  return fullTarget;
}

/**
 * Checks whether a single filesystem entry is an NTFS reparse point (junction or symlink).
 */
export async function isReparsePoint(targetPath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.lstat(targetPath);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Synchronous variant of isReparsePoint.
 */
export function isReparsePointSync(targetPath: string): boolean {
  try {
    const stats = fs.lstatSync(targetPath);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Reads the link target of a reparse point or symlink.
 * Returns null if the path is not a link or cannot be read.
 */
export async function resolveLinkTarget(linkPath: string): Promise<string | null> {
  try {
    return await fs.promises.readlink(linkPath);
  } catch {
    return null;
  }
}

/**
 * Checks hardlink count for an existing file.
 */
export async function checkHardlinks(
  filePath: string,
  maxAllowedLinks: number = 1,
): Promise<HardlinkInfo> {
  try {
    const stats = await fs.promises.stat(filePath);
    return {
      path: filePath,
      nlink: stats.nlink,
      hasMultipleLinks: stats.nlink > maxAllowedLinks,
    };
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      return {
        path: filePath,
        nlink: 0,
        hasMultipleLinks: false,
      };
    }
    throw new AirError('TOOL_EXECUTION_FAILED', `Failed to stat file for hardlinks: "${filePath}"`, {
      cause: err instanceof Error ? err : undefined,
    });
  }
}

/**
 * Inspects all ancestors from root jail down to the target path.
 * Detects any junction or symlink escaping the root jail.
 */
export async function inspectReparseChain(
  rootJail: string,
  targetPath: string,
): Promise<ReparseInspectionResult> {
  validatePathSyntax(rootJail);
  validatePathSyntax(targetPath);

  const fullRoot = canonicalize(rootJail);
  const absoluteTarget = toFullPath(fullRoot, targetPath);
  const fullTarget = rebaseTargetToCanonicalRoot(fullRoot, absoluteTarget);

  // Lexical containment pre-check
  const normalizedTarget = normalizeSeparators(fullTarget);
  const relative = path.relative(fullRoot, normalizedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return {
      safe: false,
      rootJail: fullRoot,
      targetPath: fullTarget,
      canonicalPath: fullTarget,
      hasReparsePoints: false,
      nodes: [],
      violations: [`Target path "${fullTarget}" is lexically outside root jail "${fullRoot}"`],
    };
  }

  const segments = relative.split(/[\\/]/).filter((s) => s.length > 0 && s !== '.');

  const nodes: ReparseNode[] = [];
  const violations: string[] = [];
  let hasReparse = false;

  for (let i = 0; i <= segments.length; i++) {
    const nodePath = i === 0 ? fullRoot : path.join(fullRoot, ...segments.slice(0, i));

    let exists = false;
    let isReparse = false;
    let isDir = false;
    let linkTarget: string | null = null;
    let targetCanon: string | null = null;
    let escapes = false;

    try {
      const stats = await fs.promises.lstat(nodePath);
      exists = true;
      isReparse = stats.isSymbolicLink();

      if (isReparse) {
        hasReparse = true;
        try {
          const targetStat = await fs.promises.stat(nodePath);
          isDir = targetStat.isDirectory();
        } catch {
          isDir = false;
        }

        linkTarget = await resolveLinkTarget(nodePath);
        if (linkTarget) {
          const resolvedTarget = path.isAbsolute(linkTarget)
            ? linkTarget
            : path.resolve(path.dirname(nodePath), linkTarget);
          targetCanon = canonicalize(resolvedTarget);

          if (!isInside(fullRoot, targetCanon)) {
            escapes = true;
            violations.push(
              `Reparse point at "${nodePath}" escapes root jail (points to "${targetCanon}")`,
            );
          }
        }
      } else {
        isDir = stats.isDirectory();
      }
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        exists = false;
      } else {
        // Unexpected access error
        violations.push(`Failed to lstat path component "${nodePath}": ${nodeErr.message}`);
      }
    }

    nodes.push({
      path: nodePath,
      exists,
      isReparse,
      type: isReparse ? (isDir ? 'junction' : 'symlink') : 'none',
      target: linkTarget,
      targetCanonical: targetCanon,
      escapesJail: escapes,
      isDirectory: isDir,
    });

    if (escapes) {
      break;
    }
  }

  if (violations.length === 0) {
    const finalCanon = canonicalize(fullTarget);
    if (!isInside(fullRoot, finalCanon)) {
      violations.push(`Target path "${fullTarget}" escapes root jail (resolves to "${finalCanon}")`);
    }
  }

  const safe = violations.length === 0;
  const canonical = safe ? canonicalize(fullTarget) : fullTarget;

  return {
    safe,
    rootJail: fullRoot,
    targetPath: fullTarget,
    canonicalPath: canonical,
    hasReparsePoints: hasReparse,
    nodes,
    violations,
  };
}

/**
 * Asserts that target path does not escape the jail through reparse points or symlinks.
 * Throws AirError('PATH_ESCAPE') or AirError('SECURITY_VIOLATION') on any violation.
 */
export async function assertNoReparseEscape(
  rootJail: string,
  targetPath: string,
  options?: { readonly allowIntraJailSymlinks?: boolean | undefined },
): Promise<string> {
  const result = await inspectReparseChain(rootJail, targetPath);

  if (!result.safe) {
    throw new AirError(
      'PATH_ESCAPE',
      `Reparse point defense rejected path "${targetPath}": ${result.violations.join('; ')}`,
      { context: { rootJail, targetPath, violations: result.violations } },
    );
  }

  if (result.hasReparsePoints && !options?.allowIntraJailSymlinks) {
    // If strict no-symlink policy is enforced
    throw new AirError(
      'SECURITY_VIOLATION',
      `Reparse points or symlinks are disallowed by policy for path "${targetPath}"`,
      { context: { rootJail, targetPath } },
    );
  }

  return result.canonicalPath;
}

/**
 * Opens a file with TOCTOU resistance.
 * 1. Checks path ancestors for reparse escapes before open.
 * 2. Opens the file handle.
 * 3. Interrogates open file handle (stat, hardlinks, realpath).
 * 4. Verifies the open handle still points strictly inside the root jail.
 * 5. Cleans up and throws immediately if a TOCTOU race or hardlink escape is detected.
 */
export async function openSafelyInJail(
  rootJail: string,
  targetPath: string,
  flags: string | number = 'r',
  mode?: number,
  options?: OpenSafelyOptions,
): Promise<SafeFileHandle> {
  // 1. Initial inspection
  const verifiedPath = await assertNoReparseEscape(rootJail, targetPath, {
    allowIntraJailSymlinks: options?.allowIntraJailSymlinks ?? true,
  });

  // 2. Open handle
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(verifiedPath, flags, mode);
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      throw new AirError('NOT_FOUND', `File not found: "${targetPath}"`, {
        cause: nodeErr,
        context: { rootJail, targetPath },
      });
    }
    if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
      throw new AirError('PERMISSION_DENIED', `Permission denied opening: "${targetPath}"`, {
        cause: nodeErr,
        context: { rootJail, targetPath },
      });
    }
    throw new AirError('TOOL_EXECUTION_FAILED', `Failed to open file: "${targetPath}"`, {
      cause: nodeErr,
      context: { rootJail, targetPath },
    });
  }

  // 3. Handle-based verification (TOCTOU defense)
  let stat: fs.Stats;
  try {
    stat = await handle.stat();

    // Check hardlink multiplicity if not explicitly permitted
    if (!options?.allowHardlinks && stat.nlink > 1) {
      await handle.close();
      throw new AirError(
        'SECURITY_VIOLATION',
        `Hardlink attack detected on "${targetPath}": file has multiple hardlinks (nlink = ${stat.nlink})`,
        { context: { rootJail, targetPath, nlink: stat.nlink } },
      );
    }

    // Check that path hasn't morphed into an escape after opening
    const currentCanonical = canonicalize(verifiedPath);
    if (!isInside(rootJail, currentCanonical)) {
      await handle.close();
      throw new AirError(
        'SECURITY_VIOLATION',
        `TOCTOU race detected: file path "${targetPath}" escaped jail during open`,
        { context: { rootJail, targetPath, currentCanonical } },
      );
    }
  } catch (err) {
    try {
      await handle.close();
    } catch {
      // Ignore secondary close error
    }
    throw err;
  }

  // 4. Return safe wrapper with disposal support
  return {
    handle,
    verifiedPath,
    canonicalPath: verifiedPath,
    nlink: stat.nlink,
    read: async (buffer, offset, length, position) => {
      const res = await handle.read(buffer, offset, length, position);
      return { bytesRead: res.bytesRead, buffer: res.buffer };
    },
    readFile: async (readOptions) => {
      if (readOptions) {
        return handle.readFile(readOptions);
      }
      return handle.readFile();
    },
    write: async (data, position) => {
      if (position !== undefined && position !== null) {
        const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
        await handle.write(buf, 0, buf.length, position);
      } else {
        await handle.writeFile(data, { encoding: typeof data === 'string' ? 'utf-8' : undefined });
      }
    },
    stat: async () => {
      return handle.stat();
    },
    close: async () => {
      await handle.close();
    },
    [Symbol.asyncDispose]: async () => {
      await handle.close();
    },
  };
}
