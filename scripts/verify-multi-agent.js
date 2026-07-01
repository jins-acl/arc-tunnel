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

async function connect(name, peers) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'mcp-server/dist/mcp-server.js')],
    cwd: path.join(root, 'mcp-server'),
    env: { ...process.env, WS_PORT: String(port) },
    stderr: 'pipe'
  });
  transport.stderr.on('data', chunk => process.stderr.write(`[${name}] ${chunk}`));
  const client = new Client({ name: `arc-tunnel-verify-${name}`, version: '1.0.0' });
  const peer = { client, transport };
  peers.push(peer);
  await client.connect(transport);
  return peer;
}

async function call(peer, name, arguments_ = {}) {
  return textResult(await peer.client.callTool({ name, arguments: arguments_ }));
}

function isTransientNavigationError(error) {
  if (['TAB_NOT_OWNED', 'TAB_CLOSED', 'EXTENSION_DISCONNECTED', 'CONNECTION_LOST'].includes(error?.code)) return false;
  return ['EXECUTION_ERROR', 'INTERNAL_ERROR'].includes(error?.code)
    && /execution context (?:was )?destroyed|context.*destroyed|frame (?:was )?detached|cannot access contents/i.test(error?.message || '');
}

async function settleBeforeDeadline(operation, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { timedOut: true };
  let timer;
  const observed = operation.then(
    value => ({ timedOut: false, value }),
    error => ({ timedOut: false, error })
  );
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), remaining); });
  const outcome = await Promise.race([observed, timeout]);
  clearTimeout(timer);
  if (outcome.error) throw outcome.error;
  return outcome;
}

async function waitForExpectedLocation(peer, tabId, expectedUrl, deadline = Date.now() + 15_000, pollInterval = 100) {
  let observed = null;
  let transientError = null;
  while (Date.now() < deadline) {
    try {
      const outcome = await settleBeforeDeadline(
        call(peer, 'execute_script', { tabId, script: 'location.href' }),
        deadline
      );
      if (outcome.timedOut) break;
      const response = outcome.value;
      observed = response?.result ?? null;
      transientError = null;
      if (observed === expectedUrl) return observed;
    } catch (error) {
      if (!isTransientNavigationError(error)) throw error;
      transientError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(pollInterval, remaining)));
  }
  const last = transientError ? `${transientError.code}: ${transientError.message}` : JSON.stringify(observed);
  throw new Error(`Timed out waiting for tab ${tabId} to reach ${expectedUrl}; last observed ${last}`);
}

async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  console.log(`Arc Tunnel multi-agent verification on ws://localhost:${port}`);
  const peers = [];
  let alpha;
  let beta;
  let failure;
  const cleanupErrors = [];
  try {
    alpha = await connect('alpha', peers);
    beta = await connect('beta', peers);
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

    const alphaTarget = 'https://example.com/?arc-agent=alpha';
    const betaTarget = 'https://example.org/?arc-agent=beta';
    const navigations = await Promise.all([
      call(alpha, 'navigate', { tabId: alphaTab.tabId, action: 'goto', url: alphaTarget }),
      call(beta, 'navigate', { tabId: betaTab.tabId, action: 'goto', url: betaTarget })
    ]);
    if (navigations[0]?.status !== 'navigated' || navigations[1]?.status !== 'navigated') {
      throw new Error(`Unexpected navigation results: ${JSON.stringify(navigations)}`);
    }
    const navigationDeadline = Date.now() + 15_000;
    const locations = await Promise.all([
      waitForExpectedLocation(alpha, alphaTab.tabId, alphaTarget, navigationDeadline),
      waitForExpectedLocation(beta, betaTab.tabId, betaTarget, navigationDeadline)
    ]);
    if (locations[0] !== alphaTarget || locations[1] !== betaTarget) {
      throw new Error(`Navigation crossover or wrong URL: ${JSON.stringify(locations)}`);
    }
    console.log(`PASS concurrent navigation verified alpha=${locations[0]} beta=${locations[1]}`);

    let manualTab = Number(valueAfter('--manual-tab'));
    if (!Number.isSafeInteger(manualTab)) {
      const input = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await input.question('Open a new tab manually, find its tabId in the extension/list output, and enter tabId: ');
      input.close(); manualTab = Number(answer.trim());
    }
    if (!Number.isSafeInteger(manualTab)) throw new Error('Manual step incomplete: rerun with --manual-tab <tabId> or enter a numeric tab ID.');
    const [alphaVisible, betaVisible] = await Promise.all([call(alpha, 'list_tabs'), call(beta, 'list_tabs')]);
    if (alphaVisible.tabs.some(tab => tab.tabId === betaTab.tabId)
      || betaVisible.tabs.some(tab => tab.tabId === alphaTab.tabId)) {
      throw new Error('Visibility leaked a foreign-owned tab');
    }
    if (alphaVisible.tabs.find(tab => tab.tabId === alphaTab.tabId)?.ownership !== 'owned'
      || betaVisible.tabs.find(tab => tab.tabId === betaTab.tabId)?.ownership !== 'owned'
      || alphaVisible.tabs.find(tab => tab.tabId === manualTab)?.ownership !== 'unclaimed'
      || betaVisible.tabs.find(tab => tab.tabId === manualTab)?.ownership !== 'unclaimed') {
      throw new Error('Owned/unclaimed visibility did not match the expected pre-claim state');
    }
    console.log(`PASS visibility alpha=${alphaVisible.tabs.length} beta=${betaVisible.tabs.length} (owned + unclaimed only)`);
    const alphaClaim = await call(alpha, 'claim_tab', { tabId: manualTab });
    if (alphaClaim?.tabId !== manualTab || alphaClaim?.ownership !== 'owned') throw new Error('Agent A claim result was invalid');
    const [alphaAfterClaim, betaAfterClaim] = await Promise.all([call(alpha, 'list_tabs'), call(beta, 'list_tabs')]);
    if (alphaAfterClaim.tabs.find(tab => tab.tabId === manualTab)?.ownership !== 'owned'
      || betaAfterClaim.tabs.some(tab => tab.tabId === manualTab)) throw new Error('Post-claim ownership visibility is invalid');
    console.log(`PASS Agent A claimed manual tab ${manualTab}`);
    try {
      await call(beta, 'snapshot', { tabId: manualTab });
      throw new Error('Foreign access unexpectedly succeeded');
    } catch (error) {
      if (error.code !== 'TAB_NOT_OWNED') throw error;
    }
    console.log('PASS Agent B received TAB_NOT_OWNED');

    const alphaRelease = await call(alpha, 'release_tab', { tabId: alphaTab.tabId });
    if (alphaRelease?.tabId !== alphaTab.tabId || alphaRelease?.ownership !== 'unclaimed') throw new Error('Release result was invalid');
    const releasedAlphaTab = await call(beta, 'list_tabs');
    if (releasedAlphaTab.tabs.find(tab => tab.tabId === alphaTab.tabId)?.ownership !== 'unclaimed') {
      throw new Error('Released tab was not visible as unclaimed');
    }
    const alphaReclaim = await call(alpha, 'claim_tab', { tabId: alphaTab.tabId });
    if (alphaReclaim?.tabId !== alphaTab.tabId || alphaReclaim?.ownership !== 'owned') throw new Error('Reclaim result was invalid');
    const reclaimedAlphaTab = await call(alpha, 'list_tabs');
    if (reclaimedAlphaTab.tabs.find(tab => tab.tabId === alphaTab.tabId)?.ownership !== 'owned') {
      throw new Error('Reclaimed tab was not visible as owned');
    }
    console.log(`PASS release/reclaim result and ownership for tab ${alphaTab.tabId}`);

    await alpha.client.close(); await alpha.transport.close(); peers.splice(peers.indexOf(alpha), 1);
    console.log(`Agent A disconnected; waiting ${Math.ceil(waitMs / 1000)} seconds for ownership release...`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    const released = await call(beta, 'list_tabs');
    if (released.tabs.find(tab => tab.tabId === manualTab)?.ownership !== 'unclaimed') throw new Error('Disconnected ownership was not released');
    const betaClaim = await call(beta, 'claim_tab', { tabId: manualTab });
    if (betaClaim?.tabId !== manualTab || betaClaim?.ownership !== 'owned') throw new Error('Agent B reclaim result was invalid');
    const betaOwned = await call(beta, 'list_tabs');
    if (betaOwned.tabs.find(tab => tab.tabId === manualTab)?.ownership !== 'owned') throw new Error('Agent B ownership was not visible after reclaim');
    console.log(`PASS Agent B claimed released tab ${manualTab}; browser pages remain open`);
  } catch (error) {
    failure = error;
  } finally {
    await Promise.all(peers.map(async peer => {
      await peer.client.close().catch(error => cleanupErrors.push(error));
      await peer.transport.close().catch(error => cleanupErrors.push(error));
    }));
  }
  if (failure && cleanupErrors.length) throw Object.assign(new Error(`${failure.message}; cleanup also failed`), { cause: failure, cleanupErrors });
  if (failure) throw failure;
  if (cleanupErrors.length) throw Object.assign(new Error('Client cleanup failed'), { cleanupErrors });
}

module.exports = { waitForExpectedLocation };

if (require.main === module) {
  main().catch(error => { console.error(`FAIL: ${error.message}`); process.exitCode = 1; });
}
