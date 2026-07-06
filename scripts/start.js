#!/usr/bin/env node
/** Arc Tunnel shared Broker lifecycle wrapper. */

const { spawnSync } = require('child_process');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ACTIONS = new Set(['start', 'status', 'stop', 'diagnose']);
const action = ACTIONS.has(process.argv[2]) ? process.argv[2] : 'start';
const controlEntry = path.join(REPO_ROOT, 'mcp-server', 'dist', 'arc-tunnel-control.js');
const args = process.argv.slice(action === process.argv[2] ? 3 : 2);
const result = spawnSync(process.execPath, [controlEntry, action, ...args], { stdio: 'inherit' });

process.exitCode = result.status ?? 1;
