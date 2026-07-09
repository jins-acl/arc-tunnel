const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

function loadModule(entry) {
  const result = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', entry)], bundle: true,
    format: 'cjs', platform: 'node', write: false });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { CommandHandler } = loadModule('src/background/command-handler.ts');

function failAfter(ms, message) {
  return new Promise((resolve, reject) => setTimeout(() => reject(new Error(message)), ms));
}

test('CommandHandler falls back to debugger when a lightweight command hangs', async () => {
  const events = [];
  const tabManager = {
    ensureDebuggerAttached: async tabId => events.push(['attach', tabId]),
    scheduleDebuggerDetach: (tabId, reason) => events.push(['detach', tabId, reason])
  };
  const debuggerController = {
    executeScript: async (tabId, script) => {
      events.push(['debugger', tabId, script]);
      return 'fallback-result';
    }
  };
  const lightweightController = {
    executeScript: async () => new Promise(() => {})
  };
  const handler = new CommandHandler(
    tabManager,
    debuggerController,
    {},
    {},
    {},
    {},
    {},
    lightweightController,
    { lightweightTimeoutMs: 5 }
  );

  const response = await Promise.race([
    handler.handleCommand({
    id: 'hung-lightweight',
    type: 'command',
    command: 'execute_script',
    params: { tabId: 42, script: '1 + 1' }
    }),
    failAfter(50, 'CommandHandler did not fall back from the hung lightweight path')
  ]);

  assert.equal(response.success, true);
  assert.deepEqual(response.result, { result: 'fallback-result' });
  assert.deepEqual(events, [
    ['attach', 42],
    ['debugger', 42, '1 + 1'],
    ['detach', 42, 'execute_script.fallback']
  ]);
});
