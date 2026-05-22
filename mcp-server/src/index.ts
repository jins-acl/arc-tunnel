import { ArcTunnelMCPServer } from './server';

async function main() {
  const port = parseInt(process.env.WS_PORT || '8765');
  const server = new ArcTunnelMCPServer(port);

  // Start WebSocket first so it's ready before MCP receives tool calls
  try {
    await server.startWebSocketWithRetry();
  } catch (error: any) {
    console.error('WebSocket server failed to start:', error.message);
    // Continue — MCP stdio can still report the connection error to the agent
  }

  // Start MCP after WebSocket is listening — Claude Code needs stdio initialize
  await server.startMCP();

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
