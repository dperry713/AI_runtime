/**
 * Sandbox Reparse-Point Defense Manager (Phase 7 - P7-T03).
 *
 * Enforces security invariant S4 (Filesystem tools can never read/write outside
 * granted roots, including via links, ADS, short names, or junctions).
 *
 * Defends against:
 * - Directory junctions (IO_REPARSE_TAG_MOUNT_POINT) pointing outside the jail
 * - Intermediate ancestral junctions along deep nested paths
 * - Hardlink overwrite attacks (nlink > 1)
 * - TOCTOU (Time-Of-Check to Time-Of-Use) file swap races
 * - Working directory escapes for spawned sandboxed processes
 */

import { AirError } from '../errors/index.js';
import type {
  HardlinkInfo,
  OpenSafelyOptions,
  ReparseInspectionResult,
  ReparseNode,
  ReparseType,
  SafeFileHandle,
} from '../util/index.js';
import {
  assertNoReparseEscape,
  checkHardlinks,
  inspectReparseChain,
  isReparsePoint,
  isReparsePointSync,
  openSafelyInJail,
  resolveLinkTarget,
} from '../util/index.js';

export interface ReparseDefenseOptions extends OpenSafelyOptions {
  /**
   * If true, even symlinks whose targets remain within the jail are disallowed.
   * Default: false (intra-jail symlinks permitted unless disallowed by strict profile).
   */
  readonly disallowAllSymlinks?: boolean | undefined;

  /**
   * If true, directory junctions (mklink /J) are disallowed even if inside the jail.
   * Default: false.
   */
  readonly disallowJunctions?: boolean | undefined;
}

export class ReparseDefense {
  /**
   * Inspects a path for reparse points and verifies jail containment along the ancestor chain.
   */
  public async inspect(
    rootJail: string,
    targetPath: string,
  ): Promise<ReparseInspectionResult> {
    return inspectReparseChain(rootJail, targetPath);
  }

  /**
   * Asserts that a target path is safe to access within the given root jail.
   * Throws AirError('PATH_ESCAPE') or AirError('SECURITY_VIOLATION') on any violation.
   */
  public async assertSafe(
    rootJail: string,
    targetPath: string,
    options?: ReparseDefenseOptions,
  ): Promise<string> {
    const result = await this.inspect(rootJail, targetPath);

    if (!result.safe) {
      throw new AirError(
        'PATH_ESCAPE',
        `Reparse point defense rejected path "${targetPath}": ${result.violations.join('; ')}`,
        { context: { rootJail, targetPath, violations: result.violations } },
      );
    }

    if (result.hasReparsePoints) {
      if (options?.disallowAllSymlinks) {
        throw new AirError(
          'SECURITY_VIOLATION',
          `Symbolic links are disallowed by policy for path "${targetPath}"`,
          { context: { rootJail, targetPath } },
        );
      }

      if (options?.disallowJunctions) {
        const hasJunction = result.nodes.some((n) => n.type === 'junction');
        if (hasJunction) {
          throw new AirError(
            'SECURITY_VIOLATION',
            `Directory junctions are disallowed by policy for path "${targetPath}"`,
            { context: { rootJail, targetPath } },
          );
        }
      }
    }

    return result.canonicalPath;
  }

  /**
   * Verifies that a process working directory (cwd) is strictly contained in the workspace
   * and does not escape through intermediate junctions or symlinks.
   */
  public async verifyWorkingDirectory(workspaceRoot: string, cwd: string): Promise<string> {
    return this.assertSafe(workspaceRoot, cwd, {
      disallowAllSymlinks: false,
      disallowJunctions: false,
    });
  }

  /**
   * Checks whether a single path is an NTFS junction or symlink.
   */
  public async isReparse(targetPath: string): Promise<boolean> {
    return isReparsePoint(targetPath);
  }

  /**
   * Checks hardlink multiplicity for a file.
   */
  public async checkHardlinkCount(
    filePath: string,
    maxAllowedLinks: number = 1,
  ): Promise<HardlinkInfo> {
    return checkHardlinks(filePath, maxAllowedLinks);
  }

  /**
   * Opens a file descriptor with TOCTOU-resistance and handle verification.
   */
  public async openSafe(
    rootJail: string,
    targetPath: string,
    flags: string | number = 'r',
    mode?: number,
    options?: ReparseDefenseOptions,
  ): Promise<SafeFileHandle> {
    return openSafelyInJail(rootJail, targetPath, flags, mode, {
      allowIntraJailSymlinks: !options?.disallowAllSymlinks,
      allowHardlinks: options?.allowHardlinks ?? false,
    });
  }
}

export {
  type ReparseType,
  type ReparseNode,
  type ReparseInspectionResult,
  type HardlinkInfo,
  type SafeFileHandle,
  isReparsePoint,
  isReparsePointSync,
  resolveLinkTarget,
  checkHardlinks,
  inspectReparseChain,
  assertNoReparseEscape,
  openSafelyInJail,
};
