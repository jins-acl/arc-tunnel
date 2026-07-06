import WebSocket from 'ws';
import { BrokerServer } from '../src/broker/broker-server';
import { SessionRegistry } from '../src/broker/session-registry';
import { ErrorCode, PROTOCOL_VERSION } from '../src/protocol';

type JsonMessage = Record<string, any>;

function openWs(port: number, path: string, origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : undefined);
    const onError = (error: Error) => reject(error);
    ws.once('error', onError);
    ws.once('open', () => {
      ws.off('error', onError);
      resolve(ws);
    });
  });
}

function nextMessage(ws: WebSocket): Promise<JsonMessage> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    });
    ws.once('error', reject);
    ws.once('close', () => reject(new Error('WebSocket closed before a message arrived')));
  });
}

async function connectRole(port: number, path: '/agent' | '/extension', role: 'agent' | 'extension') {
  const ws = await openWs(port, path, role === 'extension' ? 'chrome-extension://test' : undefined);
  const welcome = nextMessage(ws);
  ws.send(JSON.stringify({ type: 'hello', role, protocolVersion: PROTOCOL_VERSION }));
  return { ws, welcome: await welcome };
}

async function closeWs(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    ws.once('close', () => resolve());
    ws.close();
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('BrokerServer', () => {
  let broker: BrokerServer;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    broker = new BrokerServer({ host: '127.0.0.1', port: 0 });
    await broker.start();
  });

  afterEach(async () => {
    jest.useRealTimers();
    await Promise.all(sockets.splice(0).map(closeWs));
    await broker.stop();
  });

  it('accepts agent and extension paths and rejects webpage origins', async () => {
    const port = broker.address().port;
    const agent = await openWs(port, '/agent');
    const extension = await openWs(port, '/extension', 'chrome-extension://test');
    sockets.push(agent, extension);

    await expect(openWs(port, '/agent', 'https://malicious.example')).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json()))
      .resolves.toEqual({ name: 'arc-tunnel', protocolVersion: 2, pid: process.pid, port });
  });

  it('requires the extension origin on the legacy root path', async () => {
    const port = broker.address().port;
    await expect(openWs(port, '/')).rejects.toThrow();

    const legacy = await openWs(port, '/', 'chrome-extension://legacy');
    sockets.push(legacy);
    expect(broker.isExtensionConnected()).toBe(true);
  });

  it('welcomes matching roles and rejects a protocol mismatch', async () => {
    const port = broker.address().port;
    const agent = await connectRole(port, '/agent', 'agent');
    sockets.push(agent.ws);
    expect(agent.welcome).toMatchObject({
      type: 'welcome', protocolVersion: PROTOCOL_VERSION, sessionId: expect.any(String)
    });

    const extension = await connectRole(port, '/extension', 'extension');
    sockets.push(extension.ws);
    expect(extension.welcome).toEqual({ type: 'welcome', protocolVersion: PROTOCOL_VERSION });

    const incompatible = await openWs(port, '/agent');
    sockets.push(incompatible);
    const rejection = nextMessage(incompatible);
    incompatible.send(JSON.stringify({ type: 'hello', role: 'agent', protocolVersion: 999 }));
    await expect(rejection).resolves.toMatchObject({ error: { code: ErrorCode.PROTOCOL_MISMATCH } });
  });

  it('closes a versioned path when hello is not received within five seconds', async () => {
    jest.useFakeTimers();
    const idle = await openWs(broker.address().port, '/agent');
    sockets.push(idle);
    const closed = new Promise<number>((resolve) => idle.once('close', (code) => resolve(code)));

    jest.advanceTimersByTime(4_999);
    expect(idle.readyState).toBe(WebSocket.OPEN);
    jest.advanceTimersByTime(1);
    await expect(closed).resolves.toBe(1008);
  });

  it('routes each extension response only to its originating agent', async () => {
    const port = broker.address().port;
    const extension = await connectRole(port, '/extension', 'extension');
    const alpha = await connectRole(port, '/agent', 'agent');
    const beta = await connectRole(port, '/agent', 'agent');
    sockets.push(extension.ws, alpha.ws, beta.ws);

    const commandA = nextMessage(extension.ws);
    alpha.ws.send(JSON.stringify({ type: 'agent_request', requestId: 'same-id', command: 'list_tabs', params: {}, timeout: 1_000 }));
    const first = await commandA;
    const commandB = nextMessage(extension.ws);
    beta.ws.send(JSON.stringify({ type: 'agent_request', requestId: 'same-id', command: 'list_tabs', params: {}, timeout: 1_000 }));
    const second = await commandB;
    expect(first.id).not.toBe(second.id);

    const betaResponse = nextMessage(beta.ws);
    extension.ws.send(JSON.stringify({ id: second.id, type: 'response', success: true, result: { tabs: [{ tabId: 2 }] } }));
    const alphaResponse = nextMessage(alpha.ws);
    extension.ws.send(JSON.stringify({ id: first.id, type: 'response', success: true, result: { tabs: [{ tabId: 1 }] } }));

    await expect(alphaResponse).resolves.toMatchObject({ requestId: 'same-id', result: { tabs: [{ tabId: 1 }] } });
    await expect(betaResponse).resolves.toMatchObject({ requestId: 'same-id', result: { tabs: [{ tabId: 2 }] } });
  });

  it('returns EXTENSION_DISCONNECTED without an extension and for in-flight work on disconnect', async () => {
    const port = broker.address().port;
    const alpha = await connectRole(port, '/agent', 'agent');
    sockets.push(alpha.ws);

    let response = nextMessage(alpha.ws);
    alpha.ws.send(JSON.stringify({ type: 'agent_request', requestId: 'offline', command: 'list_tabs', params: {}, timeout: 1_000 }));
    await expect(response).resolves.toMatchObject({ requestId: 'offline', error: { code: ErrorCode.EXTENSION_DISCONNECTED } });

    const extension = await connectRole(port, '/extension', 'extension');
    sockets.push(extension.ws);
    const command = nextMessage(extension.ws);
    alpha.ws.send(JSON.stringify({ type: 'agent_request', requestId: 'in-flight', command: 'list_tabs', params: {}, timeout: 1_000 }));
    await command;
    response = nextMessage(alpha.ws);
    await closeWs(extension.ws);
    await expect(response).resolves.toMatchObject({ requestId: 'in-flight', error: { code: ErrorCode.EXTENSION_DISCONNECTED } });
  });

  it('rejects commands sent to an extension that is replaced', async () => {
    const port = broker.address().port;
    const firstExtension = await connectRole(port, '/extension', 'extension');
    const alpha = await connectRole(port, '/agent', 'agent');
    sockets.push(firstExtension.ws, alpha.ws);
    const command = nextMessage(firstExtension.ws);
    alpha.ws.send(JSON.stringify({ type: 'agent_request', requestId: 'old-extension', command: 'list_tabs', params: {}, timeout: 1_000 }));
    await command;
    const response = nextMessage(alpha.ws);

    const replacement = await connectRole(port, '/extension', 'extension');
    sockets.push(replacement.ws);
    await expect(response).resolves.toMatchObject({
      requestId: 'old-extension', error: { code: ErrorCode.EXTENSION_DISCONNECTED }
    });
  });

  it('ignores events and responses from a replaced extension socket', async () => {
    const registry = new SessionRegistry();
    await broker.stop();
    broker = new BrokerServer({ host: '127.0.0.1', port: 0 }, { registry });
    await broker.start();
    const port = broker.address().port;
    const first = await connectRole(port, '/extension', 'extension');
    const firstServerSocket = (broker as any).extension as WebSocket;
    const alpha = await connectRole(port, '/agent', 'agent');
    sockets.push(first.ws, alpha.ws);
    registry.claimTab(alpha.welcome.sessionId, 77);

    const replacement = await connectRole(port, '/extension', 'extension');
    sockets.push(replacement.ws);
    const staleMessageHandler = firstServerSocket.listeners('message')[0] as (data: Buffer) => void;
    staleMessageHandler(Buffer.from(JSON.stringify({
      type: 'event', event: 'tab_removed', data: { tabId: 77 }, timestamp: Date.now()
    })));

    expect(() => registry.assertOwnsTab(alpha.welcome.sessionId, 77)).not.toThrow();
  });

  it('treats No active recording as idempotent disconnect cleanup success', async () => {
    const registry = new SessionRegistry();
    await broker.stop();
    broker = new BrokerServer({ host: '127.0.0.1', port: 0 }, { registry });
    await broker.start();
    const port = broker.address().port;
    const extension = await connectRole(port, '/extension', 'extension');
    const alpha = await connectRole(port, '/agent', 'agent');
    const beta = await connectRole(port, '/agent', 'agent');
    sockets.push(extension.ws, alpha.ws, beta.ws);
    registry.addRecording(alpha.welcome.sessionId, 'recording-alpha');

    const cleanup = nextMessage(extension.ws);
    await closeWs(alpha.ws);
    const stop = await cleanup;
    extension.ws.send(JSON.stringify({ id: stop.id, type: 'response', success: false,
      error: { code: 'INTERNAL_ERROR', message: 'No active recording' } }));
    await new Promise(resolve => setImmediate(resolve));

    const forwarded = nextMessage(extension.ws);
    beta.ws.send(JSON.stringify({ type: 'agent_request', requestId: 'still-live', command: 'list_tabs', params: {}, timeout: 1_000 }));
    await expect(forwarded).resolves.toMatchObject({ command: 'list_tabs' });
    expect(extension.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('retries genuine recording cleanup failure before reconnect inventory sync', async () => {
    const registry = new SessionRegistry();
    await broker.stop();
    broker = new BrokerServer({ host: '127.0.0.1', port: 0 }, { registry });
    await broker.start();
    const port = broker.address().port;
    const first = await connectRole(port, '/extension', 'extension');
    const alpha = await connectRole(port, '/agent', 'agent');
    sockets.push(first.ws, alpha.ws);
    registry.addRecording(alpha.welcome.sessionId, 'recording-alpha');

    const cleanup = nextMessage(first.ws);
    await closeWs(alpha.ws);
    const stop = await cleanup;
    const firstClosed = new Promise<void>(resolve => first.ws.once('close', () => resolve()));
    first.ws.send(JSON.stringify({ id: stop.id, type: 'response', success: false,
      error: { code: 'INTERNAL_ERROR', message: 'temporary failure' } }));
    await firstClosed;

    const replacement = await openWs(port, '/extension', 'chrome-extension://test');
    sockets.push(replacement);
    const received: JsonMessage[] = [];
    replacement.on('message', data => received.push(JSON.parse(data.toString())));
    replacement.send(JSON.stringify({ type: 'hello', role: 'extension', protocolVersion: PROTOCOL_VERSION }));
    await waitUntil(() => received.length >= 2);
    expect(received[0]).toEqual({ type: 'welcome', protocolVersion: PROTOCOL_VERSION });
    const retry = received[1];
    expect(retry.command).toBe('stop_recording');
    replacement.send(JSON.stringify({ id: retry.id, type: 'response', success: false,
      error: { code: 'INTERNAL_ERROR', message: 'No active recording' } }));
    await waitUntil(() => received.length >= 3);
    const sync = received[2];
    expect(sync.command).toBe('list_tabs');
  });

  it('fences disconnected recording cleanup by extension generation', async () => {
    const registry = new SessionRegistry();
    await broker.stop();
    broker = new BrokerServer({ host: '127.0.0.1', port: 0 }, { registry });
    await broker.start();
    const port = broker.address().port;
    const first = await connectRole(port, '/extension', 'extension');
    const alpha = await connectRole(port, '/agent', 'agent');
    sockets.push(first.ws, alpha.ws);
    registry.addRecording(alpha.welcome.sessionId, 'recording-alpha');
    (broker as any).recordingReservationSessionId = alpha.welcome.sessionId;

    const oldCleanup = nextMessage(first.ws);
    await closeWs(alpha.ws);
    expect((await oldCleanup).command).toBe('stop_recording');

    const replacement = await openWs(port, '/extension', 'chrome-extension://test');
    sockets.push(replacement);
    const received: JsonMessage[] = [];
    replacement.on('message', data => received.push(JSON.parse(data.toString())));
    replacement.send(JSON.stringify({ type: 'hello', role: 'extension', protocolVersion: PROTOCOL_VERSION }));
    await waitUntil(() => received.some(message => message.command === 'stop_recording'));

    expect(registry.activeRecordingId(alpha.welcome.sessionId)).toBe('recording-alpha');
    expect((broker as any).recordingReservationSessionId).toBe(alpha.welcome.sessionId);
    expect((broker as any).diagnostics.snapshot({
      now: Date.now(), connectedAgents: 0, graceAgents: 1, claimedTabs: 0, pendingCommands: 1
    }).recovery.recordingCleanup).toBe('running');

    const cleanup = received.find(message => message.command === 'stop_recording')!;
    replacement.send(JSON.stringify({ id: cleanup.id, type: 'response', success: false,
      error: { code: 'INTERNAL_ERROR', message: 'No active recording' } }));
    await waitUntil(() => received.some(message => message.command === 'list_tabs'));
    const sync = received.find(message => message.command === 'list_tabs')!;
    replacement.send(JSON.stringify({ id: sync.id, type: 'response', success: true, result: { tabs: [] } }));
  });

  it('cleans up an uncertain in-flight start before replacement inventory sync', async () => {
    const registry = new SessionRegistry();
    await broker.stop();
    broker = new BrokerServer({ host: '127.0.0.1', port: 0 }, { registry });
    await broker.start();
    const port = broker.address().port;
    const first = await connectRole(port, '/extension', 'extension');
    const alpha = await connectRole(port, '/agent', 'agent');
    sockets.push(first.ws, alpha.ws);
    registry.claimTab(alpha.welcome.sessionId, 77);

    const start = nextMessage(first.ws);
    alpha.ws.send(JSON.stringify({ type: 'agent_request', requestId: 'start',
      command: 'start_recording', params: { tabId: 77 }, timeout: 1_000 }));
    await start;
    await closeWs(alpha.ws);
    await closeWs(first.ws);

    const replacement = await openWs(port, '/extension', 'chrome-extension://test');
    sockets.push(replacement);
    const received: JsonMessage[] = [];
    replacement.on('message', data => received.push(JSON.parse(data.toString())));
    replacement.send(JSON.stringify({ type: 'hello', role: 'extension', protocolVersion: PROTOCOL_VERSION }));
    await waitUntil(() => received.length >= 2);

    expect(received[1].command).toBe('stop_recording');
    replacement.send(JSON.stringify({ id: received[1].id, type: 'response', success: false,
      error: { code: 'EXECUTION_ERROR', message: 'No active recording' } }));
    await waitUntil(() => received.length >= 3);
    expect(received[2].command).toBe('list_tabs');
  });

  it('closes a reconnected extension when inventory synchronization times out', async () => {
    const port = broker.address().port;
    const first = await connectRole(port, '/extension', 'extension');
    sockets.push(first.ws);
    await closeWs(first.ws);

    const replacement = await openWs(port, '/extension', 'chrome-extension://test');
    sockets.push(replacement);
    const received: JsonMessage[] = [];
    replacement.on('message', data => received.push(JSON.parse(data.toString())));
    replacement.send(JSON.stringify({ type: 'hello', role: 'extension', protocolVersion: PROTOCOL_VERSION }));
    await waitUntil(() => received.some(message => message.command === 'list_tabs'));
    expect(received.some(message => message.command === 'list_tabs')).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(replacement.readyState).toBe(WebSocket.CLOSED);
    const status = await fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json() as any);
    expect(status.extension).toMatchObject({ connected: false, generation: 2, reconnectPhase: 'failed' });
    expect(status.recovery.inventorySync).toBe('failed');
  });

  it('fences recovery state by extension generation during replacement sync', async () => {
    const port = broker.address().port;
    const first = await connectRole(port, '/extension', 'extension');
    sockets.push(first.ws);
    await closeWs(first.ws);

    const secondWs = await openWs(port, '/extension', 'chrome-extension://test');
    sockets.push(secondWs);
    const secondMessages: JsonMessage[] = [];
    secondWs.on('message', data => secondMessages.push(JSON.parse(data.toString())));
    secondWs.send(JSON.stringify({ type: 'hello', role: 'extension', protocolVersion: PROTOCOL_VERSION }));
    await waitUntil(() => secondMessages.some(message => message.command === 'list_tabs'));
    const secondSync = secondMessages.find(message => message.command === 'list_tabs')!;
    expect(secondSync.command).toBe('list_tabs');

    const thirdWs = await openWs(port, '/extension', 'chrome-extension://test');
    sockets.push(thirdWs);
    const thirdMessages: JsonMessage[] = [];
    thirdWs.on('message', data => thirdMessages.push(JSON.parse(data.toString())));
    thirdWs.send(JSON.stringify({ type: 'hello', role: 'extension', protocolVersion: PROTOCOL_VERSION }));
    await waitUntil(() => thirdMessages.some(message => message.command === 'list_tabs'));
    const thirdSync = thirdMessages.find(message => message.command === 'list_tabs')!;
    expect(thirdSync.command).toBe('list_tabs');
    thirdWs.send(JSON.stringify({ id: thirdSync.id, type: 'response', success: true, result: { tabs: [] } }));
    await waitUntil(() => (broker as any).extensionReconnectPhase === 'idle');

    const status = await fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json() as any);
    expect(status.extension).toMatchObject({ connected: true, generation: 3, reconnectPhase: 'idle' });
    expect(status.recovery.inventorySync).toBe('idle');
  });

  it('returns COMMAND_TIMEOUT and ignores a response after its Agent disconnects', async () => {
    const port = broker.address().port;
    const extension = await connectRole(port, '/extension', 'extension');
    const alpha = await connectRole(port, '/agent', 'agent');
    const beta = await connectRole(port, '/agent', 'agent');
    sockets.push(extension.ws, alpha.ws, beta.ws);

    let command = nextMessage(extension.ws);
    alpha.ws.send(JSON.stringify({ type: 'agent_request', requestId: 'slow', command: 'list_tabs', params: {}, timeout: 10 }));
    await command;
    await expect(nextMessage(alpha.ws)).resolves.toMatchObject({ requestId: 'slow', error: { code: ErrorCode.COMMAND_TIMEOUT } });

    command = nextMessage(extension.ws);
    alpha.ws.send(JSON.stringify({ type: 'agent_request', requestId: 'abandoned', command: 'list_tabs', params: {}, timeout: 1_000 }));
    const abandoned = await command;
    await closeWs(alpha.ws);
    extension.ws.send(JSON.stringify({ id: abandoned.id, type: 'response', success: true, result: { leaked: true } }));

    const betaCommand = nextMessage(extension.ws);
    beta.ws.send(JSON.stringify({ type: 'agent_request', requestId: 'beta', command: 'list_tabs', params: {}, timeout: 1_000 }));
    const forwarded = await betaCommand;
    const betaResponse = nextMessage(beta.ws);
    extension.ws.send(JSON.stringify({ id: forwarded.id, type: 'response', success: true, result: { leaked: false } }));
    await expect(betaResponse).resolves.toMatchObject({ requestId: 'beta', result: { leaked: false } });
  });

  it('releases tab ownership 30 seconds after an Agent disconnects', async () => {
    const registry = new SessionRegistry();
    await broker.stop();
    broker = new BrokerServer({ host: '127.0.0.1', port: 0 }, { registry });
    await broker.start();
    const agent = await connectRole(broker.address().port, '/agent', 'agent');
    sockets.push(agent.ws);
    registry.claimTab(agent.welcome.sessionId, 42);
    const expire = jest.spyOn(registry, 'expireDisconnected');
    let markDisconnected!: () => void;
    const disconnected = new Promise<void>((resolve) => { markDisconnected = resolve; });
    const disconnect = jest.spyOn(registry, 'disconnect');
    disconnect.mockImplementation((...args) => {
      disconnect.mockRestore();
      registry.disconnect(...args);
      markDisconnected();
    });

    jest.useFakeTimers();
    agent.ws.close();
    await new Promise<void>((resolve) => agent.ws.once('close', () => resolve()));
    await disconnected;
    jest.advanceTimersByTime(29_999);
    expect(expire).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(expire).toHaveBeenCalledWith(expect.any(Number));
    expect((broker as any).diagnostics.eventsAfter(0).events).toContainEqual(expect.objectContaining({
      category: 'ownership', code: 'TAB_OWNERSHIP_EXPIRED', summary: '宽限期结束，标签页所有权已释放'
    }));
  });

  it('rejects matching work with TAB_CLOSED when a tab is removed', async () => {
    const registry = new SessionRegistry();
    await broker.stop();
    broker = new BrokerServer({ host: '127.0.0.1', port: 0 }, { registry });
    await broker.start();
    const port = broker.address().port;
    const extension = await connectRole(port, '/extension', 'extension');
    const alpha = await connectRole(port, '/agent', 'agent');
    sockets.push(extension.ws, alpha.ws);
    registry.claimTab(alpha.welcome.sessionId, 77);
    const command = nextMessage(extension.ws);
    alpha.ws.send(JSON.stringify({ type: 'agent_request', requestId: 'tab-work', command: 'navigate', params: { tabId: 77 }, timeout: 1_000 }));
    await command;
    const response = nextMessage(alpha.ws);
    extension.ws.send(JSON.stringify({ type: 'event', event: 'tab_removed', data: { tabId: 77 }, timestamp: Date.now() }));
    await expect(response).resolves.toMatchObject({ requestId: 'tab-work', error: { code: ErrorCode.TAB_CLOSED } });
  });

  it('retires closed-tab metadata only after its scheduler queue drains', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = (broker as any).scheduler.run(77, () => gate);

    (broker as any).handleBrowserEvent({
      event: 'tab_removed', data: { tabId: 77 }, timestamp: Date.now()
    });
    expect((broker as any).closedTabIds.has(77)).toBe(true);
    expect((broker as any).tabGenerations.has(77)).toBe(true);

    release();
    await pending;
    await new Promise(resolve => setImmediate(resolve));
    expect((broker as any).closedTabIds.has(77)).toBe(false);
    expect((broker as any).tabGenerations.has(77)).toBe(false);
  });

  it('rejects matching work with TAB_CLOSED when a window is removed', async () => {
    const registry = new SessionRegistry();
    await broker.stop();
    broker = new BrokerServer({ host: '127.0.0.1', port: 0 }, { registry });
    await broker.start();
    const port = broker.address().port;
    const extension = await connectRole(port, '/extension', 'extension');
    const alpha = await connectRole(port, '/agent', 'agent');
    const beta = await connectRole(port, '/agent', 'agent');
    sockets.push(extension.ws, alpha.ws, beta.ws);
    registry.assignWindow(alpha.welcome.sessionId, 88, [77]);
    const command = nextMessage(extension.ws);
    alpha.ws.send(JSON.stringify({ type: 'agent_request', requestId: 'window-work', command: 'navigate', params: { tabId: 77 }, timeout: 1_000 }));
    await command;
    const response = nextMessage(alpha.ws);
    extension.ws.send(JSON.stringify({ type: 'event', event: 'window_removed', data: { windowId: 88 }, timestamp: Date.now() }));
    await expect(response).resolves.toMatchObject({ requestId: 'window-work', error: { code: ErrorCode.TAB_CLOSED } });
    expect(registry.claimTab(beta.welcome.sessionId, 77)).toEqual({ ok: true });
  });

  it('rejects in-flight routes before closing sockets on shutdown', async () => {
    const port = broker.address().port;
    const extension = await connectRole(port, '/extension', 'extension');
    const alpha = await connectRole(port, '/agent', 'agent');
    sockets.push(extension.ws, alpha.ws);
    const command = nextMessage(extension.ws);
    alpha.ws.send(JSON.stringify({ type: 'agent_request', requestId: 'shutdown', command: 'list_tabs', params: {}, timeout: 1_000 }));
    await command;
    const response = nextMessage(alpha.ws);

    const stopping = broker.stop();
    await expect(response).resolves.toMatchObject({
      requestId: 'shutdown', error: { code: ErrorCode.EXTENSION_DISCONNECTED }
    });
    await stopping;
  });
});
