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
```

Use child `test`, typecheck, and `build` commands inside `mcp-server/` or
`extension/` only for component-specific debugging.

The committed bundles include `mcp-server/dist/mcp-server.js`,
`mcp-server/dist/arc-tunnel-broker.js`, the lifecycle artifact
`mcp-server/dist/arc-tunnel-control.js`, and `extension/dist/`.

## Install and configure

Run `node scripts/install.js` or use the files in `configs/`. Do not change the client
entry path: every Agent invokes `mcp-server/dist/mcp-server.js` with `WS_PORT`.

Port precedence is CLI `--port` → `WS_PORT` → `~/.arc-tunnel/config.json` → `8765`.
The persisted file uses `{ "port": 9000 }`. Every client and the extension popup must
select the same custom port.

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

## Multi-Agent rules

- Call `claim_tab` before using an existing tab and `release_tab` after the task.
- Only one Agent can own a tab; same-tab operations by another Agent are excluded.
- Agents may work concurrently on different tabs.
- Disconnecting an Agent releases its claims.
- All tabs use the same browser profile, so cookies and profile state are shared.
- One window per Agent provides session identity, not cookie or security isolation.

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
