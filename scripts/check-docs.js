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
const sectionBetween = (label, content, startMarker, endMarker) => {
  const start = content.indexOf(startMarker);
  if (start < 0) throw new Error(`${label} is missing section marker: ${startMarker}`);
  const end = endMarker ? content.indexOf(endMarker, start + startMarker.length) : content.length;
  if (endMarker && end < 0) throw new Error(`${label} is missing section marker: ${endMarker}`);
  return content.slice(start, end);
};
const assertSemanticContracts = (contracts) => {
  const missing = [];
  for (const [label, content, requirements] of contracts) {
    const normalized = content.replace(/\s+/g, ' ');
    for (const [requirement, pattern] of requirements) {
      if (!pattern.test(normalized)) missing.push(`${label}: ${requirement}`);
    }
  }
  if (missing.length) {
    throw new Error(`Documentation semantic contracts are missing:\n- ${missing.join('\n- ')}`);
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
const agents = read('AGENTS.md');
const design = read('docs/superpowers/specs/2026-07-30-arc-tunnel-lightweight-auth-hardening-design.md');
const implementationPlan = read('docs/superpowers/plans/2026-07-30-arc-tunnel-lightweight-auth-hardening.md');
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
  '设置了有效的 `ARC_TUNNEL_TOKEN` 时，扩展必须使用同一个生效令牌',
  '取消环境覆盖后重启 Broker 和所有 Agent 客户端',
  'node scripts/verify-browser-resilience.js',
  'node scripts/verify-multi-agent.js'
]) {
  if (!readme.includes(text)) throw new Error(`README.md is missing authentication guidance: ${text}`);
}

for (const text of [
  '{ "port": 8765, "token": "..." }',
  '`ARC_TUNNEL_TOKEN` takes precedence over the file token',
  'Node.js `>=22`',
  'npm run audit:prod',
  'local Broker capability boundary',
  'node scripts/install.js',
  'Authentication failed',
  'correct effective token',
  'When a valid `ARC_TUNNEL_TOKEN` is set, the extension must use that same effective',
  'node scripts/verify-browser-resilience.js',
  'node scripts/verify-multi-agent.js'
]) {
  if (!agents.includes(text)) throw new Error(`AGENTS.md is missing authentication guidance: ${text}`);
}
if (!/unset the environment override, restart the Broker and every Agent client/
  .test(agents.replace(/\s+/g, ' '))) {
  throw new Error('AGENTS.md is missing restart guidance after unsetting the environment override');
}

const readmeSecurity = sectionBetween('README.md', readme, '## Security', '## License');
const readmeInstall = sectionBetween('README.md', readme, '## Install', '## Broker lifecycle and ports');
const agentsInstall = sectionBetween('AGENTS.md', agents, '## Install and configure', '## Broker lifecycle');
const agentsExtension = sectionBetween('AGENTS.md', agents, '## Extension setup', '## Browser control and debugger lifecycle');
const designConstraints = sectionBetween(
  'authentication design',
  design,
  '## 3. Global Constraints',
  '## 4. Configuration and Token Lifecycle'
);
const designInstallationOutput = sectionBetween(
  'authentication design',
  design,
  '### 4.5 Installation output',
  '## 5. Protocol Authentication'
);
const designMigration = sectionBetween(
  'authentication design',
  design,
  '## 10. Documentation and Migration',
  '## 11. Testing Strategy'
);
const planTask2 = sectionBetween(
  'authentication implementation plan',
  implementationPlan,
  '## Task 2: Generate, migrate, and atomically persist the installation token',
  '## Task 3: Authenticate all Broker WebSocket routes before state activation'
);
const planTask9 = sectionBetween(
  'authentication implementation plan',
  implementationPlan,
  '## Task 9: Update installation, security, migration, and verification documentation',
  '## Task 10: Rebuild committed artifacts and run the complete automated release gate'
);
const planTask11 = sectionBetween(
  'authentication implementation plan',
  implementationPlan,
  '## Task 11: Run real Edge verification, CI, integration, and Issue #17 closure'
);

assertSemanticContracts([
  ['README.md installer guidance', readmeInstall, [
    ['valid environment override makes a generated file token fallback-only',
      /valid `ARC_TUNNEL_TOKEN` override[\s\S]*generated file token[\s\S]*fallback/i],
    ['invalid present override blocks startup and must be removed or replaced without disclosure',
      /empty or malformed[\s\S]*override[\s\S]*blocks startup[\s\S]*remove or replace[\s\S]*never prints?[\s\S]*override value/i]
  ]],
  ['README.md security boundary', readmeSecurity, [
    ['literal IPv4 loopback WebSocket host with explicit port and restricted path',
      /literal host `127\.0\.0\.1`[\s\S]*explicit port[\s\S]*path `\/` or `\/extension`/i],
    ['legacy localhost defaults are migration-only inputs',
      /three exact legacy `localhost` defaults[\s\S]*migration/i],
    ['authentication token is never sent off-loopback',
      /never sends? the authentication token to an off-loopback destination/i],
    ['same-user config theft and local-port impersonation are outside the static-token boundary',
      /hostile same-OS-user processes[\s\S]*read[\s\S]*user config[\s\S]*impersonate[\s\S]*local port[\s\S]*outside this static-token boundary/i]
  ]],
  ['AGENTS.md installer guidance', agentsInstall, [
    ['valid environment override makes a generated file token fallback-only',
      /valid `ARC_TUNNEL_TOKEN` override[\s\S]*generated file token[\s\S]*fallback/i],
    ['invalid present override blocks startup and must be removed or replaced without disclosure',
      /empty or malformed[\s\S]*override[\s\S]*blocks startup[\s\S]*remove or replace[\s\S]*never prints?[\s\S]*override value/i]
  ]],
  ['AGENTS.md extension boundary', agentsExtension, [
    ['literal IPv4 loopback WebSocket host with explicit port and restricted path',
      /literal host `127\.0\.0\.1`[\s\S]*explicit port[\s\S]*path `\/` or `\/extension`/i],
    ['legacy localhost defaults are migration-only inputs',
      /three exact legacy `localhost` defaults[\s\S]*migration/i],
    ['authentication token is never sent off-loopback',
      /never sends? the authentication token to an off-loopback destination/i],
    ['same-user config theft and local-port impersonation are outside the static-token boundary',
      /hostile same-OS-user processes[\s\S]*read[\s\S]*user config[\s\S]*impersonate[\s\S]*local port[\s\S]*outside this static-token boundary/i]
  ]],
  ['approved design global constraints', designConstraints, [
    ['strict literal-IPv4 extension URL boundary',
      /extension accepts only[\s\S]*literal host `127\.0\.0\.1`[\s\S]*explicit port[\s\S]*path `\/` or `\/extension`/i],
    ['authentication token is never sent off-loopback',
      /never sends? the authentication token to an off-loopback destination/i],
    ['same-user config theft and local-port impersonation are outside the static-token boundary',
      /hostile same-OS-user processes[\s\S]*read[\s\S]*user config[\s\S]*impersonate[\s\S]*local port[\s\S]*outside this static-token boundary/i]
  ]],
  ['approved design installation output', designInstallationOutput, [
    ['valid environment override makes a generated file token fallback-only',
      /valid `ARC_TUNNEL_TOKEN` override[\s\S]*generated file token[\s\S]*fallback/i],
    ['effective environment token comes from its controlled source',
      /effective environment token[\s\S]*controlled source/i],
    ['file fallback requires unsetting the override and restarting Broker and Agent clients',
      /unset[\s\S]*override[\s\S]*restart[\s\S]*Broker[\s\S]*Agent clients/i],
    ['empty or malformed override blocks startup and must be removed or replaced',
      /empty or malformed[\s\S]*override[\s\S]*blocks startup[\s\S]*remove or replace/i],
    ['environment override value is not printed',
      /never prints?[\s\S]*environment override value/i]
  ]],
  ['approved design migration', designMigration, [
    ['migration chooses the effective token by environment precedence',
      /effective token source[\s\S]*`ARC_TUNNEL_TOKEN`[\s\S]*persisted/i],
    ['environment token comes from its controlled source',
      /environment token[\s\S]*controlled source/i],
    ['file token requires unsetting the override and restarting all clients',
      /unset[\s\S]*override[\s\S]*restart[\s\S]*Broker[\s\S]*all Agent clients/i]
  ]],
  ['plan Task 2', planTask2, [
    ['valid environment override labels generated file token as fallback',
      /valid environment override[\s\S]*generated file token[\s\S]*fallback/i],
    ['invalid present override warns without silent fallback or disclosure',
      /empty or malformed[\s\S]*override[\s\S]*warn[\s\S]*remove or replace[\s\S]*without[\s\S]*value/i]
  ]],
  ['plan Task 9', planTask9, [
    ['strict extension URL boundary and no off-loopback token transmission',
      /strict extension URL boundary[\s\S]*never sends?[\s\S]*token[\s\S]*off-loopback/i],
    ['same-user config theft and local-port impersonation threat-model exclusion',
      /hostile same-OS-user processes[\s\S]*read[\s\S]*user config[\s\S]*impersonate[\s\S]*local port[\s\S]*outside[\s\S]*static-token boundary/i],
    ['environment-aware installer fallback and invalid-override guidance',
      /generated file token[\s\S]*fallback[\s\S]*invalid[\s\S]*environment override[\s\S]*blocks startup/i]
  ]],
  ['plan Task 11', planTask11, [
    ['valid environment override recovery uses the controlled source',
      /valid `ARC_TUNNEL_TOKEN` override[\s\S]*controlled source/i],
    ['persisted token recovery requires unsetting the override and restarting every client',
      /unset[\s\S]*override[\s\S]*restart[\s\S]*Broker[\s\S]*every Agent client[\s\S]*persisted token/i]
  ]]
]);

for (const [label, content, stalePattern] of [
  ['README.md', readme, /Other hosts, ports,\s+paths, queries, and fragments remain unchanged/],
  ['approved design migration', designMigration, /copy the newly generated token when the installer displays it/],
  ['plan Task 11', planTask11, /Restore the exact token from the user's `~\/\.arc-tunnel\/config\.json`/]
]) {
  if (stalePattern.test(content)) throw new Error(`${label} retains contradictory authentication guidance`);
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

if (!design.includes('**Status:** Approved')) throw new Error('Authentication design status must be Approved');
if (!/自己拥有的标签页取得非空 JPEG[\s\S]*对其他 Agent 标签页的截图请求返回 `TAB_NOT_OWNED`/.test(readme)) {
  throw new Error('README.md must require owned JPEG content and foreign TAB_NOT_OWNED');
}
if (!/non-empty JPEG image content from its owned tab,\s+while a foreign\s+screenshot returns `TAB_NOT_OWNED`/.test(agents)) {
  throw new Error('AGENTS.md must require owned JPEG content and foreign TAB_NOT_OWNED');
}

console.log('Repository documentation, packaging, and config assertions passed.');
