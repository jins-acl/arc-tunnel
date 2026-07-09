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

const { DebuggerController } = loadModule('src/background/debugger-controller.ts');

async function withChrome(chrome, run) {
  const original = global.chrome;
  global.chrome = chrome;
  try {
    return await run();
  } finally {
    if (original === undefined) delete global.chrome;
    else global.chrome = original;
  }
}

function failAfter(ms, message) {
  return new Promise((resolve, reject) => setTimeout(() => reject(new Error(message)), ms));
}

test('navigate waits for a page navigation event before resolving', async () => {
  let listener;
  const calls = [];
  await withChrome({
    runtime: {},
    debugger: {
      onEvent: {
        addListener(fn) { listener = fn; calls.push(['addListener']); },
        removeListener(fn) {
          assert.equal(fn, listener);
          calls.push(['removeListener']);
        }
      },
      sendCommand(target, method, params, callback) {
        calls.push([method, params]);
        setImmediate(() => {
          if (method === 'Page.navigate') {
            callback({ frameId: 'main-frame' });
          } else {
            callback({});
          }
        });
      }
    }
  }, async () => {
    const controller = new DebuggerController({ navigationTimeoutMs: 50 });
    let resolved = false;
    const navigation = controller.navigate(7, 'https://example.test').then(() => { resolved = true; });

    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resolved, false);

    listener({ tabId: 7 }, 'Page.frameNavigated', { frame: { id: 'main-frame' } });
    await navigation;
    assert.equal(resolved, true);
  });

  assert.deepEqual(calls, [
    ['Page.enable', undefined],
    ['addListener'],
    ['Page.navigate', { url: 'https://example.test' }],
    ['removeListener']
  ]);
});

test('screenshot falls back to CDP when activating a frozen tab hangs', async () => {
  const calls = [];
  await withChrome({
    runtime: {},
    tabs: {
      update: async () => new Promise(() => {}),
      captureVisibleTab: async () => {
        throw new Error('captureVisibleTab should not run after activate timeout');
      }
    },
    debugger: {
      sendCommand(target, method, params, callback) {
        calls.push([method, params]);
        setImmediate(() => callback({ data: 'cdp-image' }));
      }
    }
  }, async () => {
    const controller = new DebuggerController({ activationTimeoutMs: 5 });
    const result = await Promise.race([
      controller.screenshot(7, false),
      failAfter(50, 'screenshot did not fall back after activation hung')
    ]);
    assert.equal(result, 'cdp-image');
  });

  assert.deepEqual(calls, [
    ['Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }]
  ]);
});
