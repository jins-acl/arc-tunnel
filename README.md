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

The default is port `8765`. Configuration precedence is CLI `--port`, then `WS_PORT`,
then `8765`. All Agent client configurations must use the Broker's port. When using a
custom port, set the extension popup to the same port as well. `status` reports the PID
and port of a running Broker. `stop` removes its lifecycle state.

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

The Broker listens locally. The extension can access tabs, cookies, storage, and page
scripts, so connect only trusted Agent clients. `execute_script` runs with page access.

## License

MIT
