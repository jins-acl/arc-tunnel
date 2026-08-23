# Arc Tunnel

Arc Tunnel 是一个面向多 Agent 的本地浏览器控制工具。多个 Codex、Claude Code、
Kimi、Hermes 或 OpenClaw 会话可以通过同一个 Broker，共享控制真实的 Chrome 或
Edge 浏览器，并在不同标签页上并行工作。

## 核心特点

- 一个长期运行的 Broker 统一管理浏览器连接，避免多个 Agent 抢占端口。
- 每个 Agent 拥有独立会话和标签页所有权，响应不会串到其他任务。
- 不同标签页可以并行执行，同一标签页的操作会自动串行化。
- Agent 断开后自动释放标签页声明，页面保持打开，可由其他 Agent 接手。
- 普通操作优先使用轻量浏览器接口，需要时才临时连接调试器。
- Broker 仅监听 `127.0.0.1`，浏览器控制连接必须通过令牌认证。

## 工作原理

```text
Agent 主机 --stdio--> 轻量 MCP 客户端 --WebSocket /agent--> Broker
浏览器扩展 --------------------------WebSocket /extension--> Broker
```

每个 Agent 启动一个 `mcp-server/dist/mcp-server.js` 客户端。第一个客户端可以自动
启动 Broker，后续客户端会发现并复用它。浏览器扩展只需连接一次 Broker。

标签页所有权用于协调 Agent，不提供账号或 Cookie 隔离。所有 Agent 仍使用共享浏览器配置文件，
并共享登录状态、Cookie、本地存储和扩展权限。

## 环境要求

- Node.js `>=22`
- Chrome 或 Edge
- 支持 MCP 的 Agent 客户端

仓库已经提交 `mcp-server/dist/` 和 `extension/dist/` 构建产物。直接使用发布版本时，
无需先执行 npm 构建。

## 快速安装

```bash
node scripts/install.js
```

安装器会检测已支持的 Agent，更新对应的 MCP 配置，并在修改前创建备份。也可以从
`configs/` 目录手动选择配置模板。

首次安装会在 `~/.arc-tunnel/config.json` 中生成配置：

```json
{ "port": 8765, "token": "..." }
```

令牌不会写入 Agent 模板。令牌不放在命令行参数或 WebSocket URL 中。已有的有效
令牌会被保留，不会因重复运行安装器而自动轮换。安装器只在首次生成令牌时显示一次。

`ARC_TUNNEL_TOKEN` 优先于用户级配置文件中的令牌。设置了有效的 `ARC_TUNNEL_TOKEN` 时，扩展必须使用同一个生效令牌。
如果安装器此时生成文件令牌，它仅是备用令牌，生效令牌应从设置环境变量的受控来源取得。
空值或格式错误的环境覆盖会阻止启动，必须移除或替换；安装器不会显示环境覆盖值。
也可以清除该环境变量，取消环境覆盖后重启 Broker 和所有 Agent 客户端，再使用配置文件令牌。

## 加载浏览器扩展

1. 打开 `chrome://extensions/` 或 `edge://extensions/`。
2. 开启开发者模式，选择“加载已解压的扩展程序”。
3. 选择仓库中的 `extension/dist/`。
4. 在扩展弹窗中的密码输入框填写生效令牌，然后保存。
5. 确认状态变为 `Connected`。

默认地址为 `ws://127.0.0.1:8765`，扩展会将根路径规范化为 `/extension`。使用自定义
端口时，扩展和所有 Agent 的 `WS_PORT` 必须保持一致。

扩展只接受字面地址 `127.0.0.1`、明确端口以及 `/` 或 `/extension` 路径。旧版三个
`localhost:8765` 默认值仅用于自动迁移，新配置请始终使用 `127.0.0.1`。

### 升级步骤

1. 拉取最新代码并运行 `node scripts/install.js`。
2. 重新加载 `extension/dist/`。
3. 在扩展弹窗粘贴并保存同一个生效令牌。
4. 确认状态变为 `Connected`。
5. 运行 `node scripts/start.js diagnose --json`。

## Broker 管理

```bash
node scripts/start.js status
node scripts/start.js start
node scripts/start.js start --port 9000
node scripts/start.js status --port 9000
node scripts/start.js stop --port 9000
node scripts/start.js diagnose [--port N]
node scripts/start.js diagnose [--port N] --json
```

默认端口是 `8765`。端口优先级为：命令行 `--port` → `WS_PORT` → `~/.arc-tunnel/config.json` → `8765`。
`status` 会显示运行中的 Broker PID 和端口；
不要停止占用目标端口的未知进程。

只读运行面板位于：

```text
http://127.0.0.1:<端口>/dashboard
```

面板、`/health` 和 `diagnose` 只展示聚合状态，不包含 URL、ID、Cookie、脚本、参数和页面内容，
也不包含令牌或浏览器标识。浏览器控制 WebSocket 仍需要认证。

## 多 Agent 使用方式

1. 每个任务使用一个独立 Agent 窗口。
2. 新建标签页会自动归当前 Agent 所有。
3. 操作已有标签页前调用 `claim_tab`。
4. 完成后调用 `release_tab`。
5. 不同 Agent 可以同时操作不同标签页。

同一个标签页同一时间只能由一个 Agent 持有。客户端断开后，相关声明会在宽限期后
释放，浏览器页面不会因此关闭。

## 可用工具

| 类别 | 工具 |
|---|---|
| 页面快照与交互 | `snapshot`、`interact` |
| 导航与标签页 | `navigate`、`create_tab`、`close_tab`、`list_tabs` |
| 所有权管理 | `claim_tab`、`release_tab` |
| 内容与诊断 | `screenshot`、`get_content`、`get_console_logs`、`wait_for_element` |
| 脚本与存储 | `execute_script`、`manage_storage` |
| 操作录制 | `start_recording`、`stop_recording`、`replay_recording` |
| 会话保存 | `save_session`、`restore_session` |

`snapshot` 会返回可供 `interact` 使用的元素引用。`navigate` 支持打开地址、前进、
后退和刷新。页面内容可以返回 HTML、文本、结构化数据或 Markdown。

轻量命令优先使用 `chrome.tabs` 和 `chrome.scripting`。必须使用调试协议时才连接
`chrome.debugger`；最后一次操作结束 15 秒后自动断开。录制期间会保持调试器连接。

## 常见排查

扩展显示断开时，依次检查：

1. 运行 `node scripts/start.js status [--port N]` 确认 Broker 状态。
2. 确认扩展端口与所有 Agent 的 `WS_PORT` 一致。
3. 确认扩展加载的是当前 `extension/dist/`。
4. 确认扩展保存的是当前生效令牌。
5. 运行 `node scripts/start.js diagnose --json` 查看聚合诊断。

如果弹窗进入 `auth_failed` 并显示 `Authentication failed`，请重新保存正确的生效令牌。
扩展不会使用同一错误令牌持续重连。协议版本不一致或反复重连通常说明客户端、
Broker 和扩展来自不同构建版本，需要重新构建并重新加载全部产物。

认证恢复：先保存一个格式有效但内容错误的令牌，确认出现 `Authentication failed`；
再保存正确的生效令牌，确认状态恢复为 `Connected`。

## 开发与验证

```bash
npm ci --prefix mcp-server
npm ci --prefix extension
npm run verify
npm run audit:prod
```

构建会生成 `mcp-server/dist/mcp-server.js`、`mcp-server/dist/arc-tunnel-broker.js`、
`mcp-server/dist/arc-tunnel-control.js` 和 `extension/dist/`。

浏览器韧性验证：

```bash
node scripts/verify-browser-resilience.js [--port 8765]
```

多 Agent 所有权与 JPEG 截图隔离验证：

```bash
node scripts/verify-multi-agent.js [--port 8765] [--manual-tab N]
```

验证要求每个 Agent 从自己拥有的标签页取得非空 JPEG，并确认对其他 Agent 标签页的
截图请求返回 `TAB_NOT_OWNED`。

验证器只清理自己创建的标签页、客户端和临时服务，不会停止共享 Broker，也不会关闭
已有浏览器标签页。

## 安全说明

Broker 仅绑定 `127.0.0.1`，不会暴露到局域网，并拒绝来自普通 `http://` 或
`https://` 页面的 WebSocket 升级；旧根路径只接受 `chrome-extension://` 来源。
扩展绝不会将认证令牌发送到非回环地址。扩展拥有标签页、脚本、调试器、存储和
Cookie 权限，只应连接可信的本地 Agent。

静态令牌可以阻止未持有令牌的本地客户端，但不是同一操作系统用户之间的安全沙箱。
它保护的是本地 Broker 能力边界。能够读取用户配置或冒充本地端口的恶意进程不在此
边界内。

## 许可证

MIT
