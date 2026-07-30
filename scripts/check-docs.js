#!/usr/bin/env node
/** Deterministic repository documentation and template assertions. */

const fs = require('fs');

const read = (file) => fs.readFileSync(file, 'utf8');
const parsePackage = (file) => JSON.parse(read(file));
const assertOrdered = (label, content, markers) => {
  const normalized = content.replace(/\s+/g, ' ');
  let offset = -1;
  for (const marker of markers) {
    const next = normalized.indexOf(marker.replace(/\s+/g, ' '), offset + 1);
    if (next < 0) throw new Error(`${label} is missing ordered migration step: ${marker}`);
    if (next <= offset) throw new Error(`${label} has migration steps out of order: ${marker}`);
    offset = next;
  }
};
const fencedBlocks = content =>
  [...content.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)```/g)].map(match => match[1]);
const hasStandaloneTokenFlag = content =>
  /(?:^|[\s"',\[\]])--token(?=$|[\s="',\[\]])/m.test(content);
const yamlBlock = (content, key) => {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex(line => new RegExp(`^(\\s*)${key}:\\s*$`).test(line));
  if (start < 0) throw new Error(`YAML template is missing ${key}`);
  const indent = lines[start].match(/^\s*/)[0].length;
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && line.match(/^\s*/)[0].length <= indent) break;
    block.push(line);
  }
  return block;
};
const assertSafeTemplateShape = (file, args, envKeys) => {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) {
    throw new Error(`${file} must contain a string args list`);
  }
  if (args.some(value => value.includes('--token'))) {
    throw new Error(`${file} must not place a token flag in args`);
  }
  if (envKeys.some(key => /token/i.test(key))) {
    throw new Error(`${file} must not place a token key in env`);
  }
};
const assertSafeWebSocketUrls = (file, content) => {
  for (const match of content.matchAll(/wss?:\/\/[^\s"'`<>),]+/gi)) {
    const raw = match[0].replace(/[.;:]+$/, '');
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${file} contains an invalid WebSocket URL example`);
    }
    const afterScheme = raw.slice(raw.indexOf('://') + 3);
    const location = `${url.pathname}${url.search}${url.hash}`;
    if (url.username || url.password
      || /token/i.test(afterScheme)
      || /(?:^|[/?#&;])(?:token|auth(?:entication)?|credential)(?:[=/:~-]|$)/i.test(location)
      || /(?:^|[/?#&;=:@])[A-Za-z0-9_-]{43}(?=$|[/?#&;=:@])/.test(location)) {
      throw new Error(`${file} contains a credential-bearing WebSocket URL example`);
    }
  }
};
const unsafeWebSocketContractCases = [
  'ws://secret@127.0.0.1:8765/extension',
  'ws://127.0.0.1:8765/token/secret',
  'ws://127.0.0.1:8765/extension?token=secret',
  'ws://127.0.0.1:8765/extension?access_token=secret',
  'ws://127.0.0.1:8765/extension?brokerToken=secret',
  'ws://127.0.0.1:8765/extension#authToken=secret'
];
const missedUnsafeWebSocketCases = unsafeWebSocketContractCases.filter(example => {
  try {
    assertSafeWebSocketUrls('synthetic WebSocket guard contract', example);
    return true;
  } catch {
    return false;
  }
});
if (missedUnsafeWebSocketCases.length) {
  throw new Error(`WebSocket URL guard missed credential cases: ${missedUnsafeWebSocketCases.join(', ')}`);
}
const root = parsePackage('package.json');
const mcp = parsePackage('mcp-server/package.json');
const extension = parsePackage('extension/package.json');
const mcpLock = parsePackage('mcp-server/package-lock.json');
const extensionLock = parsePackage('extension/package-lock.json');

for (const [label, pkg, lock] of [
  ['mcp-server', mcp, mcpLock],
  ['extension', extension, extensionLock]
]) {
  if (lock.name !== pkg.name) throw new Error(`${label} lock name must match package metadata`);
  if (lock.packages?.['']?.name !== pkg.name) {
    throw new Error(`${label} lock root package name must match package metadata`);
  }
  if (lock.packages?.['']?.license !== pkg.license) {
    throw new Error(`${label} lock root package license must match package metadata`);
  }
}

if (root.private !== true) throw new Error('Root package must be private');
if (root.license !== 'MIT' || mcp.license !== 'MIT' || extension.license !== 'MIT') {
  throw new Error('Every package must use MIT');
}
for (const command of ['test', 'typecheck', 'build', 'verify']) {
  if (typeof root.scripts?.[command] !== 'string') throw new Error(`Missing root script: ${command}`);
}

for (const file of ['LICENSE', '.github/workflows/verify.yml']) {
  if (!fs.existsSync(file)) throw new Error(`Missing repository file: ${file}`);
}

const docs = ['README.md', 'AGENTS.md'];
const requiredDocText = [
  'CLI `--port` → `WS_PORT` → `~/.arc-tunnel/config.json` → `8765`',
  '127.0.0.1',
  'http://',
  'https://',
  'chrome-extension://',
  '/extension',
  '15 seconds',
  'claim_tab',
  'release_tab',
  'start_recording',
  'stop_recording',
  'replay_recording',
  'save_session',
  'restore_session',
  'diagnose',
  '/dashboard',
  'npm run verify',
  'URLs, IDs, cookies, scripts, parameters, and page content',
  'mcp-server/dist/mcp-server.js',
  'mcp-server/dist/arc-tunnel-broker.js',
  'mcp-server/dist/arc-tunnel-control.js',
  'extension/dist/'
];

for (const file of docs) {
  const content = read(file);
  for (const text of requiredDocText) {
    if (!content.includes(text)) throw new Error(`${file} is missing: ${text}`);
  }
}

const readme = read('README.md');
for (const text of [
  '{ "port": 8765, "token": "..." }',
  '`ARC_TUNNEL_TOKEN` 优先于用户级配置文件',
  '令牌不放在命令行参数或 WebSocket URL 中',
  '安装器只在首次生成令牌时显示一次',
  '扩展弹窗中的密码输入框',
  '`auth_failed`',
  'Node.js `>=22`',
  'npm run audit:prod',
  '本地 Broker 能力边界',
  '共享浏览器配置文件',
  'node scripts/install.js',
  'Authentication failed',
  '正确的生效令牌',
  '`ARC_TUNNEL_TOKEN` 已设置时，扩展必须使用同一个生效令牌',
  '取消环境覆盖后重启 Broker 和所有 Agent 客户端',
  'node scripts/verify-browser-resilience.js',
  'node scripts/verify-multi-agent.js'
]) {
  if (!readme.includes(text)) throw new Error(`README.md is missing authentication guidance: ${text}`);
}

const agents = read('AGENTS.md');
for (const text of [
  '{ "port": 8765, "token": "..." }',
  '`ARC_TUNNEL_TOKEN` takes precedence over the file token',
  'Node.js `>=22`',
  'npm run audit:prod',
  'local Broker capability boundary',
  'node scripts/install.js',
  'Authentication failed',
  'correct effective token',
  'When `ARC_TUNNEL_TOKEN` is set, the extension must use that same effective token',
  'node scripts/verify-browser-resilience.js',
  'node scripts/verify-multi-agent.js'
]) {
  if (!agents.includes(text)) throw new Error(`AGENTS.md is missing authentication guidance: ${text}`);
}
if (!/unset the environment override, restart the Broker\s+and every Agent client/.test(agents)) {
  throw new Error('AGENTS.md is missing restart guidance after unsetting the environment override');
}

const readmeMigration = readme.slice(readme.indexOf('### 认证迁移'));
assertOrdered('README.md', readmeMigration, [
  'node scripts/install.js',
  '重新加载 `extension/dist/`',
  '粘贴并保存同一个生效令牌',
  '`Connected`',
  'node scripts/start.js diagnose --json'
]);
const agentsMigration = agents.slice(agents.indexOf('For migration,'));
assertOrdered('AGENTS.md', agentsMigration, [
  'node scripts/install.js',
  'reload `extension/dist/`',
  'paste and Save the same effective token',
  '`Connected`',
  'node scripts/start.js diagnose --json'
]);
assertOrdered('README.md authentication recovery', readme.slice(readme.indexOf('认证恢复需要')), [
  '格式有效但内容错误',
  'Authentication failed',
  '正确的生效令牌',
  '`Connected`'
]);
assertOrdered('AGENTS.md authentication recovery', agents.slice(agents.indexOf('Real-browser authentication recovery')), [
  'valid-format but incorrect',
  'Authentication failed',
  'correct effective token',
  '`Connected`'
]);

for (const [file, content] of [
  ['README.md', readme],
  ['AGENTS.md', agents],
  ['configs/kimi.md', read('configs/kimi.md')]
]) {
  for (const block of fencedBlocks(content)) {
    if (hasStandaloneTokenFlag(block)) {
      throw new Error(`${file} contains a token flag in a fenced command/config example`);
    }
  }
}

for (const file of [
  'README.md',
  'AGENTS.md',
  'docs/superpowers/specs/2026-07-30-arc-tunnel-lightweight-auth-hardening-design.md',
  ...fs.readdirSync('configs').map(name => `configs/${name}`)
]) {
  assertSafeWebSocketUrls(file, read(file));
}

if (!read('AGENTS.md').includes('mcp-server/dist/arc-tunnel-control.js')) {
  throw new Error('AGENTS.md is missing the committed lifecycle artifact');
}
if (!read('extension/src/background/tab-manager.ts').includes('idleDetachDelayMs = 15000')) {
  throw new Error('Documented debugger detach grace differs from source');
}

const configFiles = [
  'configs/claude-code.json',
  'configs/hermes.yaml',
  'configs/openclaw.json',
  'configs/codex-skill.yaml',
  'configs/kimi.md'
];
for (const file of configFiles) {
  const content = read(file);
  for (const text of ['command', 'mcp-server/dist/mcp-server.js', 'WS_PORT', '8765']) {
    if (!content.includes(text)) throw new Error(`${file} is missing invariant: ${text}`);
  }
  if (!content.includes('~/.arc-tunnel/config.json')) {
    throw new Error(`${file} must explain that authentication is read from the user-level Arc Tunnel config`);
  }
  if (/(?:^|["'\s])ARC_TUNNEL_TOKEN(?:["'\s:]|$)/m.test(content)) {
    throw new Error(`${file} must not embed an authentication token environment variable`);
  }
  if (/(?:^|["'\s])token["']?\s*:/im.test(content)) {
    throw new Error(`${file} must not embed an authentication token field`);
  }
}

for (const file of ['configs/claude-code.json', 'configs/openclaw.json']) {
  const server = JSON.parse(read(file)).mcpServers?.['arc-tunnel'];
  assertSafeTemplateShape(file, server?.args, Object.keys(server?.env || {}));
}
for (const file of ['configs/hermes.yaml', 'configs/codex-skill.yaml']) {
  const content = read(file);
  const args = yamlBlock(content, 'args')
    .map(line => line.match(/^\s*-\s*["']?([^"']+)["']?\s*$/)?.[1])
    .filter(Boolean);
  const envKeys = yamlBlock(content, 'env')
    .map(line => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/)?.[1])
    .filter(Boolean);
  assertSafeTemplateShape(file, args, envKeys);
}
const kimiJsonBlock = fencedBlocks(read('configs/kimi.md'))
  .map(block => {
    try { return JSON.parse(block); } catch { return null; }
  })
  .find(value => value?.mcpServers?.['arc-tunnel']);
if (!kimiJsonBlock) throw new Error('configs/kimi.md must contain a parseable MCP JSON template');
const kimiServer = kimiJsonBlock.mcpServers['arc-tunnel'];
assertSafeTemplateShape('configs/kimi.md', kimiServer.args, Object.keys(kimiServer.env || {}));

const design = read('docs/superpowers/specs/2026-07-30-arc-tunnel-lightweight-auth-hardening-design.md');
if (!design.includes('**Status:** Approved')) throw new Error('Authentication design status must be Approved');
if (!/自己拥有的标签页取得非空 JPEG[\s\S]*对其他 Agent 标签页的截图请求返回 `TAB_NOT_OWNED`/.test(readme)) {
  throw new Error('README.md must require owned JPEG content and foreign TAB_NOT_OWNED');
}
if (!/non-empty JPEG image content from its owned tab,\s+while a foreign\s+screenshot returns `TAB_NOT_OWNED`/.test(agents)) {
  throw new Error('AGENTS.md must require owned JPEG content and foreign TAB_NOT_OWNED');
}

console.log('Repository documentation, packaging, and config assertions passed.');
