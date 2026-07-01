#!/usr/bin/env node
/** Deterministic Task 8 documentation and template assertions. */

const fs = require('fs');

const read = (file) => fs.readFileSync(file, 'utf8');
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
  'restore_session'
];

for (const file of docs) {
  const content = read(file);
  for (const text of requiredDocText) {
    if (!content.includes(text)) throw new Error(`${file} is missing: ${text}`);
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
}

console.log('Task 8 documentation and config assertions passed.');
