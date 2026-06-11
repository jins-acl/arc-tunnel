# Arc Tunnel — Agent Guide

This file provides configuration guidance for AI coding agents working with the Arc Tunnel project.

## Quick Start for Agents

```bash
# 1. Build everything (if source changed)
cd mcp-server && npm install && npm run build && cd ..
cd extension && npm install && npm run build && cd ..

# 2. Auto-configure for detected agent tools
node scripts/install.js

# 3. Start MCP Server (if not auto-started by agent)
node scripts/start.js
```

> **⚠️ MCP Server 必须常驻运行**
>
> 浏览器扩展通过 WebSocket 与 MCP Server 保持长连接。**频繁重启 Server 会导致扩展进入 disconnect → reconnect 循环**，在此过程中 Chrome/Edge 的 debugger 横幅可能被重复绘制，出现视觉上的重影/叠影。
>
> **正确做法**：启动后保持 Server 运行；如需重启，先禁用扩展，待 Server 稳定后再重新加载。

## Project Structure

| Component | Path | Build Command |
|-----------|------|---------------|
| MCP Server | `mcp-server/` | `cd mcp-server && npm run build` |
| Browser Extension | `extension/` | `cd extension && npm run build` |
| Config Templates | `configs/` | Static files |
| Install Scripts | `scripts/` | Static files |

## Multi-Agent Configuration

Arc Tunnel supports multiple AI agent tools via MCP (Model Context Protocol).

### Claude Code / Kimi

Config: `~/.mcp.json`
```json
{
  "mcpServers": {
    "arc-tunnel": {
      "command": "node",
      "args": ["<repo-path>/mcp-server/dist/mcp-server.js"],
      "env": { "WS_PORT": "8765" }
    }
  }
}
```

### Hermes Agent

Config: `~/.hermes/config.yaml`
```yaml
mcp_servers:
  arc-tunnel:
    command: "node"
    args: ["<repo-path>/mcp-server/dist/mcp-server.js"]
    env:
      WS_PORT: "8765"
    timeout: 120
    supports_parallel_tool_calls: true
```

### OpenClaw

Config: `~/.openclaw/openclaw.json` (ACPX plugin schema)
```json
{
  "mcpServers": {
    "arc-tunnel": {
      "command": "node",
      "args": ["<repo-path>/mcp-server/dist/mcp-server.js"],
      "env": { "WS_PORT": "8765" }
    }
  }
}
```

### Codex

Add to skill's `agents/openai.yaml`:
```yaml
dependencies:
  tools:
    - type: "mcp"
      value: "arc-tunnel"
      description: "Arc Tunnel browser automation"
      transport: "stdio"
      command: "node"
      args: ["<repo-path>/mcp-server/dist/mcp-server.js"]
```

## Extension Setup

1. Open Chrome/Edge → `chrome://extensions/`
2. Enable **Developer mode**
3. **Load unpacked** → Select `extension/dist/`
4. Extension popup shows connection status
5. WebSocket URL is configurable via popup (defaults to `ws://localhost:8765`)

## Architecture

```
┌─────────────┐  MCP/stdio  ┌──────────────────┐  WebSocket  ┌─────────────────┐
│ AI Agent    │ <---------> │  ArcTunnel       │ <---------> │  Browser Ext    │
│ (Host)      │             │  MCP Server      │             │  (Manifest V3)  │
└─────────────┘             └──────────────────┘             └─────────────────┘
                                                                      │
                                                             chrome.debugger API
                                                                      │
                                                             ┌─────────────────┐
                                                             │  Browser Tabs   │
                                                             └─────────────────┘
```

## Available MCP Tools (15 total)

| Tool | Description |
|------|-------------|
| `navigate` | Navigate tab to URL |
| `click` | Click element by CSS selector |
| `type` | Type text into element |
| `screenshot` | Capture tab screenshot (base64 PNG) |
| `get_content` | Extract content (html/text/structured/markdown) |
| `execute_script` | Execute JavaScript in tab |
| `wait_for_element` | Wait for element to appear |
| `create_tab` | Open new tab |
| `close_tab` | Close tab |
| `list_tabs` | List all open tabs |
| `start_recording` | Start recording user actions |
| `stop_recording` | Stop and return recording |
| `replay_recording` | Replay recorded actions |
| `save_session` | Save browser session |
| `restore_session` | Restore saved session |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_PORT` | `8765` | WebSocket server port for extension connection |

## Pre-built Artifacts

Both `mcp-server/dist/` and `extension/dist/` are committed to git. Users do not need `npm install` to use the tool.

## Testing

```bash
cd mcp-server && npm test   # 14 tests, 5 suites
```

## License

MIT
