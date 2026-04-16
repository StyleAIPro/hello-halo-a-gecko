# 功能 — app-chat

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：prd/automation-platform-v1.md
> 所属模块：modules/automation/automation-platform-v1

## 描述

基于对话的 App 交互与 MCP 集成。提供两个核心能力：

1. **App Chat（交互式对话）**：用户可以与已安装 App 的 AI Agent 进行实时聊天，复用主 Agent 的完整流式处理能力（思考、工具调用、token 追踪、中断），区别于自动化模式使用 `report_to_user`，聊天模式直接以文本形式与用户交互。

2. **Conversation MCP（对话内 App 管理）**：通过 MCP 服务器将 App 管理工具暴露给主聊天 Agent，用户可以在普通对话中通过自然语言让 AI 完成 App 的列表、创建、删除、暂停、恢复、手动触发等操作。

## 依赖

- `apps/manager` — AppManagerService 提供已安装 App 的数据和状态管理
- `apps/runtime` — AppRuntimeService 提供激活、触发、状态查询
- `apps/spec` — AppSpec 验证
- `services/agent/session-manager` — V2 会话生命周期管理（创建/复用/关闭）
- `services/agent/stream-processor` — 流式消息处理（与主聊天共享）
- `services/agent/sdk-config` — SDK 凭证解析和选项构建
- `services/agent/control` — 生成停止控制
- `platform/memory` — MemoryService AI 记忆管理
- `services/ai-browser` — AI Browser MCP 服务和 scoped 浏览器上下文

## 实现逻辑

### 正常流程 — App Chat

1. **发送消息（sendAppChatMessage）**
   - 从 AppManager 获取 App 实例
   - 解析 API 凭证（支持 userOverrides.modelSourceId/modelId 覆盖）
   - 构建 Memory 作用域（type='app', spaceId, appId）
   - 构建聊天模式系统提示词（完整 Agent prompt + 聊天上下文覆盖 + App 指令 + 记忆）
   - 创建 MCP 服务器：aico-bot-memory（不包含 report_to_user 和 notify）
   - 若启用 AI Browser，获取或创建独立的 scoped 浏览器上下文
   - 构建 SDK 选项（使用 `app-chat:{appId}` 作为会话键）
   - 获取或创建 V2 会话（跨消息复用，提供对话连续性）
   - 设置动态思考 token（thinkingEnabled ? 10240 : null）
   - 打开 SessionWriter 持久化到 `chat.jsonl`
   - 通过 `processStream` 处理流式响应（共享主聊天的完整能力）
   - 清理活跃会话（保留 V2 会话供下次复用）

2. **停止生成（stopAppChat）**
   - 通过 `stopGeneration` 中断 V2 会话

3. **状态查询（isAppChatGenerating）**
   - 检查 activeSessions 中是否存在对应会话

4. **消息加载（loadAppChatMessages）**
   - 从 JSONL 文件读取历史消息，转换为渲染器兼容的 Message[] 格式

5. **会话状态恢复（getAppChatSessionState）**
   - 页面刷新后恢复活跃会话状态和思考内容

6. **浏览器上下文清理（cleanupAppChatBrowserContext）**
   - 在删除 App 或关闭时清理 scoped 浏览器上下文

### 系统提示词差异

聊天模式 vs 自动化模式：

| 特性 | 自动化模式（prompt.ts） | 聊天模式（prompt-chat.ts） |
|------|----------------------|--------------------------|
| 用户通信 | report_to_user MCP 工具 | 直接文本输出 |
| AskUserQuestion | 不可用 | 可用 |
| 操作模式 | 无交互后台执行 | 实时交互对话 |
| report_to_user | 每次执行必须调用 | 不使用 |
| 通知工具 | aico-bot-notify 可用 | 不包含 |

### 正常流程 — Conversation MCP

1. **MCP 服务器创建（createAicoBotAppsMcpServer）**
   - 接收 spaceId 参数，所有工具闭包捕获此 ID
   - 创建 `aico-bot-apps` MCP 服务器，包含 8 个工具

2. **提供的 MCP 工具**

   | 工具 | 功能 |
   |------|------|
   | `list_automation_apps` | 列出当前空间所有已安装 App |
   | `create_automation_app` | 创建并安装新 App（含完整的 spec 验证） |
   | `update_automation_app` | 更新 App（JSON Merge Patch 语义，支持 frequency 简写） |
   | `delete_automation_app` | 永久删除 App（停用 + 卸载） |
   | `get_automation_status` | 获取 App 完整详情（spec + 运行状态） |
   | `pause_automation_app` | 暂停 App |
   | `resume_automation_app` | 恢复 App |
   | `trigger_automation_app` | 手动触发执行 |

3. **create_automation_app 流程**
   - 解析 JSON spec 字符串
   - 强制 type='automation'，设置默认值
   - Zod 验证 spec
   - 安装到空间
   - 激活（best-effort）

4. **update_automation_app 流程**
   - 解析 JSON updates 字符串
   - 处理 frequency 简写（更新主订阅的 schedule）
   - 阻止 type 变更
   - JSON Merge Patch 合并
   - 订阅变更时 deactivate/activate 循环
   - 仅频率变更时 hot-sync 调度

5. **引导竞争处理（waitForAppManager）**
   - MCP 工具可能在 AppManager 初始化完成前被调用
   - 轮询等待最多 5 秒（200ms 间隔）

### 异常流程

1. **App 服务未初始化**：返回 `NOT_READY` 错误文本
2. **App 不存在**：返回错误文本
3. **AppManager 初始化超时**：返回 `NOT_READY`
4. **Spec 解析失败**：返回 JSON 解析错误
5. **Spec 验证失败**：返回 Zod 验证错误
6. **重复触发**：`ConcurrencyLimitError` 时返回友好提示（非 isError）
7. **V2 会话错误**：关闭会话，清理浏览器上下文，下次重建
8. **用户中断**：AbortError 静默处理

## 涉及 API

→ 无独立 HTTP API

IPC 事件：
- `app:activity_entry:new` — 新活动条目广播
- `app:status_changed` — 状态变更广播
- `agent:*` — 前端通过虚拟 conversationId `app-chat:{appId}` 订阅

## 涉及数据

→ db/schema.md（共享 automation/activity_entries）

文件系统：
- 聊天消息 JSONL：`{spacePath}/.aico-bot/apps/{appId}/runs/chat.jsonl`
- 运行消息 JSONL：`{spacePath}/.aico-bot/apps/{appId}/runs/{runId}.jsonl`

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/main/apps/runtime/app-chat.ts` | 交互式聊天核心逻辑 |
| `src/main/apps/runtime/prompt-chat.ts` | 聊天模式系统提示词构建 |
| `src/main/apps/runtime/session-store.ts` | JSONL 持久化（写入 + 读取 + 消息格式转换） |
| `src/main/apps/conversation-mcp/index.ts` | 对话内 App 管理 MCP 服务器 |

## 变更

→ changelog.md
