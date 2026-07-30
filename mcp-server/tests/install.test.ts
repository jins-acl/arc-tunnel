import fs from 'fs';
import os from 'os';
import path from 'path';

const installer = require('../../scripts/install.js') as {
  ensureBrokerAuthConfig: (homeDir: string, dependencies?: Record<string, unknown>) => {
    configPath: string;
    token: string;
    generated: boolean;
  };
  isValidAuthToken: (value: unknown) => boolean;
  writeConfigAtomically: (configPath: string, contents: string, dependencies?: Record<string, unknown>) => void;
};

const VALID_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('installer broker authentication configuration', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-tunnel-install-'));
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  function configPath(): string {
    return path.join(homeDir, '.arc-tunnel', 'config.json');
  }

  function writeConfig(value: string): void {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), value, 'utf8');
  }

  function temporaryFiles(): string[] {
    const directory = path.dirname(configPath());
    return fs.existsSync(directory)
      ? fs.readdirSync(directory).filter(entry => entry.includes('.tmp'))
      : [];
  }

  function ensureConfig(dependencies: Record<string, unknown> = {}) {
    return installer.ensureBrokerAuthConfig(homeDir, { log: () => undefined, ...dependencies });
  }

  it('generates a base64url token that decodes to 32 bytes', () => {
    const result = ensureConfig();

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(result.token, 'base64url')).toHaveLength(32);
    expect(installer.isValidAuthToken(result.token)).toBe(true);
  });

  it('creates missing configuration with the default port', () => {
    const result = ensureConfig();

    expect(result).toMatchObject({ configPath: configPath(), generated: true });
    expect(JSON.parse(fs.readFileSync(configPath(), 'utf8'))).toEqual({ port: 8765, token: result.token });
  });

  it('migrates a port-only configuration while retaining its custom port', () => {
    writeConfig('{"port":9123}');

    const result = ensureConfig();

    expect(result.generated).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath(), 'utf8'))).toEqual({ port: 9123, token: result.token });
  });

  it('migrates a decimal-string port-only configuration without changing its value', () => {
    writeConfig('{"port":"9123"}');

    const result = ensureConfig();

    expect(result.generated).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath(), 'utf8'))).toEqual({ port: '9123', token: result.token });
  });

  it.each([0, 65536, '0', '65536', '8.5', ' 9123', null])(
    'replaces invalid persisted port %p with the default',
    (port) => {
      writeConfig(JSON.stringify({ port }));

      const result = ensureConfig();

      expect(JSON.parse(fs.readFileSync(configPath(), 'utf8')))
        .toEqual({ port: 8765, token: result.token });
    }
  );

  it('preserves an existing valid token exactly', () => {
    const original = `{"port":9123,"token":"${VALID_TOKEN}"}`;
    writeConfig(original);

    const result = ensureConfig();

    expect(result).toEqual({ configPath: configPath(), token: VALID_TOKEN, generated: false });
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(original);
  });

  it.each(['B', 'C', 'D'])('rejects and replaces the noncanonical Base64URL alias ending in %s', (finalCharacter) => {
    const alias = `${VALID_TOKEN.slice(0, -1)}${finalCharacter}`;
    writeConfig(`{"port":9123,"token":"${alias}"}`);

    expect(installer.isValidAuthToken(alias)).toBe(false);

    const result = ensureConfig({ randomBytes: () => Buffer.alloc(32) });

    expect(result).toEqual({ configPath: configPath(), token: VALID_TOKEN, generated: true });
    expect(JSON.parse(fs.readFileSync(configPath(), 'utf8'))).toEqual({ port: 9123, token: VALID_TOKEN });
  });

  it('replaces an invalid existing token while retaining a valid custom port', () => {
    writeConfig('{"port":9123,"token":"not-a-valid-token"}');

    const result = ensureConfig();

    expect(result.generated).toBe(true);
    expect(result.token).not.toBe('not-a-valid-token');
    expect(JSON.parse(fs.readFileSync(configPath(), 'utf8'))).toEqual({ port: 9123, token: result.token });
  });

  it('replaces an invalid token without changing a decimal-string custom port', () => {
    writeConfig('{"port":"9123","token":"not-a-valid-token"}');

    const result = ensureConfig();

    expect(result.generated).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath(), 'utf8'))).toEqual({ port: '9123', token: result.token });
  });

  it('rejects malformed configuration without overwriting its bytes', () => {
    const original = '{';
    writeConfig(original);

    expect(() => ensureConfig()).toThrow(`Invalid Arc Tunnel config: ${configPath()}`);
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(original);
  });

  it('atomically renames a completed temporary configuration without leaving it behind', () => {
    installer.writeConfigAtomically(configPath(), '{"port":8765}', { randomBytes: () => Buffer.from('unique') });

    expect(fs.readFileSync(configPath(), 'utf8')).toBe('{"port":8765}');
    expect(temporaryFiles()).toEqual([]);
  });

  it('preserves previous configuration bytes and removes the temporary file when rename fails', () => {
    const original = '{"port":9123,"token":"old"}';
    writeConfig(original);
    const failingFs = {
      ...fs,
      renameSync: () => { throw new Error('rename failed'); }
    };

    expect(() => installer.writeConfigAtomically(configPath(), '{"port":8765}', {
      fs: failingFs,
      randomBytes: () => Buffer.from('unique')
    })).toThrow('rename failed');
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(original);
    expect(temporaryFiles()).toEqual([]);
  });

  it('preserves previous configuration bytes and removes the temporary file when final permission setup fails', () => {
    const original = '{"port":9123,"token":"old"}';
    writeConfig(original);
    const failingFs = {
      ...fs,
      chmodSync: () => { throw new Error('chmod failed'); }
    };

    expect(() => installer.writeConfigAtomically(configPath(), '{"port":8765}', {
      fs: failingFs,
      randomBytes: () => Buffer.from('unique')
    })).toThrow('chmod failed');
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(original);
    expect(temporaryFiles()).toEqual([]);
  });

  it('prints a newly generated token once with the browser extension popup instruction', () => {
    const messages: string[] = [];
    const result = installer.ensureBrokerAuthConfig(homeDir, { log: (message: string) => messages.push(message) });
    const output = messages.join('\n');

    expect(output).toContain(result.token);
    expect(output.match(new RegExp(result.token, 'g'))).toHaveLength(1);
    expect(output).toMatch(/browser extension popup/i);
  });

  it('labels a generated file token as fallback when a valid environment token is effective', () => {
    const messages: string[] = [];
    const warnings: string[] = [];
    const environmentToken = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA';
    const result = installer.ensureBrokerAuthConfig(homeDir, {
      env: { ARC_TUNNEL_TOKEN: environmentToken },
      log: (message: string) => messages.push(message),
      warn: (message: string) => warnings.push(message)
    });
    const output = [...messages, ...warnings].join('\n');

    expect(result.generated).toBe(true);
    expect(output).toContain(result.token);
    expect(output.match(new RegExp(result.token, 'g'))).toHaveLength(1);
    expect(output).toMatch(/fallback/i);
    expect(output).toMatch(/effective environment token/i);
    expect(output).toMatch(/controlled source/i);
    expect(output).toMatch(/unset.+restart/i);
    expect(output).not.toContain(environmentToken);
    expect(output).not.toMatch(new RegExp(`paste[^\\n]*${result.token}`, 'i'));
  });

  it.each([
    ['empty', ''],
    ['malformed', 'not-a-valid-token']
  ])('warns that a present %s environment override blocks startup without leaking it', (_label, environmentToken) => {
    const messages: string[] = [];
    const warnings: string[] = [];
    const result = installer.ensureBrokerAuthConfig(homeDir, {
      env: { ARC_TUNNEL_TOKEN: environmentToken },
      log: (message: string) => messages.push(message),
      warn: (message: string) => warnings.push(message)
    });
    const output = [...messages, ...warnings].join('\n');

    expect(result.generated).toBe(true);
    expect(warnings.join('\n')).toMatch(/ARC_TUNNEL_TOKEN/i);
    expect(warnings.join('\n')).toMatch(/remove|replace/i);
    expect(warnings.join('\n')).toMatch(/before (?:Broker )?startup/i);
    if (environmentToken) expect(output).not.toContain(environmentToken);
    expect(output).not.toMatch(new RegExp(`paste[^\\n]*${result.token}`, 'i'));
  });

  it('reports a valid environment override as effective without printing either preserved secret', () => {
    const environmentToken = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA';
    writeConfig(`{"token":"${VALID_TOKEN}"}`);
    const messages: string[] = [];

    const result = installer.ensureBrokerAuthConfig(homeDir, {
      env: { ARC_TUNNEL_TOKEN: environmentToken },
      log: (message: string) => messages.push(message)
    });
    const output = messages.join('\n');

    expect(result.generated).toBe(false);
    expect(output).toMatch(/effective environment token/i);
    expect(output).toMatch(/controlled source/i);
    expect(output).toMatch(/unset.+restart/i);
    expect(output).not.toContain(environmentToken);
    expect(output).not.toContain(VALID_TOKEN);
  });

  it('warns about an invalid present environment override even when the file token is valid', () => {
    const environmentToken = 'still-not-a-valid-token';
    writeConfig(`{"token":"${VALID_TOKEN}"}`);
    const warnings: string[] = [];

    const result = installer.ensureBrokerAuthConfig(homeDir, {
      env: { ARC_TUNNEL_TOKEN: environmentToken },
      warn: (message: string) => warnings.push(message)
    });
    const output = warnings.join('\n');

    expect(result.generated).toBe(false);
    expect(output).toMatch(/ARC_TUNNEL_TOKEN/i);
    expect(output).toMatch(/remove|replace/i);
    expect(output).toMatch(/before (?:Broker )?startup/i);
    expect(output).not.toContain(environmentToken);
    expect(output).not.toContain(VALID_TOKEN);
  });

  it('does not print a preserved token', () => {
    writeConfig(`{"token":"${VALID_TOKEN}"}`);
    const messages: string[] = [];

    const result = installer.ensureBrokerAuthConfig(homeDir, { log: (message: string) => messages.push(message) });

    expect(result.generated).toBe(false);
    expect(messages.join('\n')).not.toContain(VALID_TOKEN);
  });
});
