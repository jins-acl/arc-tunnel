#!/usr/bin/env node
'use strict';

const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Client } = require('../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
const { StdioClientTransport } = require('../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js');
const { parseToolResult } = require('./parse-tool-result.js');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const valueAfter = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const port = Number(valueAfter('--port') || process.env.WS_PORT || 8765);

function assertFailFastTiming(command, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 5_000 || elapsedMs > 8_000) {
    throw new Error(`${command} completed in ${Math.round(elapsedMs)}ms; expected 5000-8000ms`);
  }
}

function closeHttpServer(server, sockets = new Set()) {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    });
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

async function cleanupVerifierResources({ tabId, client, transport, server, serverSockets, call }, cleanupErrors) {
  if (tabId !== undefined && client) {
    try {
      const closed = (await call('close_tab', { tabId })).value;
      if (closed?.status !== 'closed') throw new Error(`Unexpected cleanup close_tab result: ${JSON.stringify(closed)}`);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (client) await client.close().catch(error => cleanupErrors.push(error));
  if (transport) await transport.close().catch(error => cleanupErrors.push(error));
  if (server) {
    await closeHttpServer(server, serverSockets).catch(error => cleanupErrors.push(error));
  }
}

async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }

  const cleanupErrors = [];
  let server;
  const serverSockets = new Set();
  let client;
  let transport;
  let tabId;
  let failure;

  const call = async (name, arguments_ = {}) => {
    const result = await client.callTool({ name, arguments: arguments_ });
    return parseToolResult(result);
  };

  try {
    server = http.createServer((request, response) => {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      response.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Arc resilience verification</title></head>
<body>
  <button id="arc-ready" type="button">Arc ready</button>
  <script>console.log('ARC_CONSOLE_BEFORE_CALL');</script>
</body>
</html>`);
    });
    server.on('connection', socket => {
      serverSockets.add(socket);
      socket.once('close', () => serverSockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local HTTP server did not expose a port');
    const pageUrl = `http://127.0.0.1:${address.port}/`;

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, 'mcp-server/dist/mcp-server.js')],
      cwd: path.join(root, 'mcp-server'),
      env: { ...process.env, WS_PORT: String(port) },
      stderr: 'pipe'
    });
    transport.stderr.on('data', chunk => process.stderr.write(`[resilience-client] ${chunk}`));
    client = new Client({ name: 'arc-tunnel-browser-resilience', version: '1.0.0' });
    await client.connect(transport);

    let created;
    try {
      created = (await call('create_tab', { url: pageUrl })).value;
    } catch (error) {
      if (error.code === 'EXTENSION_DISCONNECTED') {
        throw new Error(`Extension is not connected to ws://127.0.0.1:${port}. Load extension/dist, connect it to this port, then rerun.`);
      }
      throw error;
    }
    if (!Number.isSafeInteger(created?.tabId)) throw new Error('create_tab did not return a tabId');
    tabId = created.tabId;

    const ready = (await call('wait_for_element', {
      tabId,
      selector: '#arc-ready',
      timeout: 10_000
    })).value;
    if (ready?.found !== true) throw new Error('Local verification page did not finish loading');

    const consoleResult = (await call('get_console_logs', { tabId })).value;
    if (!consoleResult?.logs?.some(log => String(log?.text).includes('ARC_CONSOLE_BEFORE_CALL'))) {
      throw new Error('get_console_logs did not include ARC_CONSOLE_BEFORE_CALL');
    }
    console.log('PASS console history includes the pre-call marker');

    const screenshotArguments = { tabId, format: 'jpeg', quality: 70, maxWidth: 800 };
    const firstScreenshot = await call('screenshot', screenshotArguments);
    const jpeg = firstScreenshot.images.find(item => item.mimeType === 'image/jpeg');
    if (!jpeg || typeof jpeg.data !== 'string' || jpeg.data.length === 0) {
      throw new Error('screenshot did not return an MCP image/jpeg item');
    }
    if (firstScreenshot.texts.some(text => text.includes(jpeg.data))) {
      throw new Error('screenshot base64 leaked into MCP text content');
    }
    console.log('PASS screenshot uses MCP image content without text base64');

    await call('execute_script', {
      tabId,
      script: 'setTimeout(() => { while (true) {} }, 100); "freeze-scheduled"'
    });
    await new Promise(resolve => setTimeout(resolve, 300));

    for (const [command, arguments_] of [
      ['execute_script', { tabId, script: 'document.title' }],
      ['get_content', { tabId, mode: 'text' }]
    ]) {
      const started = performance.now();
      let timedOut = false;
      try {
        await call(command, arguments_);
      } catch (error) {
        const elapsedMs = performance.now() - started;
        if (error.code !== 'TIMEOUT') throw error;
        assertFailFastTiming(command, elapsedMs);
        timedOut = true;
        console.log(`PASS ${command} returned TIMEOUT in ${Math.round(elapsedMs)}ms`);
      }
      if (!timedOut) throw new Error(`${command} unexpectedly succeeded on the frozen page`);
    }

    const recoveryScreenshot = await call('screenshot', screenshotArguments);
    if (!recoveryScreenshot.images.some(item => item.mimeType === 'image/jpeg' && item.data)) {
      throw new Error('screenshot failed after frozen-page timeouts');
    }
    console.log('PASS screenshot succeeds after frozen-page timeouts');

    const closed = (await call('close_tab', { tabId })).value;
    if (closed?.status !== 'closed') throw new Error(`Unexpected close_tab result: ${JSON.stringify(closed)}`);
    tabId = undefined;
    console.log('PASS owned verification tab closed');
  } catch (error) {
    failure = error;
  } finally {
    await cleanupVerifierResources({ tabId, client, transport, server, serverSockets, call }, cleanupErrors);
  }

  if (failure && cleanupErrors.length) {
    throw Object.assign(new Error(`${failure.message}; cleanup also failed`), {
      cause: failure,
      cleanupErrors
    });
  }
  if (failure) throw failure;
  if (cleanupErrors.length) throw Object.assign(new Error('Cleanup failed'), { cleanupErrors });
}

module.exports = { assertFailFastTiming, cleanupVerifierResources, closeHttpServer, parseToolResult };

if (require.main === module) {
  main().catch(error => {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
