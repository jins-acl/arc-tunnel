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
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(
    module,
    module.exports,
    require
  );
  return module.exports;
}

const { CONSOLE_BUFFER_LIMIT, installConsoleHook, readConsoleBuffer } =
  loadModule('src/content/console-hook.ts');

function createTarget(calls = []) {
  return {
    console: {
      log: (...args) => calls.push(['log', args]),
      warn: (...args) => calls.push(['warn', args]),
      error: (...args) => calls.push(['error', args]),
      info: (...args) => calls.push(['info', args]),
      debug: (...args) => calls.push(['debug', args])
    }
  };
}

test('preserves original console calls and serializes common values', () => {
  const calls = [];
  const target = createTarget(calls);
  const error = new Error('broken');

  installConsoleHook(target);
  target.console.log('before-call', 7, true, null, undefined, error, [1, 'two'], { value: 7 });

  assert.deepEqual(calls, [[
    'log',
    ['before-call', 7, true, null, undefined, error, [1, 'two'], { value: 7 }]
  ]]);
  const [entry] = readConsoleBuffer(target).logs;
  assert.equal(entry.level, 'info');
  assert.equal(entry.source, 'page');
  assert.equal(typeof entry.timestamp, 'number');
  assert.match(entry.text, /before-call.*7.*true.*null.*undefined.*Error.*broken.*two.*value/s);
});

test('is idempotent and retains only the latest 500 entries', () => {
  const calls = [];
  const target = createTarget(calls);

  installConsoleHook(target);
  target.console.log('before-call', { value: 7 });
  installConsoleHook(target);
  assert.equal(readConsoleBuffer(target).installed, true);
  assert.equal(CONSOLE_BUFFER_LIMIT, 500);

  for (let index = 0; index < 500; index++) target.console.log(`entry-${index}`);

  const { logs } = readConsoleBuffer(target);
  assert.equal(logs.length, 500);
  assert.match(logs[0].text, /entry-0/);
  assert.match(logs[499].text, /entry-499/);
  assert.equal(calls.length, 501);
});

test('contains hostile values and caps rendered argument and entry sizes', () => {
  const target = createTarget();
  let getterCalls = 0;
  const throwingGetter = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      getterCalls++;
      throw new Error('getter trap');
    }
  });
  const throwingProxy = new Proxy({}, {
    ownKeys() { throw new Error('proxy trap'); }
  });

  installConsoleHook(target);
  assert.doesNotThrow(() => target.console.warn(throwingGetter, throwingProxy));
  assert.equal(getterCalls, 0);
  target.console.error('x'.repeat(5000));
  target.console.info(...Array.from({ length: 5 }, () => 'y'.repeat(4096)));

  const logs = readConsoleBuffer(target).logs;
  assert.equal(logs[0].level, 'warning');
  assert.ok(logs[0].text.length > 0);
  assert.ok(logs[1].text.length <= 4096);
  assert.ok(logs[2].text.length <= 16384);
});

test('capture failures never block the original console receiver or return value', () => {
  const calls = [];
  const receiver = { name: 'receiver' };
  const target = createTarget();
  target.console.log = function (...args) {
    calls.push({ receiver: this, args });
    return 'original-result';
  };
  installConsoleHook(target);

  const state = target[Symbol.for('arc-tunnel.console-buffer.v1')];
  Object.freeze(state.logs);
  assert.equal(target.console.log.call(receiver, 'frozen-buffer'), 'original-result');

  const secondTarget = createTarget();
  secondTarget.console.log = function (...args) {
    calls.push({ receiver: this, args });
    return 'replacement-result';
  };
  installConsoleHook(secondTarget);
  secondTarget[Symbol.for('arc-tunnel.console-buffer.v1')].logs = new Proxy([], {
    set() { throw new Error('buffer write blocked'); }
  });
  assert.equal(secondTarget.console.log.call(receiver, 'replaced-buffer'), 'replacement-result');

  assert.deepEqual(calls, [
    { receiver, args: ['frozen-buffer'] },
    { receiver, args: ['replaced-buffer'] }
  ]);
});

test('snapshots required intrinsics before the page poisons them', () => {
  const calls = [];
  const receiver = { name: 'poisoned-receiver' };
  const target = createTarget();
  target.console.error = function (...args) {
    calls[calls.length] = { receiver: this, args };
    return 73;
  };
  installConsoleHook(target);
  target[Symbol.for('arc-tunnel.console-buffer.v1')].logs.length = 500;

  const originalNow = Date.now;
  const originalApply = Reflect.apply;
  const originalOwnKeys = Reflect.ownKeys;
  const originalArrayIsArray = Array.isArray;
  const originalJoin = Array.prototype.join;
  const originalMap = Array.prototype.map;
  const originalPush = Array.prototype.push;
  const originalSplice = Array.prototype.splice;
  const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const originalGetPrototypeOf = Object.getPrototypeOf;
  const originalString = global.String;
  const originalStringSlice = String.prototype.slice;
  const originalWeakSetAdd = WeakSet.prototype.add;
  const originalWeakSetHas = WeakSet.prototype.has;
  let result;
  try {
    Date.now = () => { throw new Error('poisoned Date.now'); };
    Reflect.apply = () => { throw new Error('poisoned Reflect.apply'); };
    Reflect.ownKeys = () => { throw new Error('poisoned Reflect.ownKeys'); };
    Array.isArray = () => { throw new Error('poisoned Array.isArray'); };
    Array.prototype.join = () => { throw new Error('poisoned join'); };
    Array.prototype.map = () => { throw new Error('poisoned map'); };
    Array.prototype.push = () => { throw new Error('poisoned push'); };
    Array.prototype.splice = () => { throw new Error('poisoned splice'); };
    Object.getOwnPropertyDescriptor = () => { throw new Error('poisoned descriptor'); };
    Object.getPrototypeOf = () => { throw new Error('poisoned prototype'); };
    global.String = () => { throw new Error('poisoned String'); };
    originalString.prototype.slice = () => { throw new Error('poisoned string slice'); };
    WeakSet.prototype.add = () => { throw new Error('poisoned WeakSet.add'); };
    WeakSet.prototype.has = () => { throw new Error('poisoned WeakSet.has'); };

    result = target.console.error.call(receiver, { value: 'x'.repeat(5000) });
  } finally {
    Date.now = originalNow;
    Reflect.apply = originalApply;
    Reflect.ownKeys = originalOwnKeys;
    Array.isArray = originalArrayIsArray;
    Array.prototype.join = originalJoin;
    Array.prototype.map = originalMap;
    Array.prototype.push = originalPush;
    Array.prototype.splice = originalSplice;
    Object.getOwnPropertyDescriptor = originalGetOwnPropertyDescriptor;
    Object.getPrototypeOf = originalGetPrototypeOf;
    global.String = originalString;
    originalString.prototype.slice = originalStringSlice;
    WeakSet.prototype.add = originalWeakSetAdd;
    WeakSet.prototype.has = originalWeakSetHas;
  }

  assert.equal(result, 73);
  assert.deepEqual(calls, [{ receiver, args: [{ value: 'x'.repeat(5000) }] }]);
  assert.equal(readConsoleBuffer(target).logs.length, 500);
});
