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

const { LightweightController } = loadModule('src/background/lightweight-controller.ts');

async function withScriptingResult(result, run) {
  const original = global.chrome;
  global.chrome = { scripting: { executeScript: async () => result } };
  try { await run(); } finally {
    if (original === undefined) delete global.chrome;
    else global.chrome = original;
  }
}

async function withEdgeScripting(run) {
  const original = global.chrome;
  global.chrome = { scripting: { executeScript: async ({ func, args }) => {
    try {
      return [{ frameId: 0, result: func(...args) }];
    } catch {
      return [{ frameId: 0, result: null }];
    }
  } } };
  try { await run(); } finally {
    if (original === undefined) delete global.chrome;
    else global.chrome = original;
  }
}

function validConsoleEntry(overrides = {}) {
  return {
    level: 'info',
    text: 'message',
    source: 'page',
    timestamp: 1,
    ...overrides
  };
}

test('getConsoleLogs reads only the latest 500 main-world entries', async () => {
  const originalChrome = global.chrome;
  const bufferKey = Symbol.for('arc-tunnel.console-buffer.v1');
  const originalBuffer = Object.getOwnPropertyDescriptor(globalThis, bufferKey);
  const accessed = [];
  const logs = new Proxy(
    Array.from({ length: 600 }, (_, index) => validConsoleEntry({ text: `entry-${index}` })),
    {
      getOwnPropertyDescriptor(target, key) {
        if (/^\d+$/.test(String(key))) accessed.push(Number(key));
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    }
  );
  Object.defineProperty(globalThis, bufferKey, {
    configurable: true,
    value: { logs }
  });
  global.chrome = {
    scripting: {
      async executeScript(options) {
        assert.equal(options.world, 'MAIN');
        return [{ frameId: 0, result: options.func() }];
      }
    }
  };

  try {
    const result = await new LightweightController().getConsoleLogs(41);
    assert.equal(result.installed, true);
    assert.equal(result.logs.length, 500);
    assert.equal(result.logs[0].text, 'entry-100');
    assert.equal(result.logs[499].text, 'entry-599');
    assert.equal(accessed.some(index => index < 100), false);
  } finally {
    if (originalBuffer) Object.defineProperty(globalThis, bufferKey, originalBuffer);
    else delete globalThis[bufferKey];
    if (originalChrome === undefined) delete global.chrome;
    else global.chrome = originalChrome;
  }
});

test('getConsoleLogs rejects more than 500 returned entries', async () => {
  await withScriptingResult([{
    frameId: 0,
    result: { installed: true, logs: Array.from({ length: 501 }, () => validConsoleEntry()) }
  }], async () => {
    await assert.rejects(new LightweightController().getConsoleLogs(7), /malformed|500|limit/i);
  });
});

test('getConsoleLogs rejects oversized text and illegal level or source', async () => {
  for (const entry of [
    validConsoleEntry({ text: 'x'.repeat(16_385) }),
    validConsoleEntry({ level: 'log' }),
    validConsoleEntry({ source: 'attacker' })
  ]) {
    await withScriptingResult([{
      frameId: 0,
      result: { installed: true, logs: [entry] }
    }], async () => {
      await assert.rejects(new LightweightController().getConsoleLogs(7), /malformed|invalid/i);
    });
  }
});

test('getConsoleLogs rejects non-finite timestamp, line, and column', async () => {
  for (const entry of [
    validConsoleEntry({ timestamp: Number.NaN }),
    validConsoleEntry({ line: Number.POSITIVE_INFINITY }),
    validConsoleEntry({ column: Number.NEGATIVE_INFINITY })
  ]) {
    await withScriptingResult([{
      frameId: 0,
      result: { installed: true, logs: [entry] }
    }], async () => {
      await assert.rejects(new LightweightController().getConsoleLogs(7), /malformed|invalid/i);
    });
  }
});

test('executeScript catches injected eval failures before Edge erases them to null', async () => {
  await withEdgeScripting(async () => {
    await assert.rejects(
      new LightweightController().executeScript(7, 'throw new Error("injected failure")'),
      /injected failure/
    );
  });
});

test('executeScript safely reports hostile thrown values before Edge erases them', async () => {
  await withEdgeScripting(async () => {
    await assert.rejects(
      new LightweightController().executeScript(7, `
        throw Object.defineProperties({}, {
          message: { get: function() { throw new Error('message trap'); } },
          toString: { get: function() { throw new Error('toString trap'); } }
        })
      `),
      /script evaluation failed/i
    );
    await assert.rejects(
      new LightweightController().executeScript(7, `
        throw Object.defineProperty({}, 'toString', {
          get: function() { throw new Error('toString trap'); }
        })
      `),
      /script evaluation failed/i
    );
  });
});

test('executeScript uses pristine formatting after evaluated code mutates globals', async () => {
  const originalString = global.String;
  try {
    await withEdgeScripting(async () => {
      await assert.rejects(
        new LightweightController().executeScript(7, `
          String = function() { throw new Error('mutated String'); };
          throw null
        `),
        /script evaluation failed/i
      );
    });
  } finally {
    global.String = originalString;
  }
});

test('executeScript rejects Chrome InjectionResult errors instead of returning false success', async () => {
  await withScriptingResult([{ frameId: 0, error: 'EvalError: Refused to evaluate a string as JavaScript because CSP forbids unsafe-eval' }], async () => {
    await assert.rejects(new LightweightController().executeScript(7, '1+1'), /CSP forbids unsafe-eval/);
  });
});

test('executeScript rejects a missing InjectionResult entry', async () => {
  await withScriptingResult([], async () => {
    await assert.rejects(new LightweightController().executeScript(7, '1+1'), /no result/i);
  });
});

test('executeScript preserves scalar, null, and undefined values', async () => {
  await withEdgeScripting(async () => {
    assert.equal(await new LightweightController().executeScript(7, '1+1'), 2);
    assert.equal(await new LightweightController().executeScript(7, 'null'), null);
    assert.equal(await new LightweightController().executeScript(7, 'undefined'), undefined);
  });
});

test('executeScript rejects a malformed injected result envelope', async () => {
  await withScriptingResult([{ frameId: 0, result: { value: 2 } }], async () => {
    await assert.rejects(new LightweightController().executeScript(7, '1+1'), /malformed/i);
  });
});

test('executeScript requires an exact plain own-property envelope', async () => {
  const inheritedOk = Object.create({ ok: true });
  inheritedOk.value = 2;
  const arrayEnvelope = [];
  arrayEnvelope.ok = true;
  arrayEnvelope.value = 2;
  class CustomEnvelope { constructor() { this.ok = true; this.value = 2; } }
  const accessorOk = Object.defineProperty({}, 'ok', { get: () => true });
  const accessorValue = { ok: true };
  Object.defineProperty(accessorValue, 'value', { get: () => 2 });
  const accessorError = { ok: false };
  Object.defineProperty(accessorError, 'error', { get: () => 'failure' });
  const malformed = [
    arrayEnvelope,
    new CustomEnvelope(),
    inheritedOk,
    accessorOk,
    accessorValue,
    accessorError,
    { ok: 'true', value: 2 },
    { ok: true, value: 2, extra: true },
    { ok: true, value: 2, error: 'conflict' },
    { ok: false, error: 'failure', value: 2 },
    { ok: false, error: 7 }
  ];

  for (const result of malformed) {
    await withScriptingResult([{ frameId: 0, result }], async () => {
      await assert.rejects(new LightweightController().executeScript(7, '1+1'), /malformed/i);
    });
  }
});

test('executeScript accepts serialized undefined and null-prototype envelopes', async () => {
  await withScriptingResult([{ frameId: 0, result: { ok: true } }], async () => {
    assert.equal(await new LightweightController().executeScript(7, 'undefined'), undefined);
  });
  const envelope = Object.assign(Object.create(null), { ok: true, value: null });
  await withScriptingResult([{ frameId: 0, result: envelope }], async () => {
    assert.equal(await new LightweightController().executeScript(7, 'null'), null);
  });
});

test('executeScript rejects accessor descriptors despite Object prototype value pollution', async () => {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
  try {
    Object.defineProperty(Object.prototype, 'value', {
      configurable: true,
      writable: true,
      value: true
    });
    const okAccessorDescriptor = Object.assign(Object.create(null), { enumerable: true, get: () => true });
    const valueAccessorDescriptor = Object.assign(Object.create(null), { enumerable: true, get: () => 2 });
    const accessorOk = Object.defineProperty({}, 'ok', okAccessorDescriptor);
    const accessorValue = { ok: true };
    Object.defineProperty(accessorValue, 'value', valueAccessorDescriptor);

    for (const result of [accessorOk, accessorValue]) {
      await withScriptingResult([{ frameId: 0, result }], async () => {
        await assert.rejects(new LightweightController().executeScript(7, '1+1'), /malformed/i);
      });
    }

    Object.prototype.value = 'failure';
    const accessorError = { ok: false };
    const errorAccessorDescriptor = Object.assign(Object.create(null), {
      enumerable: true,
      get: () => 'failure'
    });
    Object.defineProperty(accessorError, 'error', errorAccessorDescriptor);
    await withScriptingResult([{ frameId: 0, result: accessorError }], async () => {
      await assert.rejects(new LightweightController().executeScript(7, '1+1'), /malformed/i);
    });
  } finally {
    if (original) Object.defineProperty(Object.prototype, 'value', original);
    else delete Object.prototype.value;
  }
});
