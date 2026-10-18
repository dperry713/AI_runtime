/**
 * Optional Windows AppContainer Isolation Profile (Phase 7 - P7-T06).
 *
 * Implements AppContainer isolation primitives for sandboxed process execution on Windows:
 * 1. Deterministic AppContainer SID derivation from profile names (S-1-15-2-...).
 * 2. Standard Windows capability identifiers (internetClient, privateNetworkClientServer).
 * 3. Filesystem ACL granting (icacls) for workspace jail access.
 * 4. AppContainer profile lifecycle management (create, delete, list).
 * 5. Environment detection and diagnostic status.
 *
 * Adheres to:
 * - Rule R1: Structured logging via src/observability
 * - Rule R2: Process execution boundaries
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 * - ADR-0007: AppContainer isolation profile findings and decision
 */

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { AirError } from '../errors/index.js';
import { getLogger, type ComponentLogger } from '../observability/index.js';

const defaultLogger = getLogger('appcontainer');

// ============================================================================
// Constants & Capabilities
// ============================================================================

/**
 * Standard Windows AppContainer well-known capability SIDs and names.
 */
export const APPCONTAINER_CAPABILITIES = {
  /** Outbound internet access as client. SID: S-1-15-3-1 */
  INTERNET_CLIENT: 'internetClient',
  /** Inbound and outbound internet access. SID: S-1-15-3-2 */
  INTERNET_CLIENT_SERVER: 'internetClientServer',
  /** Intranet / private network access. SID: S-1-15-3-3 */
  PRIVATE_NETWORK: 'privateNetworkClientServer',
  /** Access to user Documents folder. SID: S-1-15-3-4 */
  DOCUMENTS_LIBRARY: 'documentsLibrary',
  /** Access to user Pictures folder. SID: S-1-15-3-5 */
  PICTURES_LIBRARY: 'picturesLibrary',
} as const;

export type AppContainerCapability =
  (typeof APPCONTAINER_CAPABILITIES)[keyof typeof APPCONTAINER_CAPABILITIES];

export interface AppContainerProfile {
  readonly name: string;
  readonly displayName: string;
  readonly description?: string | undefined;
  readonly sid: string;
  readonly capabilities: readonly AppContainerCapability[];
  readonly createdAt: string;
}

export interface AppContainerOptions {
  readonly name: string;
  readonly displayName?: string | undefined;
  readonly description?: string | undefined;
  readonly capabilities?: readonly AppContainerCapability[] | undefined;
  readonly allowNetwork?: boolean | undefined;
}

export interface AclGrantResult {
  readonly success: boolean;
  readonly sid: string;
  readonly targetPath: string;
  readonly message: string;
}

// ============================================================================
// SID Derivation
// ============================================================================

/**
 * Deterministically derives an AppContainer SID from a profile name.
 * On Windows, AppContainer SIDs use the format:
 * S-1-15-2-subauth0-subauth1-subauth2-subauth3-subauth4-subauth5-subauth6-subauth7
 * where 15 is SECURITY_APP_PACKAGE_AUTHORITY, 2 is SECURITY_APP_PACKAGE_BASE_RID,
 * and the 8 32-bit subauthorities are derived from a cryptographic hash of the name.
 */
export function deriveAppContainerSid(profileName: string): string {
  const normalized = profileName.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new AirError('INVALID_ARGUMENT', 'AppContainer profile name cannot be empty');
  }

  // Compute SHA-256 hash of the normalized profile name (32 bytes = 8 x 4-byte integers)
  const hash = crypto.createHash('sha256').update(normalized, 'utf-8').digest();

  const subAuthorities: number[] = [];
  for (let i = 0; i < 8; i++) {
    // Read 32-bit unsigned little-endian integer for each subauthority
    const subAuth = hash.readUInt32LE(i * 4);
    subAuthorities.push(subAuth);
  }

  return `S-1-15-2-${subAuthorities.join('-')}`;
}

/**
 * Checks whether Windows AppContainer isolation is supported on the current host.
 */
export function isAppContainerSupported(): boolean {
  return process.platform === 'win32';
}

// ============================================================================
// AppContainer Manager
// ============================================================================

export class AppContainerManager {
  private readonly profiles = new Map<string, AppContainerProfile>();
  private readonly logger: ComponentLogger;

  constructor(logger?: ComponentLogger) {
    this.logger = logger ?? defaultLogger;
  }

  /**
   * Creates or registers an AppContainer profile with the requested security attributes.
   */
  createProfile(options: AppContainerOptions): AppContainerProfile {
    const name = options.name.trim();
    if (name.length === 0) {
      throw new AirError('INVALID_ARGUMENT', 'AppContainer profile name cannot be empty');
    }

    const sid = deriveAppContainerSid(name);
    const capabilities: AppContainerCapability[] = [];

    if (options.capabilities) {
      capabilities.push(...options.capabilities);
    } else if (options.allowNetwork) {
      capabilities.push(APPCONTAINER_CAPABILITIES.INTERNET_CLIENT);
    }

    const profile: AppContainerProfile = {
      name,
      displayName: options.displayName ?? name,
      description: options.description,
      sid,
      capabilities,
      createdAt: new Date().toISOString(),
    };

    this.profiles.set(name, profile);
    this.logger.info(
      {
        event: 'sandbox.appcontainer.profile_created',
        name,
        sid,
        capabilities: profile.capabilities,
      },
      `Created AppContainer profile "${name}" with SID ${sid}`,
    );

    return profile;
  }

  /**
   * Retrieves an existing AppContainer profile by name.
   */
  getProfile(name: string): AppContainerProfile | undefined {
    return this.profiles.get(name.trim());
  }

  /**
   * Deletes an AppContainer profile.
   */
  deleteProfile(name: string): boolean {
    const key = name.trim();
    const existing = this.profiles.get(key);
    if (!existing) {
      return false;
    }

    this.profiles.delete(key);
    this.logger.info(
      { event: 'sandbox.appcontainer.profile_deleted', name: key, sid: existing.sid },
      `Deleted AppContainer profile "${key}"`,
    );
    return true;
  }

  /**
   * Returns list of all active AppContainer profiles managed by this instance.
   */
  listProfiles(): readonly AppContainerProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Generates the command-line ICACLS command string required to grant filesystem
   * access to the AppContainer SID for a specified target path.
   */
  generateAclCommand(sid: string, targetPath: string, access: 'read' | 'full' = 'full'): string {
    const rights = access === 'full' ? 'F' : 'RX';
    return `icacls "${targetPath}" /grant "*${sid}:(OI)(CI)${rights}" /T /C /Q`;
  }

  /**
   * Grants filesystem access on Windows to the AppContainer SID for the target folder.
   * Uses icacls utility to apply inherited object/container ACEs.
   */
  async grantAccessToPath(
    sid: string,
    targetPath: string,
    access: 'read' | 'full' = 'full',
  ): Promise<AclGrantResult> {
    if (!isAppContainerSupported()) {
      return {
        success: false,
        sid,
        targetPath,
        message: 'AppContainer ACL granting is only supported on Windows',
      };
    }

    const rights = access === 'full' ? 'F' : 'RX';
    const grantArg = `*${sid}:(OI)(CI)${rights}`;
    const args = [targetPath, '/grant', grantArg, '/T', '/C', '/Q'];

    return new Promise((resolve) => {
      execFile('icacls', args, { timeout: 10_000 }, (err, stdout, stderr) => {
        if (err) {
          resolve({
            success: false,
            sid,
            targetPath,
            message: stderr.trim() || err.message,
          });
        } else {
          resolve({
            success: true,
            sid,
            targetPath,
            message: stdout.trim() || 'Access successfully granted',
          });
        }
      });
    });
  }
}
