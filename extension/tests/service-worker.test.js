const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('configuration changes wait for tab synchronization and the latest URL wins', { concurrency: false }, async () => {
  const originals = { chrome: global.chrome, WebSocket: global.WebSocket };
  const storageChanged = event();
  const alarmEvent = event();
  const createdAlarms = [];
  const tabsReady = deferred();
  const storedValues = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      FakeWebSocket.instances.push(this);
    }

    send() {}
    close() { this.readyState = FakeWebSocket.CLOSED; }
  }

  const noopEvent = () => event();
  global.WebSocket = FakeWebSocket;
  global.chrome = {
    storage: {
      local: {
        async get() { return { arc_tunnel_ws_url: 'ws://localhost:8765' }; },
        async set(value) {
          storedValues.push(value);
          storageChanged.emit({
            arc_tunnel_ws_url: {
              oldValue: 'ws://localhost:8765',
              newValue: value.arc_tunnel_ws_url
            }
          }, 'local');
        }
      },
      onChanged: storageChanged
    },
    tabs: {
      query() { return tabsReady.promise; },
      onCreated: noopEvent(),
      onRemoved: noopEvent(),
      onUpdated: noopEvent()
    },
    windows: { onRemoved: noopEvent() },
    debugger: { onDetach: noopEvent(), onEvent: noopEvent() },
    runtime: {
      lastError: undefined,
      onMessage: noopEvent(),
      onSuspend: noopEvent()
    },
    alarms: {
      create(name, options) { createdAlarms.push({ name, options }); },
      clear() {},
      onAlarm: alarmEvent
    }
  };

  try {
    const result = esbuild.buildSync({
      entryPoints: [path.join(__dirname, '..', 'src', 'background', 'service-worker.ts')],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      write: false
    });
    new Function('require', result.outputFiles[0].text)(require);
    await flushMicrotasks();

    assert.deepEqual(createdAlarms[0], {
      name: 'keepAlive', options: { periodInMinutes: 1 }
    });

    assert.deepEqual(storedValues, [{ arc_tunnel_ws_url: 'ws://127.0.0.1:8765' }]);
    assert.equal(FakeWebSocket.instances.length, 0);

    alarmEvent.emit({ name: 'ws-reconnect' });
    assert.equal(FakeWebSocket.instances.length, 0);

    storageChanged.emit({
      arc_tunnel_ws_url: {
        oldValue: 'ws://127.0.0.1:8765',
        newValue: 'ws://127.0.0.1:9000'
      }
    }, 'local');
    assert.equal(FakeWebSocket.instances.length, 0);

    tabsReady.resolve([]);
    await flushMicrotasks();
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(FakeWebSocket.instances[0].url, 'ws://127.0.0.1:9000/extension');
  } finally {
    global.chrome = originals.chrome;
    global.WebSocket = originals.WebSocket;
  }
});
