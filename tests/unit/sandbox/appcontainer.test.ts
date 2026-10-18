
/**
 * Unit tests for Windows AppContainer Isolation Profile (Phase 7 - P7-T06).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AppContainerManager,
  deriveAppContainerSid,
  isAppContainerSupported,
  APPCONTAINER_CAPABILITIES,
} from '../../../src/sandbox/appcontainer.js';

describe('Windows AppContainer Isolation Profile (P7-T06)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-appcontainer-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe('SID Derivation', () => {
    it('derives a valid Windows AppContainer SID format', () => {
      const sid = deriveAppContainerSid('air-test-sandbox');
      expect(sid).toMatch(/^S-1-15-2(-\d+){8}$/);
    });

    it('is strictly deterministic for identical names', () => {
      const sid1 = deriveAppContainerSid('air-profile-1');
      const sid2 = deriveAppContainerSid('air-profile-1');
      expect(sid1).toBe(sid2);
    });

    it('is case-insensitive', () => {
      const sidLower = deriveAppContainerSid('myprofile');
      const sidUpper = deriveAppContainerSid('MYPROFILE');
      const sidMixed = deriveAppContainerSid('MyProfile');
      expect(sidLower).toBe(sidUpper);
      expect(sidLower).toBe(sidMixed);
    });

    it('generates different SIDs for different profile names', () => {
      const sid1 = deriveAppContainerSid('profile-a');
      const sid2 = deriveAppContainerSid('profile-b');
      expect(sid1).not.toBe(sid2);
    });

    it('rejects empty profile names', () => {
      expect(() => deriveAppContainerSid('')).toThrow('cannot be empty');
      expect(() => deriveAppContainerSid('   ')).toThrow('cannot be empty');
    });
  });

  describe('Platform Detection', () => {
    it('detects platform capability correctly', () => {
      const supported = isAppContainerSupported();
      expect(supported).toBe(process.platform === 'win32');
    });
  });

  describe('AppContainerManager Profile Lifecycle', () => {
    it('creates and retrieves a profile with custom capabilities', () => {
      const manager = new AppContainerManager();
      const profile = manager.createProfile({
        name: 'test-agent',
        displayName: 'Test Agent Profile',
        description: 'Profile for sandbox testing',
        capabilities: [
          APPCONTAINER_CAPABILITIES.DOCUMENTS_LIBRARY,
          APPCONTAINER_CAPABILITIES.PRIVATE_NETWORK,
        ],
      });

      expect(profile.name).toBe('test-agent');
      expect(profile.displayName).toBe('Test Agent Profile');
      expect(profile.description).toBe('Profile for sandbox testing');
      expect(profile.sid).toMatch(/^S-1-15-2(-\d+){8}$/);
      expect(profile.capabilities).toEqual([
        APPCONTAINER_CAPABILITIES.DOCUMENTS_LIBRARY,
        APPCONTAINER_CAPABILITIES.PRIVATE_NETWORK,
      ]);
      expect(profile.createdAt).toBeDefined();

      const retrieved = manager.getProfile('test-agent');
      expect(retrieved).toEqual(profile);
    });

    it('automatically adds INTERNET_CLIENT capability when allowNetwork is true', () => {
      const manager = new AppContainerManager();
      const profile = manager.createProfile({
        name: 'network-agent',
        allowNetwork: true,
      });

      expect(profile.capabilities).toContain(APPCONTAINER_CAPABILITIES.INTERNET_CLIENT);
    });

    it('lists and deletes profiles', () => {
      const manager = new AppContainerManager();
      manager.createProfile({ name: 'prof1' });
      manager.createProfile({ name: 'prof2' });

      const listBefore = manager.listProfiles();
      expect(listBefore).toHaveLength(2);
      expect(listBefore.map((p) => p.name)).toEqual(['prof1', 'prof2']);

      const deleted = manager.deleteProfile('prof1');
      expect(deleted).toBe(true);

      const listAfter = manager.listProfiles();
      expect(listAfter).toHaveLength(1);
      expect(listAfter[0]?.name).toBe('prof2');

      const deleteAgain = manager.deleteProfile('prof1');
      expect(deleteAgain).toBe(false);
    });

    it('rejects creating profile with empty name', () => {
      const manager = new AppContainerManager();
      expect(() => manager.createProfile({ name: '   ' })).toThrow('cannot be empty');
    });
  });

  describe('ACL Command Generation & Execution', () => {
    it('generates correct icacls syntax for full and read permissions', () => {
      const manager = new AppContainerManager();
      const sid = 'S-1-15-2-123-456';
      const target = 'C:\\dev\\workspace';

      const fullCmd = manager.generateAclCommand(sid, target, 'full');
      expect(fullCmd).toBe('icacls "C:\\dev\\workspace" /grant "*S-1-15-2-123-456:(OI)(CI)F" /T /C /Q');

      const readCmd = manager.generateAclCommand(sid, target, 'read');
      expect(readCmd).toBe('icacls "C:\\dev\\workspace" /grant "*S-1-15-2-123-456:(OI)(CI)RX" /T /C /Q');
    });

    it('safely attempts to grant access via icacls without throwing', async () => {
      const manager = new AppContainerManager();
      const sid = deriveAppContainerSid('air-test-acl');

      const result = await manager.grantAccessToPath(sid, tempDir, 'full');
      expect(typeof result.success).toBe('boolean');
      expect(result.sid).toBe(sid);
      expect(result.targetPath).toBe(tempDir);
      expect(typeof result.message).toBe('string');
    });
  });
});
