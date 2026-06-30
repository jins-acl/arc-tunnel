import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { createBrokerLauncher } from '../src/broker-launcher';

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('broker launcher', () => {
  let homeDir: string;
  let countFile: string;
  let port: number;
  let launcher: ReturnType<typeof createBrokerLauncher>;

  beforeEach(async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-launcher-'));
    countFile = path.join(homeDir, 'spawns.txt');
    port = await freePort();
    launcher = createBrokerLauncher({
      homeDir,
      brokerEntry: path.join(__dirname, 'fixtures', 'fake-broker.js'),
      brokerArgs: () => [String(port), countFile]
    });
  });

  afterEach(async () => {
    await launcher.stopBroker({ host: '127.0.0.1', port });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('starts one detached broker for concurrent callers', async () => {
    const config = { host: '127.0.0.1' as const, port };
    await Promise.all([launcher.ensureBroker(config), launcher.ensureBroker(config), launcher.ensureBroker(config)]);
    await expect(launcher.getBrokerStatus(config)).resolves.toMatchObject({ running: true, protocolVersion: 2 });
    expect(fs.readFileSync(countFile, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('fails immediately when the port is not Arc Tunnel', async () => {
    const foreign = http.createServer((_request, response) => { response.writeHead(200); response.end('foreign'); });
    await new Promise<void>((resolve) => foreign.listen(port, '127.0.0.1', resolve));
    const started = Date.now();
    await expect(launcher.ensureBroker({ host: '127.0.0.1', port })).rejects.toMatchObject({ code: 'PORT_IN_USE' });
    expect(Date.now() - started).toBeLessThan(1000);
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
  });

  it('removes a stale lock only when its process and health check are both dead', async () => {
    const lockDir = path.join(homeDir, '.arc-tunnel');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'broker.lock'), JSON.stringify({
      pid: 2147483647, port, protocolVersion: 2
    }));

    await launcher.ensureBroker({ host: '127.0.0.1', port });

    const lock = JSON.parse(fs.readFileSync(path.join(lockDir, 'broker.lock'), 'utf8'));
    expect(lock).toMatchObject({ port, protocolVersion: 2 });
    expect(lock.pid).not.toBe(2147483647);
  });

  it('stops the matching broker and removes its lock', async () => {
    const config = { host: '127.0.0.1' as const, port };
    await launcher.ensureBroker(config);
    await launcher.stopBroker(config);
    await expect(launcher.getBrokerStatus(config)).resolves.toEqual({ running: false, port });
    expect(fs.existsSync(path.join(homeDir, '.arc-tunnel', 'broker.lock'))).toBe(false);
  });
});
