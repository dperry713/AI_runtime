/**
 * `aird` entrypoint (Phase 9 - P9-T02).
 *
 * Invokes `Daemon.main()` and exits with the returned code.
 * Intended to be run as `dist/service/main.js` via the `aird` bin entry.
 */

import { main } from './daemon.js';

export { main };

void main().then((code) => {
  process.exitCode = code;
});
