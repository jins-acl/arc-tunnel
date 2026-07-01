#!/usr/bin/env node
'use strict';

const path = require('path');
const readline = require('readline/promises');
const { Client } = require('../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
const { StdioClientTransport } = require('../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const valueAfter = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const port = Number(valueAfter('--port') || process.env.WS_PORT || 8765);
const waitMs = Number(valueAfter('--release-wait-ms') || 31_000);

function textResult(result) {
  const text = result.content?.find(item => item.type === 'text')?.text;
  const value = text ? JSON.parse(text) : undefined;
  if (result.isError) throw Object.assign(new Error(value?.error || 'Tool failed'), value);
  return value;
}

async function connect(name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'mcp-server/dist/mcp-server.js')],
    cwd: path.join(root, 'mcp-server'),
    env: { ...process.env, WS_PORT: String(port) },
    stderr: 'pipe'
  });
  transport.stderr.on('data', chunk => process.stderr.write(`[${name}] ${chunk}`));
  const client = new Client({ name: `arc-tunnel-verify-${name}`, version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

async function call(peer, name, arguments_ = {}) {
  return textResult(await peer.client.callTool({ name, arguments: arguments_ }));
}

async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  console.log(`Arc Tunnel multi-agent verification on ws://localhost:${port}`);
  const peers = [];
  let alpha;
  let beta;
  try {
    alpha = await connect('alpha'); peers.push(alpha);
    beta = await connect('beta'); peers.push(beta);
    let created;
    try {
      created = await Promise.all([
        call(alpha, 'create_tab', { url: 'about:blank' }),
        call(beta, 'create_tab', { url: 'about:blank' })
      ]);
    } catch (error) {
      if (error.code === 'EXTENSION_DISCONNECTED') {
        throw new Error(`Extension is not connected to ws://localhost:${port}. Load extension/dist, set the popup URL to this port, connect it, then rerun.`);
      }
      throw error;
    }
    const [alphaTab, betaTab] = created;
    if (alphaTab.tabId === betaTab.tabId || alphaTab.windowId === betaTab.windowId) throw new Error('Agents did not receive distinct tabs/windows');
    console.log(`PASS distinct workspaces: alpha window=${alphaTab.windowId} tab=${alphaTab.tabId}; beta window=${betaTab.windowId} tab=${betaTab.tabId}`);

    await Promise.all([
      call(alpha, 'navigate', { tabId: alphaTab.tabId, url: 'https://example.com/?arc-agent=alpha' }),
      call(beta, 'navigate', { tabId: betaTab.tabId, url: 'https://example.org/?arc-agent=beta' })
    ]);
    console.log('PASS concurrent navigation completed without response crossover');
    const [alphaVisible, betaVisible] = await Promise.all([call(alpha, 'list_tabs'), call(beta, 'list_tabs')]);
    if (alphaVisible.tabs.some(tab => tab.tabId === betaTab.tabId)
      || betaVisible.tabs.some(tab => tab.tabId === alphaTab.tabId)) {
      throw new Error('Visibility leaked a foreign-owned tab');
    }
    console.log(`PASS visibility alpha=${alphaVisible.tabs.length} beta=${betaVisible.tabs.length} (owned + unclaimed only)`);

    let manualTab = Number(valueAfter('--manual-tab'));
    if (!Number.isSafeInteger(manualTab)) {
      const input = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await input.question('Open a new tab manually, find its tabId in the extension/list output, and enter tabId: ');
      input.close(); manualTab = Number(answer.trim());
    }
    if (!Number.isSafeInteger(manualTab)) throw new Error('Manual step incomplete: rerun with --manual-tab <tabId> or enter a numeric tab ID.');
    await call(alpha, 'claim_tab', { tabId: manualTab });
    console.log(`PASS Agent A claimed manual tab ${manualTab}`);
    try {
      await call(beta, 'snapshot', { tabId: manualTab });
      throw new Error('Foreign access unexpectedly succeeded');
    } catch (error) {
      if (error.code !== 'TAB_NOT_OWNED') throw error;
    }
    console.log('PASS Agent B received TAB_NOT_OWNED');

    await alpha.client.close(); await alpha.transport.close(); peers.splice(peers.indexOf(alpha), 1);
    console.log(`Agent A disconnected; waiting ${Math.ceil(waitMs / 1000)} seconds for ownership release...`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    await call(beta, 'claim_tab', { tabId: manualTab });
    console.log(`PASS Agent B claimed released tab ${manualTab}; browser pages remain open`);
  } finally {
    await Promise.all(peers.map(async peer => {
      await peer.client.close().catch(() => undefined);
      await peer.transport.close().catch(() => undefined);
    }));
  }
}

main().catch(error => { console.error(`FAIL: ${error.message}`); process.exitCode = 1; });
