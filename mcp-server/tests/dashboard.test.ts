import fs from 'fs';
import path from 'path';
import vm from 'vm';
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

  it.each(['connection', 'recovery'])(
    'copies only the currently rendered %s diagnostic events',
    async category => {
      const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'dashboard.js'), 'utf8');
      const writes: string[] = [];
      const elements = new Map<string, any>();
      const element = () => ({
        className: '', textContent: '', hidden: false, firstChild: null,
        appendChild: jest.fn(), removeChild: jest.fn(), addEventListener: jest.fn(),
        querySelector: jest.fn(() => ({ textContent: '' }))
      });
      for (const id of [
        'event-list', 'event-filter', 'copy-diagnostics', 'offline-banner', 'overall-status',
        'broker-card', 'extension-card', 'recovery-card', 'agent-count', 'grace-count',
        'claimed-tab-count', 'pending-count', 'connection-detail'
      ]) elements.set(id, element());

      const context = {
        document: {
          getElementById: (id: string) => elements.get(id),
          createElement: element
        },
        navigator: { clipboard: { writeText: async (value: string) => { writes.push(value); } } },
        EventSource: class {
          onopen = null;
          onerror = null;
          addEventListener() { /* test stub */ }
        },
        fetch: async () => ({ ok: false }),
        setTimeout: jest.fn(),
        console
      };
      vm.runInNewContext(script, context);
      const appendEvent = vm.runInNewContext('appendEvent', context);
      const setCategory = vm.runInNewContext('setCategory', context);
      const copyDiagnostics = vm.runInNewContext('copyDiagnostics', context);
      for (const eventCategory of ['broker', 'connection', 'ownership', 'recovery']) {
        appendEvent({ sequence: 1, timestamp: 1, level: 'info', category: eventCategory, code: eventCategory, summary: eventCategory });
      }
      setCategory(category);
      await copyDiagnostics();

      const payload = JSON.parse(writes[writes.length - 1]);
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0].category).toBe(category);
      expect(payload.events).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ category: category === 'connection' ? 'recovery' : 'connection' })
      ]));
    }
  );
});
