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
  (ws as any).welcome = await welcome;
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
  call(command: string, params: Record<string, unknown> = {}, timeout = 1_000): Promise<any> {
    const requestId = String(++this.requestId);
    const response = new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });
    this.ws.send(JSON.stringify({ type: 'agent_request', requestId, command, params, timeout }));
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
  const initialTabs = [
    { tabId: 101, windowId: 10, url: 'https://one.example' },
    { tabId: 202, windowId: 20, url: 'https://two.example' },
    { tabId: 300, windowId: 30, url: 'https://manual.example' }
  ];
  const tabs = [...initialTabs];
  let nextWindow = 40;
  let nextTab = 400;

  beforeEach(async () => {
    commands.splice(0);
    tabs.splice(0, tabs.length, ...initialTabs);
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
      if ((extension as any).manualResponses && command.command !== 'list_tabs') return;
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
      } else if (command.command === 'start_recording') {
        result = { recordingId: 'recording-alpha' };
      } else if (command.command === 'save_session') {
        result = { sessionId: 'session-alpha' };
      } else if (command.command === 'restore_session') {
        result = { tabIds: [nextTab++] };
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
    await expect(beta.call('claim_tab', { tabId: 300 }))
      .rejects.toMatchObject({ code: ErrorCode.TAB_NOT_OWNED });
    await expect(beta.call('navigate', { tabId: 300, action: 'goto', url: 'https://x.example' }))
      .rejects.toMatchObject({ code: ErrorCode.TAB_NOT_OWNED });
    await expect(alpha.call('navigate', { tabId: 300, action: 'goto', url: 'https://x.example' }))
      .resolves.toEqual({ ok: true });
    await alpha.call('release_tab', { tabId: 300 });
    await expect(beta.call('claim_tab', { tabId: 300 })).resolves.toEqual(expect.objectContaining({ tabId: 300 }));
  });

  it('rejects a claim for a tab absent from the extension inventory', async () => {
    await expect(alpha.call('claim_tab', { tabId: 999 }))
      .rejects.toMatchObject({ code: ErrorCode.TAB_NOT_FOUND });
    await expect(alpha.call('navigate', { tabId: 999, action: 'reload' }))
      .rejects.toMatchObject({ code: ErrorCode.TAB_NOT_OWNED });
  });

  it('claims a real unclaimed tab from the extension inventory', async () => {
    await expect(alpha.call('claim_tab', { tabId: 300 }))
      .resolves.toEqual({ tabId: 300, ownership: 'owned' });
    await expect(alpha.call('list_tabs')).resolves.toEqual(expect.objectContaining({
      tabs: expect.arrayContaining([expect.objectContaining({ tabId: 300, ownership: 'owned' })])
    }));
  });

  it('does not forward queued work after ownership is released and transferred', async () => {
    await alpha.call('claim_tab', { tabId: 101 });
    (extension as any).manualResponses = true;
    const offset = commands.length;
    const first = alpha.call('navigate', { tabId: 101, action: 'reload' });
    const queued = alpha.call('snapshot', { tabId: 101 });
    await waitUntil(() => commands.length >= offset + 1);

    await alpha.call('release_tab', { tabId: 101 });
    await beta.call('claim_tab', { tabId: 101 });
    const firstCommand = commands.slice(offset).find(command => command.command === 'navigate')!;
    extension.send(JSON.stringify({ id: firstCommand.id, type: 'response', success: true, result: { ok: true } }));

    await expect(first).resolves.toEqual({ ok: true });
    await expect(queued).rejects.toMatchObject({ code: ErrorCode.TAB_NOT_OWNED });
    expect(commands.slice(offset).filter(command => command.command === 'snapshot')).toHaveLength(0);
  });

  it('does not forward queued work after its Agent disconnects', async () => {
    await alpha.call('claim_tab', { tabId: 101 });
    (extension as any).manualResponses = true;
    const offset = commands.length;
    void alpha.call('navigate', { tabId: 101, action: 'reload' });
    void alpha.call('snapshot', { tabId: 101 });
    await waitUntil(() => commands.length >= offset + 1);

    await new Promise<void>(resolve => {
      alphaSocket.once('close', () => resolve());
      alphaSocket.close();
    });
    const first = commands.slice(offset).find(command => command.command === 'navigate')!;
    extension.send(JSON.stringify({ id: first.id, type: 'response', success: true, result: { ok: true } }));
    await new Promise(resolve => setImmediate(resolve));

    expect(commands.slice(offset).filter(command => command.command === 'snapshot')).toHaveLength(0);
  });

  it('rejects queued work with TAB_CLOSED after its tab is removed', async () => {
    await alpha.call('claim_tab', { tabId: 202 });
    (extension as any).manualResponses = true;
    const offset = commands.length;
    const first = alpha.call('navigate', { tabId: 202, action: 'reload' });
    const queued = alpha.call('snapshot', { tabId: 202 });
    await waitUntil(() => commands.length >= offset + 1);

    extension.send(JSON.stringify({ type: 'event', event: 'tab_removed', data: { tabId: 202 }, timestamp: Date.now() }));
    await expect(first).rejects.toMatchObject({ code: ErrorCode.TAB_CLOSED });
    await expect(queued).rejects.toMatchObject({ code: ErrorCode.TAB_CLOSED });
    expect(commands.slice(offset).filter(command => command.command === 'snapshot')).toHaveLength(0);
  });

  it('does not run old queued work against a new tab that reuses the same ID', async () => {
    await alpha.call('claim_tab', { tabId: 202 });
    (extension as any).manualResponses = true;
    const offset = commands.length;
    const first = alpha.call('navigate', { tabId: 202, action: 'reload' });
    const stale = alpha.call('execute_script', { tabId: 202, script: 'old incarnation' });
    const staleRejection = expect(stale).rejects.toMatchObject({ code: ErrorCode.TAB_CLOSED });
    await waitUntil(() => commands.length >= offset + 1);

    // Run both lifecycle transitions and establish new-incarnation ownership in one
    // synchronous turn so the stale scheduler callback cannot drain in between.
    (broker as any).handleBrowserEvent({ event: 'tab_removed', data: { tabId: 202 } });
    tabs.splice(tabs.findIndex(tab => tab.tabId === 202), 1,
      { tabId: 202, windowId: 21, url: 'https://reused.example' });
    (broker as any).handleBrowserEvent({ event: 'tab_created', data: { tabId: 202, windowId: 21 } });
    (broker as any).registry.claimTab((alphaSocket as any).welcome.sessionId, 202);
    const fresh = alpha.call('snapshot', { tabId: 202 });

    await expect(first).rejects.toMatchObject({ code: ErrorCode.TAB_CLOSED });
    await waitUntil(() => commands.some(command => command.command === 'execute_script'));
    const wronglyForwarded = commands.find(command => command.command === 'execute_script');
    if (wronglyForwarded) {
      extension.send(JSON.stringify({ id: wronglyForwarded.id, type: 'response', success: true, result: { stale: true } }));
    }
    await staleRejection;
    expect(wronglyForwarded).toBeUndefined();

    await waitUntil(() => commands.some(command => command.command === 'snapshot'));
    const freshCommand = commands.find(command => command.command === 'snapshot')!;
    extension.send(JSON.stringify({ id: freshCommand.id, type: 'response', success: true, result: { fresh: true } }));
    await expect(fresh).resolves.toEqual({ fresh: true });
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

  it('does not leak recording or saved-session identifiers across agents', async () => {
    await alpha.call('claim_tab', { tabId: 101 });
    await beta.call('claim_tab', { tabId: 202 });
    const { recordingId } = await alpha.call('start_recording', { tabId: 101 });
    await expect(beta.call('stop_recording')).rejects.toMatchObject({ code: ErrorCode.RECORDING_NOT_FOUND });
    await expect(beta.call('replay_recording', { recordingId, tabId: 202 }))
      .rejects.toMatchObject({ code: ErrorCode.RECORDING_NOT_FOUND });
    await alpha.call('stop_recording');
    await expect(alpha.call('replay_recording', { recordingId, tabId: 101 }))
      .resolves.toEqual({ ok: true });

    const { sessionId } = await alpha.call('save_session', { name: 'alpha' });
    await expect(beta.call('restore_session', { sessionId }))
      .rejects.toMatchObject({ code: ErrorCode.SESSION_NOT_FOUND });
  });

  it('stops an active extension recording when its Agent disconnects', async () => {
    await alpha.call('claim_tab', { tabId: 101 });
    await beta.call('claim_tab', { tabId: 202 });
    await alpha.call('start_recording', { tabId: 101 });
    const offset = commands.length;

    await new Promise<void>(resolve => {
      alphaSocket.once('close', () => resolve());
      alphaSocket.close();
    });
    await waitUntil(() => commands.slice(offset).some(command => command.command === 'stop_recording'));

    expect(commands.slice(offset).filter(command => command.command === 'stop_recording')).toHaveLength(1);
    await expect(beta.call('start_recording', { tabId: 202 }))
      .resolves.toEqual({ recordingId: 'recording-alpha' });
  });

  it('scopes save and restore commands to the owning workspace', async () => {
    const created = await alpha.call('create_tab', { url: 'https://owned.example' });
    const { sessionId } = await alpha.call('save_session', { name: 'alpha' });
    await alpha.call('restore_session', { sessionId });

    expect(commands.find(command => command.command === 'save_session')?.params.tabIds)
      .toEqual(expect.arrayContaining([created.tabId]));
    expect(commands.find(command => command.command === 'restore_session')?.params.windowId)
      .toBe(created.windowId);
  });

  it('retains only existing tab ownership after extension reconnect', async () => {
    await alpha.call('claim_tab', { tabId: 101 });
    await alpha.call('claim_tab', { tabId: 202 });
    tabs.splice(tabs.findIndex(tab => tab.tabId === 202), 1);
    extension.close();
    extension = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${broker.address().port}/extension`, { origin: 'chrome-extension://test' });
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    });
    extension.on('message', data => {
      const command = JSON.parse(data.toString());
      if (command.type === 'command' && command.command === 'list_tabs') {
        extension.send(JSON.stringify({ id: command.id, type: 'response', success: true, result: { tabs } }));
      }
    });
    const welcome = nextMessage(extension);
    extension.send(JSON.stringify({ type: 'hello', role: 'extension', protocolVersion: PROTOCOL_VERSION }));
    await welcome;

    const visible = await alpha.call('list_tabs');
    expect(visible.tabs).toContainEqual(expect.objectContaining({ tabId: 101, ownership: 'owned' }));
    expect((broker as any).registry.visibleTabs((alphaSocket as any).welcome.sessionId,
      [{ tabId: 202 }])[0].ownership).toBe('unclaimed');
  });

  it('starts synchronized tabs unclaimed in a fresh broker process', async () => {
    const fresh = new BrokerServer({ host: '127.0.0.1', port: 0 });
    await fresh.start();
    const freshExtension = await connect(fresh.address().port, '/extension', 'extension');
    freshExtension.on('message', data => {
      const command = JSON.parse(data.toString());
      if (command.type === 'command' && command.command === 'list_tabs') {
        freshExtension.send(JSON.stringify({ id: command.id, type: 'response', success: true, result: { tabs: initialTabs } }));
      }
    });
    const freshAgentSocket = await connect(fresh.address().port, '/agent', 'agent');
    const freshAgent = new Agent(freshAgentSocket);
    try {
      const visible = await freshAgent.call('list_tabs');
      expect(visible.tabs).toContainEqual(expect.objectContaining({ tabId: 101, ownership: 'unclaimed' }));
      expect(visible.tabs).toContainEqual(expect.objectContaining({ tabId: 202, ownership: 'unclaimed' }));
    } finally {
      freshAgentSocket.close();
      freshExtension.close();
      await fresh.stop();
    }
  });

  it('atomically reserves the singleton recording across concurrent agents and rolls back failure', async () => {
    await alpha.call('claim_tab', { tabId: 101 });
    await beta.call('claim_tab', { tabId: 202 });
    (extension as any).manualResponses = true;
    const offset = commands.length;
    const first = alpha.call('start_recording', { tabId: 101 });
    const competing = beta.call('start_recording', { tabId: 202 }).then(() => null, error => error);
    await waitUntil(() => commands.slice(offset).some(command => command.command === 'start_recording'));
    await new Promise(resolve => setImmediate(resolve));
    const starts = commands.slice(offset).filter(command => command.command === 'start_recording');
    for (const start of starts) extension.send(JSON.stringify({ id: start.id, type: 'response', success: false,
      error: { code: 'EXECUTION_ERROR', message: 'failed' } }));
    await expect(first).rejects.toMatchObject({ code: 'EXECUTION_ERROR' });
    const competingError = await competing;
    expect(starts).toHaveLength(1);
    expect(competingError).toMatchObject({ code: ErrorCode.RECORDING_BUSY });

    const retry = beta.call('start_recording', { tabId: 202 });
    await waitUntil(() => commands.slice(offset).filter(command => command.command === 'start_recording').length === 2);
    const retryCommand = commands.slice(offset).filter(command => command.command === 'start_recording')[1];
    extension.send(JSON.stringify({ id: retryCommand.id, type: 'response', success: true,
      result: { recordingId: 'beta-recording' } }));
    await expect(retry).resolves.toEqual({ recordingId: 'beta-recording' });
  });

  it('rolls back an in-flight recording reservation on timeout and extension disconnect', async () => {
    await alpha.call('claim_tab', { tabId: 101 });
    await beta.call('claim_tab', { tabId: 202 });
    (extension as any).manualResponses = true;
    await expect(alpha.call('start_recording', { tabId: 101 }, 10))
      .rejects.toMatchObject({ code: ErrorCode.COMMAND_TIMEOUT });

    const pending = beta.call('start_recording', { tabId: 202 });
    await waitUntil(() => commands.filter(command => command.command === 'start_recording').length >= 2);
    extension.close();
    await expect(pending).rejects.toMatchObject({ code: ErrorCode.EXTENSION_DISCONNECTED });

    extension = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${broker.address().port}/extension`, { origin: 'chrome-extension://test' });
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    });
    extension.on('message', data => {
      const command = JSON.parse(data.toString());
      if (command.type !== 'command') return;
      const result = command.command === 'list_tabs' ? { tabs } : { recordingId: 'after-disconnect' };
      extension.send(JSON.stringify({ id: command.id, type: 'response', success: true, result }));
    });
    const welcome = nextMessage(extension);
    extension.send(JSON.stringify({ type: 'hello', role: 'extension', protocolVersion: PROTOCOL_VERSION }));
    await welcome;
    await expect(alpha.call('start_recording', { tabId: 101 }))
      .resolves.toEqual({ recordingId: 'after-disconnect' });
  });

  it('shares one lazy window across concurrent restores', async () => {
    const { sessionId } = await alpha.call('save_session', { name: 'alpha' });
    const offset = commands.length;
    await Promise.all([
      alpha.call('restore_session', { sessionId }),
      alpha.call('restore_session', { sessionId })
    ]);
    const concurrent = commands.slice(offset);
    expect(concurrent.filter(command => command.command === 'create_window')).toHaveLength(1);
    const windowIds = concurrent.filter(command => command.command === 'restore_session')
      .map(command => command.params.windowId);
    expect(new Set(windowIds).size).toBe(1);
  });

  it('rejects malformed and colliding restore tab IDs without partial claims', async () => {
    await alpha.call('create_tab', { url: 'https://alpha.example' });
    const { sessionId } = await alpha.call('save_session', { name: 'alpha' });
    await beta.call('claim_tab', { tabId: 202 });
    (extension as any).manualResponses = true;

    const malformed = alpha.call('restore_session', { sessionId });
    await waitUntil(() => commands.some(command => command.command === 'restore_session'));
    let restores = commands.filter(command => command.command === 'restore_session');
    let restore = restores[restores.length - 1];
    extension.send(JSON.stringify({ id: restore.id, type: 'response', success: true, result: { tabIds: [401, 'bad'] } }));
    await expect(malformed).rejects.toMatchObject({ code: ErrorCode.SESSION_RESTORE_FAILED });
    expect((broker as any).registry.visibleTabs((alphaSocket as any).welcome.sessionId, [{ tabId: 401 }])[0].ownership)
      .toBe('unclaimed');

    const collision = alpha.call('restore_session', { sessionId });
    await waitUntil(() => commands.filter(command => command.command === 'restore_session').length >= 2);
    restores = commands.filter(command => command.command === 'restore_session');
    restore = restores[restores.length - 1];
    extension.send(JSON.stringify({ id: restore.id, type: 'response', success: true, result: { tabIds: [402, 202] } }));
    await expect(collision).rejects.toMatchObject({ code: ErrorCode.TAB_NOT_OWNED });
    expect((broker as any).registry.visibleTabs((alphaSocket as any).welcome.sessionId, [{ tabId: 402 }])[0].ownership)
      .toBe('unclaimed');
  });

  it('ignores malformed response envelopes without mutating recording ownership', async () => {
    await alpha.call('claim_tab', { tabId: 101 });
    (extension as any).manualResponses = true;
    const pending = alpha.call('start_recording', { tabId: 101 });
    await waitUntil(() => commands.some(command => command.command === 'start_recording'));
    const command = commands.find(command => command.command === 'start_recording')!;
    extension.send(JSON.stringify({ id: 123, type: 'response', success: true, result: { recordingId: 'wrong-id' } }));
    extension.send(JSON.stringify({ id: command.id, type: 'response', success: false,
      error: { code: 'EXECUTION_ERROR', message: 123 } }));
    extension.send(JSON.stringify({ id: command.id, type: 'response', success: 'yes', result: { recordingId: 'leaked' } }));
    await new Promise(resolve => setImmediate(resolve));
    extension.send(JSON.stringify({ id: command.id, type: 'response', success: false,
      error: { code: 'EXECUTION_ERROR', message: 'failed' } }));
    await expect(pending).rejects.toMatchObject({ code: 'EXECUTION_ERROR' });
    await expect(alpha.call('replay_recording', { recordingId: 'leaked', tabId: 101 }))
      .rejects.toMatchObject({ code: ErrorCode.RECORDING_NOT_FOUND });
  });

  it('rejects malformed successful recording results and releases the reservation', async () => {
    await alpha.call('claim_tab', { tabId: 101 });
    await beta.call('claim_tab', { tabId: 202 });
    (extension as any).manualResponses = true;
    const malformed = alpha.call('start_recording', { tabId: 101 });
    await waitUntil(() => commands.some(command => command.command === 'start_recording'));
    let starts = commands.filter(command => command.command === 'start_recording');
    extension.send(JSON.stringify({ id: starts[starts.length - 1].id, type: 'response', success: true, result: {} }));
    await expect(malformed).rejects.toBeDefined();
    await expect(alpha.call('replay_recording', { recordingId: 'missing', tabId: 101 }))
      .rejects.toMatchObject({ code: ErrorCode.RECORDING_NOT_FOUND });

    const valid = beta.call('start_recording', { tabId: 202 });
    await waitUntil(() => commands.filter(command => command.command === 'start_recording').length === 2);
    starts = commands.filter(command => command.command === 'start_recording');
    extension.send(JSON.stringify({ id: starts[1].id, type: 'response', success: true,
      result: { recordingId: 'valid-later' } }));
    await expect(valid).resolves.toEqual({ recordingId: 'valid-later' });
  });

  it('rejects malformed successful save results without registering a session', async () => {
    (extension as any).manualResponses = true;
    const malformed = alpha.call('save_session', { name: 'bad' });
    await waitUntil(() => commands.some(command => command.command === 'save_session'));
    const save = commands.find(command => command.command === 'save_session')!;
    extension.send(JSON.stringify({ id: save.id, type: 'response', success: true, result: { sessionId: 42 } }));
    await expect(malformed).rejects.toBeDefined();
    await expect(alpha.call('restore_session', { sessionId: '42' }))
      .rejects.toMatchObject({ code: ErrorCode.SESSION_NOT_FOUND });
  });

  it('keeps recording ownership after failed stop until the owner successfully retries', async () => {
    await alpha.call('claim_tab', { tabId: 101 });
    await beta.call('claim_tab', { tabId: 202 });
    await alpha.call('start_recording', { tabId: 101 });
    (extension as any).manualResponses = true;
    const failedStop = alpha.call('stop_recording');
    await waitUntil(() => commands.some(command => command.command === 'stop_recording'));
    let stops = commands.filter(command => command.command === 'stop_recording');
    extension.send(JSON.stringify({ id: stops[stops.length - 1].id, type: 'response', success: false,
      error: { code: 'EXECUTION_ERROR', message: 'failed stop' } }));
    await expect(failedStop).rejects.toMatchObject({ code: 'EXECUTION_ERROR' });
    await expect(beta.call('start_recording', { tabId: 202 }))
      .rejects.toMatchObject({ code: ErrorCode.RECORDING_BUSY });

    const successfulStop = alpha.call('stop_recording');
    await waitUntil(() => commands.filter(command => command.command === 'stop_recording').length === 2);
    stops = commands.filter(command => command.command === 'stop_recording');
    extension.send(JSON.stringify({ id: stops[1].id, type: 'response', success: true, result: { recording: {} } }));
    await successfulStop;
    const next = beta.call('start_recording', { tabId: 202 });
    await waitUntil(() => commands.filter(command => command.command === 'start_recording').length === 2);
    const starts = commands.filter(command => command.command === 'start_recording');
    extension.send(JSON.stringify({ id: starts[1].id, type: 'response', success: true,
      result: { recordingId: 'after-stop' } }));
    await expect(next).resolves.toEqual({ recordingId: 'after-stop' });
  });

  it('preserves create_tab intent when it races a restore-first lazy window', async () => {
    const { sessionId } = await alpha.call('save_session', { name: 'alpha' });
    (extension as any).manualResponses = true;
    const restore = alpha.call('restore_session', { sessionId });
    await waitUntil(() => commands.some(command => command.command === 'create_window'));
    const createdWindow = commands.find(command => command.command === 'create_window')!;
    const create = alpha.call('create_tab', { url: 'https://must-create.example' });
    extension.send(JSON.stringify({ id: createdWindow.id, type: 'response', success: true,
      result: { windowId: 88, tabId: 880 } }));
    await waitUntil(() => commands.some(command => command.command === 'restore_session'));
    const restoreCommand = commands.find(command => command.command === 'restore_session')!;
    extension.send(JSON.stringify({ id: restoreCommand.id, type: 'response', success: true, result: { tabIds: [] } }));
    await restore;
    await waitUntil(() => commands.some(command => command.command === 'create_tab'));
    const createCommand = commands.find(command => command.command === 'create_tab');
    expect(createCommand?.params).toMatchObject({ windowId: 88, url: 'https://must-create.example' });
    extension.send(JSON.stringify({ id: createCommand!.id, type: 'response', success: true, result: { tabId: 881 } }));
    await expect(create).resolves.toEqual({ tabId: 881 });
  });
});
