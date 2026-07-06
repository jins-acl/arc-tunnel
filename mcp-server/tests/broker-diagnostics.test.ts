import http from 'http';
import WebSocket from 'ws';
import { BrokerServer } from '../src/broker/broker-server';
import { PROTOCOL_VERSION } from '../src/protocol';

interface SseEvent { id?: string; event?: string; data?: unknown }

function connect(port: number, role: 'agent' | 'extension'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${role}`, role === 'extension'
      ? { origin: 'chrome-extension://diagnostics-test' } : undefined);
    ws.once('error', reject);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role, protocolVersion: PROTOCOL_VERSION }));
      ws.once('message', () => resolve(ws));
    });
  });
}

function close(ws: WebSocket): Promise<void> {
  return new Promise(resolve => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', () => resolve());
    ws.close();
  });
}

function readEvents(port: number, path: string, count: number): Promise<{ events: SseEvent[]; request: http.ClientRequest }> {
  let request!: http.ClientRequest;
  const result = new Promise<{ events: SseEvent[]; request: http.ClientRequest }>((resolve, reject) => {
    request = http.get({ hostname: '127.0.0.1', port, path }, response => {
      let buffer = '';
      const events: SseEvent[] = [];
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        while (buffer.includes('\n\n')) {
          const boundary = buffer.indexOf('\n\n');
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed: SseEvent = {};
          for (const line of frame.split('\n')) {
            const [field, ...rest] = line.split(':');
            const value = rest.join(':').trimStart();
            if (field === 'id') parsed.id = value;
            if (field === 'event') parsed.event = value;
            if (field === 'data') parsed.data = JSON.parse(value);
          }
          events.push(parsed);
          if (events.length === count) {
            response.destroy();
            request.destroy();
            resolve({ events, request });
            return;
          }
        }
      });
      response.once('error', error => {
        if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
      });
    });
    request.once('error', reject);
  });
  return result;
}

describe('Broker diagnostics API', () => {
  let broker: BrokerServer;

  beforeEach(async () => {
    broker = new BrokerServer({ host: '127.0.0.1', port: 0 });
    await broker.start();
  });

  afterEach(async () => broker.stop());

  it('returns only safe aggregate diagnostics with four security headers and no CORS', async () => {
    const port = broker.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const body = await response.json();
    expect(body).toMatchObject({
      broker: { port, protocolVersion: 2 },
      extension: { connected: false },
      agents: { connected: 0, grace: 0 },
      workload: { claimedTabs: 0, pendingCommands: 0 }
    });
    expect(JSON.stringify(body)).not.toMatch(/sessionId|tabId|url|cookie|script|params/i);
    expect(broker.dashboardUrl()).toBe(`http://127.0.0.1:${port}/`);
  });

  it('keeps the health response exactly compatible', async () => {
    const response = await fetch(`http://127.0.0.1:${broker.address().port}/health`);
    expect(Object.keys(await response.json() as object).sort()).toEqual(['name', 'pid', 'port', 'protocolVersion']);
  });

  it('tracks extension generation and agent grace with identifier-free Chinese lifecycle summaries', async () => {
    const extension = await connect(broker.address().port, 'extension');
    const agent = await connect(broker.address().port, 'agent');
    let status = await fetch(`http://127.0.0.1:${broker.address().port}/api/status`).then(r => r.json() as any);
    expect(status.extension).toMatchObject({ connected: true, generation: 1, reconnectPhase: 'idle' });
    expect(status.agents).toEqual({ connected: 1, grace: 0 });

    await close(agent);
    status = await fetch(`http://127.0.0.1:${broker.address().port}/api/status`).then(r => r.json() as any);
    expect(status.agents).toEqual({ connected: 0, grace: 1 });
    const events = (broker as any).diagnostics.eventsAfter(0).events;
    expect(events.map((event: any) => event.code)).toEqual(expect.arrayContaining([
      'EXTENSION_CONNECTED', 'AGENT_CONNECTED', 'AGENT_GRACE_STARTED'
    ]));
    expect(events.every((event: any) => /[\u3400-\u9fff]/.test(event.summary))).toBe(true);
    expect(JSON.stringify(events)).not.toContain('sessionId');
    await close(extension);
  });

  it('replays diagnostics after the requested sequence and unsubscribes on close', async () => {
    const diagnostics = (broker as any).diagnostics;
    diagnostics.record({ level: 'info', category: 'broker', code: 'SECOND', summary: '第二条' });
    diagnostics.record({ level: 'info', category: 'broker', code: 'THIRD', summary: '第三条' });
    const { events } = await readEvents(broker.address().port, '/api/events?after=1', 2);
    expect(events.map(event => event.id)).toEqual(['2', '3']);
    expect(events.every(event => event.event === 'diagnostic')).toBe(true);
    for (let attempt = 0; attempt < 50 && (broker as any).sseClients.size > 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect((broker as any).sseClients.size).toBe(0);
  });

  it('atomically hands off replay to live delivery without duplicates or reordering', async () => {
    const diagnostics = (broker as any).diagnostics;
    diagnostics.record({ level: 'info', category: 'broker', code: 'SECOND', summary: '第二条' });
    diagnostics.record({ level: 'info', category: 'broker', code: 'THIRD', summary: '第三条' });
    const original = diagnostics.eventsAfter.bind(diagnostics);
    diagnostics.eventsAfter = (sequence: number) => {
      const replay = original(sequence);
      diagnostics.record({ level: 'info', category: 'broker', code: 'HANDOFF', summary: '交接事件' });
      diagnostics.eventsAfter = original;
      return replay;
    };

    const { events } = await readEvents(broker.address().port, '/api/events?after=1', 3);
    expect(events.map(event => event.id)).toEqual(['2', '3', '4']);
  });

  it.each(['1junk', '1.5', '-1', '9007199254740992'])(
    'treats invalid cursor %s as zero', async cursor => {
      const diagnostics = (broker as any).diagnostics;
      diagnostics.record({ level: 'info', category: 'broker', code: 'SECOND', summary: '第二条' });
      const { events } = await readEvents(broker.address().port, `/api/events?after=${encodeURIComponent(cursor)}`, 1);
      expect(events[0].id).toBe('1');
    }
  );

  it('disconnects a backpressured SSE client and stops within a bounded time', async () => {
    const originalWrite = http.ServerResponse.prototype.write;
    const write = jest.spyOn(http.ServerResponse.prototype, 'write').mockImplementation(function (this: http.ServerResponse, ...args: any[]) {
      originalWrite.apply(this, args as any);
      return false;
    } as any);
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          const request = http.get(`http://127.0.0.1:${broker.address().port}/api/events`, response => {
            response.resume();
            response.once('close', resolve);
          });
          request.once('error', error => error.message === 'socket hang up' ? resolve() : reject(error));
        }),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('backpressured client remained open')), 250))
      ]);
      expect((broker as any).sseClients.size).toBe(0);
      await expect(Promise.race([
        broker.stop(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('stop timed out')), 250))
      ])).resolves.toBeUndefined();
    } finally {
      write.mockRestore();
    }
  });

  it('emits RESET when replay history is no longer available', async () => {
    const diagnostics = (broker as any).diagnostics;
    for (let index = 0; index < 201; index++) {
      diagnostics.record({ level: 'info', category: 'broker', code: 'FILL', summary: '填充事件' });
    }
    const { events } = await readEvents(broker.address().port, '/api/events?after=0', 1);
    expect(events[0].event).toBe('RESET');
  });

  it('closes a live SSE response without blocking broker stop', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${broker.address().port}/api/events`, response => {
        expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
        resolve();
      });
      request.once('error', reject);
    });
    expect((broker as any).sseClients.size).toBe(1);
    await expect(broker.stop()).resolves.toBeUndefined();
    expect((broker as any).sseClients.size).toBe(0);
  });
});
