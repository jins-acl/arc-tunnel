# Kimi Code CLI configuration

Arc Tunnel runs a lightweight MCP client for each Kimi window. The client connects to,
or starts, the shared multi-agent Browser Broker. Kimi uses the same `.mcp.json` shape
as Claude Code where MCP configuration is supported.

```json
{
  "mcpServers": {
    "arc-tunnel": {
      "command": "node",
      "args": ["{{REPO_PATH}}/mcp-server/dist/mcp-server.js"],
      "env": { "WS_PORT": "8765" }
    }
  }
}
```

Use the same `WS_PORT` for every Agent and configure the extension popup to connect to
that port. Authentication is read from `~/.arc-tunnel/config.json`; do not put the
token in this Agent configuration. See the project README for Broker lifecycle and tab
ownership behavior.
