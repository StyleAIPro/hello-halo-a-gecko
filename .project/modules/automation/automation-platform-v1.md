# 模块 — Automation/Digital Humans 自动化平台 automation-platform-v1

> 版本：automation-platform-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源架构：无（初始版本）

## 职责

提供 Digital Humans 自动化应用平台，包括 App 规范定义与校验、应用生命周期管理（安装/配置/暂停/恢复/卸载）、运行时执行引擎（调度/触发/执行/通知/升级）、与 Agent 的对话式 MCP 集成。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│              Automation / Digital Humans Platform                │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  spec/ — App 规范层                                       │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │   │
│  │  │ schema   │  │  parse   │  │ validate │  │  errors  │ │   │
│  │  │ (Zod)    │  │ (YAML)   │  │ (校验)   │  │ (错误)   │ │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  manager/ — 应用管理层                                    │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │   │
│  │  │ service  │  │  store   │  │migration │  │  types   │ │   │
│  │  │ (CRUD)   │  │ (持久化) │  │ (迁移)   │  │ (类型)   │ │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  runtime/ — 运行时执行层                                  │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │   │
│  │  │ service  │  │  store   │  │  execute │  │app-chat  │ │   │
│  │  │ (调度)   │  │ (活动)   │  │ (SDK调用)│  │(对话模式)│ │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │   │
│  │  │prompt    │  │session-  │  │concurr-  │  │  notify  │ │   │
│  │  │(提示词)  │  │store     │  │ency      │  │(通知工具)│ │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  conversation-mcp/ — 对话内 MCP 集成                     │   │
│  │  暴露 App 管理工具给 AI（list/create/delete/pause/        │   │
│  │  resume/trigger），使用 SDK createSdkMcpServer             │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  依赖:                                                           │
│  → platform/store (数据库)                                       │
│  → platform/scheduler (调度)                                     │
│  → platform/event-bus (事件总线)                                 │
│  → platform/memory (记忆)                                        │
│  → platform/background (后台任务)                                │
│  → services/agent (Agent 执行)                                   │
└─────────────────────────────────────────────────────────────────┘
```

## 对外接口

### IPC Handle 通道（渲染进程 → 主进程）

#### 应用管理

| 方法 | 通道名 | 输入 | 输出 | 说明 |
|------|--------|------|------|------|
| appList | `app:list` | `filter?` | `{ success, data: InstalledApp[] }` | 列出已安装的应用 |
| appGet | `app:get` | `appId` | `{ success, data: InstalledApp }` | 获取应用详情 |
| appInstall | `app:install` | `AppInstallInput (spec JSON)` | `{ success, data: { appId } }` | 安装应用 |
| appUninstall | `app:uninstall` | `{ appId }` | `{ success }` | 卸载应用 |
| appReinstall | `app:reinstall` | `{ appId }` | `{ success }` | 重新安装应用 |
| appDelete | `app:delete` | `{ appId }` | `{ success }` | 彻底删除应用 |
| appPause | `app:pause` | `appId` | `{ success }` | 暂停应用调度 |
| appResume | `app:resume` | `appId` | `{ success }` | 恢复应用调度 |
| appTrigger | `app:trigger` | `appId` | `{ success }` | 手动触发应用执行 |
| appGetState | `app:get-state` | `appId` | `{ success, data }` | 获取应用运行时状态 |
| appGetActivity | `app:get-activity` | `{ appId, limit? }` | `{ success, data }` | 获取应用活动记录 |
| appGetSession | `app:get-session` | `{ appId, sessionId }` | `{ success, data }` | 获取执行会话详情 |
| appRespondEscalation | `app:respond-escalation` | `{ appId, escalationId, response }` | `{ success }` | 响应升级请求 |
| appUpdateConfig | `app:update-config` | `{ appId, config }` | `{ success }` | 更新应用配置 |
| appUpdateFrequency | `app:update-frequency` | `{ appId, frequency }` | `{ success }` | 更新调度频率 |
| appUpdateOverrides | `app:update-overrides` | `{ appId, overrides }` | `{ success }` | 更新覆盖配置 |
| appUpdateSpec | `app:update-spec` | `{ appId, spec }` | `{ success }` | 更新应用规范 |
| appGrantPermission | `app:grant-permission` | `{ appId, permission }` | `{ success }` | 授予权限 |
| appRevokePermission | `app:revoke-permission` | `{ appId, permission }` | `{ success }` | 撤销权限 |
| appExportSpec | `app:export-spec` | `appId` | `{ success, data }` | 导出应用规范 |
| appImportSpec | `app:import-spec` | `spec JSON` | `{ success, data }` | 导入应用规范 |

#### 应用对话

| 方法 | 通道名 | 输入 | 输出 | 说明 |
|------|--------|------|------|------|
| appChatSend | `app:chat-send` | `{ appId, message, sessionId? }` | `{ success }` | 向应用发送对话消息 |
| appChatStop | `app:chat-stop` | `appId` | `{ success }` | 停止应用对话 |
| appChatStatus | `app:chat-status` | `appId` | `{ success, data }` | 获取对话状态 |
| appChatMessages | `app:chat-messages` | `{ appId, sessionId? }` | `{ success, data }` | 获取对话消息 |
| appChatSessionState | `app:chat-session-state` | `appId` | `{ success, data }` | 获取对话会话状态 |

### Renderer Event 通道（主进程 → 渲染进程）

| 通道名 | 说明 |
|--------|------|
| `app:status_changed` | 应用状态变更通知 |
| `app:activity_entry:new` | 新活动条目通知 |

## 内部组件

| 组件 | 职责 | 文件 |
|------|------|------|
| spec/schema | App 规范 Zod Schema 定义（AppSpec 类型） | `apps/spec/schema.ts` |
| spec/parse | YAML 字符串解析为 JS 对象，字段别名兼容 | `apps/spec/parse.ts` |
| spec/validate | Zod 校验，生成清晰错误信息 | `apps/spec/validate.ts` |
| spec/errors | 自定义错误类型（ParseError, ValidationError） | `apps/spec/errors.ts` |
| manager/service | AppManagerService 实现（CRUD、状态管理、数据迁移） | `apps/manager/service.ts` |
| manager/store | 应用数据持久化（数据库操作） | `apps/manager/store.ts` |
| manager/types | 应用管理类型定义（InstalledApp, AppStatus, RunOutcome） | `apps/manager/types.ts` |
| runtime/service | AppRuntimeService 实现（调度集成、执行引擎、通知、升级） | `apps/runtime/service.ts` |
| runtime/execute | SDK 执行逻辑（复用 stream-processor、会话管理） | `apps/runtime/execute.ts` |
| runtime/app-chat | 对话模式（用户直接与 App Agent 对话） | `apps/runtime/app-chat.ts` |
| runtime/session-store | 执行会话存储（JSONL 持久化） | `apps/runtime/session-store.ts` |
| runtime/store | 活动记录存储 | `apps/runtime/store.ts` |
| runtime/prompt | 系统提示词构建 | `apps/runtime/prompt.ts` |
| runtime/prompt-chat | 对话模式提示词构建 | `apps/runtime/prompt-chat.ts` |
| runtime/concurrency | 并发控制 | `apps/runtime/concurrency.ts` |
| runtime/notify-tool | 通知 MCP 工具 | `apps/runtime/notify-tool.ts` |
| runtime/report-tool | 报告 MCP 工具 | `apps/runtime/report-tool.ts` |
| conversation-mcp | 对话内 MCP 服务器（暴露 App 管理工具给 AI） | `apps/conversation-mcp/index.ts` |

## 功能列表

| 功能 | 状态 | 文档 |
|------|------|------|
| app-spec | 已完成 | features/app-spec/design.md |
| app-lifecycle | 已完成 | features/app-lifecycle/design.md |
| app-runtime | 已完成 | features/app-runtime/design.md |
| app-chat | 已完成 | features/app-chat/design.md |
| notification-channels | 已完成 | features/notification-channels/design.md |

## 绑定的 API

- 无（通过 IPC 通道暴露接口）

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始模块文档 | @moonseeker1 |
