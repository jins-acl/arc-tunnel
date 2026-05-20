import { WebBridgeMCPServer } from './server';

async function main() {
  const port = parseInt(process.env.WS_PORT || '8765');
  const server = new WebBridgeMCPServer(port);

  try {
    // Start WebSocket server
    await server.startWebSocket();
    console.log(`WebSocket server started on port ${port}`);

    // Start MCP server
    await server.startMCP();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await server.stop();
    process.exit(0);
  });
}

main();
