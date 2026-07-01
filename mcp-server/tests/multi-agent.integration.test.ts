import { spawn, ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../src/protocol';

jest.setTimeout(30_000);
const root = path.resolve(__dirname, '..');

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(port: number): Promise<{ pid: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return await response.json() as { pid: number };
    } catch { /* process is starting */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Broker health timeout');
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', () => resolve()));
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const content = ('content' in result && Array.isArray(result.content)) ? result.content : [];
  const text = content.find((item: any) => item.type === 'text');
  const value = text?.type === 'text' ? JSON.parse(text.text) : undefined;
  if ('isError' in result && result.isError) throw Object.assign(new Error(value?.error), value);
  return value;
}

describe('built multi-process broker', () => {
  it('isolates two real stdio MCP clients while sharing one Broker PID', async () => {
    const port = await freePort();
    const errors: string[] = [];
    const broker = spawn(process.execPath, [path.join(root, 'dist/arc-tunnel-broker.js'), '--port', String(port)], {
      cwd: root, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
    });
    broker.stderr!.on('data', chunk => errors.push(chunk.toString()));
    let extension: WebSocket | undefined;
    const transports: StdioClientTransport[] = [];
    const clients: Client[] = [];
    const clientPids: number[] = [];
    try {
      const pidBefore = (await waitForHealth(port)).pid;
      expect(pidBefore).toBe(broker.pid);
      extension = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: 'chrome-extension://integration-test' });
      await new Promise<void>((resolve, reject) => extension!.once('open', resolve).once('error', reject));
      extension.send(JSON.stringify({ type: 'hello', role: 'extension', protocolVersion: PROTOCOL_VERSION }));
      const tabs = [{ tabId: 901, windowId: 91, url: 'about:blank' }, { tabId: 902, windowId: 92, url: 'about:blank' }];
      let nextWindow = 100;
      let nextTab = 1000;
      extension.on('message', raw => {
        const message = JSON.parse(raw.toString());
        if (message.type !== 'command') return;
        let result: unknown = { ok: true, marker: message.params?.url };
        if (message.command === 'list_tabs') result = { tabs };
        if (message.command === 'create_window') {
          const tab = { tabId: nextTab++, windowId: nextWindow++, url: message.params?.url ?? 'about:blank' };
          tabs.push(tab); result = tab;
        }
        extension!.send(JSON.stringify({ id: message.id, type: 'response', success: true, result }));
      });

      for (const name of ['alpha', 'beta']) {
        const transport = new StdioClientTransport({ command: process.execPath,
          args: [path.join(root, 'dist/mcp-server.js')], cwd: root,
          env: { ...process.env, WS_PORT: String(port) } as Record<string, string>, stderr: 'pipe' });
        transport.stderr?.on('data', chunk => errors.push(chunk.toString()));
        const client = new Client({ name, version: '1.0.0' });
        await client.connect(transport);
        if (transport.pid) clientPids.push(transport.pid);
        transports.push(transport); clients.push(client);
      }
      const [alpha, beta] = clients;
      expect((await alpha.listTools()).tools).toContainEqual(expect.objectContaining({ name: 'claim_tab' }));
      expect((await beta.listTools()).tools).toContainEqual(expect.objectContaining({ name: 'release_tab' }));
      const [alphaTab, betaTab] = await Promise.all([
        call(alpha, 'create_tab', { url: 'https://alpha.invalid' }),
        call(beta, 'create_tab', { url: 'https://beta.invalid' })
      ]);
      expect(alphaTab.windowId).not.toBe(betaTab.windowId);
      const [alphaNavigation, betaNavigation] = await Promise.all([
        call(alpha, 'navigate', { tabId: alphaTab.tabId, url: 'https://alpha-nav.invalid' }),
        call(beta, 'navigate', { tabId: betaTab.tabId, url: 'https://beta-nav.invalid' })
      ]);
      expect({ alpha: alphaNavigation.ok ? 'ok' : 'failed', beta: betaNavigation.ok ? 'ok' : 'failed' })
        .toEqual({ alpha: 'ok', beta: 'ok' });
      expect([alphaNavigation.marker, betaNavigation.marker])
        .toEqual(['https://alpha-nav.invalid', 'https://beta-nav.invalid']);
      const [alphaVisible, betaVisible] = await Promise.all([call(alpha, 'list_tabs'), call(beta, 'list_tabs')]);
      expect(alphaVisible.tabs.map((tab: any) => tab.tabId)).toContain(alphaTab.tabId);
      expect(alphaVisible.tabs.map((tab: any) => tab.tabId)).not.toContain(betaTab.tabId);
      expect(betaVisible.tabs.map((tab: any) => tab.tabId)).toContain(betaTab.tabId);
      expect(betaVisible.tabs.map((tab: any) => tab.tabId)).not.toContain(alphaTab.tabId);
      expect((await waitForHealth(port)).pid).toBe(pidBefore);
      await expect(call(beta, 'navigate', { tabId: alphaTab.tabId, url: 'https://foreign.invalid' }))
        .rejects.toMatchObject({ code: 'TAB_NOT_OWNED' });
      await expect(call(alpha, 'release_tab', { tabId: alphaTab.tabId })).resolves.toMatchObject({ ownership: 'unclaimed' });
      await expect(call(beta, 'claim_tab', { tabId: alphaTab.tabId })).resolves.toMatchObject({ ownership: 'owned' });
    } finally {
      await Promise.all(clients.map(client => client.close().catch(() => undefined)));
      await Promise.all(transports.map(transport => transport.close().catch(() => undefined)));
      extension?.close(); broker.kill('SIGTERM'); await waitForExit(broker);
    }
    expect(broker.exitCode !== null || broker.signalCode !== null).toBe(true);
    for (const pid of clientPids) expect(() => process.kill(pid, 0)).toThrow();
    expect(errors.join('')).not.toMatch(/EADDRINUSE|EPIPE/);
  });
});
