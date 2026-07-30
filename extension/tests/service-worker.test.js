const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const TEST_AUTH_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_AUTH_TOKEN = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA';
const REJECTED_AUTH_TOKEN_KEY = 'arc_tunnel_rejected_auth_token';

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
  for (let attempt = 0; attempt < 12; attempt++) {
    await Promise.resolve();
  }
}

async function waitForMicrotasks(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail('condition was not reached while flushing microtasks');
}

function bundleServiceWorker() {
  return esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'background', 'service-worker.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false
  }).outputFiles[0].text;
}

function setupServiceWorker({
  storedConfig = {
    arc_tunnel_ws_url: 'ws://127.0.0.1:8765',
    authToken: TEST_AUTH_TOKEN
  },
  sessionValues = {},
  sessionRemovePromise,
  storageGetPromise,
  tabsPromise = Promise.resolve([])
} = {}) {
  const originals = {
    chrome: global.chrome,
    WebSocket: global.WebSocket,
    log: console.log,
    error: console.error
  };
  const storageChanged = event();
  const alarmEvent = event();
  const runtimeMessage = event();
  const storedValues = { ...storedConfig };
  const storageGets = [];
  const storageSets = [];
  const sessionGets = [];
  const sessionSets = [];
  const sessionRemoves = [];
  const createdAlarms = [];
  const logs = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      this.closeCalls = 0;
      FakeWebSocket.instances.push(this);
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }

    send(value) {
      this.sent.push(JSON.parse(value));
    }

    close() {
      this.closeCalls++;
      this.readyState = FakeWebSocket.CLOSED;
    }

    emitClose(code = 1006, reason = '') {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ code, reason });
    }
  }

  const noopEvent = () => event();
  global.WebSocket = FakeWebSocket;
  global.chrome = {
    storage: {
      local: {
        async get(keys) {
          storageGets.push(keys);
          if (storageGetPromise) return storageGetPromise;
          return { ...storedValues };
        },
        async set(value) {
          storageSets.push(value);
          const changes = {};
          for (const [key, newValue] of Object.entries(value)) {
            const oldValue = storedValues[key];
            storedValues[key] = newValue;
            changes[key] = { oldValue, newValue };
          }
          storageChanged.emit(changes, 'local');
        }
      },
      session: {
        async get(keys) {
          sessionGets.push(keys);
          return { ...sessionValues };
        },
        async set(value) {
          sessionSets.push(value);
          Object.assign(sessionValues, value);
        },
        async remove(keys) {
          sessionRemoves.push(keys);
          if (sessionRemovePromise) await sessionRemovePromise;
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete sessionValues[key];
          }
        }
      },
      onChanged: storageChanged
    },
    tabs: {
      query() { return tabsPromise; },
      onCreated: noopEvent(),
      onRemoved: noopEvent(),
      onUpdated: noopEvent()
    },
    windows: { onRemoved: noopEvent() },
    debugger: { onDetach: noopEvent(), onEvent: noopEvent() },
    runtime: {
      lastError: undefined,
      onMessage: runtimeMessage,
      onSuspend: noopEvent()
    },
    alarms: {
      create(name, options) { createdAlarms.push({ name, options }); },
      clear() {},
      onAlarm: alarmEvent
    }
  };
  console.log = (...args) => logs.push(['log', ...args]);
  console.error = (...args) => logs.push(['error', ...args]);

  new Function('require', bundleServiceWorker())(require);

  return {
    alarmEvent,
    createdAlarms,
    FakeWebSocket,
    logs,
    runtimeMessage,
    sessionGets,
    sessionRemoves,
    sessionSets,
    sessionValues,
    storageChanged,
    storageGets,
    storageSets,
    storedValues,
    restore() {
      global.chrome = originals.chrome;
      global.WebSocket = originals.WebSocket;
      console.log = originals.log;
      console.error = originals.error;
    }
  };
}

function environmentTest(name, run) {
  test(name, { concurrency: false }, async () => {
    const environment = setupServiceWorker();
    try {
      await run(environment);
    } finally {
      environment.restore();
    }
  });
}

test('startup waits for tab synchronization and applies the latest complete configuration once', { concurrency: false }, async () => {
  const tabsReady = deferred();
  const environment = setupServiceWorker({
    storedConfig: {
      arc_tunnel_ws_url: 'ws://localhost:8765',
      authToken: TEST_AUTH_TOKEN
    },
    tabsPromise: tabsReady.promise
  });
  try {
    await flushMicrotasks();

    assert.deepEqual(environment.storageGets, [
      ['arc_tunnel_ws_url', 'authToken']
    ]);
    assert.deepEqual(environment.storageSets, [{
      arc_tunnel_ws_url: 'ws://127.0.0.1:8765/extension',
      authToken: TEST_AUTH_TOKEN
    }]);
    assert.equal(environment.FakeWebSocket.instances.length, 0);

    environment.storageChanged.emit({
      arc_tunnel_ws_url: {
        oldValue: 'ws://127.0.0.1:8765',
        newValue: 'ws://127.0.0.1:9000'
      },
      authToken: {
        oldValue: TEST_AUTH_TOKEN,
        newValue: OTHER_AUTH_TOKEN
      }
    }, 'local');
    assert.equal(environment.FakeWebSocket.instances.length, 0);

    tabsReady.resolve([]);
    await flushMicrotasks();

    assert.equal(environment.FakeWebSocket.instances.length, 1);
    const socket = environment.FakeWebSocket.instances[0];
    assert.equal(socket.url, 'ws://127.0.0.1:9000/extension');
    socket.open();
    assert.equal(socket.sent[0].token, OTHER_AUTH_TOKEN);
    assert.deepEqual(environment.createdAlarms[0], {
      name: 'keepAlive', options: { periodInMinutes: 1 }
    });
  } finally {
    environment.restore();
  }
});

for (const raceCase of [
  {
    name: 'an early token-only change merges with the eventually loaded custom URL',
    changes: {
      authToken: {
        oldValue: TEST_AUTH_TOKEN,
        newValue: OTHER_AUTH_TOKEN
      }
    },
    expectedUrl: 'ws://127.0.0.1:9100/extension',
    expectedToken: OTHER_AUTH_TOKEN
  },
  {
    name: 'an early URL-only change merges with the eventually loaded stored token',
    changes: {
      arc_tunnel_ws_url: {
        oldValue: 'ws://127.0.0.1:9100',
        newValue: 'ws://127.0.0.1:9200'
      }
    },
    expectedUrl: 'ws://127.0.0.1:9200/extension',
    expectedToken: TEST_AUTH_TOKEN
  }
]) {
  test(raceCase.name, { concurrency: false }, async () => {
    const storageReady = deferred();
    const environment = setupServiceWorker({
      storageGetPromise: storageReady.promise
    });
    try {
      environment.storageChanged.emit(raceCase.changes, 'local');
      assert.equal(environment.FakeWebSocket.instances.length, 0);

      storageReady.resolve({
        arc_tunnel_ws_url: 'ws://127.0.0.1:9100',
        authToken: TEST_AUTH_TOKEN
      });
      await waitForMicrotasks(
        () => environment.FakeWebSocket.instances.length === 1
      );

      assert.equal(environment.FakeWebSocket.instances.length, 1);
      const socket = environment.FakeWebSocket.instances[0];
      assert.equal(socket.url, raceCase.expectedUrl);
      socket.open();
      assert.equal(socket.sent[0].token, raceCase.expectedToken);
    } finally {
      environment.restore();
    }
  });
}

environmentTest('one two-key storage event creates one replacement connection', async (environment) => {
  await flushMicrotasks();
  assert.equal(environment.FakeWebSocket.instances.length, 1);

  environment.storageChanged.emit({
    arc_tunnel_ws_url: {
      oldValue: 'ws://127.0.0.1:8765',
      newValue: 'ws://127.0.0.1:9000'
    },
    authToken: {
      oldValue: TEST_AUTH_TOKEN,
      newValue: OTHER_AUTH_TOKEN
    }
  }, 'local');
  await flushMicrotasks();

  assert.equal(environment.FakeWebSocket.instances.length, 2);
  const replacement = environment.FakeWebSocket.instances[1];
  assert.equal(replacement.url, 'ws://127.0.0.1:9000/extension');
  replacement.open();
  assert.equal(replacement.sent[0].token, OTHER_AUTH_TOKEN);
});

environmentTest('an authentication-failed reconnect alarm does not retry the rejected token', async (environment) => {
  await flushMicrotasks();
  const rejectedSocket = environment.FakeWebSocket.instances[0];
  rejectedSocket.open();
  rejectedSocket.emitClose(1008, 'AUTH_FAILED');
  await flushMicrotasks();
  const socketCount = environment.FakeWebSocket.instances.length;

  environment.alarmEvent.emit({ name: 'ws-reconnect' });
  await flushMicrotasks();

  assert.equal(environment.FakeWebSocket.instances.length, socketCount);
  assert.equal(
    JSON.stringify(environment.logs).includes('attempting reconnect'),
    false
  );
});

environmentTest('a changed valid token causes exactly one reconnect after authentication failure', async (environment) => {
  await flushMicrotasks();
  const rejectedSocket = environment.FakeWebSocket.instances[0];
  rejectedSocket.open();
  rejectedSocket.emitClose(1008, 'AUTH_FAILED');
  await flushMicrotasks();

  environment.storageChanged.emit({
    authToken: {
      oldValue: TEST_AUTH_TOKEN,
      newValue: OTHER_AUTH_TOKEN
    }
  }, 'local');
  await flushMicrotasks();

  assert.equal(environment.FakeWebSocket.instances.length, 2);
  const replacement = environment.FakeWebSocket.instances[1];
  replacement.open();
  assert.equal(replacement.sent[0].token, OTHER_AUTH_TOKEN);
});

test('a cold-started worker restores a matching rejection marker and reconnects only after token change', { concurrency: false }, async () => {
  const sessionValues = {};
  const firstWorker = setupServiceWorker({ sessionValues });
  try {
    await waitForMicrotasks(() => firstWorker.FakeWebSocket.instances.length === 1);
    const rejectedSocket = firstWorker.FakeWebSocket.instances[0];
    rejectedSocket.open();
    rejectedSocket.emitClose(1008, 'AUTH_FAILED');
    await waitForMicrotasks(
      () => sessionValues[REJECTED_AUTH_TOKEN_KEY] === TEST_AUTH_TOKEN
    );

    assert.deepEqual(firstWorker.sessionSets, [{
      [REJECTED_AUTH_TOKEN_KEY]: TEST_AUTH_TOKEN
    }]);
  } finally {
    firstWorker.restore();
  }

  const coldWorker = setupServiceWorker({ sessionValues });
  try {
    await flushMicrotasks();

    assert.deepEqual(coldWorker.sessionGets, [[REJECTED_AUTH_TOKEN_KEY]]);
    assert.equal(coldWorker.FakeWebSocket.instances.length, 0);
    let status;
    coldWorker.runtimeMessage.emit(
      { type: 'get_status' },
      {},
      value => { status = value; }
    );
    assert.deepEqual(status, { connected: false, state: 'auth_failed' });

    coldWorker.alarmEvent.emit({ name: 'keepAlive' });
    coldWorker.alarmEvent.emit({ name: 'ws-reconnect' });
    await flushMicrotasks();
    assert.equal(coldWorker.FakeWebSocket.instances.length, 0);

    coldWorker.storageChanged.emit({
      authToken: {
        oldValue: TEST_AUTH_TOKEN,
        newValue: OTHER_AUTH_TOKEN
      }
    }, 'local');
    await waitForMicrotasks(() => coldWorker.FakeWebSocket.instances.length === 1);

    assert.deepEqual(coldWorker.sessionRemoves, [[REJECTED_AUTH_TOKEN_KEY]]);
    assert.equal(sessionValues[REJECTED_AUTH_TOKEN_KEY], undefined);
    assert.equal(coldWorker.FakeWebSocket.instances.length, 1);
    const replacement = coldWorker.FakeWebSocket.instances[0];
    replacement.open();
    assert.equal(replacement.sent[0].token, OTHER_AUTH_TOKEN);
  } finally {
    coldWorker.restore();
  }
});

test('a rapid token round trip cannot let a stale marker removal reconnect a rejected token after restart', { concurrency: false }, async () => {
  const removeReady = deferred();
  const sessionValues = {
    [REJECTED_AUTH_TOKEN_KEY]: TEST_AUTH_TOKEN
  };
  const worker = setupServiceWorker({
    sessionValues,
    sessionRemovePromise: removeReady.promise
  });
  try {
    await flushMicrotasks();
    assert.equal(worker.FakeWebSocket.instances.length, 0);

    worker.storageChanged.emit({
      authToken: {
        oldValue: TEST_AUTH_TOKEN,
        newValue: OTHER_AUTH_TOKEN
      }
    }, 'local');
    await waitForMicrotasks(() => worker.sessionRemoves.length === 1);
    assert.deepEqual(worker.sessionRemoves, [[REJECTED_AUTH_TOKEN_KEY]]);

    worker.storageChanged.emit({
      authToken: {
        oldValue: OTHER_AUTH_TOKEN,
        newValue: TEST_AUTH_TOKEN
      }
    }, 'local');
    await flushMicrotasks();
    assert.equal(worker.FakeWebSocket.instances.length, 0);

    removeReady.resolve();
    await waitForMicrotasks(() => worker.sessionSets.length === 1);
    assert.equal(sessionValues[REJECTED_AUTH_TOKEN_KEY], TEST_AUTH_TOKEN);
  } finally {
    worker.restore();
  }

  const restartedWorker = setupServiceWorker({ sessionValues });
  try {
    await flushMicrotasks();
    assert.equal(restartedWorker.FakeWebSocket.instances.length, 0);
    let status;
    restartedWorker.runtimeMessage.emit(
      { type: 'get_status' },
      {},
      value => { status = value; }
    );
    assert.deepEqual(status, { connected: false, state: 'auth_failed' });
  } finally {
    restartedWorker.restore();
  }
});

test('an unsafe stored endpoint creates no socket or migration write and alarms stay inert', { concurrency: false }, async () => {
  const environment = setupServiceWorker({
    storedConfig: {
      arc_tunnel_ws_url: 'ws://attacker.example:8765/extension',
      authToken: TEST_AUTH_TOKEN
    }
  });
  try {
    await flushMicrotasks();

    assert.equal(environment.FakeWebSocket.instances.length, 0);
    assert.deepEqual(environment.storageSets, []);
    environment.alarmEvent.emit({ name: 'keepAlive' });
    environment.alarmEvent.emit({ name: 'ws-reconnect' });
    await flushMicrotasks();
    assert.equal(environment.FakeWebSocket.instances.length, 0);
    assert.equal(JSON.stringify(environment.logs).includes(TEST_AUTH_TOKEN), false);
  } finally {
    environment.restore();
  }
});

environmentTest('an unsafe two-key storage change creates no replacement socket or write', async (environment) => {
  await flushMicrotasks();
  assert.equal(environment.FakeWebSocket.instances.length, 1);

  environment.storageChanged.emit({
    arc_tunnel_ws_url: {
      oldValue: 'ws://127.0.0.1:8765',
      newValue: 'wss://127.0.0.1:8765/extension'
    },
    authToken: {
      oldValue: TEST_AUTH_TOKEN,
      newValue: OTHER_AUTH_TOKEN
    }
  }, 'local');
  await flushMicrotasks();

  assert.equal(environment.FakeWebSocket.instances.length, 1);
  assert.deepEqual(environment.storageSets, []);
  assert.equal(JSON.stringify(environment.logs).includes(OTHER_AUTH_TOKEN), false);
});

environmentTest('popup status exposes connection state without authentication secrets', async (environment) => {
  await flushMicrotasks();
  let response;

  environment.runtimeMessage.emit(
    { type: 'get_status' },
    {},
    value => { response = value; }
  );

  assert.deepEqual(response, {
    connected: false,
    state: 'connecting'
  });
  assert.equal(Object.hasOwn(response, 'authToken'), false);
  assert.equal(Object.hasOwn(response, 'token'), false);
  assert.equal(JSON.stringify(response).includes(TEST_AUTH_TOKEN), false);
});
