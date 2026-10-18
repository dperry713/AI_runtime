import { spawn } from 'node:child_process';

/**
 * Forcibly terminates a process and all of its spawned child processes.
 * On Windows, dispatches `taskkill /pid <pid> /T /F`.
 */
export function killProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Ignore if process already died
    }
  }
}
