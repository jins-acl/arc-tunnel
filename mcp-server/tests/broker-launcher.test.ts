import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createBrokerLauncher } from '../src/broker-launcher';

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function connectionCleanup(server: http.Server): () => void {
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return () => {
    for (const socket of sockets) socket.destroy();
  };
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

  it('does not delete an empty lock while its owner is starting the Broker', async () => {
    const config = { host: '127.0.0.1' as const, port };
    const lockDir = path.join(homeDir, '.arc-tunnel');
    const lockPath = path.join(lockDir, 'broker.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.closeSync(fs.openSync(lockPath, 'wx'));
    const externalStart = new Promise<void>((resolve) => setTimeout(() => {
      const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'fake-broker.js'), String(port), countFile], {
        detached: true, stdio: 'ignore', windowsHide: true
      });
      child.unref();
      fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, port, protocolVersion: 2 }));
      resolve();
    }, 75));
    const contender = createBrokerLauncher({
      homeDir,
      brokerEntry: path.join(__dirname, 'fixtures', 'fake-broker.js'),
      brokerArgs: () => [String(port), countFile]
    });

    await Promise.all([launcher.ensureBroker(config), contender.ensureBroker(config), externalStart]);
    await new Promise((resolve) => setTimeout(resolve, 100));

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

  it.each([
    [{ name: 'arc-tunnel', protocolVersion: 2, pid: 42 }, 'healthy'],
    [{ name: 'arc-tunnel', protocolVersion: 99, pid: 42 }, 'incompatible'],
    [{ name: 'other-service' }, 'foreign']
  ])('classifies endpoint health %j as %s', async (health, kind) => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(request.url === '/health' ? { ...health, port } : {
        broker: { pid: 42, port, protocolVersion: 2, uptimeMs: 10 },
        extension: { connected: false, generation: 0, reconnectPhase: 'idle', lastSyncAt: null },
        agents: { connected: 0, grace: 0 }, workload: { claimedTabs: 0, pendingCommands: 0 },
        recovery: { inventorySync: 'idle', recordingCleanup: 'idle' }, recentError: null
      }));
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    await expect(launcher.inspectBroker({ host: '127.0.0.1', port })).resolves.toMatchObject({ kind });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('classifies a closed endpoint as absent', async () => {
    await expect(launcher.inspectBroker({ host: '127.0.0.1', port })).resolves.toEqual({ kind: 'absent', port });
  });

  it('reports unavailable diagnostics only after compatible Arc Tunnel health', async () => {
    const server = http.createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ name: 'arc-tunnel', protocolVersion: 2, pid: 42, port }));
      } else { response.writeHead(503); response.end('unavailable'); }
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    await expect(launcher.inspectBroker({ host: '127.0.0.1', port })).resolves.toMatchObject({
      kind: 'diagnostics-unavailable', port, pid: 42, protocolVersion: 2
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('treats a foreign listener that never sends health headers as PORT_IN_USE', async () => {
    let respond = false;
    const foreign = http.createServer((_request, response) => {
      if (respond) { response.writeHead(200); response.end('foreign'); }
    });
    const destroyConnections = connectionCleanup(foreign);
    await new Promise<void>((resolve) => foreign.listen(port, '127.0.0.1', resolve));
    const bounded = createBrokerLauncher({ homeDir, startupTimeout: 100 });
    const lockDir = path.join(homeDir, '.arc-tunnel');
    const lockPath = path.join(lockDir, 'broker.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, port, protocolVersion: 2 }));
    const started = Date.now();
    const pending = bounded.ensureBroker({ host: '127.0.0.1', port })
      .then(() => ({ code: 'STARTED' }), (error) => ({ code: error.code }));
    const outcome = await Promise.race([
      pending,
      new Promise<{ code: string }>((resolve) => setTimeout(() => resolve({ code: 'HUNG' }), 400))
    ]);
    respond = true;
    destroyConnections();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
    fs.rmSync(lockPath, { force: true });
    expect(outcome).toMatchObject({ code: 'PORT_IN_USE' });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('does not spawn when a foreign listener accepts and resets health connections', async () => {
    const foreign = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => foreign.listen(port, '127.0.0.1', resolve));
    const bounded = createBrokerLauncher({
      homeDir,
      startupTimeout: 100,
      brokerEntry: path.join(__dirname, 'fixtures', 'fake-broker.js'),
      brokerArgs: () => [String(port), countFile]
    });
    const outcome = await bounded.ensureBroker({ host: '127.0.0.1', port })
      .then(() => ({ code: 'STARTED' }), (error) => ({ code: error.code }));
    await new Promise<void>((resolve) => foreign.close(() => resolve()));

    expect(outcome).toMatchObject({ code: 'PORT_IN_USE' });
    expect(fs.existsSync(countFile)).toBe(false);
  });

  it('uses an absolute health deadline even when a foreign response keeps sending chunks', async () => {
    let stream = true;
    const foreign = http.createServer((_request, response) => {
      if (!stream) {
        response.writeHead(200);
        response.end('foreign');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      const timer = setInterval(() => response.write(' '), 10);
      response.once('close', () => clearInterval(timer));
    });
    const destroyConnections = connectionCleanup(foreign);
    await new Promise<void>((resolve) => foreign.listen(port, '127.0.0.1', resolve));
    const bounded = createBrokerLauncher({ homeDir, startupTimeout: 120 });
    const lockDir = path.join(homeDir, '.arc-tunnel');
    const lockPath = path.join(lockDir, 'broker.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, port, protocolVersion: 2 }));
    const started = Date.now();
    const pending = bounded.ensureBroker({ host: '127.0.0.1', port })
      .then(() => ({ code: 'STARTED' }), (error) => ({ code: error.code }));
    const outcome = await Promise.race([
      pending,
      new Promise<{ code: string }>((resolve) => setTimeout(() => resolve({ code: 'HUNG' }), 400))
    ]);
    stream = false;
    destroyConnections();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
    fs.rmSync(lockPath, { force: true });
    expect(outcome).toMatchObject({ code: 'PORT_IN_USE' });
    expect(Date.now() - started).toBeLessThan(500);
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

  it('does not remove an empty lock owned by a concurrent starter', async () => {
    const lockDir = path.join(homeDir, '.arc-tunnel');
    const lockPath = path.join(lockDir, 'broker.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockPath, '');
    const bounded = createBrokerLauncher({ homeDir, startupTimeout: 100 });

    const outcome = await bounded.stopBroker({ host: '127.0.0.1', port })
      .then(() => ({ code: 'STOPPED' }), (error) => ({ code: error.code }));
    const lockContents = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null;
    fs.rmSync(lockPath, { force: true });

    expect(outcome).toMatchObject({ code: 'CONNECTION_LOST' });
    expect(lockContents).toBe('');
  });

  it('does not remove a matching startup lock whose recorded process is alive', async () => {
    const lockDir = path.join(homeDir, '.arc-tunnel');
    const lockPath = path.join(lockDir, 'broker.lock');
    const raw = JSON.stringify({ pid: process.pid, port, protocolVersion: 2 });
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockPath, raw);
    const bounded = createBrokerLauncher({ homeDir, startupTimeout: 100 });

    const outcome = await bounded.stopBroker({ host: '127.0.0.1', port })
      .then(() => ({ code: 'STOPPED' }), (error) => ({ code: error.code }));
    const lockContents = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null;
    fs.rmSync(lockPath, { force: true });

    expect(outcome).toMatchObject({ code: 'CONNECTION_LOST' });
    expect(lockContents).toBe(raw);
  });

  it('removes a genuinely stale dead-process lock when health is absent', async () => {
    const lockDir = path.join(homeDir, '.arc-tunnel');
    const lockPath = path.join(lockDir, 'broker.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, port, protocolVersion: 2 }));

    await launcher.stopBroker({ host: '127.0.0.1', port });

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('retains a replacement lock when ownership changes before stale unlink', async () => {
    const lockDir = path.join(homeDir, '.arc-tunnel');
    const lockPath = path.join(lockDir, 'broker.lock');
    const replacement = JSON.stringify({ pid: process.pid, port, protocolVersion: 2 });
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, port, protocolVersion: 2 }));
    const originalRead = fs.readFileSync.bind(fs);
    let lockReads = 0;
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options: any) => {
      if (String(file) === lockPath && ++lockReads === 2) fs.writeFileSync(lockPath, replacement);
      return originalRead(file, options);
    }) as typeof fs.readFileSync);

    let outcome: { code: string };
    try {
      outcome = await launcher.stopBroker({ host: '127.0.0.1', port })
        .then(() => ({ code: 'STOPPED' }), (error) => ({ code: error.code }));
    } finally {
      readSpy.mockRestore();
    }
    const lockContents = fs.readFileSync(lockPath, 'utf8');
    fs.rmSync(lockPath, { force: true });

    expect(outcome!).toMatchObject({ code: 'CONNECTION_LOST' });
    expect(lockContents).toBe(replacement);
  });

  it('retains the lock and fails when a Broker remains healthy after stop timeout', async () => {
    const health = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ name: 'arc-tunnel', protocolVersion: 2, pid: 2147483647, port }));
    });
    await new Promise<void>((resolve) => health.listen(port, '127.0.0.1', resolve));
    const lockDir = path.join(homeDir, '.arc-tunnel');
    const lockPath = path.join(lockDir, 'broker.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, port, protocolVersion: 2 }));
    const bounded = createBrokerLauncher({ homeDir, startupTimeout: 100 });

    const outcome = await bounded.stopBroker({ host: '127.0.0.1', port })
      .then(() => ({ code: 'STOPPED', message: '' }), (error) => ({ code: error.code, message: error.message }));
    const lockExists = fs.existsSync(lockPath);
    await new Promise<void>((resolve) => health.close(() => resolve()));
    expect(outcome).toMatchObject({ code: 'CONNECTION_LOST', message: expect.stringContaining('did not stop') });
    expect(lockExists).toBe(true);
  });
});
