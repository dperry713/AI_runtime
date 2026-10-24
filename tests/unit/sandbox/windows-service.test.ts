/**
 * Unit tests for WindowsService (Phase W5 - Packaging & Windows Service).
 */

import { describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  AIR_SERVICE_NAME,
  AIR_SERVICE_DISPLAY_NAME,
  WindowsService,
  installAirService,
  uninstallAirService,
  startAirService,
  stopAirService,
  queryAirService,
} from '../../../src/sandbox/windows-service.js';

describe('WindowsService', () => {
  it('uses default options when none provided', () => {
    const service = new WindowsService();
    expect(service).toBeDefined();
    expect(AIR_SERVICE_NAME).toBe('aird');
    expect(AIR_SERVICE_DISPLAY_NAME).toContain('AIR');
  });

  describe('serviceExists & query', () => {
    it('returns false when service does not exist (1060 error)', async () => {
      const service = new WindowsService({
        scRunner: (args) => {
          if (args[0] === 'query') {
            return Promise.resolve({ success: false, message: '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:' });
          }
          return Promise.resolve({ success: true, message: '' });
        },
      });

      const status = await service.status();
      expect(status).toBeNull();
    });

    it('parses running service status correctly', async () => {
      const queryOutput = `
SERVICE_NAME: aird
DISPLAY_NAME: AIR Runtime Daemon
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)
        SERVICE_EXIT_CODE  : 0  (0x0)
        CHECKPOINT         : 0x0
        WAIT_HINT          : 0x0
        PID                : 1234
        FLAGS              : 0
`;
      const service = new WindowsService({
        scRunner: (args) => {
          if (args[0] === 'query') {
            return Promise.resolve({ success: true, message: queryOutput });
          }
          return Promise.resolve({ success: true, message: '' });
        },
      });

      const status = await service.status();
      expect(status).not.toBeNull();
      expect(status?.name).toBe('aird');
      expect(status?.displayName).toBe('AIR Runtime Daemon');
      expect(status?.status).toBe('running');
      expect(status?.pid).toBe(1234);
    });

    it('parses pending and paused states', async () => {
      const makeOutput = (stateStr: string) => `
SERVICE_NAME: aird
DISPLAY_NAME: AIR Daemon
        STATE              : 2  ${stateStr}
        ACCEPTS            : STOP SHUTDOWN
        CHECKPOINT         : 1
        WAIT_HINT          : 5000
        FLAGS              : 2
`;
      const states = ['START_PENDING', 'STOP_PENDING', 'CONTINUE_PENDING', 'PAUSE_PENDING', 'PAUSED', 'UNKNOWN_XYZ'];
      for (const st of states) {
        const service = new WindowsService({
          scRunner: () => Promise.resolve({ success: true, message: makeOutput(st) }),
        });
        const status = await service.status();
        expect(status).not.toBeNull();
      }
    });

    it('handles query output with empty ACCEPTS and missing PID', async () => {
      const queryOutput = `
SERVICE_NAME: aird
        STATE              : 1  STOPPED
        ACCEPTS            :   
`;
      const service = new WindowsService({
        scRunner: () => Promise.resolve({ success: true, message: queryOutput }),
      });
      const status = await service.status();
      expect(status?.status).toBe('stopped');
      expect(status?.acceptedControls).toEqual([]);
      expect(status?.pid).toBe(0);
    });
  });

  describe('install', () => {
    it('installs service successfully when it does not exist', async () => {
      const scCalls: string[][] = [];
      const service = new WindowsService({
        serviceName: 'air-test',
        exePath: 'C:\\bin\\aird.exe',
        scRunner: (args) => {
          scCalls.push([...args]);
          if (args[0] === 'query') {
            return Promise.resolve({ success: false, message: 'FAILED 1060:' });
          }
          return Promise.resolve({ success: true, message: 'SUCCESS' });
        },
      });

      await service.install();

      expect(scCalls.some((c) => c[0] === 'create' && c[1] === 'air-test')).toBe(true);
      expect(scCalls.some((c) => c[0] === 'failure' && c[1] === 'air-test')).toBe(true);
    });

    it('throws ALREADY_EXISTS when service is already installed', async () => {
      const service = new WindowsService({
        scRunner: (args) => {
          if (args[0] === 'query') {
            return Promise.resolve({ success: true, message: 'SERVICE_NAME: aird\nSTATE: 4 RUNNING' });
          }
          return Promise.resolve({ success: true, message: '' });
        },
      });

      await expect(service.install()).rejects.toThrow(AirError);
    });

    it('throws INTERNAL error if sc create fails', async () => {
      const service = new WindowsService({
        scRunner: (args) => {
          if (args[0] === 'query') {
            return Promise.resolve({ success: false, message: 'FAILED 1060:' });
          }
          if (args[0] === 'create') {
            return Promise.resolve({ success: false, message: 'Access is denied' });
          }
          return Promise.resolve({ success: true, message: '' });
        },
      });

      await expect(service.install()).rejects.toThrow(/Failed to create service/);
    });
  });

  describe('uninstall', () => {
    it('uninstalls service successfully', async () => {
      const scCalls: string[][] = [];
      const service = new WindowsService({
        scRunner: (args) => {
          scCalls.push([...args]);
          if (args[0] === 'query') {
            return Promise.resolve({ success: true, message: 'STATE: 4 RUNNING' });
          }
          return Promise.resolve({ success: true, message: 'SUCCESS' });
        },
      });

      await service.uninstall();
      expect(scCalls.some((c) => c[0] === 'delete')).toBe(true);
    });

    it('throws NOT_FOUND when service does not exist', async () => {
      const service = new WindowsService({
        scRunner: () => Promise.resolve({ success: false, message: 'FAILED 1060:' }),
      });

      await expect(service.uninstall()).rejects.toThrow(AirError);
    });

    it('throws INTERNAL if sc delete fails', async () => {
      const service = new WindowsService({
        scRunner: (args) => {
          if (args[0] === 'query') {
            return Promise.resolve({ success: true, message: 'STATE: 4 RUNNING' });
          }
          if (args[0] === 'delete') {
            return Promise.resolve({ success: false, message: 'Failed to delete' });
          }
          return Promise.resolve({ success: true, message: '' });
        },
      });

      await expect(service.uninstall()).rejects.toThrow(/Failed to delete service/);
    });
  });

  describe('start & stop', () => {
    it('starts service successfully', async () => {
      const service = new WindowsService({
        scRunner: (args) => {
          if (args[0] === 'query') {
            return Promise.resolve({ success: true, message: 'STATE: 1 STOPPED' });
          }
          if (args[0] === 'start') {
            return Promise.resolve({ success: true, message: 'START_PENDING' });
          }
          return Promise.resolve({ success: true, message: '' });
        },
      });

      await expect(service.start()).resolves.not.toThrow();
    });

    it('ignores 1056 already running on start', async () => {
      const service = new WindowsService({
        scRunner: (args) => {
          if (args[0] === 'query') {
            return Promise.resolve({ success: true, message: 'STATE: 4 RUNNING' });
          }
          if (args[0] === 'start') {
            return Promise.resolve({ success: false, message: 'An instance of the service is already running. (1056)' });
          }
          return Promise.resolve({ success: true, message: '' });
        },
      });

      await expect(service.start()).resolves.not.toThrow();
    });

    it('throws on start failure if not already running', async () => {
      const service = new WindowsService({
        scRunner: (args) => {
          if (args[0] === 'query') {
            return Promise.resolve({ success: true, message: 'STATE: 1 STOPPED' });
          }
          if (args[0] === 'start') {
            return Promise.resolve({ success: false, message: 'Service failed to respond' });
          }
          return Promise.resolve({ success: true, message: '' });
        },
      });

      await expect(service.start()).rejects.toThrow(/Failed to start service/);
    });

    it('stops service successfully', async () => {
      const service = new WindowsService({
        scRunner: (args) => {
          if (args[0] === 'query') {
            return Promise.resolve({ success: true, message: 'STATE: 4 RUNNING' });
          }
          if (args[0] === 'stop') {
            return Promise.resolve({ success: true, message: 'STOP_PENDING' });
          }
          return Promise.resolve({ success: true, message: '' });
        },
      });

      await expect(service.stop()).resolves.not.toThrow();
    });

    it('ignores 1062 not started on stop', async () => {
      const service = new WindowsService({
        scRunner: (args) => {
          if (args[0] === 'query') {
            return Promise.resolve({ success: true, message: 'STATE: 1 STOPPED' });
          }
          if (args[0] === 'stop') {
            return Promise.resolve({ success: false, message: 'The service has not been started. (1062)' });
          }
          return Promise.resolve({ success: true, message: '' });
        },
      });

      await expect(service.stop()).resolves.not.toThrow();
    });
  });

  describe('convenience exports', () => {
    it('calls convenience functions without throwing when mocked', async () => {
      let isInstalled = false;
      const scRunner = (args: readonly string[]) => {
        if (args[0] === 'query') {
          if (!isInstalled) {
            return Promise.resolve({ success: false, message: 'FAILED 1060:' });
          }
          return Promise.resolve({ success: true, message: 'SERVICE_NAME: aird\nSTATE: 4 RUNNING' });
        }
        if (args[0] === 'create') {
          isInstalled = true;
          return Promise.resolve({ success: true, message: 'SUCCESS' });
        }
        if (args[0] === 'delete') {
          isInstalled = false;
          return Promise.resolve({ success: true, message: 'SUCCESS' });
        }
        return Promise.resolve({ success: true, message: 'SUCCESS' });
      };

      await expect(installAirService({ scRunner })).resolves.not.toThrow();
      await expect(startAirService({ scRunner })).resolves.not.toThrow();
      await expect(stopAirService({ scRunner })).resolves.not.toThrow();
      const status = await queryAirService({ scRunner });
      expect(status?.status).toBe('running');
      await expect(uninstallAirService({ scRunner })).resolves.not.toThrow();
    });
  });
});
