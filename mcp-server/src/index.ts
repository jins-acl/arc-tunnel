import { WebBridgeMCPServer } from './server';

async function main() {
  const port = parseInt(process.env.WS_PORT || '8765');
  const server = new WebBridgeMCPServer(port);

  // Start MCP immediately — Claude Code needs this, shouldn't block on WebSocket
  await server.startMCP();

  // Start WebSocket with retry — port may be held by a stale process
  server.startWebSocketWithRetry().catch((error) => {
    console.error('WebSocket server failed to start:', error);
  });

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await server.stop();
    process.exit(0);
  });
}

main();
