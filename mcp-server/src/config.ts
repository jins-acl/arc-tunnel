import fs from 'fs';
import os from 'os';
import path from 'path';

export interface BrokerConfig {
  host: '127.0.0.1';
  port: number;
}

export interface ResolveOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  fileConfig: { port?: unknown } | null;
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

export function resolveBrokerConfig(options: ResolveOptions): BrokerConfig {
  const index = options.argv.indexOf('--port');
  const raw = index >= 0
    ? options.argv[index + 1]
    : options.env.WS_PORT ?? options.fileConfig?.port ?? 8765;

  return {
    host: '127.0.0.1',
    port: parsePort(raw)
  };
}

export function loadBrokerConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  homeDir: string = os.homedir()
): BrokerConfig {
  const configPath = path.join(homeDir, '.arc-tunnel', 'config.json');
  let fileConfig: { port?: unknown } | null = null;

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    fileConfig = JSON.parse(raw) as { port?: unknown };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      throw new Error(`Invalid Arc Tunnel config: ${configPath}`);
    }
  }

  return resolveBrokerConfig({ argv, env, fileConfig });
}
