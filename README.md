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

运行 Arc Tunnel 需要 Node.js `>=22`。安装器会在
`~/.arc-tunnel/config.json` 中生成认证令牌；已有的有效令牌会原样保留，不会在
日常重跑时轮换。安装器只在首次生成令牌时显示一次；仅当没有
`ARC_TUNNEL_TOKEN` 环境覆盖时，这个新生成的文件令牌才是应复制到扩展弹窗的
生效令牌。模板只保留 MCP 客户端路径和 `WS_PORT`，客户端会自行读取用户级
Arc Tunnel 配置，不要把令牌复制进 Agent 模板。

With no environment override, a newly generated file token is the active popup
credential. With a valid `ARC_TUNNEL_TOKEN` override, the installer instead labels the
generated file token as a fallback: use the effective environment token from its
controlled source, or unset the override and restart the Broker and every Agent client
before using that fallback. An empty or malformed environment override blocks startup
rather than falling back; remove or replace it before startup. The installer never
prints the environment override value.

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
{ "port": 8765, "token": "..." }
```

All Agent client configurations must use the Broker's port. When using a custom port,
set the extension popup to the same port as well. `status` reports the PID and port of a
running Broker. `stop` removes its lifecycle state.

令牌解析规则与端口规则彼此独立：`ARC_TUNNEL_TOKEN` 优先于用户级配置文件
中的令牌，端口仍按上面的 CLI、环境变量、配置文件、默认值顺序解析。
令牌不放在命令行参数或 WebSocket URL 中，因为这些位置容易进入进程列表、
Shell 历史和诊断日志；自动启动的 Broker 通过继承环境接收已经解析的凭据。

The read-only Operations Control Center is available at
`http://127.0.0.1:<port>/dashboard`. Its status cards, event filters, and copied
diagnostics expose aggregate operational state only. The dashboard and `diagnose`
output exclude URLs, IDs, cookies, scripts, parameters, and page content.

`/health`、`/dashboard` 和 `diagnose` 使用未认证的回环聚合状态接口，输出不含
令牌、页面内容或浏览器标识；WebSocket 浏览器控制能力仍必须认证。

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
4. In the popup, verify the shared Broker port and follow the effective-token guidance
   below before saving the password field.

The extension defaults to the unambiguous IPv4 loopback URL `ws://127.0.0.1:8765` and
converts a saved root URL such as `ws://127.0.0.1:8765/` to the current
`/extension` endpoint. During migration, the Broker still accepts the legacy `/` path
only when the WebSocket Origin starts with `chrome-extension://`; new configurations
should use `/extension`.

On upgrade, the extension rewrites only the former default values
`ws://localhost:8765`, `ws://localhost:8765/`, and
`ws://localhost:8765/extension` to their `127.0.0.1` equivalents. These three exact
legacy `localhost` defaults are migration-only inputs; other `localhost` values and
every non-loopback or structurally invalid URL are rejected before connection.

设置了有效的 `ARC_TUNNEL_TOKEN` 时，扩展必须使用同一个生效令牌；请从设置该
环境变量的受控来源取得它，不要改用配置文件中的令牌。另一种做法是先清除该环境变量，
取消环境覆盖后重启 Broker 和所有 Agent 客户端，再使用
`~/.arc-tunnel/config.json` 中的持久化令牌。不要用会把令牌打印到终端的命令
获取它。

扩展弹窗中的密码输入框默认遮蔽令牌。若状态变为 `auth_failed`，扩展不会用同一
错误令牌持续重连，弹窗显示 `Authentication failed`。请按上述优先级取得正确的
生效令牌，粘贴后保存。令牌不会出现在弹窗状态文字、URL、控制台或复制的诊断
信息中。

### 认证迁移

从旧版本升级时按以下顺序操作：

1. 拉取新源码，并按开发流程构建最新 bundle。
2. 运行 `node scripts/install.js`。
3. 确认生效令牌来源：若设置了有效的 `ARC_TUNNEL_TOKEN`，从其受控来源取得同一个
   环境令牌；若未设置，则使用安装器一次性显示的新令牌或持久化文件中的现有令牌。
   若环境覆盖为空或格式错误，须在启动前移除或替换，不能静默回退到文件令牌。
4. 加载或重新加载 `extension/dist/`。
5. 在扩展弹窗中的密码输入框粘贴并保存同一个生效令牌。
6. 确认状态为 `Connected`，再运行
   `node scripts/start.js diagnose --json` 检查聚合状态。

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
npm run audit:prod
```

Both builds regenerate committed distribution artifacts. The MCP build creates the
lightweight client (`mcp-server/dist/mcp-server.js`), shared Broker
(`mcp-server/dist/arc-tunnel-broker.js`), and lifecycle control
(`mcp-server/dist/arc-tunnel-control.js`) bundles; the browser build creates
`extension/dist/`. For component-specific debugging, run the child `test`, typecheck,
or `build` commands from `mcp-server/` or `extension/`.

### Real-browser resilience verification

With the current `extension/dist/` loaded and connected to the shared Broker, run:

```bash
node scripts/verify-browser-resilience.js [--port 8765]
```

The verifier creates a loopback HTTP server, one lightweight MCP client, and one owned
browser tab. It checks pre-call console history, MCP image screenshot delivery, bounded
`TIMEOUT` responses from a deliberately frozen page, screenshot recovery, and tab
closure. On success or failure it closes only the tab, client, and HTTP server that it
created. It never stops the shared Broker and does not close any pre-existing tab.

认证恢复需要在真实浏览器中验证：先在扩展弹窗保存一个格式有效但内容错误的
令牌，确认弹窗显示 `Authentication failed`、状态稳定进入 `auth_failed` 且不会
重连循环；再保存正确的生效令牌，确认恢复为 `Connected`。若有效的环境覆盖仍
存在，这里必须使用该环境令牌；空值或格式错误的覆盖须先移除或替换。只有取消
覆盖并重启 Broker 和 Agent 客户端后，持久化文件令牌才会生效。随后运行 D/F/C
韧性检查：

```bash
node scripts/verify-browser-resilience.js [--port 8765]
```

多 Agent 所有权与截图隔离检查使用：

```bash
node scripts/verify-multi-agent.js [--port 8765] [--manual-tab N]
```

多 Agent 验证器要求每个 Agent 只能从自己拥有的标签页取得非空 JPEG，并确认
对其他 Agent 标签页的截图请求返回 `TAB_NOT_OWNED`；验证日志不会输出图片的
base64 内容。

## Security

The Broker binds only `127.0.0.1`, is not exposed on the LAN, and rejects WebSocket
upgrades with ordinary `http://` or `https://` Origins. The legacy `/` extension route
additionally requires a `chrome-extension://` Origin. The extension has tabs, scripting,
debugger, storage, and cookies permissions. It can access tabs, cookies, storage, and
page scripts, so connect only trusted local Agent clients. `execute_script` has full page
access. Agents share one browser profile and its cookies; tab claims coordinate work but
are not a security boundary.

The extension accepts only the `ws:` scheme with the literal host `127.0.0.1`, an
explicit port from 1 through 65535, and path `/` or `/extension`. It rejects `wss:`,
userinfo, queries, fragments, alternate IP spellings, non-loopback hosts, missing or
out-of-range ports, and other paths before creating a socket. The three exact legacy
`localhost` defaults listed above remain migration-only inputs. Consequently, the
extension never sends the authentication token to an off-loopback destination.

This static token protects against local clients that do not possess it; it is not a
same-user sandbox. Hostile same-OS-user processes that can read the user config or
impersonate the selected local port are outside this static-token boundary.

令牌认证保护的是本地 Broker 能力边界：同一机器上未持有令牌的进程不能调用
浏览器控制 WebSocket。它不提供 Agent 之间的 Cookie 或身份隔离；所有 Agent
仍使用共享浏览器配置文件，共享登录态、Cookie、存储和扩展权限。优先使用
`127.0.0.1`，避免 `localhost` 被解析到无关的 IPv6 监听器；普通 `http://`
和 `https://` Origin 仍会被拒绝，旧根路径也仍只接受
`chrome-extension://` Origin。

## License

MIT
