import { describe, expect, it } from 'vitest';
import { startGuiServer } from '../../../src/gui/index.js';

describe('GUI Server (Phase GUI - R-GUI-002)', () => {
  it('starts GUI server, serves static dashboard files and responds to API queries', async () => {
    // Start on port 4198 for unit testing
    const server = await startGuiServer({
      port: 4198,
      pipeName: 'air-nonexistent-gui-test',
    });

    try {
      expect(server.port).toBe(4198);
      expect(server.url).toBe('http://127.0.0.1:4198');

      // 1. Static asset - index.html
      const htmlRes = await fetch(`${server.url}/`);
      expect(htmlRes.status).toBe(200);
      expect(htmlRes.headers.get('content-type')).toContain('text/html');
      const htmlText = await htmlRes.text();
      expect(htmlText).toContain('AIR');
      expect(htmlText).toContain('CONTROL CENTER');

      // 2. Static asset - style.css
      const cssRes = await fetch(`${server.url}/style.css`);
      expect(cssRes.status).toBe(200);
      expect(cssRes.headers.get('content-type')).toContain('text/css');

      // 3. Static asset - app.js
      const jsRes = await fetch(`${server.url}/app.js`);
      expect(jsRes.status).toBe(200);
      expect(jsRes.headers.get('content-type')).toContain('application/javascript');

      // 4. API endpoint - /api/agents
      const agentsRes = await fetch(`${server.url}/api/agents`);
      expect(agentsRes.status).toBe(200);
      const agentsData = (await agentsRes.json()) as { agents: Array<{ id: string }> };
      expect(Array.isArray(agentsData.agents)).toBe(true);
      expect(agentsData.agents.length).toBeGreaterThan(0);
      const developer = agentsData.agents.find((a: { id: string }) => a.id === 'developer');
      expect(developer).toBeDefined();

      // 5. API endpoint - /api/health (offline fallback when daemon not running)
      const healthRes = await fetch(`${server.url}/api/health`);
      expect(healthRes.status).toBe(200);
      const healthData = await healthRes.json();
      expect(healthData).toBeDefined();

      // 6. 404 handler for nonexistent route
      const notFoundRes = await fetch(`${server.url}/nonexistent.html`);
      expect(notFoundRes.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
