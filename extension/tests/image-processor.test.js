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

const { calculateOutputSize, normalizeScreenshotOptions, processScreenshot } =
  loadModule('src/background/image-processor.ts');

async function withGlobals(overrides, run) {
  const originals = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    originals.set(key, global[key]);
    global[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of originals) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  }
}

test('normalizes screenshot options to JPEG quality 80 defaults', () => {
  assert.deepEqual(normalizeScreenshotOptions({}), { format: 'jpeg', quality: 80 });
});

test('accepts supported screenshot options without changing their values', () => {
  assert.deepEqual(
    normalizeScreenshotOptions({ format: 'png', quality: 100, maxWidth: 1200, maxHeight: 800 }),
    { format: 'png', quality: 100, maxWidth: 1200, maxHeight: 800 }
  );
});

test('rejects unsupported formats and non-integer or out-of-range quality', () => {
  assert.throws(() => normalizeScreenshotOptions({ format: 'webp' }), /format/i);
  for (const quality of [0, 101, 80.5, NaN, '80']) {
    assert.throws(() => normalizeScreenshotOptions({ quality }), /quality/i);
  }
});

test('rejects non-integer or non-positive maximum dimensions', () => {
  for (const maxWidth of [-1, 0, 100.5, NaN, '100']) {
    assert.throws(() => normalizeScreenshotOptions({ maxWidth }), /maxWidth/i);
  }
  for (const maxHeight of [-1, 0, 100.5, NaN, '100']) {
    assert.throws(() => normalizeScreenshotOptions({ maxHeight }), /maxHeight/i);
  }
});

test('calculates an aspect-ratio-preserving width-constrained size', () => {
  assert.deepEqual(
    calculateOutputSize(2000, 1000, { maxWidth: 1000 }),
    { width: 1000, height: 500, resized: true }
  );
});

test('does not upscale an image below its maximum dimensions', () => {
  assert.deepEqual(
    calculateOutputSize(800, 600, { maxWidth: 1000 }),
    { width: 800, height: 600, resized: false }
  );
});

test('uses the tighter of width and height constraints', () => {
  assert.deepEqual(
    calculateOutputSize(2000, 1000, { maxWidth: 1500, maxHeight: 500 }),
    { width: 1000, height: 500, resized: true }
  );
});

test('returns screenshot metadata without browser image APIs when resizing is not requested', async () => {
  assert.deepEqual(
    await processScreenshot('abc123', { format: 'jpeg', quality: 80 }),
    {
      screenshot: 'abc123',
      mimeType: 'image/jpeg',
      format: 'jpeg',
      quality: 80,
      resized: false
    }
  );
});

test('resizes, encodes large outputs in safe chunks, and returns complete metadata', async () => {
  const outputBytes = new Uint8Array(70000).fill(65);
  const drawCalls = [];
  const convertCalls = [];
  let closed = 0;

  await withGlobals({
    createImageBitmap: async () => ({
      width: 2000,
      height: 1000,
      close: () => { closed += 1; }
    }),
    OffscreenCanvas: class {
      constructor(width, height) {
        assert.deepEqual({ width, height }, { width: 1000, height: 500 });
      }
      getContext(type) {
        assert.equal(type, '2d');
        return { drawImage: (...args) => drawCalls.push(args.slice(1)) };
      }
      async convertToBlob(options) {
        convertCalls.push(options);
        return { arrayBuffer: async () => outputBytes.buffer };
      }
    }
  }, async () => {
    const result = await processScreenshot('abc123', {
      format: 'jpeg',
      quality: 75,
      maxWidth: 1000
    });

    assert.equal(result.screenshot, Buffer.from(outputBytes).toString('base64'));
    assert.deepEqual({ ...result, screenshot: '<encoded>' }, {
      screenshot: '<encoded>',
      mimeType: 'image/jpeg',
      format: 'jpeg',
      quality: 75,
      width: 1000,
      height: 500,
      originalWidth: 2000,
      originalHeight: 1000,
      resized: true
    });
  });

  assert.deepEqual(drawCalls, [[0, 0, 1000, 500]]);
  assert.deepEqual(convertCalls, [{ type: 'image/jpeg', quality: 0.75 }]);
  assert.equal(closed, 1);
});

test('closes the bitmap and reports a clear error when no 2D canvas context is available', async () => {
  let closed = 0;
  await withGlobals({
    createImageBitmap: async () => ({
      width: 200,
      height: 100,
      close: () => { closed += 1; }
    }),
    OffscreenCanvas: class {
      getContext() { return null; }
    }
  }, async () => {
    await assert.rejects(
      processScreenshot('abc123', { format: 'jpeg', quality: 80, maxWidth: 100 }),
      /2D canvas context/i
    );
  });

  assert.equal(closed, 1);
});

test('wraps screenshot fetch failures with decode context and preserves the cause', async () => {
  const cause = new Error('fetch exploded');
  await withGlobals({
    fetch: async () => { throw cause; },
    createImageBitmap: async () => assert.fail('bitmap decode must not run after fetch failure'),
    OffscreenCanvas: class {}
  }, async () => {
    await assert.rejects(
      processScreenshot('abc123', { format: 'jpeg', quality: 80, maxWidth: 100 }),
      error => /decode failed/i.test(error.message) && error.cause === cause
    );
  });
});

test('wraps bitmap decode failures with context and preserves the cause', async () => {
  const cause = new Error('bitmap exploded');
  await withGlobals({
    createImageBitmap: async () => { throw cause; },
    OffscreenCanvas: class {}
  }, async () => {
    await assert.rejects(
      processScreenshot('abc123', { format: 'jpeg', quality: 80, maxWidth: 100 }),
      error => /decode failed/i.test(error.message) && error.cause === cause
    );
  });
});

test('wraps draw failures and closes the bitmap', async () => {
  const cause = new Error('draw exploded');
  let closed = 0;
  await withGlobals({
    createImageBitmap: async () => ({ width: 200, height: 100, close: () => { closed += 1; } }),
    OffscreenCanvas: class {
      getContext() { return { drawImage: () => { throw cause; } }; }
    }
  }, async () => {
    await assert.rejects(
      processScreenshot('abc123', { format: 'jpeg', quality: 80, maxWidth: 100 }),
      error => /draw failed/i.test(error.message) && error.cause === cause
    );
  });
  assert.equal(closed, 1);
});

test('closes the bitmap when reading its dimensions fails', async () => {
  const cause = new Error('width exploded');
  let closed = 0;
  await withGlobals({
    createImageBitmap: async () => ({
      get width() { throw cause; },
      height: 100,
      close: () => { closed += 1; }
    }),
    OffscreenCanvas: class {}
  }, async () => {
    await assert.rejects(
      processScreenshot('abc123', { format: 'jpeg', quality: 80, maxWidth: 100 }),
      error => /draw failed/i.test(error.message) && error.cause === cause
    );
  });
  assert.equal(closed, 1);
});

test('wraps conversion failures and closes the bitmap', async () => {
  const cause = new Error('conversion exploded');
  let closed = 0;
  await withGlobals({
    createImageBitmap: async () => ({ width: 200, height: 100, close: () => { closed += 1; } }),
    OffscreenCanvas: class {
      getContext() { return { drawImage() {} }; }
      async convertToBlob() { throw cause; }
    }
  }, async () => {
    await assert.rejects(
      processScreenshot('abc123', { format: 'jpeg', quality: 80, maxWidth: 100 }),
      error => /conversion failed/i.test(error.message) && error.cause === cause
    );
  });
  assert.equal(closed, 1);
});

test('wraps output read failures and closes the bitmap', async () => {
  const cause = new Error('read exploded');
  let closed = 0;
  await withGlobals({
    createImageBitmap: async () => ({ width: 200, height: 100, close: () => { closed += 1; } }),
    OffscreenCanvas: class {
      getContext() { return { drawImage() {} }; }
      async convertToBlob() { return { arrayBuffer: async () => { throw cause; } }; }
    }
  }, async () => {
    await assert.rejects(
      processScreenshot('abc123', { format: 'jpeg', quality: 80, maxWidth: 100 }),
      error => /output read failed/i.test(error.message) && error.cause === cause
    );
  });
  assert.equal(closed, 1);
});

test('wraps base64 encoding failures and closes the bitmap', async () => {
  const cause = new Error('encode exploded');
  let closed = 0;
  await withGlobals({
    btoa: () => { throw cause; },
    createImageBitmap: async () => ({ width: 200, height: 100, close: () => { closed += 1; } }),
    OffscreenCanvas: class {
      getContext() { return { drawImage() {} }; }
      async convertToBlob() { return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; }
    }
  }, async () => {
    await assert.rejects(
      processScreenshot('abc123', { format: 'jpeg', quality: 80, maxWidth: 100 }),
      error => /encoding failed/i.test(error.message) && error.cause === cause
    );
  });
  assert.equal(closed, 1);
});
