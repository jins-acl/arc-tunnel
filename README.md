# Arc Tunnel

Arc Tunnel lets multiple AI Agents automate tabs in one real Chrome or Edge profile.
Each Agent window owns a lightweight MCP client; all clients and the browser extension
meet at one shared Broker.

## What the multi-Agent Broker improves

The Broker redesign changes Arc Tunnel from one browser server per Agent process into
one shared browser-control service with an independent session for every Agent.

| Workflow area | Before | Now | Practical benefit |
|---|---|---|---|
| Process model | Every MCP process tried to host the extension WebSocket server | Lightweight MCP clients connect to one long-lived Broker | Starting another Agent no longer creates a port-binding race |
| Browser connection | The extension could effectively serve one MCP process | One extension connection is routed through the Broker to many Agent sessions | Codex, Claude, Kimi, Hermes, and OpenClaw can share the same real browser profile |
| Work isolation | Agents could target the same tab without coordinated ownership | Each session owns its window and tabs; existing tabs require `claim_tab` | Commands and responses stay with the Agent that owns the work |
| Concurrency | Avoiding collisions generally meant running work sequentially | Commands are serialized per tab but different tabs run concurrently | Independent browser tasks can make progress at the same time |
| Manual tabs | A manually opened tab had no explicit assignment workflow | Any Agent can claim an unclaimed tab and release it afterward | Human-created browser context remains usable without restarting anything |
| Agent exit | Process exit could also tear down browser connectivity | The Broker remains alive; claims are released after a 30-second grace period and pages stay open | Another Agent can safely continue abandoned work |
| Recording cleanup | Interrupted recording operations could retain listeners or debugger state | Recording start/stop is serialized and disconnect cleanup is retried before resynchronization | A disconnected Agent cannot leave an orphan recording that blocks later sessions |
| Port handling | Multiple processes could loop on `EADDRINUSE` or fail with `EPIPE` | One launcher elects the Broker, validates its health, and reports foreign port occupants without stopping them | Startup failures are immediate and actionable |
| Recovery | Reconnection could trust stale browser ownership or stale socket events | Extension reconnect resynchronizes inventory; stale sockets and disconnected requests are fenced out | Old sessions cannot mutate the current Broker state |
| Network boundary | Role and endpoint separation was implicit | `/agent` and `/extension` use a versioned handshake on `127.0.0.1`; web-page Origins are rejected | The shared service remains local and protocol mismatches fail clearly |

The normal multi-Agent workflow is:

1. Start the Broker explicitly, or let the first MCP client start it.
2. Point the extension popup and every Agent's `WS_PORT` at the same Broker port.
3. Use one Agent window per task. New tabs are created in that Agent's browser window.
4. Before using an existing tab, call `claim_tab`; call `release_tab` when finished.
5. Run separate-tab work concurrently. The Broker prevents foreign-tab access and
   serializes operations that target the same tab.
6. If an Agent disconnects, leave its pages open. After the grace period, another
   Agent can discover and claim those tabs.

Tab ownership is a coordination boundary, not a browser security boundary. All Agents
still share the same Chrome or Edge profile, including cookies, accounts, local storage,
and extension permissions.

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
node scripts/start.js diagnose [--port N]
node scripts/start.js diagnose [--port N] --json
```

The default is port `8765`. Configuration precedence is CLI `--port` → `WS_PORT` → `~/.arc-tunnel/config.json` → `8765`.
A persisted configuration has this shape:

```json
{ "port": 9000 }
```

All Agent client configurations must use the Broker's port. When using a custom port,
set the extension popup to the same port as well. `status` reports the PID and port of a
running Broker. `stop` removes its lifecycle state.

The read-only Operations Control Center is available at
`http://127.0.0.1:<port>/dashboard`. Its status cards, event filters, and copied
diagnostics expose aggregate operational state only. The dashboard and `diagnose`
output exclude URLs, IDs, cookies, scripts, parameters, and page content.

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
npm ci --prefix mcp-server
npm ci --prefix extension
npm run verify
```

Both builds regenerate committed distribution artifacts. The MCP build creates the
lightweight client (`mcp-server/dist/mcp-server.js`), shared Broker
(`mcp-server/dist/arc-tunnel-broker.js`), and lifecycle control
(`mcp-server/dist/arc-tunnel-control.js`) bundles; the browser build creates
`extension/dist/`. For component-specific debugging, run the child `test`, typecheck,
or `build` commands from `mcp-server/` or `extension/`.

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
