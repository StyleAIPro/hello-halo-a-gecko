# 功能 — mcp-bridge

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（初始文档化）
> 所属模块：modules/remote-agent/remote-agent-v1

## 描述
MCP（Model Context Protocol）工具桥接服务，在本地 AICO-Bot 与远程 Agent Proxy 之间桥接 PC 资源类 MCP 工具。仅桥接 PC 资源工具（ai-browser 26 个工具、gh-search 8 个工具），不桥接业务逻辑工具（aico-bot-apps、hyper-space 由远程 Proxy 独立实现）。`AicoBotMcpBridge` 收集本地工具定义（名称、描述、inputSchema），序列化后通过 WebSocket 传输给远程 Proxy 重建；远程 Proxy 需要执行工具时，通过 `mcp:tool:call` 消息请求本地执行，本地调用完成后返回结果。

## 依赖
- `src/main/services/ai-browser/sdk-mcp-server.ts` — `buildAllTools()` 构建 AI Browser 工具（26 个）
- `src/main/services/ai-browser/context.ts` — `browserContext` 浏览器上下文
- `src/main/services/gh-search/sdk-mcp-server.ts` — `buildAllTools()` 构建 GitHub Search 工具（8 个）
- `@anthropic-ai/claude-agent-sdk` — `SdkMcpToolDefinition` 类型
- `src/main/services/remote-ws/remote-ws-client.ts` — WebSocket 消息传输（`registerMcpTools()`、`sendMcpToolResult()`、`sendMcpToolError()`、`mcp:tool:call` 事件）

## 实现逻辑

### 正常流程

**收集工具（`collectTools()`）**
1. 清空已有工具注册表（`this.tools.clear()`）
2. 收集 AI Browser 工具（26 个）：
   - 调用 `buildAiBrowserTools(browserContext)` 获取 `SdkMcpToolDefinition[]`
   - 将每个工具的 handler 存入 `this.tools` Map（key=工具名，value={handler, serverName}）
   - 将元数据（name、description、inputSchema、serverName）序列化为 `AicoBotMcpToolDef[]`
3. 收集 GitHub Search 工具（8 个）：
   - 调用 `buildGhSearchTools()` 获取工具定义
   - 同上方式注册和序列化
4. 返回所有序列化工具定义，供 WebSocket 传输

**注册到远程（`RemoteWsClient.registerMcpTools()`）**
1. 将工具定义数组和能力标识（`AicoBotMcpCapabilities`）通过 `mcp:tools:register` 消息发送
2. 发送成功后标记 `_mcpToolsRegistered = true`
3. 断连后标记重置，重连时重新注册

**处理工具调用（`handleToolCall()`）**
1. 从 `this.tools` Map 查找工具 handler
2. 未找到 → 返回 `{ content: "Unknown tool", isError: true }`
3. 调用 `handler(args, null)` 执行工具
4. 字符串结果包装为 `{ content: [{ type: 'text', text: result }] }`
5. 执行异常 → 返回 `{ content: "Error executing {tool}: {message}", isError: true }`

**能力标识（`getCapabilities()`）**
- 扫描已注册工具，返回 `{ aiBrowser: boolean, ghSearch: boolean, version: 2 }`
- 远程 Proxy 据此决定是否在 Agent 中暴露对应 MCP 服务器

**添加用户 MCP 工具（`addUserMcpTools()`）**
- 预留接口，当前阶段 handler 返回 "not yet implemented" 错误
- 不覆盖已存在的工具定义

### 异常流程
1. **AI Browser 工具收集失败** — 捕获异常，日志 warn，跳过该类工具
2. **GitHub Search 工具收集失败** — 同上
3. **未知工具调用** — 返回 `isError: true` 和错误消息
4. **工具执行异常** — 捕获异常，返回 `isError: true` 和错误消息

## 涉及 API
- `AicoBotMcpBridge` 类方法：`collectTools()`、`handleToolCall()`、`getCapabilities()`、`getToolCount()`、`addUserMcpTools()`、`dispose()`
- WebSocket 消息：`mcp:tools:register`（客户端→服务端）、`mcp:tool:call`（服务端→客户端）、`mcp:tool:response`/`mcp:tool:error`（客户端→服务端）

## 涉及数据
- `AicoBotMcpToolDef` — 序列化工具定义（name、description、inputSchema、serverName）
- `AicoBotMcpCapabilities` — 能力标识（aiBrowser、ghSearch、version）
- 内部 `tools` Map — toolName -> { handler, serverName }，handler 为闭包函数，不序列化

## 变更
-> changelog.md
