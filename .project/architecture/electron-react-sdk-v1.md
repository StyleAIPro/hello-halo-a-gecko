# 架构 — Electron + React + Claude SDK 多进程桌面架构-v1

> 版本：electron-react-sdk-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：prd/aico-bot-v1

## 全景图

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           AICO-Bot 桌面端                                │
│                                                                          │
│  ┌──────────────┐  IPC   ┌──────────────┐        ┌──────────────────┐  │
│  │  React UI    │◄──────►│  主进程       │◄──────►│ Claude Code SDK  │  │
│  │  (渲染进程)   │ preload│  (Main)      │        │ (Agent 循环)     │  │
│  └──────┬───────┘        └──────┬───────┘        └──────────────────┘  │
│         │                       │                                       │
│  ┌──────┴───────┐              │                                       │
│  │  前端模块     │              │  ┌────────────────────────────────┐ │
│  │  chat        │              │  │        服务模块（主进程）        │ │
│  │  settings    │              │  │                                │ │
│  │  onboarding  │              │  │  ┌──────────┐ ┌─────────────┐ │ │
│  │  apps (auto) │              │  │  │  agent   │ │ ai-browser  │ │ │
│  │  skill       │              │  │  │  (核心)   │ │ (浏览器自动化)│ │ │
│  │  space       │              │  │  └──────────┘ └─────────────┘ │ │
│  └──────────────┘              │  │  ┌──────────┐ ┌─────────────┐ │ │
│                                │  │  │ terminal │ │   health    │ │ │
│                                │  │  │ (终端)    │ │ (健康监控)  │ │ │
│                                │  │  └──────────┘ └─────────────┘ │ │
│                                │  │  ┌──────────┐ ┌─────────────┐ │ │
│                                │  │  │  skill   │ │ ai-sources  │ │ │
│                                │  │  │ (技能)    │ │ (模型源)    │ │ │
│                                │  │  └──────────┘ └─────────────┘ │ │
│                                │  │  ┌──────────┐ ┌─────────────┐ │ │
│                                │  │  │  remote- │ │ notification│ │ │
│                                │  │  │  agent   │ │ (通知系统)  │ │ │
│                                │  │  │ (远程)    │ │             │ │ │
│                                │  │  └──────────┘ └─────────────┘ │ │
│                                │  │  ┌──────────┐                   │ │
│                                │  │  │automation│                   │ │
│                                │  │  │(自动化)   │                   │ │
│                                │  │  └──────────┘                   │ │
│                                │  └────────────────────────────────┘ │
│                                │                                       │
│                                │  ┌──── 基础设施 ────────────────────┐ │
│                                │  │ platform (EventBus/Scheduler/   │ │
│                                │  │  Memory/Store)                  │ │
│                                │  │ i18n (7 语言)                    │ │
│                                │  │ preload / shared / worker        │ │
│                                │  └─────────────────────────────────┘ │
│                                │                                       │
│  ┌──────────────┐                                                       │
│  │ Worker 子进程 │  文件监听，通过 IPC 上报变更                          │
│  └──────────────┘                                                       │
└──────────────────────────────────────────────────────────────────────────┘

                                         ┌──────────────────────────┐
                                         │ packages/remote-agent-   │
                                         │ proxy (独立 Node.js 服务) │
                                         │ 远程 Claude 访问代理      │
                                         └──────────────────────────┘
```

## 技术栈

| 层级 | 选型 | 版本 | 理由 |
|------|------|------|------|
| 桌面框架 | Electron | — | 跨平台桌面应用，支持 macOS/Windows/Linux |
| 构建工具 | electron-vite | — | Electron 优化的 Vite 构建管线 |
| 前端框架 | React | ^18.2.0 | 函数组件 + Hooks 范式 |
| 状态管理 | Zustand | ^4.5.0 | 轻量、按功能拆分 store |
| 编程语言 | TypeScript (strict) | — | 类型安全，禁止 `any`，使用 `unknown` |
| 样式方案 | Tailwind CSS + CSS 变量 | — | 主题色通过 CSS 变量控制 |
| AI SDK | @anthropic-ai/claude-agent-sdk | ^0.2.97 | Claude Code V2 会话 API |
| 国际化 | i18next + react-i18next | ^25.7.4 / ^16.5.2 | 支持 7 种语言 |
| 数据库 | better-sqlite3 | ^12.6.2 | 本地嵌入式数据库 |
| 终端模拟 | node-pty + @xterm/xterm | ^1.1.0 / ^6.0.0 | 真实终端模拟 |
| WebSocket | ws | ^8.18.3 | 远程 Agent 通信 |
| SSH 隧道 | ssh2 | ^1.15.0 | 远程服务器安全连接 |
| 代码高亮 | CodeMirror 6 + highlight.js | ^6.x | 多语言语法高亮 |
| HTTP 服务 | Express | ^5.1.0 | 远程 Web 访问端点 |
| 代码校验 | ESLint + Prettier | — | 代码风格统一 |

## 模块划分

### 业务模块（14 个，均有独立文档）

| 模块 | 职责 | 设计文档 |
|------|------|---------|
| agent | Agent 会话管理、SDK 集成、消息处理、流式传输、权限控制 | modules/agent/{features} |
| chat | 聊天界面，消息展示、输入、搜索、画布、产物、思考过程 | modules/chat/{features} |
| space | 工作空间管理，支持本地/远程/Hyper 三种空间类型 | modules/space/{features} |
| ai-browser | AI 浏览器自动化 + Electron BrowserView 管理 | modules/ai-browser/{features} |
| remote-agent | 远程 Agent：SSH 隧道、WebSocket 客户端、远程部署、MCP 桥接 | modules/remote-agent/{features} |
| automation | Digital Humans 自动化平台：App 规范、生命周期、执行引擎 | modules/automation/{features} |
| skill | 技能系统：编辑器、市场、GitHub/GitCode 技能源 | modules/skill/{features} |
| terminal | 终端服务：进程网关、输出存储、终端 UI | modules/terminal/{features} |
| health | 健康监控：检查器、进程守护、自动恢复 | modules/health/{features} |
| ai-sources | AI 模型源管理：提供商适配、凭证管理、源切换 | modules/ai-sources/{features} |
| settings | 设置系统：全局配置、外观、远程访问、系统设置 | modules/settings/{features} |
| onboarding | 引导与初始化：新手引导、API 配置、Git Bash 安装 | modules/onboarding/{features} |

### 基础设施（无独立模块文档）

| 模块 | 职责 | 说明 |
|------|------|------|
| platform | 后台基础设施：事件总线、调度器、记忆系统、应用商店注册表 | `src/main/platform/` |
| i18n | 国际化，7 种语言翻译管理（en, zh-CN, zh-TW, ja, fr, es, de） | `src/renderer/i18n/` |
| preload | IPC 桥接，暴露 `window.aicoBot` API | `src/preload/` |
| analytics / perf | 可观测性：用户分析、性能监控（归属 agent 模块） | `src/main/services/analytics/`、`src/main/services/perf/` |
| notify-channels | 通知渠道：邮件/钉钉/飞书/企微/Webhook（归属 automation 模块） | `src/main/services/notify-channels/` |
| shared | 前后端共享类型和常量 | `src/shared/` |

## 通信方式

### IPC 通信（主进程 <-> 渲染进程）

主进程与渲染进程通过 Preload 桥接的 IPC 通道通信：

- **渲染进程 -> 主进程**：通过 `src/renderer/api/` 中的 `api.*` 方法调用，内部通过 `window.aicoBot.xxx()` 发起 IPC 调用
- **主进程 -> 渲染进程**：通过 `sendToRenderer('event-name', ...args)` 推送事件

IPC 通道名使用 `src/shared/constants/` 中的常量定义，禁止硬编码字符串。所有 IPC handler 必须包含 try/catch，返回 `{ success, data/error }` 结构。

添加新 IPC 端点需更新 3 个文件：
1. `src/preload/index.ts` — 暴露到 `window.aicoBot`
2. `src/renderer/api/transport.ts` — 在 `onEvent()` 中添加到 `methodMap`
3. `src/renderer/api/index.ts` — 导出为 `api.xxx`

### 双模式渲染器 API

`src/renderer/api/` 层以两种模式工作：
- **Electron 模式**：通过 IPC preload 桥调用 `window.aicoBot.xxx()`
- **远程 Web 模式**：调用 HTTP 端点 + WebSocket 事件

`transport.ts` 通过 `isElectron()`（检查 `window.aicoBot` 是否存在）自动检测模式。

### 远程 Agent 通信流程

```
远程服务器 (stream-processor.ts) -> 本地客户端 (send-message.ts) -> 前端 (chat.store.ts)
  SDK stream_event                    RemoteWsClient 事件              Zustand store 更新
  |- thinking start ----------------> 'thought' 事件 --------------> handleAgentThought()
  |- thinking delta ----------------> 'thought:delta' 事件 ---------> handleAgentThoughtDelta()
  +- thinking stop -----------------> (完成信号) ------------------> thought.isStreaming = false
```

关键配置：
- `space.claudeSource === 'remote'` 触发远程执行
- `space.remoteServerId` 标识目标服务器
- `space.useSshTunnel`（默认 true）决定连接模式

### SDK 集成

使用 `@anthropic-ai/claude-agent-sdk` V2 会话（`src/main/services/agent/session-manager.ts`）：
- `unstable_v2_createSession()` — 创建新会话
- `unstable_v2_resumeSession()` — 恢复已有会话

SDK 关键选项（`src/main/services/agent/sdk-config.ts`）：
- `model` — 从配置动态读取，不硬编码
- `cwd` — 工作目录
- `permissionMode: 'bypassPermissions'`
- `includePartialMessages: true`

## 全局约束

### 两阶段启动

应用通过 `src/main/bootstrap/` 分两阶段启动：

**阶段一（Essential）**：同步初始化，目标 < 500ms
- Config：应用配置（API Key、设置）
- Space：工作空间管理（首页侧栏展示）
- Conversation：聊天记录（核心功能）
- Agent：消息处理（核心功能）
- Artifact：文件管理（侧栏展示）
- System：窗口控制（基础功能）
- Updater：自动更新检查
- Auth：OAuth 认证

**阶段二（Extended）**：延迟到 `ready-to-show` 之后异步加载
- Onboarding、Remote、Browser、AI Browser、Overlay、Search、Perf、GitBash
- Platform 子系统：Store、Scheduler、EventBus、Memory
- Digital Humans 平台：AppManager、AppRuntime
- Health 健康检查、MCP 代理服务、Terminal Gateway

### 代码规范

- TypeScript strict 模式，禁止 `any`（用 `unknown`），纯类型导入使用 `import type`
- IPC 通道名使用 `src/shared/constants/` 常量，禁止硬编码
- Preload 禁止暴露原始 `ipcRenderer`
- React 只允许函数组件，Zustand 按功能拆分 store
- 命名：文件夹 kebab-case，组件 PascalCase，接口不加 `I` 前缀
- 所有用户可见字符串必须使用 `t()` 国际化函数
- Tailwind 样式使用 CSS 变量主题色，禁止硬编码颜色值

### 路径别名

- `@/` -> `src/renderer/`（渲染进程代码）
- `@main/` -> `src/main/`（测试用）
- `@shared` -> `src/shared/`（测试用）

### 提交规范

使用 conventional commits（中文描述）：`feat:`、`fix:`、`docs:`、`style:`、`refactor:`、`chore:`

### 数据目录

- `~/.aico-bot/` — 用户数据目录（对话、设置、空间）
- `~/.aico-bot-dev/` — 开发模式数据目录（`npm run dev` 使用）

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始架构文档，描述 Electron + React + Claude SDK 多进程架构 | @moonseeker1 |
| 2026-04-16 | 模块划分更新：从 6 个扩展到 14 个业务模块 + 4 个基础设施模块，全景图同步更新 | @moonseeker1 |
