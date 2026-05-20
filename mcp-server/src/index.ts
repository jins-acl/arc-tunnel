import { WebBridgeMCPServer } from './server';

async function main() {
  const port = parseInt(process.env.WS_PORT || '8765');
  const server = new WebBridgeMCPServer(port);

  // Start MCP immediately — Claude Code needs this, shouldn't block on WebSocket
  await server.startMCP();

  // Start WebSocket with retry — port may be held by a stale process
  server.startWebSocketWithRetry().catch((error) => {
    console.error('WebSocket server failed to start:', error.message);
    // Keep process alive — MCP stdio is still functional
  });

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down...`);
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
