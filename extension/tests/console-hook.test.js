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
