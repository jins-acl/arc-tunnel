import fs from 'fs';
import path from 'path';
import { BrokerServer } from '../src/broker/broker-server';

describe('Chinese operations dashboard', () => {
  let broker: BrokerServer;
  let base: string;

  beforeEach(async () => {
    broker = new BrokerServer({ host: '127.0.0.1', port: 0 });
    await broker.start();
    base = `http://127.0.0.1:${broker.address().port}`;
  });

  afterEach(async () => broker.stop());

  it('serves the Chinese dashboard and same-origin assets with a restrictive CSP', async () => {
    const html = await fetch(`${base}/dashboard`);
    expect(html.status).toBe(200);
    expect(html.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(html.headers.get('cache-control')).toBe('no-store');
    const markup = await html.text();
    expect(markup).toContain('Arc Tunnel 运维控制中心');
    expect(markup).toContain('href="/dashboard/dashboard.css"');
    expect(markup).toContain('src="/dashboard/dashboard.js"');

    const css = await fetch(`${base}/dashboard/dashboard.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    const javascript = await fetch(`${base}/dashboard/dashboard.js`);
    expect(javascript.status).toBe(200);
    expect(javascript.headers.get('content-type')).toContain('javascript');
  });

  it('contains the approved read-only control-center regions and browser functions', async () => {
    const markup = await fetch(`${base}/dashboard`).then(response => response.text());
    for (const id of [
      'overall-status', 'broker-card', 'extension-card', 'recovery-card', 'agent-count',
      'grace-count', 'claimed-tab-count', 'pending-count', 'connection-detail', 'event-list',
      'event-filter', 'copy-diagnostics', 'offline-banner'
    ]) {
      expect(markup).toContain(`id="${id}"`);
    }

    const script = await fetch(`${base}/dashboard/dashboard.js`).then(response => response.text());
    for (const functionName of ['renderStatus', 'appendEvent', 'setCategory', 'copyDiagnostics']) {
      expect(script).toContain(`function ${functionName}`);
    }
    expect(script).toContain("new EventSource('/api/events')");
    expect(script).toContain("addEventListener('RESET'");
    expect(script).toContain('document.createElement');
    expect(script).toContain('textContent');
  });

  it('keeps the dashboard script read-only and excludes sensitive browser fields', async () => {
    const scriptPath = path.join(__dirname, '..', 'src', 'dashboard', 'dashboard.js');
    const script = fs.readFileSync(scriptPath, 'utf8');
    expect(script).not.toMatch(/innerHTML\s*=/);
    expect(script).not.toMatch(/fetch\s*\([^)]*\{[^}]*method\s*:/s);
    expect(script).not.toMatch(/\/api\/(?!status\b|events\b)[a-z-]+/i);
    expect(script).not.toMatch(/sessionId|tabId|windowId|cookie|localStorage|sessionStorage|execute_script|params/i);
  });

  it('uses an exact static allowlist and refuses unknown dashboard paths', async () => {
    await expect(fetch(`${base}/dashboard/`)).resolves.toMatchObject({ status: 200 });
    await expect(fetch(`${base}/dashboard/index.html`)).resolves.toMatchObject({ status: 404 });
    await expect(fetch(`${base}/dashboard/not-allowed.js`)).resolves.toMatchObject({ status: 404 });
  });
});
