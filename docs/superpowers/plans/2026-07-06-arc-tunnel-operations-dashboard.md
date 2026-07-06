# Arc Tunnel Operations Control Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only Chinese operations control center, safe diagnostics APIs and CLI, and release-ready repository packaging for Arc Tunnel.

**Architecture:** A focused `DiagnosticsStore` owns a bounded, redacted in-memory event stream and recovery metadata. `BrokerServer` derives live counts from its existing registries, exposes same-origin read-only HTTP/SSE routes, and serves framework-free dashboard assets copied beside the committed Broker bundle. The lifecycle CLI reads the same safe status API; root scripts and CI provide one reproducible verification entry point.

**Tech Stack:** TypeScript 6, Node.js 18+, `http`, `ws`, Server-Sent Events, plain HTML/CSS/JavaScript, Jest, Node test runner, esbuild, GitHub Actions.

## Global Constraints

- Broker remains bound only to `127.0.0.1`; no LAN or remote exposure.
- Existing `/health` response fields and existing `start`, `status`, and `stop` behavior remain compatible.
- Dashboard and diagnostics endpoints are GET-only and provide no process, ownership, or browser mutation actions.
- Diagnostics must never include URLs, tab IDs, session IDs, cookies, scripts, command parameters, or extension results.
- Diagnostic events use stable English codes and Chinese display summaries.
- The event buffer contains at most 200 events per Broker process.
- `/api/events` uses SSE, supports missed-event replay, and emits `RESET` when the requested sequence predates the buffer.
- Dashboard copy and visible labels are Chinese.
- HTTP diagnostic responses use `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and a restrictive `Content-Security-Policy`; no CORS allow header is sent.
- Prebuilt `mcp-server/dist/` artifacts remain committed.
- Root `npm run verify` runs tests, typechecks, builds, integration tests, and documentation assertions.
- CI runs on `windows-latest` and `ubuntu-latest` with a supported Node.js LTS.
- The repository license is MIT with `Copyright (c) 2026 Arc Tunnel contributors`.

---

## File Structure

- `mcp-server/src/broker/diagnostics-store.ts`: diagnostic types, bounded event buffer, recovery metadata, subscriptions, and snapshot assembly.
- `mcp-server/src/broker/broker-server.ts`: lifecycle instrumentation, safe runtime counts, HTTP routes, SSE client lifecycle, and dashboard asset serving.
- `mcp-server/src/broker/session-registry.ts`: aggregate connected/grace/ownership counts only; no identifiers leave this layer.
- `mcp-server/src/dashboard/index.html`: semantic Chinese control-center markup.
- `mcp-server/src/dashboard/dashboard.css`: responsive control-center presentation.
- `mcp-server/src/dashboard/dashboard.js`: status fetch, SSE updates, filtering, reconnect state, and safe diagnostic copy.
- `mcp-server/src/broker-launcher.ts`: endpoint inspection and typed diagnostic retrieval.
- `mcp-server/src/broker-control.ts`: `diagnose` command, human output, JSON output, and exit-code mapping.
- `mcp-server/esbuild.config.js`: build all bundles and copy dashboard assets to `dist/dashboard/`.
- `package.json`: private root orchestration scripts only; child projects keep their own lockfiles.
- `.github/workflows/verify.yml`: Windows/Linux verification matrix and generated-artifact drift check.
- `LICENSE`: MIT license text.
- `README.md`, `AGENTS.md`, `scripts/check-docs.js`: user commands, privacy boundary, and deterministic documentation assertions.

---

### Task 1: Bounded Diagnostics Store

**Files:**
- Create: `mcp-server/src/broker/diagnostics-store.ts`
- Create: `mcp-server/tests/diagnostics-store.test.ts`

**Interfaces:**
- Produces: `DiagnosticsStore`, `DiagnosticEvent`, `DiagnosticCategory`, `DiagnosticLevel`, `RecoveryState`, `DiagnosticsSnapshot`, and `RuntimeDiagnostics`.
- Produces methods: `record(input)`, `eventsAfter(sequence)`, `subscribe(listener)`, `setExtensionState(state)`, `setInventorySync(state)`, `setRecordingCleanup(state)`, `snapshot(runtime)`.
- Buffer invariant: the newest 200 events are retained and sequence numbers never repeat within a process.

- [ ] **Step 1: Write failing buffer, subscription, reset, and redaction-boundary tests**

```ts
import { DiagnosticsStore } from '../src/broker/diagnostics-store';

describe('DiagnosticsStore', () => {
  it('keeps the newest 200 sequenced events and reports stale cursors', () => {
    const store = new DiagnosticsStore({ pid: 42, port: 9000, protocolVersion: 2, startedAt: 1_000 });
    for (let index = 0; index < 205; index++) {
      store.record({ level: 'info', category: 'broker', code: `EVENT_${index}`, summary: `事件 ${index}` });
    }
    const replay = store.eventsAfter(0);
    expect(replay.reset).toBe(true);
    expect(replay.events).toHaveLength(200);
    expect(replay.events[0].sequence).toBe(6);
    expect(replay.events[199].sequence).toBe(205);
  });

  it('notifies and removes subscribers', () => {
    const store = new DiagnosticsStore({ pid: 42, port: 9000, protocolVersion: 2, startedAt: 1_000 });
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    store.record({ level: 'warning', category: 'connection', code: 'EXTENSION_DISCONNECTED', summary: '浏览器扩展已断开' });
    unsubscribe();
    store.record({ level: 'info', category: 'connection', code: 'EXTENSION_CONNECTED', summary: '浏览器扩展已连接' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('builds a safe aggregate snapshot without identity or browser fields', () => {
    const store = new DiagnosticsStore({ pid: 42, port: 9000, protocolVersion: 2, startedAt: 1_000 });
    const snapshot = store.snapshot({ now: 5_000, connectedAgents: 2, graceAgents: 1, claimedTabs: 4, pendingCommands: 3 });
    expect(snapshot).toMatchObject({
      broker: { pid: 42, port: 9000, protocolVersion: 2, uptimeMs: 4_000 },
      agents: { connected: 2, grace: 1 },
      workload: { claimedTabs: 4, pendingCommands: 3 }
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/sessionId|tabId|url|cookie|script|params/i);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd mcp-server && npx jest --runInBand tests/diagnostics-store.test.ts`

Expected: FAIL because `../src/broker/diagnostics-store` does not exist.

- [ ] **Step 3: Implement the store and stable public types**

```ts
export type DiagnosticLevel = 'info' | 'warning' | 'error';
export type DiagnosticCategory = 'broker' | 'connection' | 'ownership' | 'recovery';
export type RecoveryPhase = 'idle' | 'running' | 'failed';

export interface DiagnosticEvent {
  sequence: number;
  timestamp: number;
  level: DiagnosticLevel;
  category: DiagnosticCategory;
  code: string;
  summary: string;
}

export interface RuntimeDiagnostics {
  now: number;
  connectedAgents: number;
  graceAgents: number;
  claimedTabs: number;
  pendingCommands: number;
}

export class DiagnosticsStore {
  private readonly events: DiagnosticEvent[] = [];
  private readonly listeners = new Set<(event: DiagnosticEvent) => void>();
  private sequence = 0;
  private extension = { connected: false, generation: 0, reconnectPhase: 'idle', lastSyncAt: null as number | null };
  private recovery = {
    inventorySync: 'idle' as RecoveryPhase,
    recordingCleanup: 'idle' as RecoveryPhase
  };
  private recentError: Pick<DiagnosticEvent, 'timestamp' | 'code' | 'summary'> | null = null;

  constructor(private readonly broker: { pid: number; port: number; protocolVersion: number; startedAt: number }) {}

  record(input: Omit<DiagnosticEvent, 'sequence' | 'timestamp'> & { timestamp?: number }): DiagnosticEvent {
    const event = { ...input, sequence: ++this.sequence, timestamp: input.timestamp ?? Date.now() };
    this.events.push(event);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    if (event.level === 'error') this.recentError = event;
    for (const listener of this.listeners) listener(event);
    return event;
  }

  eventsAfter(sequence: number): { reset: boolean; events: DiagnosticEvent[] } {
    const first = this.events[0]?.sequence ?? this.sequence + 1;
    return { reset: sequence < first - 1, events: this.events.filter(event => event.sequence > sequence) };
  }

  subscribe(listener: (event: DiagnosticEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
```

Complete `setExtensionState`, recovery setters, and `snapshot` with only the fields named in the approved spec. Do not accept arbitrary metadata objects in `record`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `cd mcp-server && npx jest --runInBand tests/diagnostics-store.test.ts && npx tsc -p tsconfig.test.json --noEmit`

Expected: all diagnostics tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/broker/diagnostics-store.ts mcp-server/tests/diagnostics-store.test.ts
git commit -m "feat: add bounded broker diagnostics"
```

---

### Task 2: Broker Status API, SSE, and Lifecycle Instrumentation

**Files:**
- Modify: `mcp-server/src/broker/broker-server.ts`
- Modify: `mcp-server/src/broker/session-registry.ts`
- Modify: `mcp-server/tests/broker-server.test.ts`
- Modify: `mcp-server/tests/session-registry.test.ts`
- Test: `mcp-server/tests/broker-diagnostics.test.ts`

**Interfaces:**
- Consumes: `DiagnosticsStore` from Task 1.
- Produces GET `/api/status` and `/api/events`.
- Produces `SessionRegistry.diagnosticsCounts(): { connected: number; grace: number; claimedTabs: number }`.
- Produces `BrokerServer.dashboardUrl(): string` for CLI and tests.

- [ ] **Step 1: Write failing aggregate-count and HTTP security tests**

```ts
it('returns only safe aggregate diagnostics with security headers', async () => {
  const response = await fetch(`http://127.0.0.1:${broker.address().port}/api/status`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('x-frame-options')).toBe('DENY');
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
  const body = await response.json();
  expect(body).toMatchObject({
    broker: { port: broker.address().port, protocolVersion: 2 },
    extension: { connected: false },
    agents: { connected: 0, grace: 0 },
    workload: { claimedTabs: 0, pendingCommands: 0 }
  });
  expect(JSON.stringify(body)).not.toMatch(/sessionId|tabId|url|cookie|script|params/i);
});
```

Add a compatibility assertion that `/health` still has exactly `name`, `protocolVersion`, `pid`, and `port`.

- [ ] **Step 2: Write failing SSE replay, RESET, unsubscribe, and shutdown tests**

Use Node `http.get` to parse SSE frames. Assert:

```ts
expect(replayed.map(event => event.id)).toEqual(['2', '3']);
expect(reset.event).toBe('RESET');
expect((broker as any).sseClients.size).toBe(0);
await expect(broker.stop()).resolves.toBeUndefined();
```

The test must open a live SSE response before `broker.stop()` to prove shutdown is not blocked.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `cd mcp-server && npx jest --runInBand tests/session-registry.test.ts tests/broker-diagnostics.test.ts`

Expected: FAIL because aggregate counters and diagnostic routes do not exist.

- [ ] **Step 4: Implement aggregate counts and shared security headers**

Add to `SessionRegistry`:

```ts
diagnosticsCounts(): { connected: number; grace: number; claimedTabs: number } {
  let connected = 0;
  let grace = 0;
  for (const session of this.sessions.values()) {
    if (session.connected) connected++;
    else if (session.disconnectedAt !== null) grace++;
  }
  return { connected, grace, claimedTabs: this.tabOwners.size };
}
```

Add a `writeDiagnosticHeaders(response, contentType)` helper that sets the four required security headers and never sets CORS.

- [ ] **Step 5: Implement status and SSE routing**

In the HTTP request handler, route before the 404 branch:

```ts
if (request.method === 'GET' && request.url === '/api/status') {
  this.writeDiagnosticHeaders(response, 'application/json; charset=utf-8');
  response.writeHead(200);
  response.end(JSON.stringify(this.diagnosticsSnapshot()));
  return;
}
if (request.method === 'GET' && new URL(request.url || '/', 'http://localhost').pathname === '/api/events') {
  this.openEventStream(request, response);
  return;
}
```

`openEventStream` must parse `Last-Event-ID` first, then `after`; emit `event: RESET` when `eventsAfter` returns `reset: true`; emit each diagnostic as `id`, `event: diagnostic`, and one JSON `data` line; subscribe for future events; and unsubscribe on request or response close.

- [ ] **Step 6: Instrument lifecycle transitions without sensitive values**

Record only fixed summaries at these transitions:

- Broker started/stopping;
- extension connected/disconnected/replaced;
- Agent connected and grace started/expired;
- inventory sync started/completed/failed;
- recording cleanup started/completed/failed.

Update extension generation and recovery phase in `DiagnosticsStore`. Use `this.routes.size` for pending command count and `SessionRegistry.diagnosticsCounts()` for Agent/ownership counts.

- [ ] **Step 7: Close SSE responses during Broker stop**

Store active responses in `private readonly sseClients = new Set<http.ServerResponse>()`. During `performStop`, call `response.end()` for each and clear the set before closing the HTTP server.

- [ ] **Step 8: Run focused and full MCP tests**

Run: `cd mcp-server && npx jest --runInBand tests/broker-diagnostics.test.ts tests/broker-server.test.ts tests/session-registry.test.ts && npm test -- --runInBand && npx tsc -p tsconfig.test.json --noEmit`

Expected: focused and all MCP suites PASS; TypeScript exits 0.

- [ ] **Step 9: Commit**

```bash
git add mcp-server/src/broker/broker-server.ts mcp-server/src/broker/session-registry.ts mcp-server/tests/broker-diagnostics.test.ts mcp-server/tests/broker-server.test.ts mcp-server/tests/session-registry.test.ts
git commit -m "feat: expose safe broker diagnostics"
```

---

### Task 3: Chinese Read-Only Control Center

**Files:**
- Create: `mcp-server/src/dashboard/index.html`
- Create: `mcp-server/src/dashboard/dashboard.css`
- Create: `mcp-server/src/dashboard/dashboard.js`
- Create: `mcp-server/tests/dashboard.test.ts`
- Modify: `mcp-server/src/broker/broker-server.ts`
- Modify: `mcp-server/esbuild.config.js`
- Generated: `mcp-server/dist/dashboard/index.html`
- Generated: `mcp-server/dist/dashboard/dashboard.css`
- Generated: `mcp-server/dist/dashboard/dashboard.js`
- Generated: `mcp-server/dist/arc-tunnel-broker.js`
- Generated: `mcp-server/dist/arc-tunnel-broker.js.map`

**Interfaces:**
- Consumes: `/api/status` and `/api/events` from Task 2.
- Produces: GET `/dashboard`, `/dashboard/dashboard.css`, `/dashboard/dashboard.js`.
- Browser functions: `renderStatus(snapshot)`, `appendEvent(event)`, `setCategory(category)`, `copyDiagnostics()`.

- [ ] **Step 1: Write failing asset, CSP, and Chinese-copy tests**

```ts
it('serves the Chinese dashboard and same-origin assets', async () => {
  const html = await fetch(`${base}/dashboard`);
  expect(html.headers.get('content-security-policy')).toContain("default-src 'self'");
  expect(await html.text()).toContain('Arc Tunnel 运维控制中心');
  expect((await fetch(`${base}/dashboard/dashboard.css`)).headers.get('content-type')).toContain('text/css');
  expect((await fetch(`${base}/dashboard/dashboard.js`)).headers.get('content-type')).toContain('javascript');
});
```

Read `dashboard.js` in the test and assert it does not contain mutation endpoints, `innerHTML =`, or browser-sensitive field names.

- [ ] **Step 2: Run focused test and verify RED**

Run: `cd mcp-server && npx jest --runInBand tests/dashboard.test.ts`

Expected: FAIL with dashboard route 404 or missing asset files.

- [ ] **Step 3: Create semantic dashboard HTML matching the approved C layout**

Use IDs `overall-status`, `broker-card`, `extension-card`, `recovery-card`, `agent-count`, `grace-count`, `claimed-tab-count`, `pending-count`, `connection-detail`, `event-list`, `event-filter`, `copy-diagnostics`, and `offline-banner`. Link only same-origin CSS and JavaScript files. All visible copy is Chinese.

- [ ] **Step 4: Implement safe DOM rendering and event filtering**

Use `document.createElement` and `textContent`; never inject event summaries with `innerHTML`. Fetch status on startup, connect `new EventSource('/api/events')`, refetch on `RESET`, show the offline banner on fetch/SSE errors, and cap rendered events at 200.

`copyDiagnostics()` must serialize only the current `/api/status` object and rendered diagnostic events, then call `navigator.clipboard.writeText`.

- [ ] **Step 5: Serve dashboard files with a fixed allowlist**

Map exactly these paths:

```ts
const DASHBOARD_ASSETS = new Map([
  ['/dashboard', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard/', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']]
]);
```

Resolve only the mapped filename under `path.join(__dirname, 'dashboard')`; do not concatenate arbitrary request paths.

- [ ] **Step 6: Copy static assets during build**

Refactor `mcp-server/esbuild.config.js` to an awaited `build()` function. After all three bundles succeed:

```js
fs.rmSync('dist/dashboard', { recursive: true, force: true });
fs.cpSync('src/dashboard', 'dist/dashboard', { recursive: true });
```

Log `MCP server build complete` only after the copy succeeds.

- [ ] **Step 7: Run dashboard tests, build, and generated-artifact check**

Run: `cd mcp-server && npx jest --runInBand tests/dashboard.test.ts && npm run build && node dist/arc-tunnel-broker.js --port 0`

For the last command, start it only long enough to verify it serves the copied dashboard, then stop the owned process. Expected: test PASS, build exits 0, and generated files exist under `dist/dashboard/`.

- [ ] **Step 8: Commit**

```bash
git add mcp-server/src/dashboard mcp-server/tests/dashboard.test.ts mcp-server/src/broker/broker-server.ts mcp-server/esbuild.config.js mcp-server/dist
git commit -m "feat: add Chinese operations dashboard"
```

---

### Task 4: Diagnose CLI

**Files:**
- Modify: `scripts/start.js`
- Modify: `mcp-server/src/broker-launcher.ts`
- Modify: `mcp-server/src/broker-control.ts`
- Create: `mcp-server/tests/broker-control.test.ts`
- Modify: `mcp-server/tests/broker-launcher.test.ts`
- Generated: `mcp-server/dist/arc-tunnel-control.js`
- Generated: `mcp-server/dist/arc-tunnel-control.js.map`

**Interfaces:**
- Produces: `inspectBroker(config): Promise<BrokerInspection>`.
- `BrokerInspection` variants: `healthy`, `absent`, `foreign`, `incompatible`, `diagnostics-unavailable`.
- Produces CLI: `diagnose [--port N] [--json]`.

- [ ] **Step 1: Write failing endpoint-inspection tests**

Create deterministic local HTTP servers for:

```ts
{ name: 'arc-tunnel', protocolVersion: 2, pid: 42, port }
{ name: 'arc-tunnel', protocolVersion: 99, pid: 42, port }
{ name: 'other-service' }
```

Assert `inspectBroker` returns `healthy`, `incompatible`, and `foreign` respectively, and returns `absent` for a closed port. For a valid `/health` plus failing `/api/status`, assert `diagnostics-unavailable`.

- [ ] **Step 2: Write failing CLI formatting and exit-code tests**

Export `runControl(argv, env, output, launcher)` from `broker-control.ts`, keeping `main()` as a thin process wrapper. Assert:

```ts
expect(output.stdout).toContain('Arc Tunnel 运维控制中心');
expect(output.stdout).toContain(`http://127.0.0.1:${port}/dashboard`);
expect(json.running).toBe(true);
expect(exitCodes).toEqual({ absent: 2, foreign: 3, incompatible: 4, diagnosticsUnavailable: 5 });
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `cd mcp-server && npx jest --runInBand tests/broker-control.test.ts tests/broker-launcher.test.ts`

Expected: FAIL because `inspectBroker`, `runControl`, and `diagnose` do not exist.

- [ ] **Step 4: Implement typed inspection without changing launcher safety rules**

Reuse the existing bounded HTTP probe mechanics. `/health` determines Arc Tunnel identity and compatibility; `/api/status` supplies diagnostics only after identity is confirmed. Never stop or signal a PID from `inspectBroker`.

- [ ] **Step 5: Implement human and JSON diagnose output**

Human output contains Chinese headings, Broker PID/port/protocol/uptime, Extension status, Agent/workload counts, recovery phase, recent error, dashboard URL, and one actionable recommendation for each failure variant.

`--json` writes exactly one JSON document and no decorative text. Keep existing `status` JSON unchanged.

- [ ] **Step 6: Allow `diagnose` in the wrapper**

Change the action allowlist in `scripts/start.js` to:

```js
const ACTIONS = new Set(['start', 'status', 'stop', 'diagnose']);
const action = ACTIONS.has(process.argv[2]) ? process.argv[2] : 'start';
```

- [ ] **Step 7: Run focused tests, typecheck, and build**

Run: `cd mcp-server && npx jest --runInBand tests/broker-control.test.ts tests/broker-launcher.test.ts && npx tsc -p tsconfig.test.json --noEmit && npm run build`

Expected: all focused tests PASS; TypeScript and build exit 0.

- [ ] **Step 8: Verify real CLI against an owned custom-port Broker**

Run from repository root:

```bash
node scripts/start.js start --port 19090
node scripts/start.js diagnose --port 19090
node scripts/start.js diagnose --port 19090 --json
node scripts/start.js stop --port 19090
```

Expected: human and JSON diagnostics succeed; the final status is stopped. If 19090 is occupied, select another verified-free high port. Never stop an unknown occupant.

- [ ] **Step 9: Commit**

```bash
git add scripts/start.js mcp-server/src/broker-launcher.ts mcp-server/src/broker-control.ts mcp-server/tests/broker-control.test.ts mcp-server/tests/broker-launcher.test.ts mcp-server/dist
git commit -m "feat: add broker diagnose command"
```

---

### Task 5: Repository Packaging, CI, License, and Documentation

**Files:**
- Create: `package.json`
- Create: `LICENSE`
- Create: `.github/workflows/verify.yml`
- Modify: `mcp-server/package.json`
- Modify: `extension/package.json`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `scripts/check-docs.js`

**Interfaces:**
- Produces root scripts: `test`, `typecheck`, `build`, `test:integration`, `check:docs`, `verify`.
- Produces CI matrix on Windows and Linux.

- [ ] **Step 1: Write failing deterministic packaging assertions**

Extend `scripts/check-docs.js` to parse all three package files and assert:

```js
if (root.private !== true) throw new Error('Root package must be private');
if (root.license !== 'MIT' || mcp.license !== 'MIT' || extension.license !== 'MIT') {
  throw new Error('Every package must use MIT');
}
for (const command of ['test', 'typecheck', 'build', 'verify']) {
  if (typeof root.scripts?.[command] !== 'string') throw new Error(`Missing root script: ${command}`);
}
```

Also assert README and AGENTS contain `diagnose`, `/dashboard`, the privacy boundary, root `npm run verify`, and the lifecycle artifact list.

- [ ] **Step 2: Run docs assertions and verify RED**

Run: `node scripts/check-docs.js`

Expected: FAIL because the root package, LICENSE, CI, and new documentation are absent.

- [ ] **Step 3: Add root orchestration package**

Create:

```json
{
  "name": "arc-tunnel",
  "version": "1.0.0",
  "private": true,
  "description": "Local multi-Agent browser automation through one shared Broker",
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/jins-acl/arc-tunnel.git" },
  "scripts": {
    "test": "npm --prefix mcp-server test -- --runInBand && npm --prefix extension test",
    "typecheck": "npx --prefix mcp-server tsc -p mcp-server/tsconfig.test.json --noEmit && npx --prefix extension tsc -p extension/tsconfig.json --noEmit",
    "build": "npm --prefix mcp-server run build && npm --prefix extension run build",
    "test:integration": "npm --prefix mcp-server run test:integration",
    "check:docs": "node scripts/check-docs.js",
    "verify": "npm test && npm run typecheck && npm run build && npm run test:integration && npm run check:docs"
  }
}
```

Verify the exact `npx --prefix` syntax on Windows and Linux; if npm resolves the working directory differently, use `npm exec --prefix <dir> -- tsc ...` while keeping the script names and behavior unchanged.

- [ ] **Step 4: Normalize child package metadata and add LICENSE**

Use names `@arc-tunnel/mcp-server` and `@arc-tunnel/extension`, concise descriptions, `MIT`, and the same repository object. Remove empty `author` and `keywords` fields. Add the standard MIT license text with the approved copyright line.

- [ ] **Step 5: Add Windows/Linux GitHub Actions**

Create `.github/workflows/verify.yml` with triggers for pull requests and pushes to `master` and `codex/**`. Use:

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [ubuntu-latest, windows-latest]
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 22
      cache: npm
      cache-dependency-path: |
        mcp-server/package-lock.json
        extension/package-lock.json
  - run: npm ci --prefix mcp-server
  - run: npm ci --prefix extension
  - run: npm run verify
  - run: git diff --exit-code -- mcp-server/dist extension/dist
```

- [ ] **Step 6: Update README and AGENTS**

Document:

```bash
node scripts/start.js diagnose [--port N]
node scripts/start.js diagnose [--port N] --json
```

Link the control center as `http://127.0.0.1:<port>/dashboard`. State explicitly that it is read-only and excludes URLs, IDs, cookies, scripts, parameters, and page content. Replace the two-directory development block with `npm run verify`, while retaining child commands for component-specific debugging.

- [ ] **Step 7: Run root verification and metadata assertions**

Run from repository root:

```bash
npm run verify
git diff --check
git status --short
```

Expected: MCP and extension tests PASS, both typechecks and builds PASS, integration and docs checks PASS, and only intended files/build artifacts are modified.

- [ ] **Step 8: Commit**

```bash
git add package.json LICENSE .github/workflows/verify.yml mcp-server/package.json extension/package.json README.md AGENTS.md scripts/check-docs.js
git commit -m "chore: prepare operations dashboard release"
```

---

## Final Verification

- [ ] Run `npm run verify` from the repository root.
- [ ] Run `git diff --check` and confirm no errors.
- [ ] Start an owned Broker on a verified-free custom port and open `/dashboard` in Chrome or Edge.
- [ ] Confirm Chinese labels, status cards, event filters, SSE updates, offline state, and safe copied diagnostics.
- [ ] Run two real Agent sessions and verify connected/grace/claimed/pending counts change without exposing identifiers.
- [ ] Stop the owned Broker and confirm the dashboard becomes offline and the process exits without an SSE hang.
- [ ] Confirm no unknown process on another port was stopped or modified.
- [ ] Generate a whole-branch review package and obtain independent specification and code-quality approval.
- [ ] Push `codex/arc-tunnel-multi-agent-broker` only after all checks and reviews pass.
