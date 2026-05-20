import { WebBridgeMCPServer } from '../src/server';

describe('WebBridgeMCPServer', () => {
  let server: WebBridgeMCPServer;

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('should initialize server', () => {
    server = new WebBridgeMCPServer(8767);
    expect(server).toBeDefined();
  });

  it('should start WebSocket server', async () => {
    server = new WebBridgeMCPServer(8768);
    await server.startWebSocket();
    expect(server.isWebSocketRunning()).toBe(true);
  });
});
