# Arc Tunnel — Agent Guide

## Architecture

```text
Agent host --stdio--> lightweight MCP client --WebSocket /agent--> Broker
Browser extension ---------------------------WebSocket /extension--> Broker
```

Each Agent window launches `mcp-server/dist/mcp-server.js`. This lightweight client
connects to, or starts, one shared Broker. The browser extension also connects to that
Broker. Use one window per Agent so each task has an independent MCP session.

## Build and test

```bash
npm ci --prefix mcp-server
npm ci --prefix extension
npm run verify
npm run audit:prod
```

Arc Tunnel requires Node.js `>=22`. The production audit command checks both component
lockfiles and fails on high or critical production findings.

Use child `test`, typecheck, and `build` commands inside `mcp-server/` or
`extension/` only for component-specific debugging.

The committed bundles include `mcp-server/dist/mcp-server.js`,
`mcp-server/dist/arc-tunnel-broker.js`, the lifecycle artifact
`mcp-server/dist/arc-tunnel-control.js`, and `extension/dist/`.

## Install and configure

Run `node scripts/install.js` or use the files in `configs/`. Do not change the client
entry path: every Agent invokes `mcp-server/dist/mcp-server.js` with `WS_PORT`.

Port precedence is CLI `--port` → `WS_PORT` → `~/.arc-tunnel/config.json` → `8765`.
The persisted file uses `{ "port": 8765, "token": "..." }`. Authentication has
separate precedence: `ARC_TUNNEL_TOKEN` takes precedence over the file token, while the
port precedence remains unchanged. Every client and the extension popup must select the
same custom port.

Run `node scripts/install.js` to generate a missing token or migrate a legacy port-only
file. The installer preserves a valid existing token and prints a newly generated token
once. That generated file token is the popup token only when `ARC_TUNNEL_TOKEN` is not
set. Agent templates must not contain the token: the lightweight client reads the
user-level config. Authentication has no credential command-line flag and never puts a
token in a WebSocket URL, avoiding exposure through process listings, shell history,
and URL logging.

## Broker lifecycle

```bash
node scripts/start.js status
node scripts/start.js start [--port N]
node scripts/start.js status [--port N]
node scripts/start.js stop [--port N]
node scripts/start.js diagnose [--port N]
node scripts/start.js diagnose [--port N] --json
```

While running, status prints the Broker PID and port. Always stop Brokers started by a
test or manual validation.

The read-only Operations Control Center is served at
`http://127.0.0.1:<port>/dashboard`. It and the `diagnose` output expose only aggregate
operational state and exclude URLs, IDs, cookies, scripts, parameters, and page content.
The aggregate loopback `/health`, `/dashboard`, and `diagnose` interfaces remain
unauthenticated; browser-control WebSocket capabilities require the token.

## Multi-Agent rules

- Call `claim_tab` before using an existing tab and `release_tab` after the task.
- Only one Agent can own a tab; same-tab operations by another Agent are excluded.
- Agents may work concurrently on different tabs.
- Disconnecting an Agent releases its claims.
- All tabs use the same browser profile, so cookies and profile state are shared.
- One window per Agent provides session identity, not cookie or security isolation.
- Token authentication protects the local Broker capability boundary; it does not turn
  tab ownership into cookie, account, or browser-profile isolation.

## Project structure

| Component | Path | Build command |
|---|---|---|
| MCP client, Broker, control | `mcp-server/` | `npm run build` |
| Browser extension | `extension/` | `npm run build` |
| Agent templates | `configs/` | Static files |
| Installer and lifecycle CLI | `scripts/` | Static files |

## Extension setup

Load `extension/dist/` unpacked in Chrome/Edge Developer mode. The popup defaults to
`ws://127.0.0.1:8765`; change it whenever the Broker uses a custom port. Using the
explicit IPv4 loopback avoids `localhost` resolving to an unrelated IPv6 listener.
When `ARC_TUNNEL_TOKEN` is set, the extension must use that same effective token,
obtained from the controlled source that set the environment; the persisted file token
does not override it. Alternatively, unset the environment override, restart the Broker
and every Agent client, then use the token from `~/.arc-tunnel/config.json`. Paste the
effective token into the popup password field and Save. If the popup shows
`Authentication failed` (`auth_failed`), save the correct effective token and confirm
the state returns to `Connected`; the extension does not retry the same rejected
credential. Never use a command that prints the token.

Root extension URLs are normalized to `/extension`. The legacy `/` path is accepted only
with a `chrome-extension://` Origin. The Broker rejects ordinary `http://` and `https://`
WebSocket Origins, binds only `127.0.0.1`, and has no LAN exposure.

## Browser control and debugger lifecycle

Supported tools include `snapshot`, `interact`, `navigate`, `get_console_logs`,
`manage_storage`, `screenshot`, `execute_script`, `get_content`, `wait_for_element`,
`create_tab`, `close_tab`, `list_tabs`, `claim_tab`, `release_tab`, `start_recording`,
`stop_recording`, `replay_recording`, `save_session`, and `restore_session`.

Lightweight commands avoid `chrome.debugger`. Debugger-only commands attach as needed,
and lightweight-first commands may fall back to the debugger. The implemented idle
debugger detach grace is 15 seconds after the last operation/hold; recording can retain
the debugger until stopped. The shared browser profile means cookies and extension
permissions (tabs, scripting, debugger, storage, cookies) apply across Agent sessions.

## Operational checks

Verify connection in the extension popup and with `node scripts/start.js status`. If
disconnected, ensure all client `WS_PORT` values and the popup port match, reload the
current `extension/dist/`, and rebuild all bundles together on protocol mismatch. Never
stop an unknown process occupying a selected port.

For migration, pull and build the source, run `node scripts/install.js`, determine the
effective source (`ARC_TUNNEL_TOKEN` when set, otherwise the persisted token), reload
`extension/dist/`, paste and Save the same effective token, then confirm `Connected`
and run `node scripts/start.js diagnose --json`. An installer-displayed token is the
effective token only when there is no environment override.

Real-browser authentication recovery must prove that a valid-format but incorrect popup
token reaches `Authentication failed` (`auth_failed`) without a reconnect loop, then
that saving the correct effective token reaches `Connected`. If the environment
override remains set, recovery must use that environment token; the persisted token
becomes effective only after unsetting the override and restarting the Broker and every
Agent client. The tracked MCP-client verifiers inherit environment and file
authentication without printing credentials.

For the repeatable frozen-page D/F/C check, run:

```bash
node scripts/verify-browser-resilience.js [--port 8765]
```

The verifier uses one loopback HTTP server, one lightweight MCP client, and one owned
tab. Its `finally` cleanup closes only that tab, client, and HTTP server, including after
failure. It never stops the shared Broker or closes pre-existing browser tabs.

For multi-Agent ownership and JPEG screenshot isolation, run:

```bash
node scripts/verify-multi-agent.js [--port 8765] [--manual-tab N]
```

Each Agent must receive non-empty JPEG image content from its owned tab, while a foreign
screenshot returns `TAB_NOT_OWNED`. Verifier logs must never include image base64.
