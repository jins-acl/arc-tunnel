import fs from 'fs';
import os from 'os';
import path from 'path';
import { isValidAuthToken } from './auth-token';

export interface BrokerEndpointConfig {
  host: '127.0.0.1';
  port: number;
}

export interface BrokerConfig extends BrokerEndpointConfig {
  token: string;
}

export interface ResolveOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  fileConfig: { port?: unknown; token?: unknown } | null;
}

function parsePort(value: unknown): number {
  const text = String(value);

  if (!/^\d+$/.test(text)) {
    throw new Error(`Invalid Arc Tunnel port: ${text}`);
  }

  const port = Number(text);
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid Arc Tunnel port: ${text}`);
  }

  return port;
}

export function resolveBrokerConfig(options: ResolveOptions): BrokerEndpointConfig {
  const index = options.argv.indexOf('--port');
  const raw = index >= 0
    ? options.argv[index + 1]
    : options.env.WS_PORT ?? options.fileConfig?.port ?? 8765;

  return {
    host: '127.0.0.1',
    port: parsePort(raw)
  };
}

function loadFileConfig(homeDir: string): { port?: unknown; token?: unknown } | null {
  const configPath = path.join(homeDir, '.arc-tunnel', 'config.json');

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw) as { port?: unknown; token?: unknown };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      throw new Error(`Invalid Arc Tunnel config: ${configPath}`);
    }
    return null;
  }
}

export function loadBrokerEndpointConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  homeDir: string = os.homedir()
): BrokerEndpointConfig {
  return resolveBrokerConfig({ argv, env, fileConfig: loadFileConfig(homeDir) });
}

export function loadBrokerConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  homeDir: string = os.homedir()
): BrokerConfig {
  const fileConfig = loadFileConfig(homeDir);
  const endpoint = resolveBrokerConfig({ argv, env, fileConfig });
  const token = env.ARC_TUNNEL_TOKEN ?? fileConfig?.token;

  if (!isValidAuthToken(token)) {
    throw new Error('Arc Tunnel authentication token is missing or invalid. Run node scripts/install.js to configure it.');
  }

  return { ...endpoint, token };
}
