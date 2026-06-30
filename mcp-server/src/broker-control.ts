import { ensureBroker, getBrokerStatus, stopBroker } from './broker-launcher';
import { loadBrokerConfig } from './config';

async function main(): Promise<void> {
  const action = process.argv[2] ?? 'start';
  const config = loadBrokerConfig(process.argv.slice(3), process.env);
  if (action === 'start') {
    await ensureBroker(config);
    console.log(JSON.stringify(await getBrokerStatus(config)));
  } else if (action === 'status') {
    console.log(JSON.stringify(await getBrokerStatus(config)));
  } else if (action === 'stop') {
    await stopBroker(config);
    console.log(JSON.stringify({ running: false, port: config.port }));
  } else {
    throw new Error(`Unknown broker action: ${action}`);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
