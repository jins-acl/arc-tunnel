const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

function loadClientModule() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'background', 'websocket-client.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false
  });
  const module = { exports: {} };
  const compile = new Function('module', 'exports', 'require', result.outputFiles[0].text);
  compile(module, module.exports, require);
  return module.exports;
}

const {
  WebSocketClient,
  isValidAuthToken,
  normalizeWebSocketUrl,
  resolveConfiguredWebSocketUrl
} = loadClientModule();

const TEST_AUTH_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_AUTH_TOKEN = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA';
const NONCANONICAL_AUTH_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB';

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
    this.throwOnSend = null;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(value) {
    this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) });
  }

  send(value) {
    if (this.throwOnSend) throw this.throwOnSend;
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

function setupEnvironment() {
  const originals = {
    WebSocket: global.WebSocket,
    chrome: global.chrome,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    random: Math.random,
    log: console.log,
    error: console.error,
    warn: console.warn
  };
  const timers = [];
  const intervals = [];
  const alarms = { created: [], cleared: [] };
  const logs = { log: [], error: [], warn: [] };
  let nextTimerId = 1;

  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  global.chrome = {
    alarms: {
      create(name, options) { alarms.created.push({ name, options }); },
      clear(name) { alarms.cleared.push(name); }
    }
  };
  global.setTimeout = (callback, delay) => {
    const timer = { id: nextTimerId++, callback, delay, cleared: false };
    timers.push(timer);
    return timer.id;
  };
  global.clearTimeout = (id) => {
    const timer = timers.find(candidate => candidate.id === id);
    if (timer) timer.cleared = true;
  };
  global.setInterval = (callback, delay) => {
    const interval = { id: nextTimerId++, callback, delay, cleared: false };
    intervals.push(interval);
    return interval.id;
  };
  global.clearInterval = (id) => {
    const interval = intervals.find(candidate => candidate.id === id);
    if (interval) interval.cleared = true;
  };
  Math.random = () => 0;
  console.log = (...args) => logs.log.push(args);
  console.error = (...args) => logs.error.push(args);
  console.warn = (...args) => logs.warn.push(args);

  return {
    alarms,
    logs,
    timers,
    intervals,
    runTimer(timer) {
      if (!timer.cleared) return timer.callback();
    },
    restore() {
      global.WebSocket = originals.WebSocket;
      global.chrome = originals.chrome;
      global.setTimeout = originals.setTimeout;
      global.clearTimeout = originals.clearTimeout;
      global.setInterval = originals.setInterval;
      global.clearInterval = originals.clearInterval;
      Math.random = originals.random;
      console.log = originals.log;
      console.error = originals.error;
      console.warn = originals.warn;
    }
  };
}

function environmentTest(name, run) {
  test(name, { concurrency: false }, async () => {
    const environment = setupEnvironment();
    try {
      await run(environment);
    } finally {
      environment.restore();
    }
  });
}

function latestSocket() {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

test('root URLs normalize to the extension endpoint while explicit paths are preserved', () => {
  assert.equal(normalizeWebSocketUrl('ws://localhost:8765'), 'ws://localhost:8765/extension');
  assert.equal(normalizeWebSocketUrl('ws://localhost:8765/custom'), 'ws://localhost:8765/custom');
});

test('legacy localhost default migrates without changing custom URLs', () => {
  assert.equal(typeof resolveConfiguredWebSocketUrl, 'function');
  assert.equal(resolveConfiguredWebSocketUrl(undefined), 'ws://127.0.0.1:8765');
  assert.equal(resolveConfiguredWebSocketUrl('ws://localhost:8765'), 'ws://127.0.0.1:8765');
  assert.equal(resolveConfiguredWebSocketUrl('ws://localhost:8765/'), 'ws://127.0.0.1:8765');
  assert.equal(resolveConfiguredWebSocketUrl('ws://localhost:8765/extension'), 'ws://127.0.0.1:8765/extension');
  assert.equal(resolveConfiguredWebSocketUrl('ws://localhost:9000'), 'ws://localhost:9000');
  assert.equal(resolveConfiguredWebSocketUrl('ws://localhost:8765/custom'), 'ws://localhost:8765/custom');
  assert.equal(resolveConfiguredWebSocketUrl('ws://localhost:8765?profile=x'), 'ws://localhost:8765?profile=x');
  assert.equal(resolveConfiguredWebSocketUrl('ws://localhost:8765/#fragment'), 'ws://localhost:8765/#fragment');
  assert.equal(resolveConfiguredWebSocketUrl('ws://localhost:8765/extension?x=1'), 'ws://localhost:8765/extension?x=1');
  assert.equal(resolveConfiguredWebSocketUrl('ws://example.test:8765/custom'), 'ws://example.test:8765/custom');
});

environmentTest('default client connects to the IPv4 loopback endpoint', async () => {
  const client = new WebSocketClient();
  const connection = client.connect().then(null, error => error);
  const socket = latestSocket();

  assert.equal(socket.url, 'ws://127.0.0.1:8765/extension');
  client.disconnect();
  assert.match((await connection).message, /intentionally/i);
});

for (const invalidWelcome of [
  { type: 'welcome', protocolVersion: 99 },
  { type: 'welcome' }
]) {
  environmentTest(`invalid welcome ${JSON.stringify(invalidWelcome)} rejects and cleans up`, async (env) => {
    const client = new WebSocketClient();
    const connection = client.connect().then(
      () => ({ resolved: true }),
      error => ({ error })
    );
    const socket = latestSocket();
    socket.open();
    socket.message(invalidWelcome);
    await Promise.resolve();

    assert.equal(socket.closeCalls, 1);
    const outcome = await connection;
    assert.match(outcome.error.message, /protocol|welcome/i);
    socket.emitClose();
    assert.equal(env.timers.filter(timer => !timer.cleared).length, 0);
  });
}

environmentTest('malformed JSON during handshake rejects and cleans up', async () => {
  const client = new WebSocketClient();
  const connection = client.connect().then(null, error => error);
  const socket = latestSocket();
  socket.open();
  socket.message('{not-json');
  await Promise.resolve();

  assert.equal(socket.closeCalls, 1);
  assert.match((await connection).message, /protocol|handshake|json/i);
});

environmentTest('commands are ignored until a valid welcome completes the handshake', async () => {
  const client = new WebSocketClient();
  const commands = [];
  client.onCommand(command => commands.push(command));
  const connection = client.connect();
  const socket = latestSocket();
  socket.open();
  socket.message({ id: 'early', type: 'command', command: 'list_tabs', params: {} });
  assert.equal(commands.length, 0);

  socket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;
  socket.message({ id: 'ready', type: 'command', command: 'list_tabs', params: {} });
  assert.deepEqual(commands.map(command => command.id), ['ready']);
});

environmentTest('valid v2 welcome resolves and sends the extension hello', async () => {
  const client = new WebSocketClient(undefined, TEST_AUTH_TOKEN);
  const connection = client.connect();
  const socket = latestSocket();
  socket.open();
  assert.deepEqual(socket.sent, [{
    type: 'hello',
    role: 'extension',
    protocolVersion: 2,
    token: TEST_AUTH_TOKEN
  }]);
  socket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;
  assert.equal(client.isConnected(), true);
});

environmentTest('connect remains pending and heartbeat-free until a valid welcome', async (env) => {
  const client = new WebSocketClient(undefined, TEST_AUTH_TOKEN);
  let settled = false;
  const connection = client.connect().finally(() => {
    settled = true;
  });
  const socket = latestSocket();
  socket.open();
  await Promise.resolve();

  assert.equal(settled, false);
  assert.equal(env.intervals.length, 0);
  assert.equal(client.getConnectionState(), 'connecting');

  socket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;
  assert.equal(settled, true);
  assert.equal(client.getConnectionState(), 'connected');
});

environmentTest('valid welcome starts a 10-second heartbeat interval and sends heartbeat events', async (env) => {
  const client = new WebSocketClient();
  const connection = client.connect();
  const socket = latestSocket();
  socket.open();
  socket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;

  assert.equal(env.intervals.length, 1);
  const heartbeat = env.intervals[0];
  assert.equal(heartbeat.delay, 10_000);
  heartbeat.callback();
  assert.equal(socket.sent.length, 2);
  assert.deepEqual(socket.sent[1], {
    type: 'event',
    event: 'heartbeat',
    data: {},
    timestamp: socket.sent[1].timestamp
  });
  assert.equal(typeof socket.sent[1].timestamp, 'number');
});

environmentTest('does not start heartbeat before a valid welcome', async (env) => {
  const client = new WebSocketClient();
  const connection = client.connect().then(null, error => error);
  const socket = latestSocket();
  socket.open();

  assert.equal(env.intervals.length, 0);

  client.disconnect();
  await connection;
});

environmentTest('repeated welcome messages keep exactly one heartbeat interval', async (env) => {
  const client = new WebSocketClient();
  const connection = client.connect();
  const socket = latestSocket();
  socket.open();
  socket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;
  socket.message({ type: 'welcome', protocolVersion: 2 });

  assert.equal(env.intervals.length, 1);
  assert.equal(env.intervals.filter(interval => !interval.cleared).length, 1);
});

environmentTest('heartbeat send failure closes the generation and schedules one safe reconnect', async (env) => {
  const client = new WebSocketClient();
  const connection = client.connect();
  const socket = latestSocket();
  socket.open();
  socket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;
  const heartbeat = env.intervals[0];
  socket.throwOnSend = new Error('heartbeat send failed');

  assert.doesNotThrow(() => heartbeat.callback());
  assert.equal(heartbeat.cleared, true);
  assert.equal(socket.closeCalls, 1);
  assert.equal(client.isConnected(), false);
  assert.equal(env.timers.filter(timer => !timer.cleared).length, 1);
  assert.deepEqual(env.alarms.created.at(-1), {
    name: 'ws-reconnect', options: { delayInMinutes: 1 }
  });

  socket.emitClose();
  assert.equal(env.timers.filter(timer => !timer.cleared).length, 1);
});

environmentTest('disconnect clears the active heartbeat interval', async (env) => {
  const client = new WebSocketClient();
  const connection = client.connect();
  const socket = latestSocket();
  socket.open();
  socket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;

  const heartbeat = env.intervals[0];
  assert.ok(heartbeat);
  client.disconnect();

  assert.equal(heartbeat.cleared, true);
});

environmentTest('socket close clears the active heartbeat interval', async (env) => {
  const client = new WebSocketClient();
  const connection = client.connect();
  const socket = latestSocket();
  socket.open();
  socket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;

  const heartbeat = env.intervals[0];
  assert.ok(heartbeat);
  socket.emitClose();

  assert.equal(heartbeat.cleared, true);
});

environmentTest('reconnect keeps one heartbeat interval and ignores a stale callback', async (env) => {
  const client = new WebSocketClient();
  const firstConnection = client.connect();
  const firstSocket = latestSocket();
  firstSocket.open();
  firstSocket.message({ type: 'welcome', protocolVersion: 2 });
  await firstConnection;
  const staleHeartbeat = env.intervals[0];

  firstSocket.emitClose();
  const reconnectTimer = env.timers.find(timer => !timer.cleared);
  const reconnectAttempt = env.runTimer(reconnectTimer);
  const replacement = latestSocket();
  replacement.open();
  replacement.message({ type: 'welcome', protocolVersion: 2 });
  await reconnectAttempt;

  const activeIntervals = env.intervals.filter(interval => !interval.cleared);
  assert.equal(activeIntervals.length, 1);
  assert.notEqual(activeIntervals[0], staleHeartbeat);
  const replacementSentBeforeStaleCallback = replacement.sent.length;
  staleHeartbeat.callback();
  assert.equal(firstSocket.sent.length, 1);
  assert.equal(replacement.sent.length, replacementSentBeforeStaleCallback);
});

environmentTest('setting the current URL is idempotent', async () => {
  const client = new WebSocketClient();
  const connection = client.connect();
  const socket = latestSocket();
  socket.open();
  socket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;

  client.setUrl('ws://127.0.0.1:8765');

  assert.equal(socket.closeCalls, 0);
  assert.equal(client.isConnected(), true);
});

environmentTest('setUrl invalidates the old generation and one connect creates one replacement', async () => {
  const client = new WebSocketClient();
  const oldConnection = client.connect().then(null, error => error);
  const oldSocket = latestSocket();

  client.setUrl('ws://localhost:9999');
  const replacement = client.connect();
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.match((await oldConnection).message, /superseded/i);
  assert.equal(oldSocket.closeCalls, 1);

  const newSocket = latestSocket();
  newSocket.open();
  newSocket.message({ type: 'welcome', protocolVersion: 2 });
  await replacement;
  assert.equal(newSocket.url, 'ws://localhost:9999/extension');
});

environmentTest('setUrl clears heartbeat and makes its stale callback inert', async (env) => {
  const client = new WebSocketClient();
  const connection = client.connect();
  const socket = latestSocket();
  socket.open();
  socket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;
  const heartbeat = env.intervals[0];

  client.setUrl('ws://localhost:9999');
  const sentBeforeStaleCallback = socket.sent.length;
  heartbeat.callback();

  assert.equal(heartbeat.cleared, true);
  assert.equal(socket.sent.length, sentBeforeStaleCallback);
});

environmentTest('stale old-socket callbacks do nothing', async (env) => {
  const client = new WebSocketClient();
  const oldConnection = client.connect().catch(() => undefined);
  const oldSocket = latestSocket();
  client.setUrl('ws://localhost:9999');
  await oldConnection;
  const replacement = client.connect();
  const newSocket = latestSocket();

  oldSocket.open();
  oldSocket.message({ type: 'welcome', protocolVersion: 2 });
  oldSocket.emitClose();
  assert.equal(oldSocket.sent.length, 0);
  assert.equal(env.timers.filter(timer => !timer.cleared).length, 0);

  newSocket.open();
  newSocket.message({ type: 'welcome', protocolVersion: 2 });
  await replacement;
});

environmentTest('intentional close does not reconnect', async (env) => {
  const client = new WebSocketClient();
  const connection = client.connect();
  const socket = latestSocket();
  socket.open();
  socket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;

  client.disconnect();
  socket.emitClose();
  assert.equal(env.timers.filter(timer => !timer.cleared).length, 0);
  assert.equal(env.alarms.created.length, 0);
});

environmentTest('service worker suspension preserves a persistent reconnect', async (env) => {
  const client = new WebSocketClient();
  const connection = client.connect();
  const socket = latestSocket();
  socket.open();
  socket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;

  assert.equal(typeof client.prepareForSuspend, 'function');
  client.prepareForSuspend();
  socket.emitClose();

  assert.equal(socket.closeCalls, 1);
  assert.equal(env.intervals[0].cleared, true);
  assert.equal(client.isConnected(), false);
  assert.equal(env.timers.filter(timer => !timer.cleared).length, 1);
  assert.deepEqual(env.alarms.created.at(-1), {
    name: 'ws-reconnect', options: { delayInMinutes: 1 }
  });
});

environmentTest('suspension makes the cleared heartbeat callback inert', async (env) => {
  const client = new WebSocketClient();
  const connection = client.connect();
  const socket = latestSocket();
  socket.open();
  socket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;
  const heartbeat = env.intervals[0];

  client.prepareForSuspend();
  const sentBeforeStaleCallback = socket.sent.length;
  heartbeat.callback();

  assert.equal(heartbeat.cleared, true);
  assert.equal(socket.sent.length, sentBeforeStaleCallback);
});

environmentTest('late handshake callbacks after suspension cannot cancel reconnect', async (env) => {
  const client = new WebSocketClient();
  const connection = client.connect().then(null, error => error);
  const socket = latestSocket();

  client.prepareForSuspend();
  assert.match((await connection).message, /suspend/i);

  socket.open();
  socket.message({ type: 'welcome', protocolVersion: 2 });

  assert.equal(socket.sent.length, 0);
  assert.equal(env.timers.filter(timer => !timer.cleared).length, 1);
  assert.equal(env.alarms.cleared.includes('ws-reconnect'), false);
});

environmentTest('timer and alarm reconnect overlap cannot create parallel sockets', async (env) => {
  const client = new WebSocketClient();
  const connection = client.connect();
  const firstSocket = latestSocket();
  firstSocket.open();
  firstSocket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;
  firstSocket.emitClose();
  const reconnectTimer = env.timers.find(timer => !timer.cleared);
  assert.ok(reconnectTimer);

  const alarmAttempt = client.connect();
  env.runTimer(reconnectTimer);
  assert.equal(FakeWebSocket.instances.length, 2);

  const replacement = latestSocket();
  replacement.open();
  replacement.message({ type: 'welcome', protocolVersion: 2 });
  await alarmAttempt;
});

environmentTest('failed alarm reconnect replaces the stale generation timer', async (env) => {
  const client = new WebSocketClient();
  const connection = client.connect();
  const firstSocket = latestSocket();
  firstSocket.open();
  firstSocket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;
  firstSocket.emitClose();
  const staleTimer = env.timers.find(timer => !timer.cleared);
  assert.ok(staleTimer);

  const alarmAttempt = client.connect().then(null, error => error);
  const replacement = latestSocket();
  replacement.emitClose();
  assert.match((await alarmAttempt).message, /closed/i);

  assert.equal(staleTimer.cleared, true);
  const currentTimers = env.timers.filter(timer => !timer.cleared);
  assert.equal(currentTimers.length, 1);
  assert.notEqual(currentTimers[0], staleTimer);
  assert.deepEqual(env.alarms.created.at(-1), {
    name: 'ws-reconnect', options: { delayInMinutes: 1 }
  });
});

environmentTest('switches to a persistent low-frequency retry after fast retries are exhausted', async (env) => {
  const client = new WebSocketClient();
  const connection = client.connect();
  const socket = latestSocket();
  socket.open();
  socket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;

  client.reconnectAttempts = client.maxReconnectAttempts;
  socket.emitClose();

  const retry = env.timers.find(timer => !timer.cleared);
  assert.ok(retry);
  assert.equal(retry.delay, 60_000);
  assert.deepEqual(env.alarms.created.at(-1), {
    name: 'ws-reconnect', options: { delayInMinutes: 1 }
  });
});

test('browser-safe token validation rejects noncanonical base64url aliases', () => {
  assert.equal(typeof isValidAuthToken, 'function');
  assert.equal(isValidAuthToken(TEST_AUTH_TOKEN), true);
  assert.equal(isValidAuthToken(OTHER_AUTH_TOKEN), true);
  assert.equal(isValidAuthToken(NONCANONICAL_AUTH_TOKEN), false);
  assert.equal(isValidAuthToken('short'), false);
  assert.equal(isValidAuthToken(null), false);
});

environmentTest('authentication failure is stable and rejects without exposing the token', async (env) => {
  const client = new WebSocketClient(undefined, TEST_AUTH_TOKEN);
  assert.equal(typeof client.getConnectionState, 'function');
  assert.equal(typeof client.canReconnect, 'function');

  const connection = client.connect().then(
    () => ({ resolved: true }),
    error => ({ error })
  );
  const socket = latestSocket();
  socket.open();
  socket.emitClose(1008, 'AUTH_FAILED');
  const outcome = await connection;

  assert.equal(outcome.resolved, undefined);
  assert.match(outcome.error.message, /authentication failed/i);
  assert.equal(outcome.error.message.includes(TEST_AUTH_TOKEN), false);
  assert.equal(client.getConnectionState(), 'auth_failed');
  assert.equal(client.isConnected(), false);
  assert.equal(client.canReconnect(), false);
  assert.equal(env.timers.filter(timer => !timer.cleared).length, 0);
  assert.equal(env.intervals.filter(interval => !interval.cleared).length, 0);
  assert.ok(env.alarms.cleared.includes('ws-reconnect'));
});

environmentTest('authentication failure after welcome clears the active heartbeat', async (env) => {
  const client = new WebSocketClient(undefined, TEST_AUTH_TOKEN);
  const connection = client.connect();
  const socket = latestSocket();
  socket.open();
  socket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;
  const heartbeat = env.intervals[0];
  assert.ok(heartbeat);

  socket.emitClose(1008, 'AUTH_FAILED');

  assert.equal(heartbeat.cleared, true);
  assert.equal(client.getConnectionState(), 'auth_failed');
  assert.equal(env.timers.filter(timer => !timer.cleared).length, 0);
});

environmentTest('same-token authentication failure suppresses timer, persistent, suspend, alarm, and direct retries', async (env) => {
  const client = new WebSocketClient(undefined, TEST_AUTH_TOKEN);
  assert.equal(typeof client.canReconnect, 'function');

  const connection = client.connect().catch(error => error);
  const socket = latestSocket();
  socket.open();
  socket.emitClose(1008, 'AUTH_FAILED');
  await connection;
  const socketCount = FakeWebSocket.instances.length;

  client.handleReconnect(client.connectionGeneration);
  client.reconnectAttempts = client.maxReconnectAttempts;
  client.handleReconnect(client.connectionGeneration);
  client.prepareForSuspend();
  assert.equal(client.canReconnect(), false);
  const directAttempt = client.connect().catch(error => error);
  const directError = await directAttempt;

  assert.match(directError.message, /authentication failed/i);
  assert.equal(directError.message.includes(TEST_AUTH_TOKEN), false);
  assert.equal(FakeWebSocket.instances.length, socketCount);
  assert.equal(env.timers.filter(timer => !timer.cleared).length, 0);
  assert.equal(env.alarms.created.length, 0);
});

environmentTest('authentication failure clears an already scheduled reconnect callback', async (env) => {
  const client = new WebSocketClient(undefined, TEST_AUTH_TOKEN);
  const firstConnection = client.connect();
  const firstSocket = latestSocket();
  firstSocket.open();
  firstSocket.message({ type: 'welcome', protocolVersion: 2 });
  await firstConnection;
  firstSocket.emitClose();
  const staleTimer = env.timers.find(timer => !timer.cleared);
  assert.ok(staleTimer);

  const reconnect = client.connect().catch(error => error);
  const rejectedSocket = latestSocket();
  rejectedSocket.open();
  rejectedSocket.emitClose(1008, 'AUTH_FAILED');
  await reconnect;
  env.runTimer(staleTimer);

  assert.equal(staleTimer.cleared, true);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(env.timers.filter(timer => !timer.cleared).length, 0);
});

environmentTest('changing only the URL keeps the rejected token suppressed', async () => {
  const client = new WebSocketClient(undefined, TEST_AUTH_TOKEN);
  assert.equal(typeof client.setConfig, 'function');

  const connection = client.connect().catch(error => error);
  const socket = latestSocket();
  socket.open();
  socket.emitClose(1008, 'AUTH_FAILED');
  await connection;
  const generation = client.connectionGeneration;

  assert.equal(client.setConfig('ws://localhost:9999', TEST_AUTH_TOKEN), true);
  assert.equal(client.connectionGeneration, generation + 1);
  assert.equal(client.getConnectionState(), 'auth_failed');
  const retry = await client.connect().catch(error => error);

  assert.match(retry.message, /authentication failed/i);
  assert.equal(FakeWebSocket.instances.length, 1);
});

environmentTest('a different valid token permits exactly one replacement connection', async () => {
  const client = new WebSocketClient(undefined, TEST_AUTH_TOKEN);
  assert.equal(typeof client.setConfig, 'function');

  const firstConnection = client.connect().catch(error => error);
  const firstSocket = latestSocket();
  firstSocket.open();
  firstSocket.emitClose(1008, 'AUTH_FAILED');
  await firstConnection;
  const rejectedGeneration = client.connectionGeneration;

  assert.equal(client.setConfig('ws://127.0.0.1:8765', OTHER_AUTH_TOKEN), true);
  assert.equal(client.connectionGeneration, rejectedGeneration + 1);
  assert.equal(client.getConnectionState(), 'idle');
  assert.equal(client.canReconnect(), true);
  const replacementConnection = client.connect();
  assert.equal(FakeWebSocket.instances.length, 2);
  const replacement = latestSocket();
  replacement.open();
  assert.equal(replacement.sent[0].token, OTHER_AUTH_TOKEN);
  replacement.message({ type: 'welcome', protocolVersion: 2 });
  await replacementConnection;
  assert.equal(client.getConnectionState(), 'connected');
});

environmentTest('storage-equivalent configuration calls are idempotent and create no extra socket', async () => {
  const client = new WebSocketClient('ws://localhost:8765', TEST_AUTH_TOKEN);
  assert.equal(typeof client.setConfig, 'function');
  const generation = client.connectionGeneration;

  assert.equal(client.setConfig('ws://localhost:8765/', TEST_AUTH_TOKEN), false);
  assert.equal(client.setConfig('ws://localhost:8765/extension', TEST_AUTH_TOKEN), false);
  assert.equal(client.connectionGeneration, generation);
  assert.equal(FakeWebSocket.instances.length, 0);

  assert.equal(client.setConfig('ws://localhost:9999', TEST_AUTH_TOKEN), true);
  const replacement = client.connect();
  assert.equal(client.setConfig('ws://localhost:9999/', TEST_AUTH_TOKEN), false);
  assert.equal(FakeWebSocket.instances.length, 1);
  const socket = latestSocket();
  socket.open();
  socket.message({ type: 'welcome', protocolVersion: 2 });
  await replacement;
});

environmentTest('invalid and noncanonical token configurations are rejected without sockets', async () => {
  const client = new WebSocketClient(undefined, TEST_AUTH_TOKEN);
  assert.equal(typeof client.setConfig, 'function');

  assert.equal(client.setConfig('ws://localhost:9999', NONCANONICAL_AUTH_TOKEN), false);
  assert.equal(client.setConfig('ws://localhost:9999', 'short'), false);
  assert.equal(FakeWebSocket.instances.length, 0);
});

environmentTest('normal closes retain exponential reconnect delays', async (env) => {
  const client = new WebSocketClient(undefined, TEST_AUTH_TOKEN);
  const firstConnection = client.connect();
  const firstSocket = latestSocket();
  firstSocket.open();
  firstSocket.message({ type: 'welcome', protocolVersion: 2 });
  await firstConnection;
  firstSocket.emitClose();
  const firstRetry = env.timers.find(timer => !timer.cleared);
  assert.equal(firstRetry.delay, 1000);

  const secondConnection = env.runTimer(firstRetry);
  const secondSocket = latestSocket();
  secondSocket.emitClose();
  await secondConnection.catch(() => undefined);
  const secondRetry = env.timers.at(-1);
  assert.equal(secondRetry.delay, 2000);
});

environmentTest('captured logs and errors never contain the authentication token', async (env) => {
  const client = new WebSocketClient(undefined, TEST_AUTH_TOKEN);
  assert.equal(typeof client.getConnectionState, 'function');

  const connection = client.connect().catch(error => error);
  const socket = latestSocket();
  socket.open();
  socket.emitClose(1008, 'AUTH_FAILED');
  const error = await connection;
  await client.connect().catch(() => undefined);

  const captured = JSON.stringify({
    logs: env.logs,
    error: { name: error.name, message: error.message }
  });
  assert.equal(captured.includes(TEST_AUTH_TOKEN), false);
});
