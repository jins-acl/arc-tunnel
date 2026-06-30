import { BrokerServer } from './broker/broker-server';
import { loadBrokerConfig } from './config';

async function main(): Promise<void> {
  const config = loadBrokerConfig(process.argv.slice(2), process.env);
  const broker = new BrokerServer(config);
  await broker.start();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      await broker.stop();
      process.exit(0);
    });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
