const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const TEST_AUTH_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_AUTH_TOKEN = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA';
const NONCANONICAL_AUTH_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB';
const popupHtml = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'popup', 'popup.html'),
  'utf8'
);

function eventTarget(initial = {}) {
  const listeners = new Map();
  return {
    ...initial,
    addEventListener(type, listener) {
      const typeListeners = listeners.get(type) ?? [];
      typeListeners.push(listener);
      listeners.set(type, typeListeners);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    }
  };
}

function inputAttributes(id) {
  const tag = popupHtml.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`, 'i'))?.[0];
  if (!tag) return {};
  const attributes = {};
  for (const match of tag.matchAll(/([a-z-]+)(?:="([^"]*)")?/gi)) {
    attributes[match[1].toLowerCase()] = match[2] ?? '';
  }
  return attributes;
}

function bundlePopup() {
  return esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'popup', 'popup.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false
  }).outputFiles[0].text;
}

function setupPopup({
  storedConfig = {
    arc_tunnel_ws_url: 'ws://127.0.0.1:8765',
    authToken: TEST_AUTH_TOKEN
  },
  statusResponse = { connected: false, state: 'idle' }
} = {}) {
  const originals = {
    chrome: global.chrome,
    document: global.document,
    window: global.window,
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    setTimeout: global.setTimeout,
    log: console.log,
    error: console.error,
    warn: console.warn
  };
  const urlAttributes = inputAttributes('ws-url');
  const tokenAttributes = inputAttributes('auth-token');
  const elements = {
    status: eventTarget({ id: 'status', textContent: '', className: '' }),
    'ws-url': eventTarget({
      id: 'ws-url',
      type: urlAttributes.type ?? 'text',
      autocomplete: urlAttributes.autocomplete ?? '',
      spellcheck: urlAttributes.spellcheck !== 'false',
      value: urlAttributes.value ?? ''
    }),
    'auth-token': eventTarget({
      id: 'auth-token',
      type: tokenAttributes.type ?? 'text',
      autocomplete: tokenAttributes.autocomplete ?? '',
      spellcheck: tokenAttributes.spellcheck !== 'false',
      value: tokenAttributes.value ?? ''
    }),
    'save-config': eventTarget({ id: 'save-config' })
  };
  const documentTarget = eventTarget({
    getElementById(id) { return elements[id] ?? null; }
  });
  const windowTarget = eventTarget();
  const storageGets = [];
  const storageSets = [];
  const runtimeMessages = [];
  const logs = [];
  const timeouts = [];

  global.document = documentTarget;
  global.window = windowTarget;
  global.chrome = {
    storage: {
      local: {
        get(keys, callback) {
          storageGets.push(keys);
          callback({ ...storedConfig });
        },
        set(value, callback) {
          storageSets.push(value);
          callback?.();
        }
      }
    },
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        runtimeMessages.push(message);
        callback(statusResponse);
      }
    }
  };
  global.setInterval = () => 1;
  global.clearInterval = () => {};
  global.setTimeout = (callback, delay) => {
    timeouts.push({ callback, delay });
    return timeouts.length;
  };
  console.log = (...args) => logs.push(['log', ...args]);
  console.error = (...args) => logs.push(['error', ...args]);
  console.warn = (...args) => logs.push(['warn', ...args]);

  new Function(bundlePopup())();
  documentTarget.dispatch('DOMContentLoaded');

  return {
    elements,
    logs,
    runtimeMessages,
    storageGets,
    storageSets,
    timeouts,
    restore() {
      global.chrome = originals.chrome;
      global.document = originals.document;
      global.window = originals.window;
      global.setInterval = originals.setInterval;
      global.clearInterval = originals.clearInterval;
      global.setTimeout = originals.setTimeout;
      console.log = originals.log;
      console.error = originals.error;
      console.warn = originals.warn;
    }
  };
}

function popupTest(name, options, run) {
  if (typeof options === 'function') {
    run = options;
    options = {};
  }
  test(name, { concurrency: false }, () => {
    const environment = setupPopup(options);
    try {
      run(environment);
    } finally {
      environment.restore();
    }
  });
}

popupTest('loads the stored URL and authentication token together', (environment) => {
  assert.deepEqual(environment.storageGets, [
    ['arc_tunnel_ws_url', 'authToken']
  ]);
  assert.equal(environment.elements['ws-url'].value, 'ws://127.0.0.1:8765');
  assert.equal(environment.elements['auth-token'].value, TEST_AUTH_TOKEN);
});

popupTest('authentication token input is masked and disables browser assistance', (environment) => {
  const tokenInput = environment.elements['auth-token'];
  assert.equal(tokenInput.type, 'password');
  assert.equal(tokenInput.autocomplete, 'off');
  assert.equal(tokenInput.spellcheck, false);
  assert.match(popupHtml, /<label\s+for="auth-token">Authentication Token<\/label>/i);
});

for (const invalidToken of ['short', NONCANONICAL_AUTH_TOKEN]) {
  popupTest(`rejects invalid token ${JSON.stringify(invalidToken)} without writing storage`, (environment) => {
    environment.elements['auth-token'].value = invalidToken;
    environment.elements['save-config'].dispatch('click');

    assert.equal(environment.storageSets.length, 0);
    assert.match(environment.elements.status.textContent, /token/i);
    assert.equal(environment.elements.status.textContent.includes(invalidToken), false);
  });
}

popupTest('rejects a canonical token with surrounding whitespace without echoing it', (environment) => {
  const whitespaceToken = ` ${TEST_AUTH_TOKEN} `;
  environment.elements['auth-token'].value = whitespaceToken;
  environment.elements['save-config'].dispatch('click');

  assert.equal(environment.storageSets.length, 0);
  assert.match(environment.elements.status.textContent, /token/i);
  assert.equal(environment.elements.status.textContent.includes(whitespaceToken), false);
  assert.equal(environment.elements.status.textContent.includes(TEST_AUTH_TOKEN), false);
});

popupTest('saves a valid URL and token in one atomic storage write', (environment) => {
  environment.elements['ws-url'].value = ' ws://127.0.0.1:9000 ';
  environment.elements['auth-token'].value = OTHER_AUTH_TOKEN;
  environment.elements['save-config'].dispatch('click');

  assert.deepEqual(environment.storageSets, [{
    arc_tunnel_ws_url: 'ws://127.0.0.1:9000',
    authToken: OTHER_AUTH_TOKEN
  }]);
});

popupTest('authentication failure status and captured console never expose the token', {
  statusResponse: {
    connected: false,
    state: 'auth_failed',
    authToken: TEST_AUTH_TOKEN,
    token: TEST_AUTH_TOKEN
  }
}, (environment) => {
  assert.equal(environment.elements.status.textContent, 'Status: Authentication failed');
  const captured = JSON.stringify({
    statusText: Object.values(environment.elements).map(element => element.textContent),
    logs: environment.logs
  });
  assert.equal(captured.includes(TEST_AUTH_TOKEN), false);
});

popupTest('Enter from either input follows the same atomic save path', (environment) => {
  environment.elements['ws-url'].value = 'ws://127.0.0.1:9000';
  environment.elements['auth-token'].value = OTHER_AUTH_TOKEN;

  environment.elements['ws-url'].dispatch('keypress', { key: 'Enter' });
  environment.elements['auth-token'].dispatch('keypress', { key: 'Enter' });

  assert.deepEqual(environment.storageSets, [
    {
      arc_tunnel_ws_url: 'ws://127.0.0.1:9000',
      authToken: OTHER_AUTH_TOKEN
    },
    {
      arc_tunnel_ws_url: 'ws://127.0.0.1:9000',
      authToken: OTHER_AUTH_TOKEN
    }
  ]);
});
