import WebSocket from 'ws';
import { BrokerServer } from '../src/broker/broker-server';
import { ErrorCode, PROTOCOL_VERSION } from '../src/protocol';

type Message = Record<string, any>;

function nextMessage(ws: WebSocket): Promise<Message> {
  return new Promise((resolve, reject) => {
    ws.once('message', data => resolve(JSON.parse(data.toString())));
    ws.once('error', reject);
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function connect(port: number, path: '/agent' | '/extension', role: 'agent' | 'extension') {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, role === 'extension' ? { origin: 'chrome-extension://test' } : undefined);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
  const welcome = nextMessage(ws);
  ws.send(JSON.stringify({ type: 'hello', role, protocolVersion: PROTOCOL_VERSION }));
  await welcome;
  return ws;
}

class Agent {
  private requestId = 0;
  private readonly pending = new Map<string, { resolve(value: any): void; reject(error: any): void }>();
  constructor(private readonly ws: WebSocket) {
    ws.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'agent_response') return;
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      message.success ? pending.resolve(message.result) : pending.reject(message.error);
    });
  }
  call(command: string, params: Record<string, unknown> = {}): Promise<any> {
    const requestId = String(++this.requestId);
    const response = new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });
    this.ws.send(JSON.stringify({ type: 'agent_request', requestId, command, params, timeout: 1_000 }));
    return response;
  }
}

describe('Broker ownership', () => {
  let broker: BrokerServer;
  let extension: WebSocket;
  let alphaSocket: WebSocket;
  let betaSocket: WebSocket;
  let alpha: Agent;
  let beta: Agent;
  const commands: Message[] = [];
  const tabs = [{ tabId: 300, windowId: 30, url: 'https://manual.example' }];
  let nextWindow = 40;
  let nextTab = 400;

  beforeEach(async () => {
    commands.splice(0);
    tabs.splice(0, tabs.length, { tabId: 300, windowId: 30, url: 'https://manual.example' });
    broker = new BrokerServer({ host: '127.0.0.1', port: 0 });
    await broker.start();
    const port = broker.address().port;
    extension = await connect(port, '/extension', 'extension');
    alphaSocket = await connect(port, '/agent', 'agent');
    betaSocket = await connect(port, '/agent', 'agent');
    alpha = new Agent(alphaSocket);
    beta = new Agent(betaSocket);
    extension.on('message', data => {
      const command = JSON.parse(data.toString());
      if (command.type !== 'command') return;
      commands.push(command);
      if ((extension as any).manualResponses) return;
      let result: any;
      if (command.command === 'create_window') {
        const windowId = nextWindow++;
        const tab = { tabId: nextTab++, windowId, url: command.params.url };
        tabs.push(tab);
        result = tab;
      } else if (command.command === 'create_tab') {
        const tab = { tabId: nextTab++, windowId: command.params.windowId, url: command.params.url };
        tabs.push(tab);
        result = { tabId: tab.tabId };
      } else if (command.command === 'list_tabs') {
        result = { tabs };
      } else {
        result = { ok: true };
      }
      extension.send(JSON.stringify({ id: command.id, type: 'response', success: true, result }));
    });
  });

  afterEach(async () => {
    for (const ws of [alphaSocket, betaSocket, extension]) ws.close();
    await broker.stop();
  });

  it('creates one window per session and isolates visible tabs', async () => {
    const alphaTab = await alpha.call('create_tab', { url: 'https://a.example' });
    const alphaSecond = await alpha.call('create_tab', { url: 'https://a2.example' });
    const betaTab = await beta.call('create_tab', { url: 'https://b.example' });

    expect(commands.filter(command => command.command === 'create_window')).toHaveLength(2);
    expect(commands.find(command => command.command === 'create_tab')?.params.windowId).toBe(alphaTab.windowId);
    expect(commands.filter(command => command.command === 'create_tab')[0].params.windowId).toBe(alphaTab.windowId);
    const visible = await alpha.call('list_tabs');
    expect(visible.tabs).toContainEqual(expect.objectContaining({ tabId: alphaTab.tabId, ownership: 'owned' }));
    expect(visible.tabs).toContainEqual(expect.objectContaining({ tabId: 300, ownership: 'unclaimed' }));
    expect(visible.tabs).not.toContainEqual(expect.objectContaining({ tabId: betaTab.tabId }));
  });

  it('creates exactly one window when a session opens its first tabs concurrently', async () => {
    const [first, second] = await Promise.all([
      alpha.call('create_tab', { url: 'https://first.example' }),
      alpha.call('create_tab', { url: 'https://second.example' })
    ]);

    expect(commands.filter(command => command.command === 'create_window')).toHaveLength(1);
    expect(commands.find(command => command.command === 'create_tab')?.params.windowId).toBe(first.windowId);
    expect(second).toEqual({ tabId: expect.any(Number) });
  });

  it('allows explicit claim and release and rejects foreign or unclaimed tab commands', async () => {
    await expect(alpha.call('navigate', { tabId: 300, action: 'goto', url: 'https://x.example' }))
      .rejects.toMatchObject({ code: ErrorCode.TAB_NOT_OWNED });
    await alpha.call('claim_tab', { tabId: 300 });
    await expect(beta.call('navigate', { tabId: 300, action: 'goto', url: 'https://x.example' }))
      .rejects.toMatchObject({ code: ErrorCode.TAB_NOT_OWNED });
    await expect(alpha.call('navigate', { tabId: 300, action: 'goto', url: 'https://x.example' }))
      .resolves.toEqual({ ok: true });
    await alpha.call('release_tab', { tabId: 300 });
    await expect(beta.call('claim_tab', { tabId: 300 })).resolves.toEqual(expect.objectContaining({ tabId: 300 }));
  });

  it('serializes commands on one tab while allowing different tabs to overlap', async () => {
    await alpha.call('claim_tab', { tabId: 101 });
    await alpha.call('claim_tab', { tabId: 202 });
    (extension as any).manualResponses = true;
    const offset = commands.length;

    const first = alpha.call('navigate', { tabId: 101, action: 'reload' });
    await new Promise(resolve => setImmediate(resolve));
    const second = alpha.call('snapshot', { tabId: 101 });
    const other = alpha.call('snapshot', { tabId: 202 });
    await waitUntil(() => commands.length >= offset + 2);
    const arrived = commands.slice(offset);
    expect(arrived.map(command => command.params.tabId)).toEqual([101, 202]);

    extension.send(JSON.stringify({ id: arrived[1].id, type: 'response', success: true, result: { tabId: 202 } }));
    await expect(other).resolves.toEqual({ tabId: 202 });
    expect(arrived).toHaveLength(2);
    extension.send(JSON.stringify({ id: arrived[0].id, type: 'response', success: true, result: { tabId: 101, order: 1 } }));
    await expect(first).resolves.toEqual({ tabId: 101, order: 1 });
    await waitUntil(() => commands.length >= offset + 3);
    const afterFirst = commands.slice(offset);
    expect(afterFirst.map(command => command.params.tabId)).toEqual([101, 202, 101]);
    extension.send(JSON.stringify({ id: afterFirst[2].id, type: 'response', success: true, result: { tabId: 101, order: 2 } }));
    await expect(second).resolves.toEqual({ tabId: 101, order: 2 });
  });
});
