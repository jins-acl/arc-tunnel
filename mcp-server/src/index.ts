import { BrokerClient } from './broker-client';
import { ensureBroker } from './broker-launcher';
import { loadBrokerConfig } from './config';
import { ArcTunnelMCPServer } from './server';

async function main(): Promise<void> {
  const config = loadBrokerConfig(process.argv.slice(2), process.env);
  await ensureBroker(config);
  const client = await BrokerClient.connect(config);
  const server = new ArcTunnelMCPServer(client);
  await server.startMCP();

  const shutdown = () => {
    client.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
