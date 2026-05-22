import { ArcTunnelMCPServer } from '../src/server';

describe('ArcTunnelMCPServer', () => {
  let server: ArcTunnelMCPServer;

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('should initialize server', () => {
    server = new ArcTunnelMCPServer(8767);
    expect(server).toBeDefined();
  });

  it('should start WebSocket server', async () => {
    server = new ArcTunnelMCPServer(8768);
    await server.startWebSocket();
    expect(server.isWebSocketRunning()).toBe(true);
  });
});
