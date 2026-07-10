const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

function loadModule(entry) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', entry)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

test('tab removal lifecycle disables its CDP console capture', () => {
  const { bindConsoleCaptureCleanup } = loadModule('src/background/lifecycle-cleanup.ts');
  let lifecycleListener;
  const disabled = [];
  bindConsoleCaptureCleanup(
    { onLifecycle(listener) { lifecycleListener = listener; } },
    { disableForTab(tabId) { disabled.push(tabId); } }
  );

  lifecycleListener('tab_created', { tabId: 11 });
  lifecycleListener('window_removed', { windowId: 2 });
  lifecycleListener('tab_removed', { tabId: 11, windowId: 2 });

  assert.deepEqual(disabled, [11]);
});
