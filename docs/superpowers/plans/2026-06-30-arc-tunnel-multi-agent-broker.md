# Arc Tunnel Multi-Agent Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-Agent WebSocket listener with one local Broker so multiple MCP Agents can concurrently control isolated browser windows and tabs without port conflicts.

**Architecture:** Keep `mcp-server/dist/mcp-server.js` as the stdio MCP entry point, but make it a thin Broker client. A detached singleton Broker owns the extension WebSocket, session ownership, per-tab scheduling, and response routing; the extension remains the browser execution layer and adds window creation plus lifecycle events.

**Tech Stack:** Node.js 18+, TypeScript, MCP SDK, `ws`, Jest, Chrome Manifest V3 APIs, esbuild

## Global Constraints

- Broker binds only to `127.0.0.1` and rejects ordinary `http`/`https` WebSocket origins.
- Port precedence is CLI `--port`, `WS_PORT`, `~/.arc-tunnel/config.json`, then `8765`.
- Existing Agent configs must continue invoking `mcp-server/dist/mcp-server.js`.
- Existing tool names and inputs remain compatible; `claim_tab` and `release_tab` are additive.
- Each Agent gets one `sessionId`, one lazily created browser window, and exclusive ownership of its tabs.
- Commands on one tab are serialized; commands on different tabs may run concurrently.
- Agent disconnect grace period is exactly 30 seconds and never closes browser pages.
- Browser profile, cookies, and login state remain shared.
- Both `mcp-server/dist/` and `extension/dist/` remain committed.
- Source design: `docs/superpowers/specs/2026-06-30-arc-tunnel-multi-agent-broker-design.md`.

## File Map

| File | Responsibility |
|------|----------------|
| `mcp-server/src/config.ts` | Resolve and validate the Broker port and user config path. |
| `mcp-server/src/protocol.ts` | Shared Broker/Agent/extension protocol types and version. |
| `mcp-server/src/broker/session-registry.ts` | Session, window, tab, recording, and saved-session ownership. |
| `mcp-server/src/broker/tab-scheduler.ts` | Serialize same-tab work while allowing cross-tab concurrency. |
| `mcp-server/src/broker/broker-server.ts` | HTTP health endpoint, WebSocket upgrades, routing, authorization, and recovery. |
| `mcp-server/src/broker-entry.ts` | Standalone Broker process entry point and shutdown handling. |
| `mcp-server/src/broker-control.ts` | Broker start/status/stop command entry point. |
| `mcp-server/src/broker-client.ts` | Agent-side WebSocket request/response client. |
| `mcp-server/src/broker-launcher.ts` | Singleton probe, lock file, detached startup, status, and stop. |
| `mcp-server/src/server.ts` | Thin stdio MCP adapter forwarding tool calls to `BrokerClient`. |
| `mcp-server/src/index.ts` | Resolve config, ensure Broker, and start the stdio adapter. |
| `extension/src/background/websocket-client.ts` | Extension role handshake and resilient reconnect. |
| `extension/src/background/tab-manager.ts` | Window creation, window-aware tabs, and lifecycle callbacks. |
| `extension/src/background/command-handler.ts` | Internal `create_window`, window-aware `create_tab`, and richer `list_tabs`. |
| `extension/src/background/service-worker.ts` | Forward tab/window lifecycle events to the Broker. |
| `mcp-server/src/tools/index.ts` | Public claim/release tools and shared-profile warnings. |
| `scripts/start.js` | Broker `start`, `status`, and `stop` CLI. |
| `scripts/install.js`, `configs/*`, `README.md`, `AGENTS.md` | Shared-Broker installation and usage documentation. |

---

### Task 1: Configuration And Versioned Protocol

**Files:**
- Create: `mcp-server/src/config.ts`
- Create: `mcp-server/src/protocol.ts`
- Modify: `mcp-server/src/types.ts`
- Test: `mcp-server/tests/config.test.ts`
- Test: `mcp-server/tests/protocol.test.ts`

**Interfaces:**
- Produces: `resolveBrokerConfig(options): BrokerConfig`
- Produces: `loadBrokerConfig(argv, env, homeDir?): BrokerConfig`
- Produces: `PROTOCOL_VERSION`, `HelloMessage`, `WelcomeMessage`, `AgentRequest`, `AgentResponse`, `BrowserEvent`
- Produces: `ArcTunnelError` and `toErrorInfo(error): ErrorInfo`
- Produces: error codes `TAB_NOT_OWNED`, `EXTENSION_DISCONNECTED`, `COMMAND_TIMEOUT`, `PROTOCOL_MISMATCH`, `PORT_IN_USE`, `RECORDING_BUSY`

- [ ] **Step 1: Write failing configuration tests**

```ts
import { resolveBrokerConfig } from '../src/config';

describe('resolveBrokerConfig', () => {
  it('uses CLI, env, file, default precedence', () => {
    expect(resolveBrokerConfig({ argv: ['--port', '9100'], env: { WS_PORT: '9000' }, fileConfig: { port: 8900 } }).port).toBe(9100);
    expect(resolveBrokerConfig({ argv: [], env: { WS_PORT: '9000' }, fileConfig: { port: 8900 } }).port).toBe(9000);
    expect(resolveBrokerConfig({ argv: [], env: {}, fileConfig: { port: 8900 } }).port).toBe(8900);
    expect(resolveBrokerConfig({ argv: [], env: {}, fileConfig: null }).port).toBe(8765);
  });

  it.each(['0', '65536', 'abc', '8.5'])('rejects invalid port %s', (port) => {
    expect(() => resolveBrokerConfig({ argv: [], env: { WS_PORT: port }, fileConfig: null }))
      .toThrow(`Invalid Arc Tunnel port: ${port}`);
  });
});
```

- [ ] **Step 2: Run tests and verify the missing-module failure**

Run: `cd mcp-server && npm test -- --runInBand tests/config.test.ts`
Expected: FAIL because `../src/config` does not exist.

- [ ] **Step 3: Implement strict port resolution**

```ts
export interface BrokerConfig { host: '127.0.0.1'; port: number; }
export interface ResolveOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  fileConfig: { port?: unknown } | null;
}

function parsePort(value: unknown): number {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error(`Invalid Arc Tunnel port: ${text}`);
  const port = Number(text);
  if (port < 1 || port > 65535) throw new Error(`Invalid Arc Tunnel port: ${text}`);
  return port;
}

export function resolveBrokerConfig(options: ResolveOptions): BrokerConfig {
  const index = options.argv.indexOf('--port');
  const raw = index >= 0 ? options.argv[index + 1]
    : options.env.WS_PORT ?? options.fileConfig?.port ?? 8765;
  return { host: '127.0.0.1', port: parsePort(raw) };
}
```

Add `loadBrokerConfig(argv, env, homeDir = os.homedir())`, which reads
`<homeDir>/.arc-tunnel/config.json`; missing file means `null`, malformed JSON throws
`Invalid Arc Tunnel config: <path>`. Define the shared error shape:

```ts
export class ArcTunnelError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: unknown) { super(message); }
}
export function toErrorInfo(error: unknown): ErrorInfo {
  return error instanceof ArcTunnelError
    ? { code: error.code, message: error.message, details: error.details }
    : { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) };
}
```

- [ ] **Step 4: Add protocol round-trip tests**

```ts
import { PROTOCOL_VERSION, isHelloMessage } from '../src/protocol';

it('accepts the current extension and agent hello messages', () => {
  expect(isHelloMessage({ type: 'hello', role: 'agent', protocolVersion: PROTOCOL_VERSION })).toBe(true);
  expect(isHelloMessage({ type: 'hello', role: 'extension', protocolVersion: PROTOCOL_VERSION })).toBe(true);
  expect(isHelloMessage({ type: 'hello', role: 'agent', protocolVersion: 999 })).toBe(false);
});
```

Define exact envelopes:

```ts
export const PROTOCOL_VERSION = 2;
export type ConnectionRole = 'agent' | 'extension';
export interface HelloMessage { type: 'hello'; role: ConnectionRole; protocolVersion: number; clientName?: string; }
export interface WelcomeMessage { type: 'welcome'; protocolVersion: 2; sessionId?: string; }
export interface AgentRequest { type: 'agent_request'; requestId: string; command: string; params: Record<string, unknown>; timeout: number; }
export interface AgentResponse { type: 'agent_response'; requestId: string; success: boolean; result?: unknown; error?: ErrorInfo; }
export interface BrowserEvent { type: 'event'; event: 'heartbeat' | 'tab_created' | 'tab_removed' | 'window_removed'; data: Record<string, unknown>; timestamp: number; }
```

- [ ] **Step 5: Run focused and full server tests**

Run: `cd mcp-server && npm test -- --runInBand tests/config.test.ts tests/protocol.test.ts`
Expected: PASS.
Run: `cd mcp-server && npm test -- --runInBand`
Expected: existing suites and new suites PASS.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/config.ts mcp-server/src/protocol.ts mcp-server/src/types.ts mcp-server/tests/config.test.ts mcp-server/tests/protocol.test.ts
git commit -m "feat: define broker configuration and protocol"
```

### Task 2: Session Ownership And Per-Tab Scheduling

**Files:**
- Create: `mcp-server/src/broker/session-registry.ts`
- Create: `mcp-server/src/broker/tab-scheduler.ts`
- Test: `mcp-server/tests/session-registry.test.ts`
- Test: `mcp-server/tests/tab-scheduler.test.ts`

**Interfaces:**
- Consumes: `ErrorCode.TAB_NOT_OWNED`
- Produces: `SessionRegistry.createSession()`, `assignWindow()`, `claimTab()`, `releaseTab()`, `assertOwnsTab()`, `visibleTabs()`, `disconnect()`, `expireDisconnected()`
- Produces: `TabScheduler.run<T>(tabId, operation): Promise<T>`

- [ ] **Step 1: Write ownership tests**

```ts
const registry = new SessionRegistry();
const alpha = registry.createSession('alpha');
const beta = registry.createSession('beta');

registry.assignWindow(alpha.id, 10, [101]);
expect(registry.claimTab(beta.id, 101)).toEqual({ ok: false, code: 'TAB_NOT_OWNED' });
expect(() => registry.assertOwnsTab(beta.id, 101)).toThrow('TAB_NOT_OWNED');
expect(registry.visibleTabs(alpha.id, [{ tabId: 101 }, { tabId: 102 }])).toEqual([
  { tabId: 101, ownership: 'owned' },
  { tabId: 102, ownership: 'unclaimed' }
]);
expect(registry.visibleTabs(beta.id, [{ tabId: 101 }, { tabId: 102 }])).toEqual([
  { tabId: 102, ownership: 'unclaimed' }
]);
```

- [ ] **Step 2: Verify ownership tests fail**

Run: `cd mcp-server && npm test -- --runInBand tests/session-registry.test.ts`
Expected: FAIL because `SessionRegistry` is missing.

- [ ] **Step 3: Implement session records and explicit ownership**

```ts
interface AgentSession {
  id: string;
  connected: boolean;
  disconnectedAt: number | null;
  windowId: number | null;
  tabIds: Set<number>;
  recordingIds: Set<string>;
  savedSessionIds: Set<string>;
}

type ClaimResult = { ok: true } | { ok: false; code: ErrorCode.TAB_NOT_OWNED };

claimTab(sessionId: string, tabId: number): ClaimResult {
  const owner = this.tabOwners.get(tabId);
  if (owner && owner !== sessionId) return { ok: false, code: ErrorCode.TAB_NOT_OWNED };
  this.requireSession(sessionId).tabIds.add(tabId);
  this.tabOwners.set(tabId, sessionId);
  return { ok: true };
}

expireDisconnected(now: number): number[] {
  const expired: number[] = [];
  for (const session of this.sessions.values()) {
    if (session.connected || session.disconnectedAt == null || now - session.disconnectedAt < 30_000) continue;
    for (const tabId of session.tabIds) { this.tabOwners.delete(tabId); expired.push(tabId); }
    session.tabIds.clear();
    session.windowId = null;
  }
  return expired;
}
```

- [ ] **Step 4: Write scheduler concurrency tests**

```ts
it('serializes one tab but overlaps different tabs', async () => {
  const scheduler = new TabScheduler();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });

  const first = scheduler.run(1, async () => { order.push('a:start'); await gate; order.push('a:end'); });
  const second = scheduler.run(1, async () => { order.push('b'); });
  const other = scheduler.run(2, async () => { order.push('c'); });
  await other;
  expect(order).toEqual(['a:start', 'c']);
  release();
  await Promise.all([first, second]);
  expect(order).toEqual(['a:start', 'c', 'a:end', 'b']);
});
```

- [ ] **Step 5: Implement tail-promise scheduling and run tests**

```ts
export class TabScheduler {
  private tails = new Map<number, Promise<unknown>>();

  run<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(tabId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.tails.set(tabId, current);
    void current.then(
      () => { if (this.tails.get(tabId) === current) this.tails.delete(tabId); },
      () => { if (this.tails.get(tabId) === current) this.tails.delete(tabId); }
    );
    return current;
  }
}
```

Run: `cd mcp-server && npm test -- --runInBand tests/session-registry.test.ts tests/tab-scheduler.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/broker/session-registry.ts mcp-server/src/broker/tab-scheduler.ts mcp-server/tests/session-registry.test.ts mcp-server/tests/tab-scheduler.test.ts
git commit -m "feat: add agent session and tab ownership"
```

### Task 3: Broker Transport, Routing, And Recovery

**Files:**
- Create: `mcp-server/src/broker/broker-server.ts`
- Create: `mcp-server/src/broker-entry.ts`
- Modify: `mcp-server/src/command-queue.ts`
- Test: `mcp-server/tests/broker-server.test.ts`

**Interfaces:**
- Consumes: Task 1 protocol/config and Task 2 registry/scheduler
- Produces: `BrokerServer.start()`, `stop()`, `address()`, `isExtensionConnected()`
- Produces: `GET /health -> { name: 'arc-tunnel', protocolVersion: 2, pid: number, port: number }`

- [ ] **Step 1: Write failing connection and origin tests**

```ts
it('accepts agent and extension paths and rejects webpage origins', async () => {
  broker = await startTestBroker();
  await expect(connectWs(broker.port, '/agent')).resolves.toBeDefined();
  await expect(connectWs(broker.port, '/extension', 'chrome-extension://test')).resolves.toBeDefined();
  await expect(connectWs(broker.port, '/agent', 'https://malicious.example')).rejects.toThrow();
  await expect(fetch(`http://127.0.0.1:${broker.port}/health`).then(r => r.json()))
    .resolves.toMatchObject({ name: 'arc-tunnel', protocolVersion: 2, pid: process.pid, port: broker.port });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `cd mcp-server && npm test -- --runInBand tests/broker-server.test.ts`
Expected: FAIL because `BrokerServer` is missing.

- [ ] **Step 3: Implement HTTP upgrade routing and handshake**

```ts
this.httpServer.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  const origin = request.headers.origin;
  if (origin?.startsWith('http://') || origin?.startsWith('https://')) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  const target = pathname === '/agent' ? this.agentWss
    : pathname === '/extension' || pathname === '/' ? this.extensionWss : null;
  if (!target) { socket.destroy(); return; }
  target.handleUpgrade(request, socket, head, ws => target.emit('connection', ws, request));
});
```

Require a `hello` within 5 seconds on `/agent` and `/extension`, reject protocol
mismatch with `PROTOCOL_MISMATCH`, assign a UUID session only to Agent connections,
and send `WelcomeMessage`. For migration, `/` is accepted only when the request Origin
starts with `chrome-extension://`; treat it as a legacy extension connection using the
existing command envelope without waiting for `hello`. Add a test that `/` with no
extension Origin is rejected.

- [ ] **Step 4: Write two-Agent route isolation and disconnect tests**

```ts
it('routes each extension response only to its originating agent', async () => {
  const extension = await connectExtension(broker.port);
  const alpha = await connectAgent(broker.port);
  const beta = await connectAgent(broker.port);
  const a = alpha.request('list_tabs', {});
  const b = beta.request('list_tabs', {});
  const [commandA, commandB] = await readTwoCommands(extension);
  extension.send(responseFor(commandB, { tabs: [{ tabId: 2 }] }));
  extension.send(responseFor(commandA, { tabs: [{ tabId: 1 }] }));
  await expect(a).resolves.toMatchObject({ tabs: [{ tabId: 1 }] });
  await expect(b).resolves.toMatchObject({ tabs: [{ tabId: 2 }] });
});
```

Also assert `EXTENSION_DISCONNECTED`, `COMMAND_TIMEOUT`, Agent pending-request rejection on disconnect, and a 30-second fake-timer ownership release.

- [ ] **Step 5: Implement command routing and lifecycle cleanup**

Use globally unique extension command IDs and retain the Agent request ID only in Broker state:

```ts
interface PendingRoute { sessionId: string; agentRequestId: string; timer: NodeJS.Timeout; }

private forward(sessionId: string, request: AgentRequest): void {
  if (!this.extension || this.extension.readyState !== WebSocket.OPEN) {
    return this.replyError(sessionId, request.requestId, ErrorCode.EXTENSION_DISCONNECTED);
  }
  const extensionCommandId = randomUUID();
  this.routes.set(extensionCommandId, this.createRoute(sessionId, request));
  this.extension.send(JSON.stringify({
    id: extensionCommandId, type: 'command', command: request.command,
    params: request.params, timeout: request.timeout
  }));
}
```

Handle `tab_removed` and `window_removed` events by releasing ownership and rejecting matching routes with `TAB_CLOSED`. On Broker shutdown, reject all routes and close sockets before closing HTTP.

- [ ] **Step 6: Add the standalone entry point and verify tests**

```ts
const config = loadBrokerConfig(process.argv.slice(2), process.env);
const broker = new BrokerServer(config);
await broker.start();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => { await broker.stop(); process.exit(0); });
}
```

Run: `cd mcp-server && npm test -- --runInBand tests/broker-server.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add mcp-server/src/broker/broker-server.ts mcp-server/src/broker-entry.ts mcp-server/src/command-queue.ts mcp-server/tests/broker-server.test.ts
git commit -m "feat: add singleton browser broker transport"
```

### Task 4: Broker Launcher And Thin MCP Adapter

**Files:**
- Create: `mcp-server/src/broker-client.ts`
- Create: `mcp-server/src/broker-launcher.ts`
- Create: `mcp-server/src/broker-control.ts`
- Modify: `mcp-server/src/server.ts`
- Modify: `mcp-server/src/index.ts`
- Modify: `mcp-server/esbuild.config.js`
- Test: `mcp-server/tests/broker-client.test.ts`
- Test: `mcp-server/tests/broker-launcher.test.ts`
- Modify: `mcp-server/tests/server.test.ts`

**Interfaces:**
- Consumes: `BrokerConfig`, `AgentRequest`, `AgentResponse`
- Produces: `BrokerClient.connect()`, `call(command, params, timeout)`, `close()`
- Produces: `ensureBroker(config)`, `getBrokerStatus(config)`, `stopBroker(config)`
- Produces: `dist/arc-tunnel-control.js [start|status|stop] [--port N]`
- Produces: `ArcTunnelMCPServer` as stdio-only adapter

- [ ] **Step 1: Write failing client correlation tests**

```ts
it('correlates out-of-order Broker responses', async () => {
  const client = await connectBrokerClient(fakeBroker.url);
  const first = client.call('first', {}, 1000);
  const second = client.call('second', {}, 1000);
  fakeBroker.replyTo('second', { value: 2 });
  fakeBroker.replyTo('first', { value: 1 });
  await expect(first).resolves.toEqual({ value: 1 });
  await expect(second).resolves.toEqual({ value: 2 });
});
```

- [ ] **Step 2: Implement `BrokerClient` with no stdout logging**

```ts
async call(command: string, params: Record<string, unknown>, timeout = 30_000): Promise<unknown> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { this.pending.delete(requestId); reject(codeError('COMMAND_TIMEOUT')); }, timeout);
    this.pending.set(requestId, { resolve, reject, timer });
    this.ws.send(JSON.stringify({ type: 'agent_request', requestId, command, params, timeout } satisfies AgentRequest));
  });
}
```

Construct the connection URL as `ws://127.0.0.1:<port>/agent`. All diagnostics go to
stderr because stdout belongs exclusively to MCP stdio.

- [ ] **Step 3: Write launcher race and foreign-port tests**

```ts
it('starts one detached broker for concurrent callers', async () => {
  await Promise.all([ensureBroker(config), ensureBroker(config), ensureBroker(config)]);
  expect(await getBrokerStatus(config)).toMatchObject({ running: true, protocolVersion: 2 });
  expect(readSpawnCount()).toBe(1);
});

it('fails immediately when the port is not Arc Tunnel', async () => {
  const foreign = await listenForeignHttpServer(config.port);
  await expect(ensureBroker(config)).rejects.toMatchObject({ code: 'PORT_IN_USE' });
  await foreign.close();
});
```

- [ ] **Step 4: Implement lock, probe, detached spawn, status, and stop**

Use `~/.arc-tunnel/broker.lock` with `{ pid, port, protocolVersion }`. Acquire using
`fs.openSync(path, 'wx')`; remove a stale lock only when both `process.kill(pid, 0)` and
`GET /health` fail. Spawn `dist/arc-tunnel-broker.js --port <port>` with
`detached: true`, `stdio: 'ignore'`, then `unref()` and poll `/health` for at most 5 seconds.

- [ ] **Step 5: Convert the MCP server to forwarding only**

```ts
export class ArcTunnelMCPServer {
  constructor(private brokerClient: BrokerClient) { /* register MCP handlers */ }

  private async handleToolCall(request: CallToolRequest): Promise<CallToolResult> {
    try {
      const result = await this.brokerClient.call(request.params.name, request.params.arguments ?? {}, 30_000);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      const info = toErrorInfo(error);
      return { content: [{ type: 'text', text: JSON.stringify({ error: info.message, code: info.code }) }], isError: true };
    }
  }
}
```

`index.ts` resolves config, calls `ensureBroker`, connects `BrokerClient`, starts MCP,
and closes only the client on SIGINT/SIGTERM. Remove all WebSocket bind/retry behavior
from the stdio process.

- [ ] **Step 6: Build three Node entry points**

Add the control entry:

```ts
const action = process.argv[2] ?? 'start';
const config = loadBrokerConfig(process.argv.slice(3), process.env);
if (action === 'start') { await ensureBroker(config); console.log(JSON.stringify(await getBrokerStatus(config))); }
else if (action === 'status') { console.log(JSON.stringify(await getBrokerStatus(config))); }
else if (action === 'stop') { await stopBroker(config); console.log(JSON.stringify({ running: false, port: config.port })); }
else { throw new Error(`Unknown broker action: ${action}`); }
```

```js
await Promise.all([
  esbuild.build({ entryPoints: ['src/index.ts'], bundle: true, platform: 'node', target: 'node18', outfile: 'dist/mcp-server.js', sourcemap: true }),
  esbuild.build({ entryPoints: ['src/broker-entry.ts'], bundle: true, platform: 'node', target: 'node18', outfile: 'dist/arc-tunnel-broker.js', sourcemap: true }),
  esbuild.build({ entryPoints: ['src/broker-control.ts'], bundle: true, platform: 'node', target: 'node18', outfile: 'dist/arc-tunnel-control.js', sourcemap: true })
]);
```

- [ ] **Step 7: Run client, launcher, server, and build verification**

Run: `cd mcp-server && npm test -- --runInBand tests/broker-client.test.ts tests/broker-launcher.test.ts tests/server.test.ts`
Expected: PASS.
Run: `cd mcp-server && npm run build`
Expected: `dist/mcp-server.js`, `dist/arc-tunnel-broker.js`, and
`dist/arc-tunnel-control.js` exist.

- [ ] **Step 8: Commit**

```bash
git add mcp-server/src/broker-client.ts mcp-server/src/broker-launcher.ts mcp-server/src/broker-control.ts mcp-server/src/server.ts mcp-server/src/index.ts mcp-server/esbuild.config.js mcp-server/tests/broker-client.test.ts mcp-server/tests/broker-launcher.test.ts mcp-server/tests/server.test.ts mcp-server/dist
git commit -m "feat: make mcp server a shared broker client"
```

### Task 5: Extension Handshake, Windows, And Lifecycle Events

**Files:**
- Modify: `extension/src/types/index.ts`
- Modify: `extension/src/background/websocket-client.ts`
- Modify: `extension/src/background/tab-manager.ts`
- Modify: `extension/src/background/command-handler.ts`
- Modify: `extension/src/background/service-worker.ts`
- Test by typecheck: `extension/tsconfig.json`

**Interfaces:**
- Consumes: protocol version 2 and existing command/response envelopes
- Produces: `TabManager.createWindow(url?) -> { windowId, tabId }`
- Produces: lifecycle events `tab_created`, `tab_removed`, `window_removed`
- Produces: extension `hello` handshake before command processing

- [ ] **Step 1: Add compile-time protocol and tab shape changes**

```ts
export interface TabInfo {
  id: number;
  windowId: number;
  url: string;
  title: string;
  debuggerAttached: boolean;
}

export interface HelloMessage {
  type: 'hello';
  role: 'extension';
  protocolVersion: 2;
}
```

Run: `cd extension && npx tsc --noEmit`
Expected: FAIL at each `TabInfo` construction until `windowId` is populated.

- [ ] **Step 2: Add window-aware tab management**

```ts
async createWindow(url?: string): Promise<{ windowId: number; tabId: number }> {
  const created = await chrome.windows.create({ url: url || 'about:blank', focused: true });
  const tab = created.tabs?.[0];
  if (created.id == null || tab?.id == null) throw new Error('Failed to create browser window');
  this.trackTab(tab);
  return { windowId: created.id, tabId: tab.id };
}

async createTab(url?: string, windowId?: number): Promise<number> {
  const tab = await chrome.tabs.create({ url, windowId, active: true });
  if (tab.id == null) throw new Error('Failed to create tab');
  this.trackTab(tab);
  return tab.id;
}
```

Refactor repeated map writes into `trackTab(tab)` and include `windowId` during initial sync and updates.

- [ ] **Step 3: Add lifecycle subscriptions without duplicate Chrome listeners**

```ts
type LifecycleListener = (event: 'tab_created' | 'tab_removed' | 'window_removed', data: Record<string, unknown>) => void;
onLifecycle(listener: LifecycleListener): () => void { this.lifecycleListeners.add(listener); return () => this.lifecycleListeners.delete(listener); }
```

Existing `chrome.tabs.onCreated/onRemoved` handlers notify listeners after updating local state. Add one `chrome.windows.onRemoved` listener in the same `listenersSetup` guard.

- [ ] **Step 4: Implement extension handshake and reconnect reset**

```ts
const generation = ++this.connectionGeneration;
this.ws.onopen = () => {
  if (generation !== this.connectionGeneration) return;
  this.intentionalClose = false;
  this.ws!.send(JSON.stringify({ type: 'hello', role: 'extension', protocolVersion: 2 }));
};
this.ws.onmessage = event => {
  if (generation !== this.connectionGeneration) return;
  const message = JSON.parse(event.data);
  if (message.type === 'welcome' && message.protocolVersion === 2) resolve();
  else this.handleMessage(message);
};
this.ws.onclose = () => {
  if (generation !== this.connectionGeneration || this.intentionalClose) return;
  this.handleReconnect();
};
```

Normalize a configured root URL such as `ws://localhost:8765` to
`ws://localhost:8765/extension` before connecting; preserve any explicitly configured
non-root path.

`setUrl()` increments `connectionGeneration` before closing the old socket, cancels its
pending reconnect timer, resets `intentionalClose = false`, and starts exactly one new
connection through the service worker. Old-generation callbacks must return without
scheduling reconnect work.

- [ ] **Step 5: Add internal window commands and richer tab listing**

```ts
case 'create_window':
  return await this.tabManager.createWindow(params.url);
case 'create_tab':
  return { tabId: await this.tabManager.createTab(params.url, params.windowId) };
case 'list_tabs': {
  const tabs = await chrome.tabs.query({});
  return { tabs: tabs.filter(t => t.id != null).map(t => ({
    tabId: t.id!, windowId: t.windowId, url: t.url || '', title: t.title || '', active: !!t.active
  })) };
}
```

- [ ] **Step 6: Forward lifecycle events and typecheck/build**

```ts
tabManager.onLifecycle((event, data) => {
  wsClient.sendEvent({ type: 'event', event, data, timestamp: Date.now() });
});
```

Run: `cd extension && npx tsc --noEmit`
Expected: PASS.
Run: `cd extension && npm run build`
Expected: extension build completes.

- [ ] **Step 7: Commit**

```bash
git add extension/src/types/index.ts extension/src/background/websocket-client.ts extension/src/background/tab-manager.ts extension/src/background/command-handler.ts extension/src/background/service-worker.ts extension/dist
git commit -m "feat: add broker-aware browser window lifecycle"
```

### Task 6: Broker Ownership Tools And Concurrent Browser Control

**Files:**
- Modify: `mcp-server/src/broker/broker-server.ts`
- Modify: `mcp-server/src/tools/index.ts`
- Modify: `mcp-server/src/types.ts`
- Test: `mcp-server/tests/broker-ownership.test.ts`
- Modify: `mcp-server/tests/tools.test.ts`

**Interfaces:**
- Consumes: extension `create_window`, `create_tab`, `list_tabs`, lifecycle events
- Produces: public `claim_tab(tabId)` and `release_tab(tabId)`
- Produces: filtered `list_tabs` with `ownership: 'owned' | 'unclaimed'`

- [ ] **Step 1: Write failing end-to-end ownership tests against a fake extension**

```ts
it('creates one window per session and isolates visible tabs', async () => {
  const alphaTab = await alpha.call('create_tab', { url: 'https://a.example' });
  const betaTab = await beta.call('create_tab', { url: 'https://b.example' });
  expect(fakeExtension.commandsNamed('create_window')).toHaveLength(2);
  expect((await alpha.call('list_tabs', {})).tabs).toContainEqual(expect.objectContaining({ tabId: alphaTab.tabId, ownership: 'owned' }));
  expect((await alpha.call('list_tabs', {})).tabs).not.toContainEqual(expect.objectContaining({ tabId: betaTab.tabId }));
});

it('allows explicit claim and rejects foreign tab commands', async () => {
  await alpha.call('claim_tab', { tabId: 300 });
  await expect(beta.call('navigate', { tabId: 300, action: 'goto', url: 'https://x.example' }))
    .rejects.toMatchObject({ code: 'TAB_NOT_OWNED' });
});
```

- [ ] **Step 2: Implement Broker-owned control commands**

```ts
switch (request.command) {
  case 'claim_tab': return this.claimTab(sessionId, request);
  case 'release_tab': return this.releaseTab(sessionId, request);
  case 'list_tabs': return this.listVisibleTabs(sessionId, request);
  case 'create_tab': return this.createOwnedTab(sessionId, request);
}
```

`createOwnedTab` sends `create_window` once per session and records both returned IDs;
later calls send `create_tab` with the owned `windowId`. `listVisibleTabs` fetches all
extension tabs and applies `SessionRegistry.visibleTabs`. Before forwarding any request
whose params include numeric `tabId`, call `assertOwnsTab`.

- [ ] **Step 3: Add public tool definitions and shared-profile warnings**

```ts
{
  name: 'claim_tab',
  description: 'Claim an unowned manually opened tab for this Agent session.',
  inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] }
},
{
  name: 'release_tab',
  description: 'Release an owned tab without closing it so another Agent may claim it.',
  inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] }
}
```

Update `manage_storage` description to say cookie and storage mutations share the same browser profile across Agent sessions.

- [ ] **Step 4: Verify same-tab serialization and cross-tab concurrency through Broker**

Extend the integration test so two commands targeting tab 101 arrive at the fake extension in order, while a command targeting tab 202 arrives before tab 101's first response.

Run: `cd mcp-server && npm test -- --runInBand tests/broker-ownership.test.ts tests/tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/broker/broker-server.ts mcp-server/src/tools/index.ts mcp-server/src/types.ts mcp-server/tests/broker-ownership.test.ts mcp-server/tests/tools.test.ts
git commit -m "feat: isolate agent windows and tabs"
```

### Task 7: Recording, Replay, Saved-Session Ownership, And Reconnect Sync

**Files:**
- Modify: `mcp-server/src/broker/session-registry.ts`
- Modify: `mcp-server/src/broker/broker-server.ts`
- Modify: `mcp-server/tests/broker-ownership.test.ts`
- Modify: `extension/src/background/session-manager.ts`
- Modify: `extension/src/background/command-handler.ts`
- Modify: `extension/src/types/index.ts`

**Interfaces:**
- Consumes: recording and saved-session IDs returned by the extension
- Produces: session-scoped access checks for `stop_recording`, `replay_recording`, and `restore_session`
- Produces: `SessionManager.saveSession(name, tabIds)` and `restoreSession(sessionId, windowId)`
- Produces: resync behavior after extension reconnect

- [ ] **Step 1: Write failing scoped-resource tests**

```ts
it('does not leak recording or saved-session identifiers across agents', async () => {
  const { recordingId } = await alpha.call('start_recording', { tabId: 101 });
  await expect(beta.call('replay_recording', { recordingId, tabId: 202 }))
    .rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' });
  const { sessionId: savedId } = await alpha.call('save_session', { name: 'alpha' });
  await expect(beta.call('restore_session', { sessionId: savedId }))
    .rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
});
```

- [ ] **Step 2: Track resource ownership at successful response time**

```ts
if (route.command === 'start_recording' && result.recordingId) {
  this.sessions.addRecording(route.sessionId, result.recordingId);
}
if (route.command === 'save_session' && result.sessionId) {
  this.sessions.addSavedSession(route.sessionId, result.sessionId);
}
```

Authorize `stop_recording` against the session's active recording, `replay_recording`
against `recordingId`, and `restore_session` against its saved-session set. If another
recording is already active in the extension, return `RECORDING_BUSY` rather than mixing
two sessions in the extension's singleton recording engine.

- [ ] **Step 3: Restrict save and restore to the owning Agent workspace**

Before forwarding `save_session`, the Broker adds the requesting session's owned
`tabIds`. Before forwarding `restore_session`, it adds the session's owned `windowId`;
if no window exists, it creates one first. Update the extension APIs:

```ts
async saveSession(name: string, tabIds: number[]): Promise<string> {
  const tabs = await Promise.all(tabIds.map(tabId => chrome.tabs.get(tabId)));
  const states: TabState[] = [];
  for (const tab of tabs) {
    if (!tab.url) continue;
    const cookies = await chrome.cookies.getAll({ url: tab.url }).catch(() => []);
    states.push({ url: tab.url, cookies, localStorage: {}, sessionStorage: {} });
  }
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [`session_${id}`]: { id, name, tabs: states, savedAt: new Date().toISOString() } });
  return id;
}

async restoreSession(sessionId: string, windowId: number): Promise<number[]> {
  const stored = await chrome.storage.local.get(`session_${sessionId}`);
  const session = stored[`session_${sessionId}`] as SessionData | undefined;
  if (!session) throw new Error('Session not found');
  const tabIds: number[] = [];
  for (const state of session.tabs) {
    const tab = await chrome.tabs.create({ url: state.url, windowId, active: false });
    if (tab.id != null) tabIds.push(tab.id);
    for (const cookie of state.cookies) {
      await chrome.cookies.set({ url: state.url, name: cookie.name, value: cookie.value, path: cookie.path || '/', secure: cookie.secure, httpOnly: cookie.httpOnly });
    }
  }
  return tabIds;
}
```

`CommandHandler` passes `params.tabIds` and `params.windowId`, returns restored
`tabIds`, and never queries all browser tabs for these operations.

- [ ] **Step 4: Test extension reconnect and Broker restart separately**

```ts
it('retains ownership for existing tabs after extension reconnect', async () => {
  await alpha.call('claim_tab', { tabId: 101 });
  await reconnectExtensionWithTabs([{ tabId: 101, windowId: 10 }]);
  expect((await alpha.call('list_tabs', {})).tabs).toContainEqual(expect.objectContaining({ tabId: 101, ownership: 'owned' }));
  expect((await beta.call('list_tabs', {})).tabs).not.toContainEqual(expect.objectContaining({ tabId: 101 }));
});

it('starts with all synchronized tabs unclaimed in a new Broker process', async () => {
  const restarted = await startFreshBrokerWithTabs([{ tabId: 101, windowId: 10 }]);
  const session = await connectAgent(restarted.port);
  expect((await session.call('list_tabs', {})).tabs).toContainEqual(expect.objectContaining({ tabId: 101, ownership: 'unclaimed' }));
});
```

On ordinary extension reconnect within one running Broker, retain session ownership
only for tabs still present after a `list_tabs` sync. On a new Broker process, the
registry starts empty, so all synchronized tabs are unclaimed.

- [ ] **Step 5: Verify disconnect and resource tests**

Run: `cd mcp-server && npm test -- --runInBand tests/broker-ownership.test.ts tests/broker-server.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/broker/session-registry.ts mcp-server/src/broker/broker-server.ts mcp-server/tests/broker-ownership.test.ts mcp-server/tests/broker-server.test.ts extension/src/background/session-manager.ts extension/src/background/command-handler.ts extension/src/types/index.ts
git commit -m "feat: scope browser resources to agent sessions"
```

### Task 8: CLI, Installer, Config Templates, And Documentation

**Files:**
- Modify: `scripts/start.js`
- Modify: `scripts/install.js`
- Modify: `configs/claude-code.json`
- Modify: `configs/hermes.yaml`
- Modify: `configs/openclaw.json`
- Modify: `configs/codex-skill.yaml`
- Modify: `configs/kimi.md`
- Modify: `README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: `dist/arc-tunnel-broker.js`, `WS_PORT`, launcher status/stop behavior
- Produces: `node scripts/start.js [start|status|stop] [--port N]`

- [ ] **Step 1: Replace the old child-process wrapper with Broker lifecycle commands**

```js
const action = ['start', 'status', 'stop'].includes(process.argv[2]) ? process.argv[2] : 'start';
const controlEntry = path.join(REPO_ROOT, 'mcp-server', 'dist', 'arc-tunnel-control.js');
const args = process.argv.slice(action === process.argv[2] ? 3 : 2);
const result = spawnSync(process.execPath, [controlEntry, action, ...args], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
```

Acceptance commands:

```powershell
node scripts/start.js status
node scripts/start.js start --port 9000
node scripts/start.js status --port 9000
node scripts/start.js stop --port 9000
```

Expected: status changes `stopped -> running -> stopped`, with PID and port shown while running.

- [ ] **Step 2: Update templates without changing the MCP command path**

Keep every template's `command`, `args`, and `WS_PORT`; update descriptions/comments to
state that the command connects to or starts the shared Broker. Add no Agent-specific
transport implementation.

- [ ] **Step 3: Update installer checks and instructions**

Require both `dist/mcp-server.js` and `dist/arc-tunnel-broker.js`. After installation,
print the shared Broker behavior and custom-port requirement that the extension popup
must use the same port.

- [ ] **Step 4: Update README and AGENTS architecture/testing sections**

Document:

```text
Agent host --stdio--> lightweight MCP client --WebSocket /agent--> Broker
Browser extension ---------------------------WebSocket /extension--> Broker
```

Include `claim_tab`, `release_tab`, one-window-per-Agent behavior, same-tab exclusion,
cross-tab concurrency, shared cookies, config precedence, and start/status/stop commands.

- [ ] **Step 5: Build and run all automated checks**

Run: `cd mcp-server && npm test -- --runInBand`
Expected: all suites PASS.
Run: `cd mcp-server && npx tsc -p tsconfig.test.json --noEmit`
Expected: PASS.
Run: `cd mcp-server && npm run build`
Expected: both committed bundles rebuilt.
Run: `cd extension && npx tsc --noEmit && npm run build`
Expected: PASS and committed extension bundle rebuilt.

- [ ] **Step 6: Commit**

```bash
git add scripts/start.js scripts/install.js configs README.md AGENTS.md mcp-server/dist extension/dist
git commit -m "docs: document shared multi-agent broker"
```

### Task 9: Multi-Process Integration And Real Browser Verification

**Files:**
- Create: `mcp-server/tests/multi-agent.integration.test.ts`
- Create: `scripts/verify-multi-agent.js`
- Modify: `mcp-server/package.json`

**Interfaces:**
- Consumes: built Broker and MCP client bundles
- Produces: `npm run test:integration` and a reusable real-browser verification script

- [ ] **Step 1: Add a spawned-process integration test**

The test chooses a free port, spawns `dist/arc-tunnel-broker.js`, connects a fake
extension, and spawns two `dist/mcp-server.js` stdio processes using the MCP SDK client.
It must assert:

```ts
expect(await alpha.listTools()).toContainEqual(expect.objectContaining({ name: 'claim_tab' }));
expect(await beta.listTools()).toContainEqual(expect.objectContaining({ name: 'release_tab' }));
const pidBefore = (await fetchHealth(port)).pid;
expect(await runConcurrentOwnedNavigations(alpha, beta)).toEqual({ alpha: 'ok', beta: 'ok' });
expect((await fetchHealth(port)).pid).toBe(pidBefore);
```

- [ ] **Step 2: Run the integration test repeatedly**

Add package script:

```json
"test:integration": "jest --runInBand tests/multi-agent.integration.test.ts"
```

Run: `cd mcp-server && npm run build && npm run test:integration` three times.
Expected each run: PASS, one listening Broker, no `EADDRINUSE`, no `EPIPE`, and no leftover child process.

- [ ] **Step 3: Add the real-browser verification script**

`scripts/verify-multi-agent.js` connects two Broker clients and prints deterministic
instructions/results for:

1. create one tab per Agent and report distinct `windowId`/`tabId` values;
2. navigate both tabs concurrently;
3. list only owned plus unclaimed tabs;
4. claim a manually opened tab from Agent A;
5. verify Agent B receives `TAB_NOT_OWNED`;
6. disconnect Agent A, wait 31 seconds, and verify Agent B can claim the released tab.

- [ ] **Step 4: Verify default and custom ports with the unpacked extension**

Run default-port flow with popup URL `ws://localhost:8765`, then stop it and repeat with
`WS_PORT=9000` plus popup URL `ws://localhost:9000`. Capture terminal results in the
commit message notes; do not commit user-specific paths or logs.

Expected:

- extension reconnects once per Broker start;
- two dedicated windows remain responsive concurrently;
- manually opened tab claiming works;
- pages remain open after either Agent exits;
- Windows Application log and Arc Tunnel stderr show no new `EADDRINUSE`/`EPIPE` errors.

- [ ] **Step 5: Run final regression checks**

Run: `cd mcp-server && npm test -- --runInBand && npm run test:integration`
Expected: PASS.
Run: `cd extension && npx tsc --noEmit && npm run build`
Expected: PASS.
Run: `git diff --check`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/tests/multi-agent.integration.test.ts mcp-server/package.json scripts/verify-multi-agent.js mcp-server/dist extension/dist
git commit -m "test: verify concurrent multi-agent browser control"
```

## Completion Gate

- Run `git status --short` and verify only intentional project files are changed.
- Run all commands from Task 9 Step 5 and retain their exact pass/fail output.
- Confirm the active Broker PID owns the configured port and no second Broker process exists.
- Confirm the extension controls a manually opened tab after explicit claim.
- Confirm two Agents operate separate windows concurrently without response crossover.
- Review the final diff for accidental home-directory files, secrets, tokens, or generated logs.
- Use `superpowers:verification-before-completion` before claiming success.
- Use `superpowers:requesting-code-review` before integration or push.
