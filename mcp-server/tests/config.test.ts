import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadBrokerConfig, resolveBrokerConfig } from '../src/config';
import { ArcTunnelError, ErrorCode, toErrorInfo } from '../src/protocol';

describe('resolveBrokerConfig', () => {
  it('uses CLI, env, file, default precedence', () => {
    expect(resolveBrokerConfig({ argv: ['--port', '9100'], env: { WS_PORT: '9000' }, fileConfig: { port: 8900 } }).port).toBe(9100);
    expect(resolveBrokerConfig({ argv: [], env: { WS_PORT: '9000' }, fileConfig: { port: 8900 } }).port).toBe(9000);
    expect(resolveBrokerConfig({ argv: [], env: {}, fileConfig: { port: 8900 } }).port).toBe(8900);
    expect(resolveBrokerConfig({ argv: [], env: {}, fileConfig: null }).port).toBe(8765);
  });

  it.each(['0', '65536', 'abc', '8.5'])('rejects invalid port %s', (port) => {
    expect(() => resolveBrokerConfig({ argv: [], env: { WS_PORT: port }, fileConfig: null }))
      .toThrow(`Invalid Arc Tunnel port: ${port}`);
  });
});

describe('loadBrokerConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-tunnel-config-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads port from ~/.arc-tunnel/config.json when present', () => {
    const configDir = path.join(tempDir, '.arc-tunnel');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ port: 8123 }));

    expect(loadBrokerConfig([], {}, tempDir)).toEqual({ host: '127.0.0.1', port: 8123 });
  });

  it('treats a missing config file as null and falls back to defaults', () => {
    expect(loadBrokerConfig([], {}, tempDir)).toEqual({ host: '127.0.0.1', port: 8765 });
  });

  it('throws for malformed config JSON with the exact path', () => {
    const configDir = path.join(tempDir, '.arc-tunnel');
    const configPath = path.join(configDir, 'config.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, '{');

    expect(() => loadBrokerConfig([], {}, tempDir))
      .toThrow(`Invalid Arc Tunnel config: ${configPath}`);
  });
});

describe('toErrorInfo', () => {
  it('preserves ArcTunnelError codes and details', () => {
    expect(
      toErrorInfo(new ArcTunnelError(ErrorCode.PROTOCOL_MISMATCH, 'Protocol mismatch', { expected: 2, received: 1 }))
    ).toEqual({
      code: ErrorCode.PROTOCOL_MISMATCH,
      message: 'Protocol mismatch',
      details: { expected: 2, received: 1 }
    });
  });

  it('maps unknown errors to INTERNAL_ERROR', () => {
    expect(toErrorInfo(new Error('boom'))).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'boom'
    });
  });
});
