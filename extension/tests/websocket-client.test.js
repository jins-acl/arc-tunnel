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

const { WebSocketClient, normalizeWebSocketUrl } = loadClientModule();

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

  message(value) {
    this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) });
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    this.closeCalls++;
    this.readyState = FakeWebSocket.CLOSED;
  }

  emitClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

function setupEnvironment() {
  const timers = [];
  const alarms = { created: [], cleared: [] };
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
  Math.random = () => 0;

  return {
    alarms,
    timers,
    runTimer(timer) {
      if (!timer.cleared) return timer.callback();
    }
  };
}

function latestSocket() {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

test('root URLs normalize to the extension endpoint while explicit paths are preserved', () => {
  assert.equal(normalizeWebSocketUrl('ws://localhost:8765'), 'ws://localhost:8765/extension');
  assert.equal(normalizeWebSocketUrl('ws://localhost:8765/custom'), 'ws://localhost:8765/custom');
});

for (const invalidWelcome of [
  { type: 'welcome', protocolVersion: 99 },
  { type: 'welcome' }
]) {
  test(`invalid welcome ${JSON.stringify(invalidWelcome)} rejects and cleans up`, { concurrency: false }, async (t) => {
    const env = setupEnvironment(t);
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

test('malformed JSON during handshake rejects and cleans up', { concurrency: false }, async (t) => {
  setupEnvironment(t);
  const client = new WebSocketClient();
  const connection = client.connect().then(null, error => error);
  const socket = latestSocket();
  socket.open();
  socket.message('{not-json');
  await Promise.resolve();

  assert.equal(socket.closeCalls, 1);
  assert.match((await connection).message, /protocol|handshake|json/i);
});

test('commands are ignored until a valid welcome completes the handshake', { concurrency: false }, async (t) => {
  setupEnvironment(t);
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

test('valid v2 welcome resolves and sends the extension hello', { concurrency: false }, async (t) => {
  setupEnvironment(t);
  const client = new WebSocketClient();
  const connection = client.connect();
  const socket = latestSocket();
  socket.open();
  assert.deepEqual(socket.sent, [{ type: 'hello', role: 'extension', protocolVersion: 2 }]);
  socket.message({ type: 'welcome', protocolVersion: 2 });
  await connection;
  assert.equal(client.isConnected(), true);
});

test('setUrl invalidates the old generation and one connect creates one replacement', { concurrency: false }, async (t) => {
  setupEnvironment(t);
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

test('stale old-socket callbacks do nothing', { concurrency: false }, async (t) => {
  const env = setupEnvironment(t);
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

test('intentional close does not reconnect', { concurrency: false }, async (t) => {
  const env = setupEnvironment(t);
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

test('timer and alarm reconnect overlap cannot create parallel sockets', { concurrency: false }, async (t) => {
  const env = setupEnvironment(t);
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
