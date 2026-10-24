/**
 * Unit tests for AppContainerRunner (Phase W2 - AppContainer default sandbox).
 *
 * Tests the TypeScript AppContainer client using a mock handler, avoiding
 * the need to spawn air-sandbox.exe or PowerShell.
 */

import { describe, expect, it, vi } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  AppContainerRunner,
  type AppContainerLaunchOptions,
  type AppContainerProfile,
} from '../../../src/sandbox/appcontainer-runner.js';

function makeMockHandler(responses: Record<string, unknown>[]) {
  let index = 0;
  return async (_request: Record<string, unknown>): Promise<Record<string, unknown>> => {
    void _request;
    const response = responses[index] as Record<string, unknown>;
    index += 1;
    return Promise.resolve(response);
  };
}

describe('AppContainerRunner', () => {
  it('createProfile sends ac_create_profile and returns profile', async () => {
    const runner = new AppContainerRunner({
      mockHandler: makeMockHandler([
        {
          type: 'ac_profile_created',
          version: 1,
          profile: {
            name: 'AIR-AC-test-profile',
            sid: 'S-1-15-2-1234567890-1234567890-1234567890-1234567890',
            capabilities: ['internetClient'],
          },
        },
      ]),
    });

    const result = await runner.createProfile({
      name: 'test-profile',
      displayName: 'Test Profile',
      capabilities: ['internetClient'],
    });

    expect(result.name).toBe('AIR-AC-test-profile');
    expect(result.sid).toBe('S-1-15-2-1234567890-1234567890-1234567890-1234567890');
    expect(result.capabilities).toContain('internetClient');
  });

  it('createProfile throws AirError on error response', async () => {
    const runner = new AppContainerRunner({
      mockHandler: makeMockHandler([
        {
          type: 'error',
          version: 1,
          code: 'AC_CREATE_FAILED',
          message: 'New-AppContainerProfile failed: Access is denied.',
        },
      ]),
    });

    await expect(
      runner.createProfile({ name: 'test-profile' }),
    ).rejects.toThrow(AirError);
  });

  it('deleteProfile sends ac_delete_profile and returns success', async () => {
    const runner = new AppContainerRunner({
      mockHandler: makeMockHandler([
        {
          type: 'ac_profile_deleted',
          version: 1,
          name: 'AIR-AC-test-profile',
          success: true,
        },
      ]),
    });

    const result = await runner.deleteProfile('test-profile');
    expect(result).toBe(true);
  });

  it('grantAccessToPath sends ac_grant_access and returns result', async () => {
    const runner = new AppContainerRunner({
      mockHandler: makeMockHandler([
        {
          type: 'ac_access_granted',
          version: 1,
          result: {
            sid: 'S-1-15-2-1234567890',
            targetPath: 'C:\\workspace',
            success: true,
            message: 'Access successfully granted',
          },
        },
      ]),
    });

    const result = await runner.grantAccessToPath(
      'S-1-15-2-1234567890',
      'C:\\workspace',
      'full',
    );

    expect(result.success).toBe(true);
    expect(result.message).toBe('Access successfully granted');
  });

  it('deleteProfile throws on error response', async () => {
    const runner = new AppContainerRunner({
      mockHandler: makeMockHandler([
        { type: 'error', version: 1, message: 'Delete failed' },
      ]),
    });
    await expect(runner.deleteProfile('test')).rejects.toThrow(AirError);
  });

  it('grantAccessToPath throws on error response', async () => {
    const runner = new AppContainerRunner({
      mockHandler: makeMockHandler([
        { type: 'error', version: 1, message: 'ACL failed' },
      ]),
    });
    await expect(runner.grantAccessToPath('S-1-15-2-123', 'C:\\jail')).rejects.toThrow(AirError);
  });

  it('createProfile throws on unexpected response type', async () => {
    const runner = new AppContainerRunner({
      mockHandler: makeMockHandler([
        { type: 'ac_profile_deleted', version: 1, success: true },
      ]),
    });
    await expect(runner.createProfile({ name: 'test' })).rejects.toThrow(AirError);
  });

  it('run falls back to StandardProcessRunner when AppContainer unavailable', async () => {
    const fallbackRun = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: 'output',
      stderr: '',
      durationMs: 100,
      timedOut: false,
      killed: false,
      pid: 1234,
    });

    const runner = new AppContainerRunner({
      fallbackRunner: {
        run: fallbackRun,
        getActiveProcesses: () => [],
        killAll: async () => {},
      },
    });

    const options: AppContainerLaunchOptions = {
      command: 'echo hello',
      appContainer: false,
    };

    const result = await runner.run(options);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('output');
    expect(fallbackRun).toHaveBeenCalledTimes(1);
  });

  it('listProfiles returns empty array initially, and tracks active processes', async () => {
    const runner = new AppContainerRunner();
    const profiles: readonly AppContainerProfile[] = runner.listProfiles();
    expect(profiles).toEqual([]);
    expect(runner.getActiveProcesses()).toEqual([]);
    await expect(runner.killAll()).resolves.not.toThrow();
  });
});
