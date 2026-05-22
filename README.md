# Arc Tunnel

> AI-powered browser automation — 让 AI 控制你的真实浏览器

Arc Tunnel 通过 MCP 协议让 Claude Code 等 AI 助手控制你手动打开的浏览器，执行导航、点击、输入、截图等操作。支持录制回放和会话管理。

## 架构

```
┌─────────────┐  MCP/stdio  ┌──────────────────┐  WebSocket  ┌─────────────────┐
│ Claude Code │ <---------> │  MCP Server       │ <---------> │  Browser Extension │
│   (AI)      │             │  (协议适配层)      │             │  (自动化引擎)      │
└─────────────┘             └──────────────────┘             └─────────────────┘
                                                                      │
                                                             chrome.debugger API
                                                                      │
                                                             ┌─────────────────┐
                                                             │  Browser Tabs    │
                                                             └─────────────────┘
```

- **MCP Server** — Node.js 进程，MCP 协议 + WebSocket 中转，**已预构建为单文件，无需 npm**
- **Browser Extension** — Chrome/Edge 扩展，`chrome.debugger` API 控制标签页，**已预构建，直接加载**

## 安装

### 1. 获取代码

```bash
git clone https://github.com/jins-acl/arc-tunnel.git
cd arc-tunnel
```

> 提交记录包含所有预构建产物，克隆后无需 npm install / npm run build 即可直接使用。

### 2. 加载浏览器扩展

1. 打开 Chrome 或 Edge，地址栏输入 `chrome://extensions/` 或 `edge://extensions/`
2. 启用右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择 `extension/dist` 目录

### 3. 配置 AI Agent 工具

Arc Tunnel 支持多种 AI Agent 工具，提供一键自动配置：

```bash
node scripts/install.js
```

该脚本会自动检测系统中已安装的 Agent 工具并写入对应配置。

#### 支持的 Agent 工具

| Agent 工具 | 配置格式 | 配置文件路径 |
|-----------|---------|------------|
| **Claude Code** | JSON | `~/.mcp.json` |
| **Hermes Agent** | YAML | `~/.hermes/config.yaml` |
| **OpenClaw** | JSON | `~/.openclaw/openclaw.json` |
| **Kimi Code CLI** | JSON | `~/.mcp.json` |
| **Codex (OpenAI)** | YAML | Skill-level `agents/openai.yaml` |

#### 手动配置

如果自动配置不适用，可从 `configs/` 目录复制对应模板手动配置：

**Claude Code / Kimi（`.mcp.json`）**

| 系统 | 路径 |
|------|------|
| Windows | `%USERPROFILE%\.mcp.json` |
| macOS / Linux | `~/.mcp.json` |

```json
{
  "mcpServers": {
    "arc-tunnel": {
      "command": "node",
      "args": ["<仓库路径>/mcp-server/dist/mcp-server.js"],
      "env": {
        "WS_PORT": "8765"
      }
    }
  }
}
```

**Hermes Agent（`~/.hermes/config.yaml`）**

```yaml
mcp_servers:
  arc-tunnel:
    command: "node"
    args:
      - "<仓库路径>/mcp-server/dist/mcp-server.js"
    env:
      WS_PORT: "8765"
    timeout: 120
    supports_parallel_tool_calls: true
```

将 `<仓库路径>` 替换为 `git clone` 下载到的实际路径，例如：
- Windows: `C:/Users/xxx/arc-tunnel/mcp-server/dist/mcp-server.js`
- macOS/Linux: `/home/xxx/arc-tunnel/mcp-server/dist/mcp-server.js`

### 4. 启动

**方式一：通过 AI Agent 自动启动**

大多数 Agent 工具（Claude Code、Kimi 等）会在需要时自动启动 MCP Server。

**方式二：手动启动**

```bash
node scripts/start.js        # 默认端口 8765
node scripts/start.js --port 9876  # 自定义端口
```

### 5. 验证连接

1. 重启你的 AI Agent 工具
2. 点击浏览器扩展图标，弹窗应显示 **"Status: Connected"**
3. 如果 MCP Server 运行在非默认端口，可在扩展弹窗中修改 **MCP Server URL**

### 在线环境（如需修改源码）

如果修改了 TypeScript 源代码，需要在线环境重新构建：

```bash
cd mcp-server && npm install && npm run build && cd ..
cd extension && npm install && npm run build && cd ..
```

### 预构建文件说明

| 文件 | 大小 | 说明 |
|------|------|------|
| `mcp-server/dist/mcp-server.js` | ~680KB | MCP 服务器单文件，含全部依赖 |
| `extension/dist/` | ~30KB | 扩展构建产物，可直接加载 |

## 功能

| 类别 | 工具 |
|------|------|
| 导航操作 | `navigate`, `create_tab`, `close_tab`, `list_tabs` |
| 交互操作 | `click`, `type`, `wait_for_element` |
| 内容提取 | `get_content` (html/text/structured/markdown), `screenshot` |
| 脚本执行 | `execute_script` |
| 录制回放 | `start_recording`, `stop_recording`, `replay_recording` |
| 会话管理 | `save_session`, `restore_session` |

## 使用

### 基础用法

```
"帮我打开 GitHub 首页"
→ AI 调用 navigate 工具

"搜索 react 项目"
→ AI 调用 type + click

"截图"
→ AI 调用 screenshot 返回截图

"获取页面的结构化内容"
→ AI 调用 get_content(mode='structured')
```

### 录制回放

```
"开始录制" → start_recording
[你在浏览器中手动操作]
"停止录制" → stop_recording
"回放刚才的录制" → replay_recording
```

### 会话管理

```
"保存当前浏览器会话" → save_session(name='我的会话')
"恢复之前的会话"     → restore_session(sessionId='xxx')
```

### 工具速查

```typescript
// 基础操作
navigate({ tabId, url })
click({ tabId, selector })
type({ tabId, selector, text })
screenshot({ tabId, fullPage? })
get_content({ tabId, mode })         // html | text | structured | markdown
execute_script({ tabId, script })
wait_for_element({ tabId, selector, timeout? })

// 标签页
create_tab({ url? })
close_tab({ tabId })
list_tabs()

// 录制回放
start_recording({ tabId })
stop_recording({ tabId })
replay_recording({ recordingId, tabId? })

// 会话
save_session({ name })
restore_session({ sessionId })
```

## 项目结构

```
arc-tunnel/
├── mcp-server/             # MCP 服务器 (Node.js + TypeScript)
│   ├── src/                # 源代码
│   │   ├── index.ts        # 入口
│   │   ├── server.ts       # MCP 服务器主类
│   │   ├── websocket-server.ts
│   │   ├── command-queue.ts
│   │   ├── tools/          # 15 个 MCP 工具定义
│   │   └── types.ts
│   ├── dist/               # 预构建产物 (已纳入 git)
│   └── tests/              # Jest 测试
├── extension/              # 浏览器扩展 (Manifest V3)
│   ├── src/
│   │   ├── background/     # Service Worker + 核心模块
│   │   ├── content/        # Content Script
│   │   ├── popup/          # 扩展弹窗
│   │   └── types/
│   ├── public/manifest.json
│   └── dist/               # 预构建产物 (已纳入 git)
├── configs/                # 各 Agent 工具的 MCP 配置模板
│   ├── claude-code.json
│   ├── hermes.yaml
│   ├── openclaw.json
│   ├── kimi.md
│   └── codex-skill.yaml
├── scripts/                # 辅助脚本
│   ├── install.js          # 自动检测并配置 Agent 工具
│   └── start.js            # 一键启动 MCP Server
└── docs/superpowers/
    ├── specs/              # 设计文档
    └── plans/              # 实现计划
```

## 开发

```bash
# 运行测试
cd mcp-server && npm test     # 14 tests, 5 suites

# 修改后重新构建
cd mcp-server && npm run build   # 输出 dist/mcp-server.js
cd extension && npm run build    # 输出 dist/

# 提交时包含预构建产物
git add mcp-server/dist/ extension/dist/
```

## 技术栈

| 组件 | 技术 |
|------|------|
| MCP Server | Node.js 18+, TypeScript, `@modelcontextprotocol/sdk`, `ws` |
| Browser Extension | TypeScript, Chrome Extension Manifest V3 |
| 构建 | esbuild (单文件打包) |
| 通信 | WebSocket (ws://localhost:8765) |
| 测试 | Jest, ts-jest |

## 安全

- WebSocket 仅监听 localhost，不暴露到网络
- `JSON.stringify()` 防注入，所有用户输入安全编码
- 扩展权限最小化（debugger, tabs, storage, cookies）
- `get_content(html)` 返回原始 HTML（包含可见字段值及已填充的密码），调用者自行过滤敏感信息
- `execute_script` 具有完整页面访问权限，仅在可信 AI 助手中使用

## 版本

- **v1.0** — 初始版本: 15 个 MCP 工具, CDP 控制, 录制回放, 会话管理

## License

MIT
