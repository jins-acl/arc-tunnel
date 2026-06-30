# Arc Tunnel Multi-Agent Broker Design

**Date:** 2026-06-30
**Status:** Approved for implementation planning

## Problem

The current MCP process owns both the stdio MCP transport and the browser-extension
WebSocket server. Every Agent session therefore tries to bind the same port (8765).
With multiple Codex or other Agent sessions, later processes repeatedly fail with
`EADDRINUSE`, may emit `EPIPE`, and can increase host UI and process instability.

The browser extension also supports only one WebSocket endpoint, so assigning a
different port to every MCP process would not provide usable multi-Agent control.

## Goals

- Run one long-lived local Broker that owns the browser-extension connection.
- Let multiple MCP-compatible Agents use the same Broker concurrently.
- Isolate Agents by browser window and tab ownership while sharing the user's
  existing browser profile, cookies, and login state.
- Allow different owned tabs to execute commands concurrently.
- Preserve control of manually opened tabs through explicit claiming.
- Preserve existing Agent configuration paths and the `WS_PORT` environment variable.
- Support a configurable local port with clear startup and conflict errors.

## Non-Goals

- Isolating cookies, accounts, local storage, or cache between Agents.
- Launching a separate Chrome profile for each Agent.
- Allowing two Agents to control the same tab simultaneously.
- Exposing the Broker to the LAN or remote hosts.
- Adding Agent-specific browser behavior outside the standard MCP adapter.

## Architecture

```text
Codex MCP Client -------\
Claude MCP Client -------+--> Arc Tunnel Broker --> Browser Extension --> Browser
Kimi/Hermes/OpenClaw ---/
```

### Broker

The Broker is the only process that listens on the configured port. It owns:

- the browser-extension WebSocket connection;
- Agent WebSocket connections;
- Agent session registration and heartbeat state;
- window and tab ownership;
- per-tab command serialization;
- command ID routing from an Agent to the extension and back;
- recording, replay, and saved-session ownership metadata.

The Broker binds only to `127.0.0.1`. New connections use `/extension` or `/agent`
WebSocket paths and perform a role and protocol-version handshake. The existing
extension root connection remains supported during migration. The Broker rejects
ordinary `http` and `https` browser origins so a web page cannot impersonate a local
Agent through localhost WebSocket access.

### Lightweight MCP Client

`mcp-server/dist/mcp-server.js` remains the command configured by Agent hosts, but it
becomes a lightweight stdio MCP adapter. It registers the existing tools, establishes
one Agent session with the Broker, forwards tool calls, and returns routed results.
It never binds the browser WebSocket port.

This keeps Codex, Claude Code, Kimi, Hermes, OpenClaw, and other stdio MCP hosts on the
same implementation. Their configuration differs only in the host-specific wrapper
format.

### Broker Launcher

When an MCP client starts, it probes the configured endpoint:

1. If a compatible Broker responds, the client reuses it.
2. If the port is free, a singleton launcher uses an exclusive
   `~/.arc-tunnel/broker.lock` file, starts a detached Broker, and waits for its health
   handshake.
3. If another launcher wins the startup race, the losing client connects to the new
   Broker.
4. If a non-Arc Tunnel process owns the port, startup fails immediately with a clear
   port-conflict error.

The Broker survives individual Agent exits. `scripts/start.js` becomes an explicit
Broker start/status/stop entry point rather than another stdio MCP process launcher.
Stale lock files are ignored only after the recorded process and health endpoint are
both confirmed absent.

## Port Configuration

The effective port uses this precedence:

1. CLI option: `--port <number>`
2. Existing environment variable: `WS_PORT`
3. User configuration: `~/.arc-tunnel/config.json`
4. Default: `8765`

Example user configuration:

```json
{
  "port": 9000
}
```

Ports must be integers from 1 through 65535. The extension popup continues to store a
WebSocket URL such as `ws://localhost:9000`. The extension and Agent clients must point
to the same Broker port. Invalid values and non-Broker port occupants fail immediately;
the former 30-second bind retry is removed.

## Session And Ownership Model

Each MCP client connection receives a unique `sessionId`. The Broker maintains:

```text
sessionId -> owned window IDs -> owned tab IDs
tabId -> owning sessionId | unclaimed
commandId -> sessionId + tabId + pending request
```

The first `create_tab` call lazily creates a dedicated browser window for that session.
Subsequent tabs are created in the same window. Selecting among multiple owned windows
is outside this design's scope.

`list_tabs` returns only:

- tabs owned by the requesting session; and
- unclaimed tabs that were opened manually or released by another session.

Tabs claimed by other sessions are not returned. New tools provide explicit ownership:

- `claim_tab(tabId)` claims an unowned tab;
- `release_tab(tabId)` makes an owned tab unclaimed.

Every tab-scoped tool is authorized by `sessionId + tabId` before forwarding. A request
for an unowned or foreign tab returns `TAB_NOT_OWNED`. The Broker serializes commands
for the same tab, while commands for different tabs execute concurrently.

The browser profile remains shared. Cookie and storage mutations can therefore affect
other sessions even when tabs and windows are isolated. Tool descriptions and errors
must state this boundary clearly.

## Disconnect And Recovery

- **Agent disconnect:** reject that Agent's pending commands, retain its ownership for
  a 30-second grace period, then release its windows and tabs without closing them.
- **Extension disconnect:** keep Agent sessions alive and return
  `EXTENSION_DISCONNECTED` for new browser commands until reconnection.
- **Extension reconnect:** resynchronize browser tabs and windows before accepting new
  commands.
- **Broker restart:** resynchronize existing browser state and mark tabs unclaimed;
  stale ownership is not trusted across Broker processes.
- **Tab closed manually:** remove ownership and reject pending requests with
  `TAB_CLOSED`.
- **Command timeout:** remove the route entry and return `COMMAND_TIMEOUT` only to the
  originating Agent.
- **Protocol mismatch:** reject the connection with supported and received versions.

Recording, replay, and saved-session identifiers are scoped to the creating Agent
session. Disconnect cleanup prevents recordings or responses from leaking to a later
session.

## Backward Compatibility And Migration

- Existing Agent configs continue to invoke `mcp-server/dist/mcp-server.js`.
- Existing `WS_PORT` configuration remains valid.
- The extension default stays `ws://localhost:8765` and custom popup URLs remain saved.
- Existing browser tools keep their names and input shapes except for additive
  `claim_tab` and `release_tab` tools and ownership metadata in `list_tabs` results.
- Prebuilt `mcp-server/dist` and `extension/dist` artifacts remain committed.
- Agent configuration templates and README examples are updated for the shared Broker
  lifecycle without requiring Agent-specific server implementations.

## Testing Strategy

### Unit Tests

- configuration precedence, range validation, and custom ports;
- session registration, grace-period cleanup, and protocol negotiation;
- tab claim, release, ownership visibility, and authorization failures;
- per-tab serialization and cross-tab concurrency;
- command route isolation, timeout cleanup, and disconnect rejection;
- singleton launcher races and non-Broker port conflicts.

### Integration Tests

Use a fake extension WebSocket and multiple real stdio MCP client processes to verify:

- one Broker serves multiple Agents without another port bind;
- responses return only to the originating Agent;
- two Agents can operate separate tabs concurrently;
- foreign-tab access is rejected;
- extension disconnect and reconnect preserve Agent sessions;
- Codex-style and Claude/Kimi-style configurations use the same client entry point.

### Manual Browser Verification

- Connect the unpacked extension to the default and a custom port.
- Start two Agent sessions and confirm each receives a dedicated window.
- Run concurrent navigation and interaction in separate windows.
- Open a tab manually, claim it from one Agent, and confirm the other cannot operate it.
- Stop one Agent and confirm its pages remain open and become claimable after the grace
  period.
- Confirm repeated Agent startup produces no `EADDRINUSE` retry loop or `EPIPE` crash.

## Success Criteria

- One Broker process owns the configured port regardless of Agent session count.
- Multiple supported MCP Agents can control separate windows and tabs concurrently.
- No command or response crosses session ownership boundaries.
- Manually opened browser tabs remain controllable through explicit claiming.
- Agent exit does not terminate the Broker or close browser pages.
- Existing default configurations continue working after rebuilding committed artifacts.
