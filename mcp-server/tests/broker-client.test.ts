import net from 'net';
import { WebSocketServer } from 'ws';
import { BrokerClient } from '../src/broker-client';
import { PROTOCOL_VERSION } from '../src/protocol';

describe('BrokerClient', () => {
  let server: WebSocketServer;
  let client: BrokerClient | undefined;
  let port: number;
  const requests: any[] = [];
  let socket: any;

  beforeEach(async () => {
    requests.length = 0;
    server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/agent' });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as any).port;
    server.on('connection', (ws) => {
      socket = ws;
      ws.once('message', () => ws.send(JSON.stringify({ type: 'welcome', protocolVersion: PROTOCOL_VERSION, sessionId: 'test' })));
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'agent_request') requests.push(message);
      });
    });
  });

  afterEach(async () => {
    client?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function waitForRequests(count: number): Promise<void> {
    while (requests.length < count) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  it('correlates out-of-order Broker responses', async () => {
    client = await BrokerClient.connect({ host: '127.0.0.1', port });
    const first = client.call('first', {}, 1000);
    const second = client.call('second', {}, 1000);
    await waitForRequests(2);
    const firstRequest = requests.find((request) => request.command === 'first');
    const secondRequest = requests.find((request) => request.command === 'second');
    socket.send(JSON.stringify({ type: 'agent_response', requestId: secondRequest.requestId, success: true, result: { value: 2 } }));
    socket.send(JSON.stringify({ type: 'agent_response', requestId: firstRequest.requestId, success: true, result: { value: 1 } }));
    await expect(first).resolves.toEqual({ value: 1 });
    await expect(second).resolves.toEqual({ value: 2 });
  });

  it('rejects Broker errors and local command timeouts with their codes', async () => {
    client = await BrokerClient.connect({ host: '127.0.0.1', port });
    const rejected = client.call('rejected', {}, 1000);
    await waitForRequests(1);
    socket.send(JSON.stringify({
      type: 'agent_response', requestId: requests[0].requestId, success: false,
      error: { code: 'TAB_NOT_FOUND', message: 'missing tab' }
    }));
    await expect(rejected).rejects.toMatchObject({ code: 'TAB_NOT_FOUND', message: 'missing tab' });
    await expect(client.call('slow', {}, 10)).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT' });
  });

  it('rejects pending calls when the Broker connection closes', async () => {
    client = await BrokerClient.connect({ host: '127.0.0.1', port });
    const pending = client.call('pending', {}, 1000);
    await waitForRequests(1);
    socket.close();
    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  });

  it('times out a CONNECTING handshake without an uncaught socket error', async () => {
    const sockets = new Set<net.Socket>();
    const tcp = net.createServer((tcpSocket) => {
      sockets.add(tcpSocket);
      tcpSocket.once('close', () => sockets.delete(tcpSocket));
    });
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    const hangingPort = (tcp.address() as net.AddressInfo).port;
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.prependListener('uncaughtException', onUncaught);
    try {
      await expect(BrokerClient.connect({ host: '127.0.0.1', port: hangingPort }))
        .rejects.toMatchObject({ code: 'CONNECTION_LOST' });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      for (const tcpSocket of sockets) tcpSocket.destroy();
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
    }
  }, 10_000);
});
