# Console History, Screenshot Delivery, and Fail-Fast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close console-history gap D, screenshot token/size gap F, and frozen-page fail-fast verification gap C, then merge the verified branch into `master`.

**Architecture:** A main-world `document_start` hook stores a bounded console ring buffer in each page and `get_console_logs` reads it without holding the debugger. Screenshots become configurable JPEG/PNG captures, optionally resize in the extension worker, and are translated by the MCP client into standard image content rather than base64 text. Existing layered timeouts remain, with combined-path automated tests and a real Edge busy-loop validation script.

**Tech Stack:** TypeScript 6, Chrome/Edge MV3 APIs, `chrome.scripting`, CDP, OffscreenCanvas, esbuild, Node test runner, Jest, MCP SDK 1.29.

## Global Constraints

- Work only in `E:\worktrees\arc-tunnel-multi-agent-broker` on `codex/arc-tunnel-multi-agent-broker` until the final merge.
- Preserve Broker protocol version 2, current tool names, tab ownership, the 5-second generic CDP timeout, the 15-second `Input.*` timeout, and the 30-second Broker deadline.
- Main-world console capture retains at most 500 bounded entries and transmits them only after an explicit `get_console_logs` call.
- Screenshot defaults are JPEG quality 80; PNG and original dimensions remain available through optional parameters.
- Never include screenshot base64 in MCP text content.
- Rebuild and commit `extension/dist/` and all committed MCP bundles affected by source changes.
- Do not stage or delete the existing untracked manual scripts under `mcp-server/` and `scripts/smoke-test.js`.
- Each task requires independent specification and code-quality review before the next task.

---

## File Structure

- Create `extension/src/content/console-hook.ts`: install and own the main-world console ring buffer.
- Create `extension/tests/console-hook.test.js`: verify wrapping, serialization, idempotence, and 500-entry eviction.
- Modify `extension/public/manifest.json`: add the main-world `document_start` content script and Chromium minimum version.
- Modify `extension/esbuild.config.js`: build `console-hook.ts` to `dist/content/console-hook.js`.
- Modify `extension/src/background/lightweight-controller.ts`: read the page buffer in `MAIN` world.
- Modify `extension/src/background/console-capture.ts`: register CDP listener before `Runtime.enable` and expose fallback metadata.
- Modify `extension/src/background/command-handler.ts`: select page-buffer first, CDP fallback second, and return capture metadata.
- Create `extension/src/background/image-processor.ts`: validate options, calculate dimensions, decode, resize, and re-encode screenshots.
- Create `extension/tests/image-processor.test.js`: verify validation and aspect-ratio calculations.
- Modify `extension/src/background/debugger-controller.ts`: capture requested format/quality and invoke the image processor.
- Modify `mcp-server/src/server.ts`: translate screenshot results to MCP image content.
- Modify `mcp-server/src/tools/index.ts`: document console semantics and screenshot inputs.
- Modify `extension/tests/command-handler.test.js`, `extension/tests/debugger-controller.test.js`, `mcp-server/tests/server.test.ts`, and `mcp-server/tests/tools.test.ts`: focused regressions.
- Create `scripts/verify-browser-resilience.js`: repeatable real-browser D/F/C validation and cleanup.
- Modify `README.md`, `AGENTS.md`, and `.superpowers/sdd/progress.md`: document behavior, validation, and completion.

---

### Task 1: Main-World Console History

**Files:**
- Create: `extension/src/content/console-hook.ts`
- Create: `extension/tests/console-hook.test.js`
- Modify: `extension/public/manifest.json`
- Modify: `extension/esbuild.config.js`
- Modify: `extension/src/background/lightweight-controller.ts`
- Modify: `extension/src/background/console-capture.ts`
- Modify: `extension/src/background/command-handler.ts`
- Modify: `extension/tests/command-handler.test.js`
- Modify: `mcp-server/src/tools/index.ts`
- Modify: `mcp-server/tests/tools.test.ts`
- Rebuild: `extension/dist/content/console-hook.js`, `extension/dist/background/service-worker.js`, `extension/dist/manifest.json`

**Interfaces:**
- Produces: `installConsoleHook(target: Window & typeof globalThis): void`.
- Produces: `LightweightController.getConsoleLogs(tabId: number): Promise<{ installed: boolean; logs: ConsoleLogEntry[] }>`.
- Produces response: `{ logs: ConsoleLogEntry[], capture: { source: 'page-buffer' | 'cdp'; historyAvailable: boolean; limit: 500 } }`.

- [ ] **Step 1: Write failing console-hook tests**

Add tests that call the wished-for export, then assert original console calls are preserved, values are serialized, reinstall is idempotent, and entry 501 evicts entry 1:

```js
const { installConsoleHook, readConsoleBuffer } = loadModule('src/content/console-hook.ts');
const calls = [];
const target = { console: { log: (...args) => calls.push(args), warn() {}, error() {}, info() {}, debug() {} } };
installConsoleHook(target);
target.console.log('before-call', { value: 7 });
assert.deepEqual(calls, [['before-call', { value: 7 }]]);
assert.match(readConsoleBuffer(target).logs[0].text, /before-call.*value.*7/);
installConsoleHook(target);
assert.equal(readConsoleBuffer(target).installed, true);
for (let index = 0; index < 500; index++) target.console.log(`entry-${index}`);
assert.equal(readConsoleBuffer(target).logs.length, 500);
assert.match(readConsoleBuffer(target).logs[0].text, /entry-0/);
```

- [ ] **Step 2: Run RED test**

Run: `node --test tests/console-hook.test.js` from `extension/`.

Expected: FAIL because `console-hook.ts` or its exports do not exist.

- [ ] **Step 3: Implement the bounded main-world hook**

Implement the module around a private symbol and bounded serializer:

```ts
export const CONSOLE_BUFFER_LIMIT = 500;
const BUFFER_KEY = Symbol.for('arc-tunnel.console-buffer.v1');

export interface BufferedConsoleEntry {
  level: 'debug' | 'info' | 'warning' | 'error';
  text: string;
  source: string;
  timestamp: number;
}

export function readConsoleBuffer(target: any) {
  const state = target[BUFFER_KEY];
  return { installed: Boolean(state), logs: state ? state.logs.slice() : [] };
}

export function installConsoleHook(target: any): void {
  if (target[BUFFER_KEY]) return;
  const state = { logs: [] as BufferedConsoleEntry[] };
  Object.defineProperty(target, BUFFER_KEY, { value: state, configurable: false });
  for (const [method, level] of [['debug', 'debug'], ['log', 'info'], ['info', 'info'], ['warn', 'warning'], ['error', 'error']] as const) {
    const original = target.console[method];
    target.console[method] = function (...args: unknown[]) {
      state.logs.push({ level, text: renderArguments(args), source: 'page', timestamp: Date.now() });
      if (state.logs.length > CONSOLE_BUFFER_LIMIT) state.logs.splice(0, state.logs.length - CONSOLE_BUFFER_LIMIT);
      return Reflect.apply(original, this, args);
    };
  }
}

if (typeof window !== 'undefined') installConsoleHook(window);
```

`renderArguments` must handle strings, primitives, `Error`, arrays, and plain objects; catch proxies/getters; cap each rendered argument at 4,096 characters and the combined entry at 16,384 characters.

- [ ] **Step 4: Configure early main-world injection**

Add `minimum_chrome_version: "111"` and this first content-script entry:

```json
{
  "matches": ["<all_urls>"],
  "js": ["content/console-hook.js"],
  "run_at": "document_start",
  "world": "MAIN"
}
```

Add an esbuild entry mapping `src/content/console-hook.ts` to `dist/content/console-hook.js`. Keep the existing isolated content script as a separate entry.

- [ ] **Step 5: Write failing retrieval and fallback tests**

In `command-handler.test.js`, assert a page buffer is returned without debugger attach and missing buffer falls back to CDP with metadata:

```js
assert.deepEqual(pageResult.result, {
  logs: [{ level: 'error', text: 'historic', source: 'page', timestamp: 1 }],
  capture: { source: 'page-buffer', historyAvailable: true, limit: 500 }
});
assert.deepEqual(fallbackResult.result.capture, {
  source: 'cdp', historyAvailable: false, limit: 500
});
```

In a focused `console-capture` test, make `Runtime.enable` synchronously emit `Runtime.consoleAPICalled`; expect the entry to be present, proving the listener was installed first.

- [ ] **Step 6: Implement retrieval and CDP ordering**

Add `getConsoleLogs` to `LightweightController` using `chrome.scripting.executeScript` with `world: 'MAIN'`. Validate the returned envelope as an own-property plain object before trusting it.

Change `ConsoleCapture.enableForTab` order to:

```ts
if (!this.listeners.has(tabId)) {
  chrome.debugger.onEvent.addListener(handler);
  this.listeners.set(tabId, handler);
}
await debuggerController.sendCommand(tabId, 'Runtime.enable');
```

Update `CommandHandler` to try the page buffer first; on missing hook or injection error, use the existing debugger lifecycle. Normalize `warn` to `warning` before `minLevel` filtering.

- [ ] **Step 7: Update schema, build, and verify Task 1**

Update the `get_console_logs` description to state: history starts at `document_start`, existing tabs need one refresh after extension reload, and restricted pages fall back to CDP-from-now capture.

Run:

```powershell
npm test --prefix extension
npm run typecheck
npm run build
npm test --prefix mcp-server -- --runInBand tests/tools.test.ts
git diff --check
```

Expected: all commands exit 0 and `extension/dist/content/console-hook.js` exists.

- [ ] **Step 8: Independent spec and code-quality review**

Review against D in the design spec. Fix all Critical and Important findings, rerun Step 7, then commit:

```powershell
git add extension/src/content/console-hook.ts extension/src/background/lightweight-controller.ts extension/src/background/console-capture.ts extension/src/background/command-handler.ts extension/public/manifest.json extension/esbuild.config.js extension/tests/console-hook.test.js extension/tests/command-handler.test.js mcp-server/src/tools/index.ts mcp-server/tests/tools.test.ts extension/dist
git commit -m "feat: capture page console history"
```

---

### Task 2: Token-Safe Screenshot Image Delivery

**Files:**
- Create: `extension/src/background/image-processor.ts`
- Create: `extension/tests/image-processor.test.js`
- Modify: `extension/src/background/debugger-controller.ts`
- Modify: `extension/src/background/command-handler.ts`
- Modify: `extension/tests/debugger-controller.test.js`
- Modify: `mcp-server/src/server.ts`
- Modify: `mcp-server/tests/server.test.ts`
- Modify: `mcp-server/src/tools/index.ts`
- Modify: `mcp-server/tests/tools.test.ts`
- Rebuild: `extension/dist/background/service-worker.js`, `mcp-server/dist/mcp-server.js`

**Interfaces:**
- Produces: `ScreenshotOptions { format: 'jpeg' | 'png'; quality: number; maxWidth?: number; maxHeight?: number }`.
- Produces: `ScreenshotResult { screenshot: string; mimeType: 'image/jpeg' | 'image/png'; format: 'jpeg' | 'png'; quality?: number; width?: number; height?: number; originalWidth?: number; originalHeight?: number; resized: boolean }`.
- Consumed by: `ArcTunnelMCPServer.handleToolCall`, which emits MCP `image` content and metadata text.

- [ ] **Step 1: Write failing option and dimension tests**

Create tests for exact validation and aspect-ratio calculations:

```js
assert.deepEqual(normalizeScreenshotOptions({}), { format: 'jpeg', quality: 80 });
assert.throws(() => normalizeScreenshotOptions({ quality: 0 }), /quality/i);
assert.throws(() => normalizeScreenshotOptions({ maxWidth: -1 }), /maxWidth/i);
assert.deepEqual(calculateOutputSize(2000, 1000, { maxWidth: 1000 }), { width: 1000, height: 500, resized: true });
assert.deepEqual(calculateOutputSize(800, 600, { maxWidth: 1000 }), { width: 800, height: 600, resized: false });
```

- [ ] **Step 2: Run RED image-processor test**

Run: `node --test tests/image-processor.test.js` from `extension/`.

Expected: FAIL because the module and functions do not exist.

- [ ] **Step 3: Implement image option validation and resizing**

Implement exact integer/range validation and the browser pipeline:

```ts
export async function processScreenshot(data: string, options: ScreenshotOptions): Promise<ScreenshotResult> {
  const mimeType = options.format === 'png' ? 'image/png' : 'image/jpeg';
  if (options.maxWidth === undefined && options.maxHeight === undefined) {
    return { screenshot: data, mimeType, format: options.format, quality: options.format === 'jpeg' ? options.quality : undefined, resized: false };
  }
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new Error('Screenshot resizing is not supported by this browser');
  }
  const source = await createImageBitmap(await (await fetch(`data:${mimeType};base64,${data}`)).blob());
  const originalWidth = source.width;
  const originalHeight = source.height;
  const size = calculateOutputSize(originalWidth, originalHeight, options);
  const canvas = new OffscreenCanvas(size.width, size.height);
  canvas.getContext('2d')!.drawImage(source, 0, 0, size.width, size.height);
  source.close();
  const blob = await canvas.convertToBlob({ type: mimeType, quality: options.quality / 100 });
  const encoded = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  return { screenshot: encoded, mimeType, format: options.format, quality: options.format === 'jpeg' ? options.quality : undefined, width: size.width, height: size.height, originalWidth, originalHeight, resized: size.resized };
}
```

Split `bytesToBase64` into safe chunks to avoid argument-count overflow.

- [ ] **Step 4: Write failing capture parameter tests**

Update the frozen-tab screenshot test to request default options and expect JPEG 80 on CDP. Add a visible-tab test expecting:

```js
assert.deepEqual(captureOptions, { format: 'jpeg', quality: 80 });
assert.deepEqual(cdpParams, { format: 'jpeg', quality: 80, captureBeyondViewport: false });
```

- [ ] **Step 5: Implement capture option propagation**

Change `DebuggerController.screenshot` to accept raw optional parameters, call `normalizeScreenshotOptions`, pass the resulting format/quality to both browser capture paths, and return `processScreenshot(...)`. Update `CommandHandler` to forward only `format`, `quality`, `maxWidth`, and `maxHeight` from command params.

- [ ] **Step 6: Write RED MCP image-content tests**

In `mcp-server/tests/server.test.ts`, return a fake screenshot result and assert:

```ts
expect(result).toEqual({ content: [
  { type: 'image', data: 'abc123', mimeType: 'image/jpeg' },
  { type: 'text', text: JSON.stringify({ format: 'jpeg', quality: 80, resized: false }) }
] });
expect(JSON.stringify(result.content[1])).not.toContain('abc123');
```

Add a malformed screenshot result test that expects `isError: true` and code `INTERNAL_ERROR`.

- [ ] **Step 7: Implement MCP image translation and schema**

In `ArcTunnelMCPServer.handleToolCall`, special-case only `request.params.name === 'screenshot'`, validate `screenshot` and `mimeType`, remove the base64 field from metadata, and return image plus JSON metadata content. Keep all other tools on the generic text path.

Add schema properties with exact bounds:

```ts
format: { type: 'string', enum: ['jpeg', 'png'], description: 'Output format; defaults to jpeg.' },
quality: { type: 'number', minimum: 1, maximum: 100, description: 'JPEG quality; defaults to 80 and is ignored for PNG.' },
maxWidth: { type: 'number', minimum: 1, description: 'Optional maximum output width; preserves aspect ratio.' },
maxHeight: { type: 'number', minimum: 1, description: 'Optional maximum output height; preserves aspect ratio.' }
```

- [ ] **Step 8: Verify and independently review Task 2**

Run focused tests, typecheck, build, and `git diff --check`. Obtain independent spec and code-quality approval, fix all Critical/Important issues, rerun, then commit:

```powershell
git add extension/src/background/image-processor.ts extension/src/background/debugger-controller.ts extension/src/background/command-handler.ts extension/tests/image-processor.test.js extension/tests/debugger-controller.test.js mcp-server/src/server.ts mcp-server/src/tools/index.ts mcp-server/tests/server.test.ts mcp-server/tests/tools.test.ts extension/dist/background/service-worker.js mcp-server/dist/mcp-server.js
git commit -m "feat: deliver token-safe screenshots"
```

---

### Task 3: Combined Fail-Fast Tests and Real-Browser Harness

**Files:**
- Modify: `extension/tests/command-handler.test.js`
- Modify: `mcp-server/src/tools/index.ts`
- Create: `scripts/verify-browser-resilience.js`
- Modify: `README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes existing 1.5-second lightweight timeout, 5-second generic CDP timeout, and MCP client tool calling.
- Produces CLI: `node scripts/verify-browser-resilience.js [--port 8765]`.

- [ ] **Step 1: Add failing combined-path tests**

Add parameterized tests for `execute_script` and `get_content`. Use a 5ms lightweight timeout and a debugger fallback that rejects a coded timeout after 5ms:

```js
for (const [command, params] of [
  ['execute_script', { tabId: 42, script: 'document.title' }],
  ['get_content', { tabId: 42, mode: 'text' }]
]) {
  const response = await Promise.race([
    handler.handleCommand({ id: command, type: 'command', command, params }),
    failAfter(50, `${command} exceeded the combined fail-fast bound`)
  ]);
  assert.equal(response.success, false);
  assert.equal(response.error.code, 'TIMEOUT');
}
```

The test must also assert debugger attach and scheduled detach occur exactly once per fallback.

- [ ] **Step 2: Run RED combined tests**

Run: `node --test tests/command-handler.test.js` from `extension/`.

Expected: FAIL if timeout codes are lost or either command waits beyond the bound.

- [ ] **Step 3: Make only evidence-driven timeout fixes**

If the RED test fails, preserve the existing timeout numbers and change only error propagation or cleanup needed for both commands to return coded `TIMEOUT`. If it already passes because the behavior exists, retain the regression test without changing production timeout code.

- [ ] **Step 4: Write the real-browser verifier**

Implement a script that:

1. starts an HTTP server on `127.0.0.1` port 0 serving a page that logs `ARC_CONSOLE_BEFORE_CALL` and exposes a button;
2. connects one MCP client to the configured shared Broker;
3. creates an owned tab for the local page and waits for load;
4. verifies `get_console_logs` includes the pre-call marker;
5. calls `screenshot` with `{ format: 'jpeg', quality: 70, maxWidth: 800 }` and asserts an MCP `image/jpeg` item exists and no text item contains its base64;
6. schedules `setTimeout(() => { while (true) {} }, 100)` through `execute_script` and waits 300ms;
7. measures `execute_script` and `get_content`, requiring coded `TIMEOUT` and elapsed time from 5,000 to 8,000ms;
8. verifies screenshot succeeds and `close_tab` returns `{ status: 'closed' }`;
9. closes the MCP client and HTTP server in `finally` without stopping the shared Broker.

Use the existing MCP SDK imports and stdio transport pattern from `scripts/verify-multi-agent.js`. Parse both text and image content instead of assuming text-only results.

- [ ] **Step 5: Document and test the verifier without a browser**

Export pure helpers `parseToolResult` and `assertFailFastTiming`. Add Jest tests in `mcp-server/tests/verify-browser-resilience.test.ts` for image parsing, coded errors, and the 5-8 second acceptance window. Add the exact command and cleanup behavior to README and AGENTS.

- [ ] **Step 6: Review and commit Task 3**

Run focused tests and get independent spec/code approval. Fix all Critical/Important findings, then commit:

```powershell
git add extension/tests/command-handler.test.js mcp-server/src/tools/index.ts scripts/verify-browser-resilience.js mcp-server/tests/verify-browser-resilience.test.ts README.md AGENTS.md
git commit -m "test: verify frozen-page fail-fast behavior"
```

---

### Task 4: Full Verification, Progress, and Master Merge

**Files:**
- Modify: `.superpowers/sdd/progress.md`
- Rebuild: all committed `mcp-server/dist/` and `extension/dist/` outputs

- [ ] **Step 1: Update progress and rebuild deterministically**

Record D, F, and C completion, focused test evidence, real-browser evidence fields, review outcomes, commits, and remaining limitations. Run `npm run build` and confirm only expected bundles change.

- [ ] **Step 2: Run the repository verification gate**

Run from the repository root:

```powershell
npm run verify
git diff --check
git status --short --branch
```

Expected: MCP 180+ tests pass, extension 40+ tests pass, integration test passes, typecheck/build/docs pass, and only expected tracked files plus preserved manual scripts appear.

- [ ] **Step 3: Reload and verify the real Edge extension**

Reload `extension/dist/` once in `edge://extensions`, confirm the popup is Connected to `ws://127.0.0.1:8765`, then run:

```powershell
node scripts/verify-browser-resilience.js --port 8765
node scripts/start.js diagnose --json
```

Expected: console history, image content, both fail-fast timings, frozen screenshot, and frozen close all print PASS; Broker diagnostics end healthy with no claims or pending commands.

- [ ] **Step 4: Final independent review and branch commit**

Request final specification and code-quality reviews over the full range from `8286cf4` to HEAD. Fix all Critical and Important findings, rerun Steps 1-3, then commit progress/bundle changes and push the feature branch.

- [ ] **Step 5: Confirm branch CI on Ubuntu and Windows**

Wait for the `Verify` workflow on `codex/arc-tunnel-multi-agent-broker`. Both jobs and the committed-dist diff check must pass.

- [ ] **Step 6: Fast-forward `master` safely**

Run:

```powershell
git fetch origin master
git merge-base --is-ancestor origin/master HEAD
git push origin HEAD:master
```

If the ancestor check fails or branch protection blocks direct push, create a non-draft PR from `codex/arc-tunnel-multi-agent-broker` to `master`, wait for required checks, and merge it without force-pushing.

- [ ] **Step 7: Verify remote master**

Confirm `origin/master` resolves to the reviewed merge/fast-forward commit and wait for the master `Verify` workflow to pass on Ubuntu and Windows. Report the final commit, CI URL, real-browser timings, and any unavoidable browser limitations.
