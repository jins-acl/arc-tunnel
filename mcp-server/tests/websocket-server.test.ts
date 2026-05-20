import { WebSocketServer } from '../src/websocket-server';
import WebSocket from 'ws';

// Use the same WS import structure for clients

describe('WebSocketServer', () => {
  let server: WebSocketServer;

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('should start and listen on specified port', async () => {
    server = new WebSocketServer(8765);
    await server.start();
    expect(server.isRunning()).toBe(true);
  });

  it('should handle client connection', (done) => {
    server = new WebSocketServer(8766);

    server.on('connection', (ws) => {
      expect(ws).toBeDefined();
      done();
    });

    server.start().then(() => {
      const client = new WebSocket('ws://localhost:8766');
      client.on('open', () => {
        // Connection established, close it
        client.close();
      });
    });
  });
});
