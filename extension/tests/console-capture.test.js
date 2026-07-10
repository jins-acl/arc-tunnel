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

const { ConsoleCapture } = loadModule('src/background/console-capture.ts');

function debuggerEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    },
    listenerCount() { return listeners.length; }
  };
}

async function withDebuggerEvent(run) {
  const original = global.chrome;
  const onEvent = debuggerEvent();
  global.chrome = { debugger: { onEvent } };
  try {
    await run(onEvent);
  } finally {
    if (original === undefined) delete global.chrome;
    else global.chrome = original;
  }
}

test('CDP console listeners isolate events by source tab', async () => {
  await withDebuggerEvent(async onEvent => {
    const capture = new ConsoleCapture();
    await capture.enableForTab(11);
    await capture.enableForTab(22);

    onEvent.emit(
      { tabId: 11 },
      'Runtime.consoleAPICalled',
      { type: 'log', args: [{ value: 'only-eleven' }] }
    );
    onEvent.emit(
      { tabId: 22 },
      'Runtime.consoleAPICalled',
      { type: 'error', args: [{ value: 'only-twenty-two' }] }
    );

    assert.deepEqual(capture.getLogs(11).map(entry => entry.text), ['only-eleven']);
    assert.deepEqual(capture.getLogs(22).map(entry => entry.text), ['only-twenty-two']);
  });
});

test('CDP console entries bound text to 16,384 and source to 4,096 characters', async () => {
  await withDebuggerEvent(async onEvent => {
    const capture = new ConsoleCapture();
    await capture.enableForTab(11);
    onEvent.emit(
      { tabId: 11 },
      'Runtime.consoleAPICalled',
      {
        type: 'error',
        args: [{ value: 't'.repeat(20_000) }],
        stackTrace: { callFrames: [{ url: 's'.repeat(5_000) }] }
      }
    );

    const [entry] = capture.getLogs(11);
    assert.equal(entry.text.length, 16_384);
    assert.equal(entry.source.length, 4_096);
  });
});

test('CDP console normalizes log and warn before minimum-level filtering', async () => {
  await withDebuggerEvent(async onEvent => {
    const capture = new ConsoleCapture();
    await capture.enableForTab(11);
    for (const [type, value] of [['debug', 'd'], ['log', 'i'], ['warn', 'w'], ['error', 'e']]) {
      onEvent.emit(
        { tabId: 11 },
        'Runtime.consoleAPICalled',
        { type, args: [{ value }] }
      );
    }

    assert.deepEqual(
      capture.getLogs(11, 'info').map(({ level, text }) => ({ level, text })),
      [
        { level: 'info', text: 'i' },
        { level: 'warning', text: 'w' },
        { level: 'error', text: 'e' }
      ]
    );
  });
});

test('disableForTab removes the listener and buffered logs before tab ID reuse', async () => {
  await withDebuggerEvent(async onEvent => {
    const capture = new ConsoleCapture();
    await capture.enableForTab(11);
    onEvent.emit(
      { tabId: 11 },
      'Runtime.consoleAPICalled',
      { type: 'error', args: [{ value: 'stale' }] }
    );
    assert.equal(onEvent.listenerCount(), 1);

    capture.disableForTab(11);

    assert.equal(onEvent.listenerCount(), 0);
    assert.deepEqual(capture.getLogs(11), []);
  });
});
