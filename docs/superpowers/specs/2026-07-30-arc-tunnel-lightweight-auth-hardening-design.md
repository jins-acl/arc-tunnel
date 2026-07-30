# Arc Tunnel Lightweight Authentication Hardening Design

**Date:** 2026-07-30  
**Status:** Approved
**Target branch:** `codex/arc-tunnel-lightweight-auth-hardening`

## 1. Goal

Harden Arc Tunnel's local Broker boundary without turning the project into an
account, pairing, or credential-management system.

This change adds one mandatory, installation-generated static token to the
existing loopback WebSocket handshake, upgrades vulnerable production
dependencies, adds a high-severity dependency gate, aligns the documented Node
runtime, closes three test-hygiene gaps, and updates the installation and
security documentation.

## 2. Scope

### 2.1 Included

1. A mandatory 32-byte random token shared by:
   - the Broker;
   - every lightweight MCP Agent client;
   - the browser extension.
2. Token persistence in `~/.arc-tunnel/config.json`.
3. Token entry and persistence in the extension popup.
4. Authentication of `/agent`, `/extension`, and the legacy root extension
   WebSocket route before the Broker sends `welcome`.
5. Explicit `AUTH_FAILED` behavior with no secret disclosure.
6. Dependency upgrades:
   - `ws` to `^8.21.1`;
   - `@modelcontextprotocol/sdk` to `^1.30.0`.
7. A production-dependency audit gate using the official npm registry and
   blocking `high` and `critical` findings.
8. Node.js runtime declaration of `>=22` and Node type definitions aligned to
   the Node 22 runtime floor.
9. The three verifier test-hygiene improvements identified in the prior final
   review.
10. README, Agent guide, installer, configuration examples, and migration
    documentation updates.
11. A verification comment followed by closure of GitHub Issue #17 after the
    reviewed commit is merged and the `master` CI is green.

### 2.2 Excluded

The following remain separate follow-up projects:

- account-based authentication;
- token refresh, expiry, rotation, QR codes, or one-time pairing codes;
- TLS or LAN exposure;
- automated real-Edge execution on hosted CI runners;
- recording/replay selector-fallback improvements;
- broad decomposition of `broker-server.ts` or `command-handler.ts`;
- separate browser profiles per Agent.

## 3. Global Constraints

- The Broker continues to bind only `127.0.0.1`.
- The extension accepts only the `ws:` scheme with the literal host
  `127.0.0.1`, an explicit port from 1 through 65535, and path `/` or
  `/extension`. The three exact former defaults—`ws://localhost:8765`,
  `ws://localhost:8765/`, and `ws://localhost:8765/extension`—are accepted only
  as migration inputs to their `127.0.0.1` equivalents. Every other scheme,
  host spelling, port, path, userinfo, query, or fragment is rejected before a
  socket is created. The extension never sends the authentication token to an
  off-loopback destination.
- Ordinary `http://` and `https://` WebSocket Origins remain rejected.
- The legacy root extension route continues to require a
  `chrome-extension://` Origin.
- Protocol version remains `2`; authentication is a deployment prerequisite,
  not a change to command or response semantics.
- The port precedence remains CLI `--port` → `WS_PORT` → persisted config →
  `8765`.
- Token precedence is `ARC_TUNNEL_TOKEN` → persisted config. There is no
  `--token` CLI flag and no token in a WebSocket URL.
- A valid token is exactly 32 random bytes encoded without padding as 43
  base64url characters matching `^[A-Za-z0-9_-]{43}$`.
- Missing or invalid authentication never falls back to unauthenticated mode.
- Except for the generated file token's explicit one-time installer display,
  tokens never appear in logs, diagnostics, dashboard content, event streams,
  URLs, process arguments, error messages, or copied operational reports.
- Existing tab ownership, one-window-per-Agent behavior, heartbeat timing,
  debugger timeouts, and command deadlines remain unchanged.
- Committed MCP and extension bundles must be rebuilt and deterministic.
- Existing user-owned untracked smoke and probe scripts must not be staged,
  modified, or deleted.

The static token rejects local clients that do not possess it; it does not
claim to sandbox a compromised user account. Hostile same-OS-user processes
that can read the user config or impersonate the selected local port are
outside this static-token boundary.

## 4. Configuration and Token Lifecycle

### 4.1 Persisted format

The persisted configuration becomes:

```json
{
  "port": 8765,
  "token": "43-character-base64url-token"
}
```

The existing custom port remains intact during migration.

### 4.2 Generation

`scripts/install.js` generates the token with:

```js
crypto.randomBytes(32).toString('base64url')
```

Generation occurs only when the persisted configuration has no valid token.
An existing valid token is preserved exactly.

### 4.3 Atomic persistence

Configuration writes use a temporary file in the same directory followed by an
atomic rename. The temporary and final files request mode `0o600`. On Windows,
the file remains inside the current user's profile and inherits that profile's
ACL; the implementation must not claim Unix mode bits provide a Windows ACL
guarantee.

If migration fails, the previous valid configuration remains readable. A
temporary file is cleaned up on the handled failure path.

### 4.4 Startup behavior

The Broker and Agent client select the token from:

1. `ARC_TUNNEL_TOKEN`, whenever it is present;
2. `~/.arc-tunnel/config.json`, only when the environment override is absent.

The selected token must be valid. An empty or malformed environment override
does not fall back to the persisted token. If the selected source does not
provide a valid token, startup fails before opening the Broker or Agent
WebSocket and prints a non-secret instruction to run:

```bash
node scripts/install.js
```

The environment variable exists for CI, isolated test fixtures, and advanced
launchers. It is never written back to disk.

### 4.5 Installation output

When installation generates a new token without an environment override, the
installer prints it once with a clear instruction to paste it into the
extension popup. With a valid `ARC_TUNNEL_TOKEN` override, the generated file
token is printed once but labeled as a fallback, not the active popup
credential. The effective environment token must come from its controlled
source; the installer never prints the environment override value. To make the
file fallback effective, the user must unset the environment override and
restart the Broker and all Agent clients before using it.

An empty or malformed environment override blocks startup without falling
back. The installer warns the user to remove or replace the override before
startup without echoing its value or presenting the generated file token as
the active popup credential. Routine reruns that preserve an existing token do
not print that token.

Without an environment override, users who need to recover the token read
their own `~/.arc-tunnel/config.json`. With a valid override, they obtain the
effective token from its controlled source. No `--show-token` command is added.

## 5. Protocol Authentication

### 5.1 Hello messages

Both roles add the required `token` field:

```json
{
  "type": "hello",
  "role": "agent",
  "protocolVersion": 2,
  "clientName": "codex",
  "token": "43-character-base64url-token"
}
```

```json
{
  "type": "hello",
  "role": "extension",
  "protocolVersion": 2,
  "token": "43-character-base64url-token"
}
```

Runtime guards require `token` to be a string, but authentication code owns
format validation and comparison so every malformed or incorrect credential
has the same external result.

### 5.2 Comparison

The Broker decodes a valid-length base64url candidate into 32 bytes. Invalid
input uses a fixed 32-byte dummy buffer. It then calls
`crypto.timingSafeEqual(candidateBytes, expectedBytes)` and succeeds only when
the candidate format was valid and the fixed-length comparison matches.

The expected token is validated once during Broker construction. A Broker
cannot start with an invalid expected token.

### 5.3 Failure

For a missing, malformed, or incorrect token:

- no `welcome` is sent;
- no Agent session or Extension generation is registered;
- no tab inventory synchronization starts;
- the WebSocket closes with policy code `1008` and reason `AUTH_FAILED`;
- diagnostics may record the aggregate code `AUTH_FAILED`, but never the token,
  its prefix, its length, or the rejected hello payload.

Protocol-version and structural errors retain their current explicit behavior.

### 5.4 Protocol version decision

Protocol version stays at `2` because command names, payloads, ownership, and
response semantics do not change. Old v2 clients are intentionally rejected by
the new deployment prerequisite and receive `AUTH_FAILED`; all committed
clients and bundles are upgraded together.

## 6. Extension Behavior

### 6.1 Popup

The popup adds a password-style Token field:

- storage key: `authToken`;
- autocomplete disabled;
- value remains masked by default;
- Save validates the exact 43-character base64url format;
- invalid values remain local to the popup and are not sent;
- successful Save updates WebSocket URL and token as one configuration change.

The popup must not place the token in DOM status text, console output, copied
diagnostics, or query strings.

### 6.2 WebSocket client

`WebSocketClient` receives both URL and token. A valid v2 `welcome` is still the
only event that completes connection setup and starts the 10-second heartbeat.

When the socket closes with `AUTH_FAILED`:

- connection state becomes `auth_failed`;
- heartbeat and reconnect timers are cleared;
- fast retry, persistent retry, and alarm-triggered reconnect do not create a
  new socket with the same rejected token;
- saving a different valid token invalidates the old generation and starts
  exactly one new connection attempt.

Other disconnects retain the current retry and suspend behavior.

### 6.3 Service worker and alarm

The Service Worker passes the stored token into the WebSocket client before
connecting. On `AUTH_FAILED`, it stores a rejection marker keyed to the current
token in `chrome.storage.session`. A new worker loads that marker before any
connection attempt: a marker matching the stored token restores `auth_failed`
and creates no socket, while a different valid token clears the stale marker
and permits exactly one connection. Marker writes and removals are ordered so a
rapid token change cannot erase a reselected rejection. Alarm handlers respect
the restored state and do not reconnect the same rejected credential.

## 7. Agent, Launcher, and Broker Lifecycle

- The lightweight MCP client loads the token before connecting to `/agent`.
- An Agent authentication failure is surfaced as a coded `AUTH_FAILED` startup
  error and does not trigger Broker-restart loops.
- A client that starts the shared Broker passes the already-resolved token
  through an inherited environment variable, never through command arguments.
- Lifecycle `status` and `diagnose` keep using the aggregate loopback HTTP
  endpoints. These endpoints remain unauthenticated because their documented
  payload excludes URLs, IDs, cookies, scripts, parameters, page content, and
  tokens.
- `start` and automatic launch require valid token configuration.
- `stop` retains its existing PID/port ownership safeguards.

## 8. Dependency and Runtime Hardening

### 8.1 Production dependencies

Update package ranges and lockfile resolution:

```json
{
  "@modelcontextprotocol/sdk": "^1.30.0",
  "ws": "^8.21.1"
}
```

No `npm audit fix --force` or unrelated major dependency upgrade is allowed.
Jest 29, TypeScript 6, and other unrelated major versions remain unchanged.

### 8.2 Node runtime

The root, MCP, and extension package metadata declare:

```json
{
  "engines": {
    "node": ">=22"
  }
}
```

MCP development types use the current Node 22 type line. CI continues to test
Node 22 on Windows and Ubuntu.

### 8.3 Audit gate

The root package adds `audit:prod`, running both component audits against:

```text
https://registry.npmjs.org
```

The CI gate uses `--omit=dev --audit-level=high`. High or critical production
findings fail the job. Low and moderate findings remain visible but do not
block a release.

## 9. Verifier Test-Hygiene Closure

The previous final review identified three non-production gaps:

1. The successful side of the `Promise.race` cleanup test clears its one-second
   timeout.
2. A focused test disables `server.closeAllConnections()` and passes tracked
   sockets, proving the compatibility fallback destroys a real active
   connection.
3. A focused test injects a non-benign `server.close()` error and proves the
   original error is rejected and reaches `cleanupErrors`.

These changes do not alter the verified runtime cleanup algorithm.

## 10. Documentation and Migration

Update:

- `README.md`;
- `AGENTS.md`;
- installer output and config examples;
- extension setup instructions;
- troubleshooting;
- security and threat-model text;
- real-browser verification steps.

Migration instructions are:

1. pull/build the new source;
2. run `node scripts/install.js`;
3. determine the effective token source: `ARC_TUNNEL_TOKEN` when present,
   otherwise the persisted token;
4. obtain an effective environment token from its controlled source, or unset
   the override and restart the Broker and all Agent clients before using the
   persisted fallback;
5. if an empty or malformed override is present, remove or replace it before
   startup rather than expecting fallback;
6. load or reload `extension/dist/`;
7. paste and Save the effective token;
8. verify `Connected` and `node scripts/start.js diagnose --json`.

The documentation explicitly states that token authentication protects the
local Broker capability boundary but does not isolate cookies or browser
profiles between Agents.

## 11. Testing Strategy

All production behavior changes follow RED → GREEN TDD.

### 11.1 Configuration

Tests cover:

- exact 32-byte base64url generation;
- existing-token preservation;
- legacy `{ "port": N }` migration;
- missing, malformed, and wrong-length tokens;
- `ARC_TUNNEL_TOKEN` precedence without persistence;
- atomic-write success and handled-failure cleanup;
- no token in thrown messages.

### 11.2 Protocol and Broker

Tests cover both Agent and Extension roles:

- correct token receives `welcome`;
- missing, malformed, and incorrect token receives `AUTH_FAILED`;
- failed authentication creates no session, generation, pending recovery, or
  inventory synchronization;
- protocol and Origin checks remain enforced;
- logs, diagnostics, dashboard, and events do not contain a known test token;
- constant-time comparison helper accepts only the exact credential.

### 11.3 Extension

Tests cover:

- popup storage and validation;
- token included in hello but excluded from logs and status UI;
- no heartbeat before authenticated welcome;
- `auth_failed` clears timers and suppresses every same-token retry path;
- new valid token creates one replacement generation;
- normal close, suspend, alarm, and heartbeat recovery remain unchanged.

### 11.4 Integration and release

Release gates:

1. focused RED/GREEN suites for every task;
2. `npm run verify`;
3. deterministic committed-dist rebuild comparison;
4. `npm run audit:prod`;
5. clean-install verification for both component lockfiles;
6. real Edge wrong-token rejection followed by correct-token recovery;
7. real D/F/C resilience verification;
8. real multi-Agent ownership and screenshot isolation smoke test;
9. independent task and final code review;
10. feature-branch Ubuntu and Windows CI;
11. fast-forward or reviewed PR merge to `master`;
12. `master` Ubuntu and Windows CI;
13. a results comment and closure of Issue #17.

## 12. Acceptance Criteria

The work is complete only when:

- no unauthenticated Agent or Extension WebSocket reaches `welcome`;
- a valid configured Agent and extension connect without repeated token entry;
- wrong-token state is stable and does not reconnect-loop;
- no supported diagnostics surface contains the token;
- high/critical production audit count is zero;
- all existing tools, ownership, heartbeat, timeout, screenshot, and console
  behavior pass without regression;
- committed bundles match source;
- real Edge authentication recovery and D/F/C verification pass;
- feature and `master` CI pass on Ubuntu and Windows;
- Issue #17 is closed with current verification evidence.
