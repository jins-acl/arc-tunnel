# Arc Tunnel Lightweight Authentication Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax so progress can be recorded in this document.

**Goal:** Require one installation-generated local token for every Agent and Extension WebSocket, harden production dependencies and runtime metadata, close the remaining verifier hygiene gaps, and ship the change with automated, browser, review, CI, and migration evidence.

**Architecture:** Keep the Broker bound to `127.0.0.1` and keep protocol version 2. Add a required 43-character base64url token to the existing `hello` handshake, validate the configured secret before startup, compare credentials with a fixed-length timing-safe helper, and close rejected sockets with `1008/AUTH_FAILED` before creating any session or extension state. Agent clients read the token from environment or config; a spawned Broker receives it only through `ARC_TUNNEL_TOKEN`. The extension stores the token in `chrome.storage.local`, treats URL and token as one connection configuration, and suppresses retries for a rejected token until the token changes.

**Tech Stack:** Node.js 22, TypeScript 6, `ws`, `@modelcontextprotocol/sdk`, Jest 29, Node test runner, esbuild, Chrome/Edge Manifest V3, GitHub Actions.

## Global Constraints

- [ ] Run every command with `E:\worktrees\arc-tunnel-multi-agent-broker` as the working directory.
- [ ] Preserve every pre-existing untracked smoke/probe file; never stage, modify, delete, or clean them.
- [ ] Follow RED → GREEN TDD for each production behavior change.
- [ ] Keep protocol version `2`, loopback binding, Origin restrictions, tab ownership, heartbeat timing, debugger deadlines, and command deadlines unchanged.
- [ ] Never put a token in URLs, CLI arguments, lock files, logs, diagnostics, dashboard content, events, errors, screenshots, or review output.
- [ ] Use `ARC_TUNNEL_TOKEN` only for process-to-process configuration; never persist an environment override.
- [ ] After each implementation task, run an independent specification-compliance review and then an independent code-quality review. Resolve findings and repeat the affected review before starting the next task.
- [ ] Commit only the files belonging to the current task. Use the commit message specified by that task unless a review fix requires a separate `fix:` commit.
- [ ] Do not merge, push `master`, close Issue #17, or claim completion until all automated and real-browser release gates pass.

---

## Task 1: Add the token primitive and split authenticated startup from read-only lifecycle configuration

**Files:**

- Create: `mcp-server/src/auth-token.ts`
- Create: `mcp-server/tests/helpers/auth.ts`
- Modify: `mcp-server/src/config.ts`
- Modify: `mcp-server/tests/config.test.ts`
- Modify: `mcp-server/src/broker-control.ts`
- Modify: `mcp-server/tests/broker-control.test.ts`

### Behavior contract

Use these public shapes:

```ts
export const AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const AUTH_TOKEN_BYTES = 32;

export function isValidAuthToken(value: unknown): value is string;
export function verifyAuthToken(candidate: unknown, expected: string): boolean;

export interface BrokerEndpointConfig {
  host: '127.0.0.1';
  port: number;
}

export interface BrokerConfig extends BrokerEndpointConfig {
  token: string;
}

export function loadBrokerEndpointConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  homeDir?: string
): BrokerEndpointConfig;

export function loadBrokerConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  homeDir?: string
): BrokerConfig;
```

`loadBrokerConfig` resolves `ARC_TUNNEL_TOKEN` before the persisted token and throws a non-secret message containing `node scripts/install.js` when the selected token is absent or invalid. `loadBrokerEndpointConfig` preserves the current port precedence and does not require a token. `runControl` uses the full config only for `start`; `status`, `stop`, and `diagnose` use the endpoint config.

The timing-safe helper must:

```ts
const candidateIsValid = isValidAuthToken(candidate);
const candidateBytes = candidateIsValid
  ? Buffer.from(candidate, 'base64url')
  : Buffer.alloc(AUTH_TOKEN_BYTES);
const expectedBytes = Buffer.from(expected, 'base64url');
return timingSafeEqual(candidateBytes, expectedBytes) && candidateIsValid;
```

Validate `expected` before comparison so `timingSafeEqual` always receives two 32-byte buffers.

### TDD steps

- [ ] Add RED tests to `mcp-server/tests/config.test.ts` for:
  - a persisted valid token;
  - `ARC_TUNNEL_TOKEN` precedence over a different valid file token;
  - a missing token;
  - 42- and 44-character tokens;
  - invalid base64url characters and padding;
  - an invalid environment token not falling back to the file token;
  - error text containing the installer command and not containing the rejected token;
  - endpoint-only loading retaining CLI → `WS_PORT` → file → `8765` precedence without a token.
- [ ] Add RED tests for `isValidAuthToken` and `verifyAuthToken`, including correct, incorrect, malformed, and wrong-length candidates. Use the stable fixture:

```ts
export const TEST_AUTH_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
export const OTHER_AUTH_TOKEN = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
export const testBrokerConfig = (port = 0) => ({
  host: '127.0.0.1' as const,
  port,
  token: TEST_AUTH_TOKEN
});
```

- [ ] Add RED control tests proving `status`, `stop`, and `diagnose` work with no token while `start` rejects with the installer instruction.
- [ ] Run RED:

```powershell
npm --prefix mcp-server test -- --runInBand tests/config.test.ts tests/broker-control.test.ts
```

Expected: new token and endpoint-only assertions fail.

- [ ] Implement `auth-token.ts`, refactor config loading, and select the appropriate loader in `runControl`.
- [ ] Ensure the token never appears in a thrown message, including invalid environment and invalid persisted-config cases.
- [ ] Run GREEN:

```powershell
npm --prefix mcp-server test -- --runInBand tests/config.test.ts tests/broker-control.test.ts
npm run typecheck
```

- [ ] Commit:

```powershell
git add mcp-server/src/auth-token.ts mcp-server/src/config.ts mcp-server/src/broker-control.ts mcp-server/tests/helpers/auth.ts mcp-server/tests/config.test.ts mcp-server/tests/broker-control.test.ts
git commit -m "feat: require broker authentication configuration"
```

- [ ] Specification review: verify exact token format/precedence, non-secret errors, and endpoint-only lifecycle behavior against the approved design.
- [ ] Code-quality review: inspect parsing boundaries, fixed-length comparison, type separation, and regression coverage.

---

## Task 2: Generate, migrate, and atomically persist the installation token

**Files:**

- Modify: `scripts/install.js`
- Create: `mcp-server/tests/install.test.ts`

### Behavior contract

Refactor the installer so requiring the module does not execute installation:

```js
if (require.main === module) install();

module.exports = {
  ensureBrokerAuthConfig,
  isValidAuthToken,
  writeConfigAtomically
};
```

Use:

```js
crypto.randomBytes(32).toString('base64url')
```

and return:

```js
{
  configPath,
  token,
  generated
}
```

`ensureBrokerAuthConfig(homeDir, dependencies?)` must preserve a valid existing token and any valid custom port, migrate `{ "port": N }`, and create `~/.arc-tunnel/config.json` when absent. `writeConfigAtomically` must create the directory, write a uniquely named same-directory temporary file using mode `0o600`, rename it over the final path, request mode `0o600` for the final file, and remove the temporary file on handled failure without removing or truncating the prior config.

Call token setup after committed bundles have been checked but before Agent detection, so installations with no auto-detected Agent still receive a Broker token.

### TDD steps

- [ ] Add RED installer tests for:
  - generated tokens matching `^[A-Za-z0-9_-]{43}$` and decoding to exactly 32 bytes;
  - absent config creation with default port 8765;
  - `{ "port": 9123 }` migration preserving port;
  - exact preservation of an existing valid token;
  - invalid existing token replacement;
  - malformed JSON rejection without overwriting the file;
  - atomic rename success with no leftover temporary file;
  - injected rename failure preserving the previous bytes and removing the temporary file;
  - `generated: true` only for a newly generated token.
- [ ] Capture installer output in a focused test or injected logger and prove:
  - a newly generated token is printed exactly once with the popup instruction;
  - a preserved token is not printed;
  - no routine summary or error duplicates the token.
- [ ] Run RED:

```powershell
npm --prefix mcp-server test -- --runInBand tests/install.test.ts
```

Expected: exports and token persistence behavior do not exist.

- [ ] Implement the guarded module entry, atomic writer, migration, and one-time output.
- [ ] Do not claim Unix mode bits guarantee Windows ACL behavior.
- [ ] Run GREEN:

```powershell
npm --prefix mcp-server test -- --runInBand tests/install.test.ts tests/config.test.ts
node --check scripts/install.js
```

- [ ] Commit:

```powershell
git add scripts/install.js mcp-server/tests/install.test.ts
git commit -m "feat: generate broker authentication token"
```

- [ ] Specification review: verify generation timing, migration, one-time display, preservation, atomicity, and failure cleanup.
- [ ] Code-quality review: inspect dependency injection seams, filesystem cleanup, permission wording, and secret-safe output.

---

## Task 3: Authenticate all Broker WebSocket routes before state activation

**Files:**

- Modify: `mcp-server/src/types.ts`
- Modify: `mcp-server/src/protocol.ts`
- Modify: `mcp-server/src/broker/broker-server.ts`
- Modify: `mcp-server/tests/protocol.test.ts`
- Modify: `mcp-server/tests/broker-server.test.ts`
- Modify: `mcp-server/tests/broker-diagnostics.test.ts`
- Modify: `mcp-server/tests/broker-ownership.test.ts`
- Modify: `mcp-server/tests/dashboard.test.ts`
- Modify: `mcp-server/tests/multi-agent.integration.test.ts`
- Reuse: `mcp-server/tests/helpers/auth.ts`

### Behavior contract

Add:

```ts
AUTH_FAILED = 'AUTH_FAILED'
```

to `ErrorCode`, and make `token: string` required in both MCP and extension `HelloMessage` types. The protocol runtime guard checks only that `token` is a string; `verifyAuthToken` owns credential format and equality so missing, malformed, and incorrect credentials share one external result.

Change Broker handshake flow to:

```ts
private awaitHello(
  ws: WebSocket,
  expectedRole: ConnectionRole,
  accept: (hello: HelloMessage) => void
): void
```

with authentication performed before `accept`. For an authentication failure:

```ts
this.diagnostics.recordError(ErrorCode.AUTH_FAILED, 'WebSocket authentication failed');
ws.close(1008, ErrorCode.AUTH_FAILED);
```

Do not include the candidate, its length, prefix, payload, URL, or role-specific details in diagnostics.

The legacy `/` extension path must no longer call `activateExtension` immediately. It must receive and authenticate an extension hello first, then activate with `sendWelcome: false` to preserve legacy welcome semantics. Origin checks remain unchanged.

Order the checks deliberately: parse JSON, validate the hello envelope/role and
protocol version, authenticate `value.token` (including `undefined` and
non-string values), and only then apply the full `isHelloMessage` structural
guard. This preserves explicit protocol/role errors while making a missing or
malformed credential indistinguishable from a wrong credential.

### TDD steps

- [ ] Update protocol RED tests so hello requires a string token while protocol version remains 2.
- [ ] Update existing Broker test fixtures to construct `BrokerServer(testBrokerConfig())` and to send `TEST_AUTH_TOKEN` in every successful hello.
- [ ] Add a close-observer helper:

```ts
function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise(resolve => ws.once('close', (code, reason) => {
    resolve({ code, reason: reason.toString() });
  }));
}
```

- [ ] Add table-driven RED tests for Agent, `/extension`, and legacy `/` with missing, malformed, and incorrect tokens. Assert `1008/AUTH_FAILED` and zero welcome messages.
- [ ] Inject a `SessionRegistry` and assert failed Agent authentication creates no session or grace entry.
- [ ] Assert failed Extension authentication does not:
  - set `isExtensionConnected()`;
  - increment extension generation;
  - begin inventory synchronization;
  - replace a valid existing extension.
- [ ] Use a known rejected test token and assert serialized `/diagnostics`, `/dashboard`, recent errors, and captured Broker output do not contain it.
- [ ] Retain explicit RED/GREEN coverage for protocol mismatch and malicious Origin rejection.
- [ ] Run RED:

```powershell
npm --prefix mcp-server test -- --runInBand tests/protocol.test.ts tests/broker-server.test.ts tests/broker-diagnostics.test.ts tests/broker-ownership.test.ts tests/dashboard.test.ts
```

Expected: unauthenticated paths are still accepted or test fixtures fail the new contract.

- [ ] Implement the required hello field and authenticate before all state activation.
- [ ] Validate the configured expected token in `BrokerServer` construction, before `start()` opens the HTTP server.
- [ ] Run GREEN:

```powershell
npm --prefix mcp-server test -- --runInBand tests/protocol.test.ts tests/broker-server.test.ts tests/broker-diagnostics.test.ts tests/broker-ownership.test.ts tests/dashboard.test.ts
npm --prefix mcp-server run test:integration
npm run typecheck
```

- [ ] Commit:

```powershell
git add mcp-server/src/types.ts mcp-server/src/protocol.ts mcp-server/src/broker/broker-server.ts mcp-server/tests/protocol.test.ts mcp-server/tests/broker-server.test.ts mcp-server/tests/broker-diagnostics.test.ts mcp-server/tests/broker-ownership.test.ts mcp-server/tests/dashboard.test.ts mcp-server/tests/multi-agent.integration.test.ts
git commit -m "feat: authenticate broker websocket handshakes"
```

- [ ] Specification review: verify all three routes authenticate before welcome/session/generation/inventory and all failures are indistinguishable.
- [ ] Code-quality review: inspect handshake listener cleanup, close races, legacy behavior, diagnostic secrecy, and test fixture completeness.

---

## Task 4: Authenticate the Agent client and pass spawned-Broker credentials only through the environment

**Files:**

- Modify: `mcp-server/src/broker-client.ts`
- Modify: `mcp-server/src/broker-launcher.ts`
- Modify: `mcp-server/tests/broker-client.test.ts`
- Modify: `mcp-server/tests/broker-launcher.test.ts`
- Modify: `mcp-server/tests/fixtures/fake-broker.js`

### Behavior contract

The Agent hello includes `config.token`. During handshake, recognize:

```ts
const onClose = (code: number, reason: Buffer) => {
  if (code === 1008 && reason.toString() === ErrorCode.AUTH_FAILED) {
    fail(new ArcTunnelError(ErrorCode.AUTH_FAILED, 'Broker authentication failed'));
    return;
  }
  fail(new ArcTunnelError(ErrorCode.CONNECTION_LOST, 'Broker closed during handshake'));
};
```

The message and coded error must not include the token. `index.ts` already loads the full config before `ensureBroker` and `BrokerClient.connect`; preserve that order so configuration failures happen before any WebSocket opens.

The launcher must spawn with:

```ts
{
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
  env: { ...process.env, ARC_TUNNEL_TOKEN: config.token }
}
```

The default Broker arguments remain only `['--port', String(config.port)]`. The lock file remains `{ pid, port, protocolVersion }`.

Change read-only launcher methods to accept `BrokerEndpointConfig`; only `ensureBroker`/`launch` require `BrokerConfig`.

### TDD steps

- [ ] Add RED BrokerClient tests that capture the first hello and assert the exact configured token is present.
- [ ] Add a server case that closes `1008/AUTH_FAILED` and assert the client rejects once with `{ code: 'AUTH_FAILED', message: 'Broker authentication failed' }`, without restart behavior or token disclosure.
- [ ] Update every BrokerClient fixture config with `TEST_AUTH_TOKEN`.
- [ ] Inject `spawnProcess` in launcher tests and assert:
  - `ARC_TUNNEL_TOKEN` is set in child `env`;
  - neither argv nor the lock file contains the token;
  - the inherited parent environment is retained;
  - endpoint-only `status`, `stop`, and `inspect` accept configs without a token.
- [ ] Update the fake Broker fixture only as needed to record safe spawn facts; do not write the token to its count file.
- [ ] Run RED:

```powershell
npm --prefix mcp-server test -- --runInBand tests/broker-client.test.ts tests/broker-launcher.test.ts
```

- [ ] Implement Agent hello authentication, coded close mapping, launcher environment propagation, and endpoint/full config types.
- [ ] Run GREEN:

```powershell
npm --prefix mcp-server test -- --runInBand tests/broker-client.test.ts tests/broker-launcher.test.ts tests/broker-control.test.ts
npm run typecheck
```

- [ ] Commit:

```powershell
git add mcp-server/src/broker-client.ts mcp-server/src/broker-launcher.ts mcp-server/tests/broker-client.test.ts mcp-server/tests/broker-launcher.test.ts mcp-server/tests/fixtures/fake-broker.js
git commit -m "feat: authenticate agent broker connections"
```

- [ ] Specification review: verify token transport is hello plus child environment only and auth failures do not trigger Broker restart loops.
- [ ] Code-quality review: inspect WebSocket cleanup/error ordering, spawn option preservation, type boundaries, and secret-safe assertions.

---

## Task 5: Add authenticated and stable `auth_failed` behavior to the extension WebSocket client

**Files:**

- Create: `extension/src/auth-token.ts`
- Modify: `extension/src/types/index.ts`
- Modify: `extension/src/background/websocket-client.ts`
- Modify: `extension/tests/websocket-client.test.js`

### Behavior contract

Expose:

```ts
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'auth_failed';

export class WebSocketClient {
  constructor(url?: string, token?: string);
  setConfig(url: string, token: string): boolean;
  getConnectionState(): ConnectionState;
  canReconnect(): boolean;
}
```

`setConfig` normalizes the URL, compares URL and token together, and returns `true` only when the effective pair changed. One pair change increments `connectionGeneration` once, cancels the old socket/timers/alarm, clears a prior rejected-token marker only when the token changed, and permits one caller-triggered `connect()`.

The open handler sends:

```ts
const hello: HelloMessage = {
  type: 'hello',
  role: 'extension',
  protocolVersion: 2,
  token: this.token
};
```

The close handler accepts the real close event:

```ts
socket.onclose = (event) => {
  if (event.code === 1008 && event.reason === 'AUTH_FAILED') {
    this.enterAuthFailed(generation, socket);
    return;
  }
  // existing reconnect path
};
```

`enterAuthFailed` rejects the pending connect with a non-secret error, clears heartbeat/reconnect timers and the reconnect alarm, records only the rejected token internally for equality suppression, nulls the socket, and sets state to `auth_failed`. `connect`, reconnect timers, `prepareForSuspend`, and alarm-facing `canReconnect` must not create a socket while the current token equals the rejected token.

### TDD steps

- [ ] Extend `FakeWebSocket.emitClose(code = 1006, reason = '')` so tests exercise close metadata.
- [ ] Add RED tests for:
  - token present in hello;
  - no heartbeat or resolved `connect()` before a valid welcome;
  - `1008/AUTH_FAILED` enters `auth_failed`;
  - the pending connect rejects without including the token;
  - reconnect timeout, persistent retry, suspend, and alarm-facing paths create zero additional sockets with the same token;
  - changing only the URL with the same rejected token remains suppressed;
  - changing to a different valid token and calling `connect()` creates exactly one new socket/generation;
  - repeated storage-equivalent `setConfig` calls create no socket;
  - normal close, heartbeat failure, protocol mismatch, suspend, and exponential reconnect behavior remain unchanged;
  - captured `console.log/error/warn` entries never contain the test token.
- [ ] Run RED:

```powershell
node --test extension/tests/websocket-client.test.js
```

- [ ] Implement the extension token helper, required hello type, pair-wise configuration, connection state, and auth-failure suppression.
- [ ] Keep the token field private and never expose it from status methods.
- [ ] Run GREEN:

```powershell
node --test extension/tests/websocket-client.test.js
npm --prefix extension run build
npm run typecheck
```

- [ ] Commit:

```powershell
git add extension/src/auth-token.ts extension/src/types/index.ts extension/src/background/websocket-client.ts extension/tests/websocket-client.test.js
git commit -m "feat: authenticate extension websocket connections"
```

- [ ] Specification review: verify stable same-token rejection, one replacement generation, no pre-welcome heartbeat, and unchanged normal recovery.
- [ ] Code-quality review: inspect generation transitions, timer/alarm cleanup, close races, internal secret retention, and log assertions.

---

## Task 6: Store and validate URL plus token as one extension configuration

**Files:**

- Modify: `extension/src/background/service-worker.ts`
- Modify: `extension/src/popup/popup.ts`
- Modify: `extension/public/popup/popup.html`
- Modify: `extension/tests/service-worker.test.js`
- Create: `extension/tests/popup.test.js`

### Behavior contract

Use storage keys:

```ts
const STORAGE_KEYS = ['arc_tunnel_ws_url', 'authToken'] as const;
```

and one configuration object:

```ts
interface StoredConnectionConfig {
  wsUrl: string;
  authToken: string;
}
```

`loadConfig` returns both values. During initialization, the latest complete configuration pair wins if storage changes while tab synchronization is pending. A single `chrome.storage.local.set({ arc_tunnel_ws_url: url, authToken: token })` from the popup must cause one `wsClient.setConfig(url, token)` and one `connectClient()` call, even though both keys are present in the `changes` object.

The status reply becomes:

```ts
{
  connected: boolean;
  state: ConnectionState
}
```

with no token. The alarm handler calls `connectClient()` only when `wsClient.canReconnect()` is true.

The popup adds:

```html
<label for="auth-token">Authentication Token</label>
<input
  type="password"
  id="auth-token"
  autocomplete="off"
  spellcheck="false"
  placeholder="Paste the 43-character token">
```

Save rejects anything not matching `^[A-Za-z0-9_-]{43}$` before storage. Status text may say `Authentication failed` but must never echo the token.

### TDD steps

- [ ] Extend the service-worker test storage fixture to return both keys.
- [ ] Add RED service-worker tests proving:
  - startup waits for tab synchronization and applies the latest URL/token pair once;
  - one two-key storage event causes one configuration replacement/socket;
  - an `auth_failed` alarm does not retry the same token;
  - a changed valid token causes exactly one reconnect;
  - `get_status` contains `connected` and `state`, but not `authToken` or `token`.
- [ ] Add popup tests using a minimal fake DOM and fake `chrome.storage.local` for:
  - loading both stored values;
  - the token input being password-style with autocomplete disabled;
  - invalid token rejection with zero storage writes;
  - valid URL/token saved in one `set` call;
  - status UI and captured console never containing the token;
  - Enter from either input using the same save path.
- [ ] Run RED:

```powershell
node --test extension/tests/service-worker.test.js extension/tests/popup.test.js
```

- [ ] Implement paired storage/configuration, popup validation, masked input, status mapping, and alarm suppression.
- [ ] Run GREEN:

```powershell
node --test extension/tests/service-worker.test.js extension/tests/popup.test.js extension/tests/websocket-client.test.js
npm --prefix extension test
npm run typecheck
```

- [ ] Commit:

```powershell
git add extension/src/background/service-worker.ts extension/src/popup/popup.ts extension/public/popup/popup.html extension/tests/service-worker.test.js extension/tests/popup.test.js
git commit -m "feat: configure extension authentication token"
```

- [ ] Specification review: verify masking, exact validation, one atomic storage write, latest-pair initialization, alarm suppression, and secret-free status.
- [ ] Code-quality review: inspect popup test isolation, storage event coalescing, initialization races, accessibility labels, and duplicate reconnect prevention.

---

## Task 7: Upgrade production dependencies, align Node 22 metadata, and add the audit gate

**Files:**

- Modify: `package.json`
- Modify: `mcp-server/package.json`
- Modify: `mcp-server/package-lock.json`
- Modify: `mcp-server/esbuild.config.js`
- Modify: `extension/package.json`
- Modify: `extension/package-lock.json`
- Modify: `.github/workflows/verify.yml`

### Required metadata

Set:

```json
"engines": {
  "node": ">=22"
}
```

in all three package manifests. In MCP dependencies use:

```json
"@modelcontextprotocol/sdk": "^1.30.0",
"ws": "^8.21.1"
```

and align development types to:

```json
"@types/node": "^22.20.1"
```

Change the MCP esbuild target from `node18` to `node22`.

Add the root script:

```json
"audit:prod": "npm --prefix mcp-server audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org && npm --prefix extension audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org"
```

Add `npm run audit:prod` to CI after both clean installs and before `npm run verify`.

### Verification steps

- [ ] Record the pre-change production audit result for review evidence without committing generated reports:

```powershell
npm --prefix mcp-server audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
npm --prefix extension audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
```

- [ ] Update only the named dependency ranges/runtime metadata and regenerate each component lockfile with its component install command:

```powershell
npm install --prefix mcp-server
npm install --prefix extension
```

- [ ] Inspect lockfile changes and reject unrelated major upgrades.
- [ ] Verify exact resolved package versions and Node metadata:

```powershell
npm --prefix mcp-server ls ws @modelcontextprotocol/sdk @types/node
node -e "for (const p of ['package.json','mcp-server/package.json','extension/package.json']) console.log(p, require('./'+p).engines)"
```

- [ ] Run:

```powershell
npm run audit:prod
npm run verify
```

- [ ] Commit:

```powershell
git add package.json mcp-server/package.json mcp-server/package-lock.json mcp-server/esbuild.config.js extension/package.json extension/package-lock.json .github/workflows/verify.yml
git commit -m "chore: harden dependencies and runtime gates"
```

- [ ] Specification review: verify exact dependency floors, Node 22 alignment, official registry, production-only audit, and high/critical blocking.
- [ ] Code-quality review: inspect lockfile scope, CI ordering/cross-platform syntax, deterministic builds, and absence of forced/unrelated upgrades.

---

## Task 8: Close the three verifier cleanup-test hygiene gaps

**Files:**

- Modify: `scripts/verify-browser-resilience.js`
- Modify: `mcp-server/tests/verify-browser-resilience.test.ts`

### Behavior contract

Do not change the production cleanup order: destroy tracked sockets, close the server, and use `closeAllConnections` when available. Tests must explicitly prove both modern and compatibility paths.

### TDD steps

- [ ] Add or refine the successful `Promise.race` cleanup test so its timeout handle is always cleared in a `finally` block:

```ts
let timer: NodeJS.Timeout | undefined;
try {
  await Promise.race([
    cleanup,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('cleanup timed out')), 1_000);
    })
  ]);
} finally {
  if (timer) clearTimeout(timer);
}
```

- [ ] Add a focused compatibility RED test that:
  - creates a real HTTP keep-alive connection;
  - tracks the accepted socket;
  - shadows or disables `server.closeAllConnections`;
  - calls `closeHttpServer(server, trackedSockets)`;
  - proves the active socket was destroyed and cleanup settled.
- [ ] Add a focused RED test that injects a non-benign `server.close()` callback error such as `{ code: 'EIO' }`, asserts the original object is rejected by `closeHttpServer`, and then verifies the verifier's `finally` aggregation places it in `cleanupErrors`.
- [ ] Run RED:

```powershell
npm --prefix mcp-server test -- --runInBand tests/verify-browser-resilience.test.ts
```

- [ ] Make only the minimal test seam/runtime adjustment required for error injection; preserve benign `ERR_SERVER_NOT_RUNNING` handling.
- [ ] Run GREEN:

```powershell
npm --prefix mcp-server test -- --runInBand tests/verify-browser-resilience.test.ts
node --check scripts/verify-browser-resilience.js
```

- [ ] Commit:

```powershell
git add scripts/verify-browser-resilience.js mcp-server/tests/verify-browser-resilience.test.ts
git commit -m "test: harden browser verifier cleanup coverage"
```

- [ ] Specification review: verify all three named gaps are directly covered and runtime cleanup semantics did not expand.
- [ ] Code-quality review: inspect timer lifetime, real-socket cleanup, error identity/aggregation, and Windows reliability.

---

## Task 9: Update installation, security, migration, and verification documentation

**Files:**

- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `configs/claude-code.json`
- Modify: `configs/hermes.yaml`
- Modify: `configs/openclaw.json`
- Modify: `configs/kimi.md`
- Modify: `configs/codex-skill.yaml`
- Modify: `docs/superpowers/specs/2026-07-30-arc-tunnel-lightweight-auth-hardening-design.md`
- Modify: `scripts/check-docs.js`
- Modify: `scripts/verify-browser-resilience.js`
- Modify: `scripts/verify-multi-agent.js`
- Modify: `mcp-server/tests/verify-multi-agent.test.ts`

### Documentation contract

Document:

- persisted `{ "port": 8765, "token": "..." }`;
- `ARC_TUNNEL_TOKEN` → file token precedence and unchanged port precedence;
- why there is no `--token` and no token in a URL;
- installer generation/preservation and one-time display;
- extension password field and `auth_failed` recovery;
- migration steps in the approved design;
- `127.0.0.1` versus `localhost` and existing Origin restrictions;
- aggregate unauthenticated health/dashboard/diagnose endpoints;
- local capability protection versus shared cookies/profile state;
- `npm run audit:prod`;
- wrong-token/correct-token browser verification;
- D/F/C and multi-Agent verifier commands;
- Node.js `>=22`.

Update the design status from `Awaiting written-spec review` to `Approved`.

Every tracked script that opens an Agent hello or starts an MCP client must obtain the token from `ARC_TUNNEL_TOKEN` or `~/.arc-tunnel/config.json` without printing it. For spawned MCP clients, pass the already inherited environment unchanged. Change verifier-facing URLs from `localhost` to `127.0.0.1` where applicable.

Configuration templates continue to point Agent tools at the same MCP bundle and `WS_PORT`; do not embed the token in those files. Instead, explain that the client reads the user-level Arc Tunnel config.

Make the multi-Agent verifier exercise screenshot isolation, not just ownership
metadata: use `parseToolResult` so each Agent can capture a non-empty JPEG image
from its own tab, and prove a foreign-owned screenshot request returns
`TAB_NOT_OWNED`. Keep image data out of verifier logs.

### TDD and verification steps

- [ ] Add RED documentation checks for the token key, installer command, extension migration step, Node 22, audit command, security boundary, and absence of token-bearing URL/CLI examples.
- [ ] Add/update script tests so tracked smoke and multi-Agent helpers send authenticated hellos or inherit authenticated config.
- [ ] Add a focused verifier-helper test for extracting MCP image content and rejecting an empty/non-JPEG result without logging the base64 payload.
- [ ] Run RED:

```powershell
npm run check:docs
npm --prefix mcp-server test -- --runInBand tests/verify-multi-agent.test.ts
```

- [ ] Update the named docs, examples, and tracked verification scripts.
- [ ] Search for stale unauthenticated hello examples and unsafe token placement:

```powershell
git grep -n -E "type.?[=:].?['\\\"]hello|protocolVersion" -- README.md AGENTS.md docs configs scripts mcp-server extension
git grep -n -E -e "--token|token=.*ws://|ws://[^ ]*token" -- README.md AGENTS.md docs configs scripts mcp-server extension
```

The first search must show a token field or authenticated-config path for every executable hello. The second must have no credential-bearing CLI/URL example.

- [ ] Run GREEN:

```powershell
npm run check:docs
npm --prefix mcp-server test -- --runInBand tests/verify-multi-agent.test.ts tests/protocol.test.ts
node --check scripts/verify-browser-resilience.js
node --check scripts/verify-multi-agent.js
```

- [ ] Commit:

```powershell
git add README.md AGENTS.md configs/claude-code.json configs/hermes.yaml configs/openclaw.json configs/kimi.md configs/codex-skill.yaml docs/superpowers/specs/2026-07-30-arc-tunnel-lightweight-auth-hardening-design.md scripts/check-docs.js scripts/verify-browser-resilience.js scripts/verify-multi-agent.js mcp-server/tests/verify-multi-agent.test.ts
git commit -m "docs: explain lightweight broker authentication"
```

- [ ] Specification review: compare every migration/security/runtime statement with the approved design and ensure no scope expansion.
- [ ] Code-quality review: inspect examples for copy-paste correctness, script secrecy, terminology consistency, and stale localhost/unauthenticated guidance.

---

## Task 10: Rebuild committed artifacts and run the complete automated release gate

**Files:**

- Modify generated artifacts only:
  - `mcp-server/dist/mcp-server.js`
  - `mcp-server/dist/mcp-server.js.map`
  - `mcp-server/dist/arc-tunnel-broker.js`
  - `mcp-server/dist/arc-tunnel-broker.js.map`
  - `mcp-server/dist/arc-tunnel-control.js`
  - `mcp-server/dist/arc-tunnel-control.js.map`
  - `extension/dist/background/service-worker.js`
  - `extension/dist/content/console-hook.js`
  - `extension/dist/content/content-script.js`
  - `extension/dist/popup/popup.js`
  - `extension/dist/popup/popup.html`
  - any other tracked files produced by the existing build

### Verification steps

- [ ] Confirm the worktree contains only expected tracked changes plus the preserved user-owned untracked files:

```powershell
git status --short
git diff --check
```

- [ ] Perform clean component installs:

```powershell
npm ci --prefix mcp-server
npm ci --prefix extension
```

- [ ] Run the complete automated suite and audit:

```powershell
npm run verify
npm run audit:prod
```

- [ ] Search generated bundles and tracked source for the known test tokens and credential leaks:

```powershell
rg -n "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA|BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" mcp-server/dist extension/dist README.md AGENTS.md configs scripts
```

Expected: no matches outside test sources.

- [ ] Prove deterministic committed artifacts:

```powershell
git diff -- mcp-server/dist extension/dist > $env:TEMP\arc-tunnel-dist-first.diff
npm run build
git diff -- mcp-server/dist extension/dist > $env:TEMP\arc-tunnel-dist-second.diff
Compare-Object (Get-Content $env:TEMP\arc-tunnel-dist-first.diff) (Get-Content $env:TEMP\arc-tunnel-dist-second.diff)
```

Expected: `Compare-Object` prints nothing.

- [ ] Stage only tracked build artifacts; never use `git add .`:

```powershell
git add mcp-server/dist extension/dist
git commit -m "build: publish authenticated broker bundles"
```

- [ ] Run the final independent specification review against all acceptance criteria.
- [ ] Run the final independent code-quality review over the entire branch diff from `origin/master`.
- [ ] Resolve all P0/P1 findings and any in-scope P2/P3 findings, rerun affected focused tests plus `npm run verify` and `npm run audit:prod`, commit fixes, and repeat both reviews until approved.

---

## Task 11: Run real Edge verification, CI, integration, and Issue #17 closure

**Files:** No source changes unless verification exposes a defect. Any defect returns to RED → GREEN TDD and both reviews before continuing.

### Local lifecycle preparation

- [ ] Ensure the user config has a valid token by running the installer:

```powershell
node scripts/install.js
```

- [ ] Record the selected port without printing the token:

```powershell
node scripts/start.js status
```

- [ ] If a Broker is started for this verification, record its PID and stop only that known Broker during cleanup.
- [ ] Reload the current `extension/dist/` unpacked extension in Edge.

### Real authentication verification

- [ ] Save a deliberately wrong but valid-format token in the extension popup.
- [ ] Confirm the popup reaches `Authentication failed`, remains stable for at least two reconnect-alarm intervals, and the Service Worker does not create repeated WebSocket generations.
- [ ] Confirm `node scripts/start.js diagnose --json` exposes only aggregate disconnected state and does not contain the wrong token.
- [ ] Restore the exact token from the user's `~/.arc-tunnel/config.json`, Save once, and confirm exactly one reconnect generation reaches `Connected`.
- [ ] Confirm a newly launched lightweight MCP client authenticates without manual per-client token entry.

### Real browser regression verification

- [ ] Run D/F/C verification:

```powershell
node scripts/verify-browser-resilience.js --port 8765
```

Use the actual selected port if it is not 8765. Require:

- historical console marker present;
- JPEG/resize screenshot returned as MCP image content;
- frozen `execute_script` and `get_content` fail fast in the documented 5–8 second window;
- screenshot still succeeds after the frozen-page failures;
- the verifier closes only its owned tab and local HTTP resources.

- [ ] Run multi-Agent ownership and screenshot isolation:

```powershell
node scripts/verify-multi-agent.js --port 8765
```

Use a manually opened safe tab when prompted. Require distinct windows/tabs, no foreign-owned visibility, `TAB_NOT_OWNED` isolation, release/reclaim behavior, disconnect release, and successful screenshots confined to each Agent's own tab.

- [ ] Run a representative tool smoke pass on fresh, responsive tabs and confirm no regression in all supported tools.
- [ ] Stop only the known verification-started Broker; leave pre-existing Brokers and browser tabs untouched.

### Push, CI, and merge

- [ ] Re-run immediately before push:

```powershell
npm run verify
npm run audit:prod
git diff --check
git status --short
```

- [ ] Push the feature branch:

```powershell
git push -u origin codex/arc-tunnel-lightweight-auth-hardening
```

- [ ] Wait for both Ubuntu and Windows feature-branch CI jobs. If either fails, diagnose systematically, add a reproducing test when applicable, fix, re-review, and repeat.
- [ ] Merge by reviewed pull request or fast-forward only after all branch checks and reviews are green. Do not overwrite unrelated `master` work.
- [ ] Pull/fetch the resulting `master` and wait for both Ubuntu and Windows `master` CI jobs.
- [ ] Verify the merged commit's committed dist matches a fresh Node 22 build.

### Issue #17

- [ ] Post a concise Issue #17 verification comment containing:
  - the merged commit;
  - automated test totals;
  - production audit result;
  - real wrong-token/correct-token recovery result;
  - D/F/C verifier result;
  - multi-Agent ownership/screenshot isolation result;
  - Ubuntu and Windows `master` CI links.
- [ ] Close Issue #17 only after that comment is posted and both `master` jobs are green.
- [ ] Final handoff must state the merged commit, CI links, audit result, browser evidence, issue status, and any explicitly deferred follow-up work.

## Completion Checklist

- [ ] Unauthenticated Agent, `/extension`, and legacy `/` sockets never receive `welcome`.
- [ ] Missing, malformed, and incorrect credentials close `1008/AUTH_FAILED` before state mutation.
- [ ] Correct Agent and Extension credentials recover cleanly without repeated entry.
- [ ] Same-token `auth_failed` state creates no reconnect loop.
- [ ] Tokens are absent from every supported operational surface and generated bundle.
- [ ] `status`, `stop`, and `diagnose` remain available without token configuration; `start` and Agent startup require it.
- [ ] Production dependencies and Node 22 metadata match the approved versions.
- [ ] Production high/critical audit findings are zero.
- [ ] All focused tests, full verification, integration, deterministic build, and independent reviews pass.
- [ ] Real Edge authentication, D/F/C, tool smoke, and multi-Agent isolation pass.
- [ ] Feature and `master` CI pass on Ubuntu and Windows.
- [ ] Issue #17 is updated and closed with current evidence.
