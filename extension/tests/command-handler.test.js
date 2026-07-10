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
const { ConsoleCapture } = loadModule('src/background/console-capture.ts');

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

function createConsoleHandler({ tabManager, consoleCapture, lightweightController, debuggerController }) {
  return new CommandHandler(
    tabManager,
    debuggerController,
    {},
    {},
    {},
    consoleCapture,
    {},
    lightweightController,
    { lightweightTimeoutMs: 5 }
  );
}

test('screenshot forwards only supported image options and returns the image result', async () => {
  const calls = [];
  const screenshotResult = {
    screenshot: 'abc123',
    mimeType: 'image/jpeg',
    format: 'jpeg',
    quality: 75,
    resized: false
  };
  const handler = new CommandHandler(
    {},
    {
      screenshot: async (...args) => {
        calls.push(args);
        return screenshotResult;
      }
    },
    {}, {}, {}, {}, {}, {}
  );

  const response = await handler.handleCommand({
    id: 'screenshot-options',
    type: 'command',
    command: 'screenshot',
    params: {
      tabId: 42,
      fullPage: false,
      format: 'jpeg',
      quality: 75,
      maxWidth: 1200,
      maxHeight: 800,
      unexpected: 'must-not-forward'
    }
  });

  assert.equal(response.success, true);
  assert.deepEqual(response.result, screenshotResult);
  assert.deepEqual(calls, [[42, false, {
    format: 'jpeg',
    quality: 75,
    maxWidth: 1200,
    maxHeight: 800
  }]]);
});

test('screenshot processing errors do not retry or attach the debugger', async () => {
  let screenshotCalls = 0;
  const lifecycle = [];
  const handler = new CommandHandler(
    {
      ensureDebuggerAttached: async tabId => lifecycle.push(['attach', tabId]),
      scheduleDebuggerDetach: (tabId, reason) => lifecycle.push(['detach', tabId, reason])
    },
    {
      screenshot: async () => {
        screenshotCalls += 1;
        throw new Error('Screenshot conversion failed: Debugger is not attached');
      }
    },
    {}, {}, {}, {}, {}, {}
  );

  const response = await handler.handleCommand({
    id: 'processing-failure',
    type: 'command',
    command: 'screenshot',
    params: { tabId: 42, maxWidth: 800 }
  });

  assert.equal(response.success, false);
  assert.match(response.error.message, /conversion failed/i);
  assert.equal(screenshotCalls, 1);
  assert.deepEqual(lifecycle, []);
});

test('screenshot retries with an attached debugger only for a not-attached error', async () => {
  let screenshotCalls = 0;
  const lifecycle = [];
  const handler = new CommandHandler(
    {
      ensureDebuggerAttached: async tabId => lifecycle.push(['attach', tabId]),
      scheduleDebuggerDetach: (tabId, reason) => lifecycle.push(['detach', tabId, reason])
    },
    {
      screenshot: async () => {
        screenshotCalls += 1;
        if (screenshotCalls === 1) {
          throw Object.assign(new Error('Debugger is not attached'), { code: 'DEBUGGER_NOT_ATTACHED' });
        }
        return { screenshot: 'YWJj', mimeType: 'image/jpeg', format: 'jpeg', quality: 80, resized: false };
      }
    },
    {}, {}, {}, {}, {}, {}
  );

  const response = await handler.handleCommand({
    id: 'attach-retry',
    type: 'command',
    command: 'screenshot',
    params: { tabId: 42 }
  });

  assert.equal(response.success, true);
  assert.equal(screenshotCalls, 2);
  assert.deepEqual(lifecycle, [
    ['attach', 42],
    ['detach', 42, 'screenshot.fallback']
  ]);
});

test('get_console_logs returns page history without attaching the debugger', async () => {
  const tabManager = {
    ensureDebuggerAttached: async () => assert.fail('page history must not attach the debugger'),
    scheduleDebuggerDetach: () => assert.fail('page history must not schedule debugger detach')
  };
  const handler = createConsoleHandler({
    tabManager,
    debuggerController: {},
    consoleCapture: {
      enableForTab: async () => assert.fail('page history must not enable CDP capture'),
      getLogs: () => assert.fail('page history must not read CDP capture')
    },
    lightweightController: {
      getConsoleLogs: async tabId => {
        assert.equal(tabId, 17);
        return {
          installed: true,
          logs: [{ level: 'error', text: 'historic', source: 'page', timestamp: 1 }]
        };
      }
    }
  });

  const pageResult = await handler.handleCommand({
    id: 'page-buffer',
    type: 'command',
    command: 'get_console_logs',
    params: { tabId: 17 }
  });

  assert.equal(pageResult.success, true);
  assert.deepEqual(pageResult.result, {
    logs: [{ level: 'error', text: 'historic', source: 'page', timestamp: 1 }],
    capture: { source: 'page-buffer', historyAvailable: true, limit: 500 }
  });
});

test('get_console_logs falls back to CDP when page history is missing', async () => {
  const events = [];
  const tabManager = {
    ensureDebuggerAttached: async tabId => events.push(['attach', tabId]),
    scheduleDebuggerDetach: (tabId, reason) => events.push(['detach', tabId, reason])
  };
  const debuggerController = {};
  const consoleCapture = {
    enableForTab: async (tabId, controller) => events.push(['enable', tabId, controller]),
    getLogs: tabId => {
      events.push(['logs', tabId]);
      return [{ level: 'warn', text: 'current', source: 'cdp', timestamp: 2 }];
    }
  };
  const handler = createConsoleHandler({
    tabManager,
    debuggerController,
    consoleCapture,
    lightweightController: {
      getConsoleLogs: async () => ({ installed: false, logs: [] })
    }
  });

  const fallbackResult = await handler.handleCommand({
    id: 'cdp-fallback',
    type: 'command',
    command: 'get_console_logs',
    params: { tabId: 23, minLevel: 'warning' }
  });

  assert.equal(fallbackResult.success, true);
  assert.deepEqual(fallbackResult.result.logs, [
    { level: 'warning', text: 'current', source: 'cdp', timestamp: 2 }
  ]);
  assert.deepEqual(fallbackResult.result.capture, {
    source: 'cdp', historyAvailable: false, limit: 500
  });
  assert.deepEqual(events, [
    ['attach', 23],
    ['enable', 23, debuggerController],
    ['logs', 23],
    ['detach', 23, 'get_console_logs.fallback']
  ]);
});

test('get_console_logs falls back to CDP when main-world injection fails', async () => {
  let attached = false;
  const handler = createConsoleHandler({
    tabManager: {
      ensureDebuggerAttached: async () => { attached = true; },
      scheduleDebuggerDetach() {}
    },
    debuggerController: {},
    consoleCapture: {
      enableForTab: async () => {},
      getLogs: () => []
    },
    lightweightController: {
      getConsoleLogs: async () => { throw new Error('restricted page'); }
    }
  });

  const result = await handler.handleCommand({
    id: 'restricted-page',
    type: 'command',
    command: 'get_console_logs',
    params: { tabId: 24 }
  });

  assert.equal(result.success, true);
  assert.equal(attached, true);
  assert.deepEqual(result.result.capture, {
    source: 'cdp', historyAvailable: false, limit: 500
  });
});

test('ConsoleCapture installs its listener before Runtime.enable can emit synchronously', async () => {
  const original = global.chrome;
  let listener;
  global.chrome = {
    debugger: {
      onEvent: {
        addListener(handler) { listener = handler; },
        removeListener() {}
      }
    }
  };

  try {
    const capture = new ConsoleCapture();
    await capture.enableForTab(31, {
      async sendCommand(tabId, method) {
        assert.equal(tabId, 31);
        assert.equal(method, 'Runtime.enable');
        assert.equal(typeof listener, 'function');
        listener(
          { tabId: 31 },
          'Runtime.consoleAPICalled',
          { type: 'error', args: [{ value: 'during-enable' }] }
        );
      }
    });

    assert.deepEqual(capture.getLogs(31).map(({ level, text }) => ({ level, text })), [
      { level: 'error', text: 'during-enable' }
    ]);
  } finally {
    if (original === undefined) delete global.chrome;
    else global.chrome = original;
  }
});
