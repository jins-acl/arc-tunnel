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

test('executeScript catches injected eval failures before Edge erases them to null', async () => {
  await withEdgeScripting(async () => {
    await assert.rejects(
      new LightweightController().executeScript(7, 'throw new Error("injected failure")'),
      /injected failure/
    );
  });
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
