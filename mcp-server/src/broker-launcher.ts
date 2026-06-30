import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { BrokerConfig } from './config';
import { ArcTunnelError, ErrorCode, PROTOCOL_VERSION } from './protocol';

interface Health { name: 'arc-tunnel'; protocolVersion: number; pid: number; port: number; }
interface LockFile { pid: number; port: number; protocolVersion: number; }
type Probe = { kind: 'absent' } | { kind: 'foreign' } | { kind: 'arc'; health: Health };

export interface BrokerStatus {
  running: boolean;
  port: number;
  protocolVersion?: number;
  pid?: number;
}

interface LauncherOptions {
  homeDir?: string;
  brokerEntry?: string;
  brokerArgs?: (config: BrokerConfig) => string[];
  startupTimeout?: number;
  spawnProcess?: typeof spawn;
}

export function createBrokerLauncher(options: LauncherOptions = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const arcDir = path.join(homeDir, '.arc-tunnel');
  const lockPath = path.join(arcDir, 'broker.lock');
  const brokerEntry = options.brokerEntry ?? path.resolve(__dirname, '../dist/arc-tunnel-broker.js');
  const brokerArgs = options.brokerArgs ?? ((config: BrokerConfig) => ['--port', String(config.port)]);
  const startupTimeout = options.startupTimeout ?? 5_000;
  const spawnProcess = options.spawnProcess ?? spawn;
  const starting = new Map<number, Promise<void>>();

  async function probe(config: BrokerConfig): Promise<Probe> {
    return new Promise((resolve) => {
      const request = http.get({ hostname: '127.0.0.1', port: config.port, path: '/health', timeout: 250 }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          if (response.statusCode !== 200) return resolve({ kind: 'foreign' });
          try {
            const health = JSON.parse(body) as Partial<Health>;
            if (health.name === 'arc-tunnel' && health.protocolVersion === PROTOCOL_VERSION
              && typeof health.pid === 'number' && health.port === config.port) {
              resolve({ kind: 'arc', health: health as Health });
            } else resolve({ kind: 'foreign' });
          } catch { resolve({ kind: 'foreign' }); }
        });
      });
      request.once('timeout', () => request.destroy());
      request.once('error', (error: NodeJS.ErrnoException) => {
        const absent = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'];
        resolve({ kind: absent.includes(error.code || '') ? 'absent' : 'foreign' });
      });
    });
  }

  function pidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  function readLock(): LockFile | null {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<LockFile>;
      return typeof lock.pid === 'number' && typeof lock.port === 'number' && typeof lock.protocolVersion === 'number'
        ? lock as LockFile : null;
    } catch { return null; }
  }

  function removeLock(): void {
    try { fs.unlinkSync(lockPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async function waitForBroker(config: BrokerConfig, deadline: number): Promise<void> {
    while (Date.now() <= deadline) {
      const result = await probe(config);
      if (result.kind === 'arc') return;
      if (result.kind === 'foreign') throw new ArcTunnelError(ErrorCode.PORT_IN_USE, `Port ${config.port} is not Arc Tunnel`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new ArcTunnelError(ErrorCode.CONNECTION_LOST, `Broker did not become healthy within ${startupTimeout}ms`);
  }

  async function launch(config: BrokerConfig): Promise<void> {
    const deadline = Date.now() + startupTimeout;
    while (true) {
      const current = await probe(config);
      if (current.kind === 'arc') return;
      if (current.kind === 'foreign') throw new ArcTunnelError(ErrorCode.PORT_IN_USE, `Port ${config.port} is already in use`);
      fs.mkdirSync(arcDir, { recursive: true });

      let fd: number;
      try { fd = fs.openSync(lockPath, 'wx'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const lock = readLock();
        const lockProbe = lock ? await probe({ host: '127.0.0.1', port: lock.port }) : { kind: 'absent' as const };
        if (lockProbe.kind === 'arc') {
          if (lock?.port === config.port) return;
          throw new ArcTunnelError(ErrorCode.PORT_IN_USE, `Arc Tunnel Broker is already running on port ${lock?.port}`);
        }
        if (!lock || !pidAlive(lock.pid)) {
          removeLock();
          continue;
        }
        await waitForBroker(config, deadline);
        return;
      }

      let child: ChildProcess | undefined;
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, port: config.port, protocolVersion: PROTOCOL_VERSION }));
        fs.closeSync(fd);
        child = spawnProcess(process.execPath, [brokerEntry, ...brokerArgs(config)], {
          detached: true, stdio: 'ignore', windowsHide: true
        });
        child.unref();
        if (typeof child.pid !== 'number') throw new Error('Broker process did not provide a pid');
        fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, port: config.port, protocolVersion: PROTOCOL_VERSION }));
        await waitForBroker(config, deadline);
        return;
      } catch (error) {
        if (child?.pid) try { process.kill(child.pid); } catch { /* already exited */ }
        removeLock();
        throw error;
      }
    }
  }

  async function ensureBroker(config: BrokerConfig): Promise<void> {
    const existing = starting.get(config.port);
    if (existing) return existing;
    const promise = launch(config).finally(() => starting.delete(config.port));
    starting.set(config.port, promise);
    return promise;
  }

  async function getBrokerStatus(config: BrokerConfig): Promise<BrokerStatus> {
    const result = await probe(config);
    if (result.kind !== 'arc') return { running: false, port: config.port };
    return { running: true, port: config.port, protocolVersion: result.health.protocolVersion, pid: result.health.pid };
  }

  async function stopBroker(config: BrokerConfig): Promise<void> {
    const result = await probe(config);
    if (result.kind === 'foreign') throw new ArcTunnelError(ErrorCode.PORT_IN_USE, `Port ${config.port} is not Arc Tunnel`);
    if (result.kind === 'arc') {
      try { process.kill(result.health.pid, 'SIGTERM'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      const deadline = Date.now() + startupTimeout;
      while (Date.now() <= deadline && (await probe(config)).kind === 'arc') {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const lock = readLock();
    if (!lock || lock.port === config.port) removeLock();
  }

  return { ensureBroker, getBrokerStatus, stopBroker };
}

const defaultLauncher = createBrokerLauncher();
export const ensureBroker = defaultLauncher.ensureBroker;
export const getBrokerStatus = defaultLauncher.getBrokerStatus;
export const stopBroker = defaultLauncher.stopBroker;
