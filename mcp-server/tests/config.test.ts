import fs from 'fs';
import os from 'os';
import path from 'path';

import { isValidAuthToken, verifyAuthToken } from '../src/auth-token';
import { loadBrokerConfig, loadBrokerEndpointConfig, resolveBrokerConfig } from '../src/config';
import { ArcTunnelError, ErrorCode, toErrorInfo } from '../src/protocol';
import { OTHER_AUTH_TOKEN, TEST_AUTH_TOKEN } from './helpers/auth';

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

describe('authentication token', () => {
  it.each([
    ['a valid base64url token', TEST_AUTH_TOKEN, true],
    ['a 42-character token', 'A'.repeat(42), false],
    ['a 44-character token', 'A'.repeat(44), false],
    ['a token with an invalid base64url character', `${'A'.repeat(42)}!`, false],
    ['a padded token', `${'A'.repeat(42)}=`, false],
    ['a non-string value', null, false]
  ])('accepts only %s', (_description, value, expected) => {
    expect(isValidAuthToken(value)).toBe(expected);
  });

  it.each([
    ['the correct token', TEST_AUTH_TOKEN, TEST_AUTH_TOKEN, true],
    ['a different valid token', OTHER_AUTH_TOKEN, TEST_AUTH_TOKEN, false],
    ['a malformed token', `${'A'.repeat(42)}!`, TEST_AUTH_TOKEN, false],
    ['a wrong-length token', 'A'.repeat(42), TEST_AUTH_TOKEN, false],
    ['an invalid expected token', TEST_AUTH_TOKEN, 'A'.repeat(42), false]
  ])('verifies %s without accepting it', (_description, candidate, expected, result) => {
    expect(verifyAuthToken(candidate, expected)).toBe(result);
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

  function writeConfig(config: Record<string, unknown>): void {
    const configDir = path.join(tempDir, '.arc-tunnel');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));
  }

  it('loads a persisted valid token and port', () => {
    writeConfig({ port: 8123, token: TEST_AUTH_TOKEN });

    expect(loadBrokerConfig([], {}, tempDir)).toEqual({ host: '127.0.0.1', port: 8123, token: TEST_AUTH_TOKEN });
  });

  it('uses ARC_TUNNEL_TOKEN before a different persisted token', () => {
    writeConfig({ token: OTHER_AUTH_TOKEN });

    expect(loadBrokerConfig([], { ARC_TUNNEL_TOKEN: TEST_AUTH_TOKEN }, tempDir).token).toBe(TEST_AUTH_TOKEN);
  });

  it.each([
    ['a missing token', undefined],
    ['a 42-character token', 'A'.repeat(42)],
    ['a 44-character token', 'A'.repeat(44)],
    ['an invalid base64url character', `${'A'.repeat(42)}!`],
    ['a padded token', `${'A'.repeat(42)}=`]
  ])('rejects %s', (_description, token) => {
    if (token !== undefined) writeConfig({ token });

    expect(() => loadBrokerConfig([], {}, tempDir)).toThrow('node scripts/install.js');
  });

  it('does not fall back to a valid persisted token when ARC_TUNNEL_TOKEN is invalid', () => {
    writeConfig({ token: TEST_AUTH_TOKEN });

    expect(() => loadBrokerConfig([], { ARC_TUNNEL_TOKEN: OTHER_AUTH_TOKEN.slice(0, -1) }, tempDir))
      .toThrow('node scripts/install.js');
  });

  it('does not include a rejected token in an authentication error', () => {
    const rejectedToken = 'this-secret-must-not-appear';
    writeConfig({ token: rejectedToken });

    expect(() => loadBrokerConfig([], {}, tempDir)).toThrow('node scripts/install.js');
    try {
      loadBrokerConfig([], {}, tempDir);
    } catch (error) {
      expect((error as Error).message).not.toContain(rejectedToken);
    }
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

describe('loadBrokerEndpointConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-tunnel-config-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('retains CLI, WS_PORT, file, and default port precedence without a token', () => {
    const configDir = path.join(tempDir, '.arc-tunnel');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ port: 8123 }));

    expect(loadBrokerEndpointConfig(['--port', '9100'], { WS_PORT: '9000' }, tempDir)).toEqual({ host: '127.0.0.1', port: 9100 });
    expect(loadBrokerEndpointConfig([], { WS_PORT: '9000' }, tempDir)).toEqual({ host: '127.0.0.1', port: 9000 });
    expect(loadBrokerEndpointConfig([], {}, tempDir)).toEqual({ host: '127.0.0.1', port: 8123 });
    expect(loadBrokerEndpointConfig([], {}, path.join(tempDir, 'missing'))).toEqual({ host: '127.0.0.1', port: 8765 });
  });

  it('throws for malformed config JSON with the exact path', () => {
    const configDir = path.join(tempDir, '.arc-tunnel');
    const configPath = path.join(configDir, 'config.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, '{');

    expect(() => loadBrokerEndpointConfig([], {}, tempDir))
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
