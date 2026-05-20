# GAweb Bridge

> AI-powered browser automation plugin — 让 AI 控制你的真实浏览器

GAweb Bridge 是一个浏览器自动化系统，通过 MCP (Model Context Protocol) 协议让 Claude Code 等 AI 助手控制用户手动打开的浏览器，执行导航、点击、输入、截图、内容提取等操作，并支持智能录制回放和会话管理。

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

- **MCP Server** — Node.js 进程，负责 MCP 协议处理和 WebSocket 中转
- **Browser Extension** — Chrome/Edge 扩展，通过 `chrome.debugger` API 控制标签页

## 功能

| 类别 | 功能 |
|------|------|
| 导航操作 | navigate, create_tab, close_tab, list_tabs |
| 交互操作 | click, type, wait_for_element |
| 内容提取 | get_content (html/text/structured/markdown), screenshot |
| 脚本执行 | execute_script |
| 录制回放 | start_recording, stop_recording, replay_recording |
| 会话管理 | save_session, restore_session |

## 安装

### 1. 克隆仓库

```bash
git clone https://github.com/2184011312/GAweb_bridge.git
cd GAweb_bridge
```

### 2. 构建 MCP 服务器

```bash
cd mcp-server
npm install
npm run build
```

### 3. 构建浏览器扩展

```bash
cd extension
npm install
npm run build
```

### 4. 加载扩展到浏览器

1. 打开 `chrome://extensions/`（或 `edge://extensions/`）
2. 启用 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择 `extension/dist` 目录

### 5. 配置 Claude Code

在 `~/.claude/settings.json` 中添加：

```json
{
  "mcpServers": {
    "web-bridge": {
      "command": "node",
      "args": ["C:/path/to/GAweb_bridge/mcp-server/dist/mcp-server.js"],
      "env": {
        "WS_PORT": "8765"
      }
    }
  }
}
```

## 使用

### 启动

MCP 服务器由 Claude Code 自动启动。确保浏览器扩展已加载并连接到 MCP 服务器（Popup 显示 "Status: Connected"）。

### 在 Claude Code 中使用

AI 可以直接调用 MCP 工具来控制浏览器：

```
"帮我打开 GitHub 并搜索 react"
→ AI 自动调用 navigate、click、type 等工具完成操作

"截一张当前页面的图"
→ AI 调用 screenshot 工具返回截图

"获取这个页面的结构化内容"
→ AI 调用 get_content(mode='structured') 获取标题、链接、表单等

"录制我的操作然后回放"
→ start_recording → [你手动操作] → stop_recording → replay_recording
```

### 可用工具

```typescript
// 基础操作
navigate({ tabId, url })           // 导航到 URL
click({ tabId, selector })         // 点击元素
type({ tabId, selector, text })    // 输入文本
screenshot({ tabId, fullPage? })   // 截图
get_content({ tabId, mode })       // 获取内容 (html|text|structured|markdown)
execute_script({ tabId, script })  // 执行 JS
wait_for_element({ tabId, selector, timeout? })  // 等待元素

// 标签页管理
create_tab({ url? })               // 新建标签页
close_tab({ tabId })               // 关闭标签页
list_tabs()                         // 列出所有标签页

// 录制回放
start_recording({ tabId })         // 开始录制
stop_recording({ tabId })          // 停止录制
replay_recording({ recordingId, tabId? })  // 回放录制

// 会话管理
save_session({ name })             // 保存当前会话
restore_session({ sessionId })     // 恢复已保存会话
```

## 开发

### 项目结构

```
GAweb_bridge/
├── mcp-server/           # MCP 服务器 (Node.js + TypeScript)
│   ├── src/
│   │   ├── index.ts      # 入口
│   │   ├── server.ts     # MCP 服务器类
│   │   ├── websocket-server.ts
│   │   ├── command-queue.ts
│   │   ├── tools/        # MCP 工具定义
│   │   └── types.ts
│   └── tests/
├── extension/            # 浏览器扩展 (Manifest V3)
│   ├── src/
│   │   ├── background/   # Service Worker + 核心模块
│   │   ├── content/      # Content Script
│   │   ├── popup/        # 扩展弹窗
│   │   └── types/
│   └── public/
│       └── manifest.json
└── docs/                 # 设计文档和计划
    └── superpowers/
        ├── specs/        # 设计规格
        └── plans/        # 实现计划
```

### 运行测试

```bash
cd mcp-server
npm test
```

### 构建

```bash
# MCP 服务器
cd mcp-server && npm run build

# 浏览器扩展
cd extension && npm run build
```

## 技术栈

- **MCP Server**: Node.js, TypeScript, `@modelcontextprotocol/sdk`, `ws`
- **Browser Extension**: TypeScript, Chrome Extension Manifest V3, `esbuild`
- **通信**: WebSocket (ws://localhost:8765)
- **测试**: Jest, ts-jest

## 安全

- WebSocket 默认仅监听 localhost
- 使用 `JSON.stringify` 防注入
- 扩展权限最小化
- 密码字段不记录到录制脚本

## 版本

- **v1.0** — 初始版本：15 个 MCP 工具、CDP 控制、录制回放、会话管理

## License

MIT
