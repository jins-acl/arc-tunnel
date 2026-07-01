# Arc Tunnel

Arc Tunnel lets multiple AI Agents automate tabs in one real Chrome or Edge profile.
Each Agent window owns a lightweight MCP client; all clients and the browser extension
meet at one shared Broker.

## Architecture

```text
Agent host --stdio--> lightweight MCP client --WebSocket /agent--> Broker
Browser extension ---------------------------WebSocket /extension--> Broker
```

The client command remains `node mcp-server/dist/mcp-server.js`. The first client can
start the Broker; later clients discover and connect to it. The extension uses the
`/extension` endpoint and Agent clients use `/agent`.

## Install

Pre-built `mcp-server/dist/` and `extension/dist/` artifacts are committed, so using a
release does not require npm. Load `extension/dist/` as an unpacked extension, then
configure an Agent with a template from `configs/` or run:

```bash
node scripts/install.js
```

The installer detects supported tools and updates their configuration. Review backups
it creates beside changed files. Templates support Claude Code, Hermes, OpenClaw, Kimi,
and Codex.

## Broker lifecycle and ports

```bash
node scripts/start.js status
node scripts/start.js start
node scripts/start.js start --port 9000
node scripts/start.js status --port 9000
node scripts/start.js stop --port 9000
```

The default is port `8765`. Configuration precedence is CLI `--port` → `WS_PORT` → `~/.arc-tunnel/config.json` → `8765`.
A persisted configuration has this shape:

```json
{ "port": 9000 }
```

All Agent client configurations must use the Broker's port. When using a custom port,
set the extension popup to the same port as well. `status` reports the PID and port of a
running Broker. `stop` removes its lifecycle state.

## Multi-Agent tab ownership

Call `claim_tab` before automating an existing tab and `release_tab` when finished.
Closing a client releases its claims. A tab can be claimed by only one Agent at a time,
so two Agents cannot race on the same tab. Different Agents may operate different tabs
concurrently.

Use one Agent window per task/Agent identity. Agent windows have independent MCP
sessions and tab claims, but browser tabs remain in the same Chrome/Edge profile.
Cookies and other profile-level browser state are therefore shared; tab ownership is
coordination, not security isolation.

## Extension setup

1. Open `chrome://extensions/` or `edge://extensions/`.
2. Enable Developer mode and choose **Load unpacked**.
3. Select `extension/dist/`.
4. In the popup, verify the shared Broker port and connection state.

The extension converts a saved root URL such as `ws://localhost:8765/` to the current
`/extension` endpoint. During migration, the Broker still accepts the legacy `/` path
only when the WebSocket Origin starts with `chrome-extension://`; new configurations
should use `/extension`.

## Tools and features

| Area | Tools |
|---|---|
| Snapshot and interaction | `snapshot`, `interact` |
| Navigation and tabs | `navigate`, `create_tab`, `close_tab`, `list_tabs` |
| Ownership | `claim_tab`, `release_tab` |
| Content and diagnostics | `screenshot`, `get_content`, `get_console_logs`, `wait_for_element` |
| Page and profile state | `execute_script`, `manage_storage` |
| Recording | `start_recording`, `stop_recording`, `replay_recording` |
| Sessions | `save_session`, `restore_session` |

`snapshot` returns ref-based interactive elements for `interact`. `navigate` supports
goto, back, forward, and reload. Content can be returned as HTML, text, structured data,
or Markdown. Recording captures user actions for later replay; saved sessions restore
tabs within the owning Agent's browser window.

### Lightweight and debugger paths

Lightweight commands use browser APIs such as `chrome.tabs` and `chrome.scripting` and
avoid attaching the debugger. Debugger-only commands attach `chrome.debugger` when
needed; lightweight-first commands can fall back to it when necessary. After the last
debugger operation or hold is released, the implemented idle grace is 15 seconds before
detach. Recording may hold the debugger until recording stops.

## Connection verification and troubleshooting

After restarting the Agent, open the extension popup and confirm it is connected. If it
is not, check `node scripts/start.js status [--port N]`, confirm every `WS_PORT` and the
popup port match, and verify the extension is loaded from the current `extension/dist/`.
Use `status` before `start`; a foreign process on the selected port is reported rather
than stopped. Protocol mismatch or repeated reconnect messages usually mean the client,
Broker, and extension bundles were built from different revisions; rebuild and reload
all committed artifacts together.

## Development

```bash
cd mcp-server
npm install
npm test -- --runInBand
npx tsc -p tsconfig.test.json --noEmit
npm run build

cd ../extension
npm install
npm test
npx tsc --noEmit
npm run build
```

Both builds regenerate committed distribution artifacts. The MCP build creates the
lightweight client, shared Broker, and lifecycle control bundles.

## Security

The Broker binds only `127.0.0.1`, is not exposed on the LAN, and rejects WebSocket
upgrades with ordinary `http://` or `https://` Origins. The legacy `/` extension route
additionally requires a `chrome-extension://` Origin. The extension has tabs, scripting,
debugger, storage, and cookies permissions. It can access tabs, cookies, storage, and
page scripts, so connect only trusted local Agent clients. `execute_script` has full page
access. Agents share one browser profile and its cookies; tab claims coordinate work but
are not a security boundary.

## License

MIT
