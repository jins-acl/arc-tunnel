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
cd mcp-server && npm install && npm test -- --runInBand
npx tsc -p tsconfig.test.json --noEmit && npm run build && cd ..
cd extension && npm install && npm test
npx tsc --noEmit && npm run build && cd ..
```

The committed bundles include `mcp-server/dist/mcp-server.js`,
`mcp-server/dist/arc-tunnel-broker.js`, lifecycle control, and `extension/dist/`.

## Install and configure

Run `node scripts/install.js` or use the files in `configs/`. Do not change the client
entry path: every Agent invokes `mcp-server/dist/mcp-server.js` with `WS_PORT`.

Port precedence is CLI `--port`, then `WS_PORT`, then `8765`. Every client and the
extension popup must select the same custom port.

## Broker lifecycle

```bash
node scripts/start.js status
node scripts/start.js start [--port N]
node scripts/start.js status [--port N]
node scripts/start.js stop [--port N]
```

While running, status prints the Broker PID and port. Always stop Brokers started by a
test or manual validation.

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
`ws://localhost:8765`; change it whenever the Broker uses a custom port.
