/**
 * GUI module entry point (Phase GUI).
 *
 * Public API:
 * - `startGuiServer` — starts the HTTP server bridging the web GUI to the daemon
 * - `GuiServerOptions`, `GuiServerInstance`
 */

export {
  startGuiServer,
  type GuiServerOptions,
  type GuiServerInstance,
} from './server.js';
