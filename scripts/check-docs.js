#!/usr/bin/env node
/** Deterministic repository documentation and template assertions. */

const fs = require('fs');

const read = (file) => fs.readFileSync(file, 'utf8');
const parsePackage = (file) => JSON.parse(read(file));
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
  'local Broker capability boundary'
]) {
  if (!agents.includes(text)) throw new Error(`AGENTS.md is missing authentication guidance: ${text}`);
}

const forbiddenCredentialExamples = [
  [/\bnode\b[^\r\n]*\s--token(?:\s|=)/, 'token-bearing CLI example'],
  [/wss?:\/\/[^\s"'`<>]*[?&#][^\s"'`<>]*token=/i, 'token-bearing WebSocket URL example']
];
for (const file of [
  'README.md',
  'AGENTS.md',
  'docs/superpowers/specs/2026-07-30-arc-tunnel-lightweight-auth-hardening-design.md',
  ...fs.readdirSync('configs').map(name => `configs/${name}`)
]) {
  const content = read(file);
  for (const [pattern, label] of forbiddenCredentialExamples) {
    if (pattern.test(content)) throw new Error(`${file} contains a forbidden ${label}`);
  }
}

if (!read('AGENTS.md').includes('mcp-server/dist/arc-tunnel-control.js')) {
  throw new Error('AGENTS.md is missing the committed lifecycle artifact');
}
if (!read('extension/src/background/tab-manager.ts').includes('idleDetachDelayMs = 15000')) {
  throw new Error('Documented debugger detach grace differs from source');
}

for (const file of [
  'configs/claude-code.json',
  'configs/hermes.yaml',
  'configs/openclaw.json',
  'configs/codex-skill.yaml',
  'configs/kimi.md'
]) {
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

console.log('Repository documentation, packaging, and config assertions passed.');
