/**
 * Service module entry point (Phase 9 - P9-T02).
 *
 * Public API:
 * - `Daemon` — daemon host with boot, recovery, IPC bind, graceful shutdown
 * - `main` — `aird` process entrypoint
 *
 * Layer 8 per ARCHITECTURE.md §3: may import layers 0–7 only through their index.ts.
 */

export { Daemon, type DaemonOptions, type DaemonState, type DaemonStatus } from './daemon.js';
export { main } from './main.js';
