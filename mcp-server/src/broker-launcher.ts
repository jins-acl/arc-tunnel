import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { BrokerConfig } from './config';
import { ArcTunnelError, ErrorCode, PROTOCOL_VERSION } from './protocol';

interface Health { name: 'arc-tunnel'; protocolVersion: number; pid: number; port: number; }
interface LockFile { pid: number; port: number; protocolVersion: number; }
interface LockSnapshot { raw: string; lock: LockFile | null; }
type Probe = { kind: 'absent' } | { kind: 'foreign'; transient?: boolean } | { kind: 'arc'; health: Health };

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

  async function probe(config: BrokerConfig, deadline = Date.now() + Math.min(250, startupTimeout)): Promise<Probe> {
    return new Promise((resolve) => {
      let settled = false;
      let connected = false;
      let response: http.IncomingMessage | undefined;
      let timer: NodeJS.Timeout;
      const finish = (result: Probe) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        response?.destroy();
        request.destroy();
        resolve(result);
      };
      const request = http.get({ hostname: '127.0.0.1', port: config.port, path: '/health' }, (incoming) => {
        response = incoming;
        connected = true;
        let body = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => { body += chunk; });
        incoming.once('aborted', () => finish({ kind: 'foreign', transient: true }));
        incoming.once('error', () => finish({ kind: 'foreign', transient: true }));
        incoming.on('end', () => {
          if (incoming.statusCode !== 200) return finish({ kind: 'foreign' });
          try {
            const health = JSON.parse(body) as Partial<Health>;
            if (health.name === 'arc-tunnel' && health.protocolVersion === PROTOCOL_VERSION
              && typeof health.pid === 'number' && health.port === config.port) {
              finish({ kind: 'arc', health: health as Health });
            } else finish({ kind: 'foreign' });
          } catch { finish({ kind: 'foreign' }); }
        });
      });
      request.once('socket', (socket) => socket.once('connect', () => { connected = true; }));
      request.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET') {
          finish({ kind: 'foreign', transient: true });
          return;
        }
        const absent = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'];
        finish({ kind: !connected && absent.includes(error.code || '') ? 'absent' : 'foreign' });
      });
      const remaining = Math.max(0, deadline - Date.now());
      timer = setTimeout(() => finish({ kind: 'foreign' }), remaining);
    });
  }

  function pidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  function readLockSnapshot(): LockSnapshot | null {
    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      let value: Partial<LockFile> | null = null;
      try { value = JSON.parse(raw) as Partial<LockFile>; } catch { /* in-progress lock */ }
      const lock = value && typeof value.pid === 'number' && typeof value.port === 'number'
        && typeof value.protocolVersion === 'number' ? value as LockFile : null;
      return { raw, lock };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  function removeLock(expectedRaw?: string): boolean {
    if (expectedRaw !== undefined && readLockSnapshot()?.raw !== expectedRaw) return false;
    try {
      fs.unlinkSync(lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return false;
    }
  }

  async function waitForBroker(config: BrokerConfig, deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      const result = await probe(config, deadline);
      if (result.kind === 'arc') return;
      if (result.kind === 'foreign') throw new ArcTunnelError(ErrorCode.PORT_IN_USE, `Port ${config.port} is not Arc Tunnel`);
      const delay = Math.min(50, Math.max(0, deadline - Date.now()));
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    throw new ArcTunnelError(ErrorCode.CONNECTION_LOST, `Broker did not become healthy within ${startupTimeout}ms`);
  }

  async function waitForLockOwner(config: BrokerConfig, deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      const current = await probe(config, deadline);
      if (current.kind === 'arc') return;
      if (current.kind === 'foreign') {
        throw new ArcTunnelError(ErrorCode.PORT_IN_USE, `Port ${config.port} is not Arc Tunnel`);
      }
      const snapshot = readLockSnapshot();
      const lock = snapshot?.lock;
      if (lock && snapshot) {
        const lockProbe = lock.port === config.port
          ? current
          : await probe({ host: '127.0.0.1', port: lock.port }, deadline);
        if (lockProbe.kind === 'arc') {
          if (lock.port === config.port) return;
          throw new ArcTunnelError(ErrorCode.PORT_IN_USE, `Arc Tunnel Broker is already running on port ${lock.port}`);
        }
        if (!pidAlive(lock.pid)) {
          if (!removeLock(snapshot.raw)) continue;
          return launch(config, deadline);
        }
      }
      const delay = Math.min(25, Math.max(0, deadline - Date.now()));
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    throw new ArcTunnelError(ErrorCode.CONNECTION_LOST, `Broker lock did not become healthy within ${startupTimeout}ms`);
  }

  async function launch(config: BrokerConfig, deadline = Date.now() + startupTimeout): Promise<void> {
    while (true) {
      const current = await probe(config, deadline);
      if (current.kind === 'arc') return;
      if (current.kind === 'foreign') throw new ArcTunnelError(ErrorCode.PORT_IN_USE, `Port ${config.port} is already in use`);
      fs.mkdirSync(arcDir, { recursive: true });

      let fd: number;
      try { fd = fs.openSync(lockPath, 'wx'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await waitForLockOwner(config, deadline);
        return;
      }

      let child: ChildProcess | undefined;
      let ownedLockRaw: string | undefined;
      try {
        ownedLockRaw = JSON.stringify({ pid: process.pid, port: config.port, protocolVersion: PROTOCOL_VERSION });
        fs.writeFileSync(fd, ownedLockRaw);
        fs.closeSync(fd);
        child = spawnProcess(process.execPath, [brokerEntry, ...brokerArgs(config)], {
          detached: true, stdio: 'ignore', windowsHide: true
        });
        child.unref();
        if (typeof child.pid !== 'number') throw new Error('Broker process did not provide a pid');
        ownedLockRaw = JSON.stringify({ pid: child.pid, port: config.port, protocolVersion: PROTOCOL_VERSION });
        fs.writeFileSync(lockPath, ownedLockRaw);
        await waitForBroker(config, deadline);
        return;
      } catch (error) {
        if (child?.pid) try { process.kill(child.pid); } catch { /* already exited */ }
        if (ownedLockRaw !== undefined) removeLock(ownedLockRaw);
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
    const deadline = Date.now() + startupTimeout;
    let result = await probe(config, deadline);
    while (result.kind === 'foreign' && result.transient && Date.now() < deadline) {
      const delay = Math.min(25, Math.max(0, deadline - Date.now()));
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      result = await probe(config, deadline);
    }
    if (result.kind === 'foreign' && result.transient) {
      throw new ArcTunnelError(ErrorCode.CONNECTION_LOST, `Broker state on port ${config.port} did not settle within ${startupTimeout}ms`);
    }
    if (result.kind === 'foreign') throw new ArcTunnelError(ErrorCode.PORT_IN_USE, `Port ${config.port} is not Arc Tunnel`);
    if (result.kind === 'arc') {
      try { process.kill(result.health.pid, 'SIGTERM'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      let stillRunning = true;
      while (Date.now() < deadline) {
        const stopped = await probe(config, deadline);
        if (stopped.kind === 'absent') {
          stillRunning = false;
          break;
        }
        if (stopped.kind === 'foreign' && !stopped.transient) {
          throw new ArcTunnelError(ErrorCode.PORT_IN_USE, `Port ${config.port} is not Arc Tunnel`);
        }
        const delay = Math.min(50, Math.max(0, deadline - Date.now()));
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (stillRunning) {
        throw new ArcTunnelError(ErrorCode.CONNECTION_LOST, `Broker on port ${config.port} did not stop within ${startupTimeout}ms`);
      }
      await removeStoppedLock(config, deadline, true);
      return;
    }
    await removeStoppedLock(config, deadline, false);
  }

  async function removeStoppedLock(config: BrokerConfig, deadline: number, waitForProcess: boolean): Promise<void> {
    const snapshot = readLockSnapshot();
    if (!snapshot) return;
    if (!snapshot.lock) {
      throw new ArcTunnelError(ErrorCode.CONNECTION_LOST, 'Broker startup lock is still in progress');
    }
    if (snapshot.lock.port !== config.port) return;
    if (waitForProcess) {
      while (pidAlive(snapshot.lock.pid) && Date.now() < deadline) {
        const delay = Math.min(25, Math.max(0, deadline - Date.now()));
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    if (pidAlive(snapshot.lock.pid)) {
      throw new ArcTunnelError(ErrorCode.CONNECTION_LOST, `Broker process ${snapshot.lock.pid} is still starting or stopping`);
    }
    if (Date.now() >= deadline) {
      throw new ArcTunnelError(ErrorCode.CONNECTION_LOST, 'Broker cleanup deadline expired before ownership could be verified');
    }
    const health = await probe(config, deadline);
    if (health.kind !== 'absent') {
      throw new ArcTunnelError(ErrorCode.CONNECTION_LOST, `Broker health on port ${config.port} is not absent`);
    }
    if (!removeLock(snapshot.raw)) {
      throw new ArcTunnelError(ErrorCode.CONNECTION_LOST, 'Broker lock ownership changed during cleanup');
    }
  }

  return { ensureBroker, getBrokerStatus, stopBroker };
}

const defaultLauncher = createBrokerLauncher();
export const ensureBroker = defaultLauncher.ensureBroker;
export const getBrokerStatus = defaultLauncher.getBrokerStatus;
export const stopBroker = defaultLauncher.stopBroker;
