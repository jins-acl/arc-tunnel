# Arc Tunnel 运维控制中心与项目包装设计

**日期：** 2026-07-06  
**状态：** 已确认，待实现计划

## 背景

Arc Tunnel 已具备共享 Broker、多 Agent 会话、标签所有权、断连恢复和录制清理能力，
但运行状态主要通过控制台日志和基础 `status` 命令观察。发生连接、库存同步或恢复问题时，
用户难以快速判断当前阶段。仓库同时缺少统一根目录命令、持续集成和一致的发布元数据。

本设计增加一个中文、只读、本机运维控制中心，并完善诊断 CLI 和项目包装。它不增加远程
管理能力，也不改变 Agent、Broker 和浏览器扩展之间的控制协议。

## 目标

- 在浏览器中查看 Broker、扩展、Agent、工作负载和恢复状态。
- 提供脱敏的实时诊断事件流，帮助定位连接与生命周期问题。
- 提供适合人类和脚本使用的诊断 CLI。
- 保持现有 `/health` 和 `status` 行为兼容。
- 统一测试、类型检查、构建和完整验证命令。
- 增加 Windows 与 Linux CI，并统一许可证和包元数据。

## 非目标

- 不展示 URL、标签 ID、会话 ID、Cookie、脚本、命令参数或页面内容。
- 不提供停止未知进程、强制断开 Agent、释放标签或执行浏览器命令的 HTTP 接口。
- 不把控制中心暴露到局域网或远程主机。
- 不实现持久化日志、指标数据库、用户系统或权限后台。
- 不替代真实 Chrome/Edge 发布前验证。

## 用户界面

采用已确认的 C 方案“完整控制中心”，界面全部使用中文。页面包含：

1. 顶部状态栏：端口、协议版本和整体健康状态。
2. 三张主状态卡：Broker、浏览器扩展、恢复状态。
3. Agent 与工作负载：在线 Agent、宽限期 Agent、已认领标签和待处理命令计数。
4. 连接与恢复：扩展连接、重连阶段、最近库存同步和最近错误。
5. 实时诊断事件：支持全部、连接、所有权、恢复分类筛选和复制诊断。

页面默认只读。Broker 不可达时显示明确的离线状态和启动建议，但页面本身不尝试启动、
停止或修改 Broker。

## DiagnosticsStore

Broker 内新增独立的 `DiagnosticsStore`，负责汇总状态和诊断事件。它不拥有业务状态，
而是从 Broker 生命周期事件更新可观察快照。

### 状态快照

快照包含：

- Broker：PID、端口、协议版本、启动时间和运行时长；
- Extension：连接状态、连接代次、重连阶段和最近同步时间；
- Agent：在线数量和处于 30 秒宽限期的数量；
- 工作负载：已认领标签数量和 pending command 数量；
- Recovery：库存同步和录制清理的当前阶段；
- 最近错误：时间、稳定事件代码和脱敏摘要。

状态不包含任何浏览上下文或身份标识。

### 事件模型

事件包含：

```text
sequence, timestamp, level, category, code, summary
```

- `sequence` 在当前 Broker 进程内单调递增；
- `level` 为 `info`、`warning` 或 `error`；
- `category` 为 `broker`、`connection`、`ownership` 或 `recovery`；
- `code` 是稳定、机器可读的英文事件代码；
- `summary` 是脱敏的中文展示文本。

事件存入最多 200 条的内存环形缓冲区。Broker 重启后事件自然清空。代码不得把 URL、
tabId、sessionId、Cookie、脚本、命令参数或扩展返回结果写入事件。

典型事件代码包括 `BROKER_STARTED`、`EXTENSION_CONNECTED`、
`EXTENSION_DISCONNECTED`、`AGENT_CONNECTED`、`AGENT_GRACE_STARTED`、
`INVENTORY_SYNC_COMPLETED`、`INVENTORY_SYNC_FAILED`、
`RECORDING_CLEANUP_STARTED` 和 `RECORDING_CLEANUP_FAILED`。

## HTTP 接口

Broker 继续只绑定 `127.0.0.1`，并新增以下 GET 路由：

- `/dashboard`：中文控制中心静态页面；
- `/api/status`：返回当前安全状态快照；
- `/api/events`：Server-Sent Events 诊断流。

现有 `/health` 响应格式保持不变，确保 Broker launcher 和旧客户端兼容。

所有新响应设置 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、
`X-Frame-Options: DENY` 和限制性的 `Content-Security-Policy`。不发送 CORS 允许头。
接口完全只读，普通网页因同源策略不能读取响应。

### SSE 恢复

客户端通过 `Last-Event-ID` 或查询参数提交最后收到的事件序号。缓冲区仍包含后续事件时，
Broker 先补发遗漏事件再进入实时推送。请求序号早于缓冲区范围时，Broker 发送一个
`RESET` 事件，客户端重新请求 `/api/status`。

SSE 连接关闭时必须移除监听器。Broker 停止时应关闭全部 SSE 响应，避免阻塞进程退出。

## 诊断 CLI

保留现有 `start`、`status`、`stop` 行为及 `status` 的 JSON 输出。新增：

```bash
node scripts/start.js diagnose [--port N]
node scripts/start.js diagnose [--port N] --json
```

默认输出中文摘要、控制中心完整 URL和可执行建议；`--json` 输出稳定的机器可读结构。

CLI 区分以下状态并返回不同的非零退出码：

- Broker 未运行；
- 端口被非 Arc Tunnel 进程占用；
- Broker 协议不兼容；
- Broker 健康但诊断接口不可用。

诊断命令只读取状态，不自动启动或停止任何进程。

## 控制中心前端

控制中心使用仓库内静态 TypeScript、HTML 和 CSS 构建，不引入前端框架。页面流程为：

1. 加载时请求 `/api/status`；
2. 建立 `/api/events` SSE；
3. 根据事件增量更新状态或重新拉取快照；
4. 支持事件类别筛选；
5. “复制诊断”只复制安全状态和脱敏事件。

SSE 断开时页面显示重连状态并使用浏览器原生重连。Broker 不可达时显示离线提示。

## 项目包装

### 根目录命令

新增根目录私有 `package.json`，不改变两个子目录的安装方式，提供：

- `npm test`：运行 MCP 与扩展测试；
- `npm run typecheck`：运行两侧 TypeScript 检查；
- `npm run build`：重新生成全部提交产物；
- `npm run verify`：依次执行测试、类型检查、构建、集成测试和文档断言。

### 包元数据

`mcp-server/package.json` 和 `extension/package.json` 使用一致的：

- 清晰 package name 和 description；
- `MIT` license；
- GitHub repository 信息；
- 现有版本策略。

删除空的 author、keywords 等占位字段。仓库根目录新增正式 MIT `LICENSE`：

```text
Copyright (c) 2026 Arc Tunnel contributors
```

### CI

新增 GitHub Actions，在 `windows-latest` 和 `ubuntu-latest` 上使用受支持的 Node.js LTS：

1. 安装两个子项目的锁定依赖；
2. 执行根目录 `npm run verify`；
3. 检查构建后提交产物没有差异。

CI 不启动真实浏览器；真实 Chrome/Edge 验证继续作为发布前人工门禁。

## README 更新

README 增加：

- 控制中心访问方式；
- `diagnose` 与 `diagnose --json` 示例；
- 状态字段和隐私边界；
- 根目录统一开发命令；
- CI 与真实浏览器验证的职责边界。

## 测试策略

### 单元测试

- DiagnosticsStore 容量、顺序、序号、订阅和脱敏约束；
- 状态计数随 Agent、Extension、pending、同步和 cleanup 生命周期更新；
- session 或标签标识不会进入诊断输出；
- CLI 人类可读输出、JSON 输出和退出码；
- 控制中心筛选、离线状态、RESET 和复制诊断。

### HTTP 集成测试

- `/health` 保持原格式；
- dashboard 和 API content type、安全头、no-store 和无 CORS；
- SSE 初始补发、断点续传、RESET 和断开清理；
- Broker stop 不被 SSE 客户端阻塞。

### 完整验证

- Windows 与 Linux CI 运行根目录 `npm run verify`；
- 构建产物与源码保持同步；
- 发布前按现有脚本执行真实双 Agent 浏览器验证。

## 成功标准

- 用户可以在中文控制中心中判断 Broker、Extension、Agent 和恢复状态；
- 用户可以复制不含浏览敏感信息的诊断摘要；
- 诊断页面和 CLI 不提供任何状态修改能力；
- `/health`、现有生命周期命令和 Agent 配置保持兼容；
- 根目录一条命令完成完整验证；
- Windows 与 Linux CI 均通过；
- README、LICENSE 和 package metadata 一致。
