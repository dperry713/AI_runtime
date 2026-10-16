import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalize } from '../util/index.js';

/**
 * Resolves the AIR runtime home directory.
 *
 * Precedence:
 * 1. env.AIR_HOME (if explicitly provided and non-empty)
 * 2. %LOCALAPPDATA%\AIR (Windows standard per Rule R10 to avoid OneDrive locking)
 * 3. Fallback: ~/.air (USERPROFILE / HOME / os.homedir())
 */
export function resolveAirHome(env?: Record<string, string | undefined>): string {
  const envSource = env ?? process.env;

  const explicit = envSource['AIR_HOME']?.trim();
  if (explicit && explicit.length > 0) {
    return canonicalize(explicit);
  }

  const localAppData = envSource['LOCALAPPDATA']?.trim();
  if (localAppData && localAppData.length > 0) {
    return canonicalize(path.join(localAppData, 'AIR'));
  }

  const userProfile = envSource['USERPROFILE']?.trim();
  const home = envSource['HOME']?.trim();
  const baseHome = userProfile || home || os.homedir();

  return canonicalize(path.join(baseHome, '.air'));
}
