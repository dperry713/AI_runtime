/**
 * AIR Control Center GUI Server (Phase GUI - R-GUI-002).
 *
 * Provides a lightweight local HTTP server binding `127.0.0.1:4100` that bridges
 * web browser client requests to the running AIR daemon over the Windows named pipe
 * using `AirClient`.
 *
 * Adheres to:
 * - Rule R1: No console.log in src/ (uses getLogger from observability)
 * - Rule R2: Safe filesystem reads through src/util/index.js
 * - Rule R4: Never expose raw secrets in config endpoints
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 */

import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AirClient } from '../client/index.js';
import { resolveAirHome } from '../config/index.js';
import { AirError } from '../errors/index.js';
import { getLogger } from '../observability/index.js';
import { readFileIn, existsIn } from '../util/index.js';

const logger = getLogger('air-gui');

export interface GuiServerOptions {
  readonly port?: number | undefined;
  readonly pipeName?: string | undefined;
  readonly home?: string | undefined;
}

export interface GuiServerInstance {
  readonly port: number;
  readonly url: string;
  close: () => Promise<void>;
}

const BUILTIN_AGENTS = [
  {
    id: 'developer',
    name: 'Standard Developer Agent',
    description: 'Full workspace read and safe edits governed by the project-write policy.',
    policyProfile: 'project-write',
  },
  {
    id: 'reviewer',
    name: 'Code Reviewer Agent',
    description: 'Read-only inspection and critique governed by the readonly policy.',
    policyProfile: 'readonly',
  },
  {
    id: 'dev-shell',
    name: 'Full Toolchain Agent',
    description: 'Autonomous execution of build, test, and git commands in the sandbox.',
    policyProfile: 'dev-shell',
  },
  {
    id: 'auditor',
    name: 'Zero-Trust Auditor',
    description: 'Strict minimal-privilege inspection under the locked-down policy.',
    policyProfile: 'locked-down',
  },
];

/**
 * Reads a JSON request body from an IncomingMessage stream.
 */
async function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw || raw.trim().length === 0) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        const cause = err instanceof Error ? err : new Error(String(err));
        reject(new AirError('IPC_PROTOCOL_ERROR', 'Invalid JSON payload received in GUI request', { cause }));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

/**
 * Sends a JSON HTTP response.
 */
function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

/**
 * Sends an error HTTP response mapped from an AirError or Error.
 */
function sendError(res: http.ServerResponse, err: unknown): void {
  const airErr = err instanceof AirError ? err : new AirError('INTERNAL', String(err));
  sendJson(res, 500, {
    error: {
      code: airErr.code,
      message: airErr.message,
    },
  });
}

async function resolvePublicDir(currentDir: string): Promise<string> {
  const candidates = [
    path.resolve(currentDir, 'public'),
    path.resolve(currentDir, '../../src/gui/public'),
    path.resolve(process.cwd(), 'src/gui/public'),
    path.resolve(process.cwd(), 'dist/gui/public'),
  ];
  for (const dir of candidates) {
    try {
      if (await existsIn(dir, 'index.html')) {
        return dir;
      }
    } catch {
      // Continue to next candidate
    }
  }
  return candidates[0] ?? path.resolve(currentDir, 'public');
}

/**
 * Starts the local AIR GUI Server.
 */
export async function startGuiServer(options: GuiServerOptions = {}): Promise<GuiServerInstance> {
  const port = options.port ?? 4100;
  const client = new AirClient({ pipeName: options.pipeName });
  const home = options.home ?? resolveAirHome();

  // Determine static asset directory relative to current file
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = await resolvePublicDir(currentDir);

  let clientConnected = false;
  try {
    await client.connect();
    clientConnected = true;
    logger.info({ event: 'gui.client.connected' }, 'GUI client connected to AIR daemon');
  } catch (err) {
    const errorObj = err instanceof Error ? err : new Error(String(err));
    logger.warn({ event: 'gui.client.connect_deferred', err: errorObj }, 'AIR daemon not currently reachable; GUI will start in offline mode');
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const pathname = url.pathname;

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    try {
      // API Routes
      if (pathname === '/api/health' && req.method === 'GET') {
        if (!clientConnected) {
          try {
            await client.connect();
            clientConnected = true;
          } catch {
            sendJson(res, 200, { status: 'daemon_offline', message: 'Daemon is not currently running.' });
            return;
          }
        }
        const health = await client.health();
        sendJson(res, 200, health);
        return;
      }

      if (pathname === '/api/agents' && req.method === 'GET') {
        sendJson(res, 200, { agents: BUILTIN_AGENTS });
        return;
      }

      if (pathname === '/api/sessions' && req.method === 'GET') {
        const result = await client.listSessions();
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/sessions' && req.method === 'POST') {
        const body = await parseJsonBody<{ agentId?: string }>(req);
        const result = await client.createSession({ agentId: body.agentId ?? 'developer' });
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/runs' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        const result = await client.listRuns(sessionId ? { sessionId } : {});
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/runs/start' && req.method === 'POST') {
        const body = await parseJsonBody<{ sessionId: string; agentId: string; goal: string }>(req);
        if (!body.sessionId || !body.agentId || !body.goal) {
          sendJson(res, 400, { error: 'Missing sessionId, agentId, or goal in request body' });
          return;
        }
        const result = await client.startRun({
          sessionId: body.sessionId,
          agentId: body.agentId,
          goal: body.goal,
        });
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/runs/pause' && req.method === 'POST') {
        const body = await parseJsonBody<{ runId: string }>(req);
        const result = await client.pauseRun({ runId: body.runId });
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/runs/resume' && req.method === 'POST') {
        const body = await parseJsonBody<{ runId: string }>(req);
        const result = await client.resumeRun({ runId: body.runId });
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/runs/cancel' && req.method === 'POST') {
        const body = await parseJsonBody<{ runId: string }>(req);
        const result = await client.cancelRun({ runId: body.runId });
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/approvals' && req.method === 'GET') {
        const result = await client.listApprovals();
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/approvals/resolve' && req.method === 'POST') {
        const body = await parseJsonBody<{ approvalId: string; decision: 'approve' | 'deny'; reason?: string }>(req);
        const result = await client.resolveApproval({
          approvalId: body.approvalId,
          decision: body.decision,
          reason: body.reason,
        });
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/logs' && req.method === 'GET') {
        const logsDir = path.join(home, 'logs');
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
        let logLines: string[] = [];

        try {
          if (await existsIn(logsDir, 'runtime.log')) {
            const content = await readFileIn(logsDir, 'runtime.log');
            const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
            logLines = lines.slice(-limit);
          }
        } catch {
          // Log reading fallback
        }

        sendJson(res, 200, { lines: logLines });
        return;
      }

      // Static Asset Serving
      const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      if (relativePath.includes('..')) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      // Determine content type
      let contentType = 'text/plain';
      if (relativePath.endsWith('.html')) contentType = 'text/html; charset=utf-8';
      else if (relativePath.endsWith('.css')) contentType = 'text/css; charset=utf-8';
      else if (relativePath.endsWith('.js')) contentType = 'application/javascript; charset=utf-8';
      else if (relativePath.endsWith('.json')) contentType = 'application/json';

      try {
        if (await existsIn(publicDir, relativePath)) {
          const content = await readFileIn(publicDir, relativePath);
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': Buffer.byteLength(content),
            'Cache-Control': 'no-cache',
          });
          res.end(content);
          return;
        }
      } catch {
        // Fall through to 404
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      logger.error({ event: 'gui.request.failed', err: errorObj, path: pathname }, 'GUI request handler error');
      sendError(res, err);
    }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });

  const url = `http://127.0.0.1:${port}`;
  logger.info({ event: 'gui.server.started', port, url }, `AIR Control Center listening at ${url}`);

  return {
    port,
    url,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (clientConnected) {
        try {
          await client.disconnect();
        } catch {
          // Ignore disconnection error
        }
      }
    },
  };
}
