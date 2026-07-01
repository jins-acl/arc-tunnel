const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

function loadModule(entry) {
  const result = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', entry)], bundle: true, format: 'cjs', platform: 'node', write: false });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { SessionManager } = loadModule('src/background/session-manager.ts');
const { CommandHandler } = loadModule('src/background/command-handler.ts');

test('saveSession reads only the supplied tab IDs', async () => {
  const gets = [];
  global.crypto = { randomUUID: () => 'saved' };
  global.chrome = {
    tabs: { get: async id => (gets.push(id), { id, url: `https://${id}.example` }), query: () => { throw new Error('must not query all tabs'); } },
    cookies: { getAll: async () => [] },
    storage: { local: { set: async () => {} } }
  };
  await new SessionManager().saveSession('owned', [11, 22]);
  assert.deepEqual(gets, [11, 22]);
});

test('restoreSession creates tabs only in the supplied window and returns their IDs', async () => {
  const creates = [];
  global.chrome = {
    tabs: { create: async params => (creates.push(params), { id: creates.length }) },
    cookies: { set: async () => {} },
    storage: { local: { get: async () => ({ session_saved: { id: 'saved', name: 'x', savedAt: '', tabs: [{ url: 'https://one.example', cookies: [], localStorage: {}, sessionStorage: {} }] } }) } }
  };
  const ids = await new SessionManager().restoreSession('saved', 77);
  assert.deepEqual(ids, [1]);
  assert.deepEqual(creates, [{ url: 'https://one.example', windowId: 77, active: false }]);
});

test('CommandHandler returns RECORDING_BUSY for its singleton recording engine', async () => {
  const recordingEngine = { isCurrentlyRecording: () => true };
  const handler = new CommandHandler({}, {}, recordingEngine, {}, {}, {}, {}, {});
  const response = await handler.handleCommand({ id: 'busy', type: 'command', command: 'start_recording', params: { tabId: 1 } });
  assert.equal(response.success, false);
  assert.equal(response.error.code, 'RECORDING_BUSY');
});

test('CommandHandler synchronously reserves recording while start awaits', async () => {
  let release;
  let starts = 0;
  const gate = new Promise(resolve => { release = resolve; });
  global.chrome = { tabs: { query: async () => [{ id: 1 }, { id: 2 }] } };
  const recordingEngine = {
    isCurrentlyRecording: () => false,
    startRecording: async () => { starts++; await gate; return 'recording'; },
    injectListeners: async () => {}
  };
  const tabManager = {
    holdDebuggerAttached() {},
    ensureDebuggerAttached: async () => {},
    releaseDebuggerAttached() {}
  };
  const handler = new CommandHandler(tabManager, {}, recordingEngine, {}, {}, {}, {}, {});
  const first = handler.handleCommand({ id: 'first', type: 'command', command: 'start_recording', params: { tabId: 1 } });
  const second = handler.handleCommand({ id: 'second', type: 'command', command: 'start_recording', params: { tabId: 2 } });
  await new Promise(resolve => setImmediate(resolve));
  release();
  const secondResponse = await second;
  assert.equal(secondResponse.error.code, 'RECORDING_BUSY');
  assert.equal(starts, 1);
  assert.equal((await first).success, true);
});
