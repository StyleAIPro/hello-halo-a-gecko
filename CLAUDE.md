# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 提供项目代码指引。

## 项目概述

AICO-Bot 是一个开源 Electron 桌面应用，将 Claude Code 的 AI Agent 能力封装为可视化跨平台界面。用户无需使用终端即可与 AI Agent 交互。2.x 版本包含 Digital Humans 自动化平台。

## 开发流程

> 详细工作流见 [ai-development-workflow.md](./docs/ai-development-workflow.md)

```
需求 → PRD(subagent写) → 文档预读 → 编码 → 自测 → 文档更新 → 提交
```

### 铁律

1. **无 PRD 拒绝工作**：需求开发和 bug 修改都必须先有 PRD，无一例外
2. **PRD 用 subagent 写**：Agent 创建 subagent 写 PRD，主 agent 在开发时读取 PRD 文件
3. **编码前必读文档**：必须先读取 PRD「开发前必读」中列出的所有文档，跳过 = 违规
4. **一个 PRD 一个 commit**：commit message 引用 PRD 路径，禁止不相关变更堆叠
5. **精准增量更新文档**：只更新 PRD 涉及文件对应的文档，不做全量同步

### PRD 状态流转

`draft` → `confirmed`（人确认）→ `in-progress`（开始编码）→ `done`（验收通过）

### 步骤详解

#### 步骤 1：需求提出（人）

人描述需求（新功能 / Bug / 重构），Agent 用 AskUserQuestion 补充：
- 归属哪个模块？
- 优先级？（P0 / P1 / P2）
- 影响范围？（仅前端 / 仅后端 / 全栈）

#### 步骤 2：PRD 编写（Agent subagent）

1. 判断 PRD 级别：bugfix / feature / module / project
2. 搜索 `.project/prd/` 已有 PRD，存在则升版本而非新建
3. **搜索相关文档**（subagent 写 PRD 前必须执行）：
   - 搜索 `.project/modules/` 找到相关模块的概述文档、功能 design.md / changelog.md / bugfix.md
   - 搜索 `.project/api/` 找到相关 API 文档
   - 搜索 `src/` 找到需修改的源码文件
4. **Subagent 独立写 PRD**（中文），必须包含：
   - 元信息（时间戳、状态、指令人）
   - 需求分析 / 问题根因
   - 技术方案
   - **开发前必读**（分类表格：模块设计文档 / 源码文件 / API 文档 / 编码规范，每项注阅读目的）
   - **涉及文件**（预估，开发后更新为实际）
   - **验收标准**（可逐条打勾）
5. 人确认 → PRD 状态改为 `confirmed`

#### 步骤 3：文档预读（Agent）

读取 PRD「开发前必读」中列出的所有文档，建立上下文：
- **模块设计文档** → 理解模块职责、对外接口、内部组件
- **功能 design.md** → 理解实现逻辑、正常/异常流程
- **changelog.md** → 了解最近变更，避免回归
- **bugfix.md** → 了解已知问题，避免重复踩坑

根据预读结果确认技术方案是否需要调整，发现问题向人提出。

#### 步骤 4：编码（Agent）

1. PRD 状态 → `in-progress`
2. 按 PRD 技术方案编码
3. 每个文件编辑后：**re-read 确认逻辑未被覆盖**（Windows 行尾问题）
4. 编码完成后更新 PRD「涉及文件」为实际修改清单
5. 跨模块变更时，用 TaskList 逐模块追踪进度

#### 步骤 5：自测（Agent + 人）

Agent 自动检查（必须全部通过）：
```bash
npm run typecheck && npm run build
```
涉及新用户可见文本时：`npm run i18n`

人功能验证：按 PRD「验收标准」逐条测试。不通过 → 回步骤 2 更新 PRD。

#### 步骤 6：文档更新（Agent）

精准增量更新（只更新 PRD 涉及文件对应的文档）：

| 更新目标 | 触发条件 | 操作 |
|----------|---------|------|
| 功能 changelog.md | 每次 | 追加变更行 |
| 功能 bugfix.md | bug 修复时 | 追加 bug 记录 |
| 模块设计文档 | 涉及文件变化时 | 仅更新受影响段落 |
| API 文档 | 接口签名变化时 | 仅更新变更的接口 |
| 全局 CHANGELOG | 每次 | 追加一行 |

#### 步骤 7：提交（Agent 提交，人审核）

**一个 PRD = 一个逻辑 commit。**

```
<type>(<scope>): <中文简述>

- 改了什么、为什么改
- PRD: .project/prd/bugfix/skill/bugfix-xxx-v1.md
```

| PRD 规模 | 提交策略 |
|----------|---------|
| 小（单 bug / 单功能） | 1 commit |
| 中（2-3 层变更） | 代码 + 文档各 1 commit |
| 大（跨模块重构） | 每个子任务 1 commit |

**禁止**：不相关变更堆叠、空提交、不引用 PRD。

#### 步骤 8：收尾

- PRD 状态 → `done`，验收标准全部打勾
- Agent 生成变更摘要：做了什么、改了哪些文件、验收结果、待跟进

## 规范引用

### 文档管理

详见 [vibecoding-doc-standard.md](./docs/vibecoding-doc-standard.md)。Agent 必须遵守：

- PRD 是一切代码改动的前提，中文书写，指令人必确认
- 修改必留痕、API 必须最新、合并必解冲突
- 模块自包含，跨模块逐功能更新 changelog
- PRD 按层级分目录：`prd/project/`、`prd/module/`、`prd/feature/`、`prd/bugfix/`
- PRD 模板含：时间戳、状态、开发前必读、涉及文件、验收标准

### 编码规范

详见 [Development-Standards-Guide.md](./docs/Development-Standards-Guide.md)。核心规则：

- TypeScript strict，禁止 `any`（用 `unknown`），纯类型导入用 `import type`
- IPC 通道常量化（`src/shared/constants/`），handler 必须 try/catch + `{ success, data/error }`
- Preload 禁止暴露原始 `ipcRenderer`
- React 只允许函数组件，Zustand 按功能拆分 store
- 命名：文件夹 kebab-case，组件 PascalCase，接口不加 `I` 前缀
- UI 禁止硬编码文本（用 `t()`），Tailwind 用 CSS 变量主题色
- **编辑文件后必须 re-read 确认逻辑未被覆盖**（Windows 行尾问题）

## 构建/测试命令

```bash
# 开发
npm run dev              # 启动开发服务器（使用 ~/.aico-bot-dev 数据目录，端口 8081）

# 构建
npm run build            # 构建 proxy + electron-vite build（输出到 out/）
npm run build:mac        # 构建 macOS universal（dmg + zip）
npm run build:win        # 构建 Windows x64（nsis 安装包）
npm run build:linux      # 构建 Linux x64（AppImage）

# 国际化（提交新用户可见文本前运行）
npm run i18n             # 提取 + 翻译
npm run i18n:extract     # 仅提取 key
npm run i18n:translate   # 仅 AI 翻译

# 二进制准备
npm run prepare          # 下载当前平台的二进制文件
npm run prepare:all      # 下载所有平台的二进制文件

# 发布
npm run release:win      # 构建并发布 Windows 版本到 GitHub Releases（需 GH_TOKEN）
npm run release          # 同时构建并发布多平台版本

# 代码质量
npm run typecheck        # TypeScript 类型检查
```

### Windows 打包流程

详见 `docs/WINDOWS_DEV.md`。核心步骤：

1. **环境准备**：安装 Node.js 20.x、Python 3.x、Visual Studio Build Tools 2022+
2. **安装依赖**：`npm install`（会自动执行 postinstall 应用补丁）
3. **下载二进制**：`npm run prepare`（下载 cloudflared、gh CLI、better-sqlite3 prebuild 等）
4. **构建打包**：`npm run build:win`（构建 proxy → electron-vite build → electron-builder 打包 NSIS 安装包）
5. **发布**（可选）：在 `.env.local` 配置 `GH_TOKEN`，然后 `npm run release:win`

构建产物：
- `out/` — electron-vite 编译输出
- `dist/` — electron-builder 打包输出（`AICO-Bot Setup x.x.x.exe`）

常见问题：
- 原生模块编译失败 → `npm config set msvs_version 2022 && npm install`
- better-sqlite3/node-pty 报错 → `npx electron-rebuild && npm run prepare`
- `npm run prepare` 下载失败 → 设置 `HTTPS_PROXY` 或手动下载
- `app.asar` 被占用 → 关闭所有 AICO-Bot 和 Electron 进程后再打包

### 远程 Agent Proxy 打包注意事项

`packages/remote-agent-proxy/` 会被打包进 asar 并部署到远程服务器。以下目录必须包含在 `package.json` 的 `build.files` 中，否则远程部署会失败：

| 目录 | 用途 | 部署后行为 |
|------|------|-----------|
| `dist/**/*` | 编译后的 JS 代码 | proxy 运行入口 |
| `package.json` | 依赖声明 + `postinstall` 钩子 | `npm install` 后自动执行 `scripts/patch-sdk.mjs` |
| `scripts/**/*` | `patch-sdk.mjs` 等 | SDK 补丁脚本，`postinstall` 依赖 |

> **重要**：如果 `scripts/` 未包含在 asar 中，远程 `npm install` 会因找不到 `patch-sdk.mjs` 而失败（`MODULE_NOT_FOUND`）。
> 新增 `packages/remote-agent-proxy/` 下的子目录时，必须同步更新 `package.json` 的 `build.files`。

## 架构概述

### 多进程 Electron 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        AICO-Bot 桌面端                           │
│  ┌─────────────┐    ┌─────────────┐    ┌───────────────────┐   │
│  │   React UI  │◄──►│    主进程    │◄──►│  Claude Code SDK  │   │
│  │  (渲染进程)  │IPC │   (Main)    │    │   (Agent 循环)    │   │
│  └─────────────┘    └─────────────┘    └───────────────────┘   │
│                            │                                    │
│                            ▼                                    │
│                    ┌───────────────┐                           │
│                    │  本地文件     │                           │
│                    │  ~/.aico-bot/ │                           │
│                    └───────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

应用通过 `src/main/bootstrap/` 分两阶段启动：
- **阶段一（Essential）**：同步初始化，目标 <500ms — 空间、配置、IPC 处理器
- **阶段二（Extended）**：延迟到 `ready-to-show` 之后 — 分析、健康检查、后台服务

### 关键目录

- **`/src/main/`** — Electron 主进程
  - `services/agent/` — 核心 Agent，SDK 集成，消息处理
  - `services/ai-browser/` — AI 浏览器自动化
  - `services/ai-sources/` — AI 模型提供商配置与认证
  - `services/auth/` — 外部平台认证（GitHub、GitCode）与安全存储
  - `services/browser/` — BrowserView 管理、覆盖层、上下文菜单
  - `services/file-watcher/` — 文件监听、制品扫描与缓存
  - `services/gh-search/` — GitHub 搜索 MCP 工具
  - `services/health/` — 健康监控与崩溃恢复
  - `services/mcp-proxy/` — MCP 协议代理
  - `services/proxy/` — HTTP 代理
  - `services/remote/` — 远程基础设施集群
    - `services/remote/access/` — 远程访问协调与 Cloudflare 隧道
    - `services/remote/deploy/` — 远程 Agent 部署
    - `services/remote/ssh/` — SSH 隧道
    - `services/remote/ws/` — 远程服务器 WebSocket 客户端
  - `services/skill/` — 技能系统
  - `services/stealth/` — 浏览器指纹规避
  - `services/terminal/` — 终端管理与 Git Bash
  - `services/config.service.ts` — 应用配置（顶层基础服务）
  - `services/conversation.service.ts` — 聊天记录持久化（顶层基础服务）
  - `services/space.service.ts` — 工作空间管理（顶层基础服务）
  - `platform/` — 后台子系统（事件总线、记忆、调度、后台应用）
  - `apps/` — Digital Humans 自动化平台（规范、管理、运行时）
  - `ipc/` — IPC 处理器模块
  - `http/` — 远程访问 HTTP 服务

- **`/src/renderer/`** — React 前端
  - `components/` — UI 组件
  - `stores/` — Zustand 状态管理（`chat.store.ts` 是最核心的）
  - `api/` — 双模式 IPC/HTTP 适配层（见下方说明）
  - `pages/` — 页面组件
  - `i18n/` — 国际化（7 种语言）

- **`/src/shared/`** — 前后端共享（禁止导入 Node.js 或 Electron 模块）
  - `types/` — 共享类型定义
  - `constants/` — 共享常量

- **`/src/preload/`** — Preload 脚本，暴露 `window.aicoBot`

- **`/src/worker/`** — 文件监听器（作为独立子进程运行）

- **`/packages/remote-agent-proxy/`** — 独立 Node.js 服务，用于远程 Claude 访问

### 双模式渲染器 API

渲染器 API 层（`src/renderer/api/`）以两种模式工作：
- **Electron 模式**：方法通过 IPC preload 桥调用 `window.aicoBot.xxx()`
- **远程 Web 模式**：方法调用 HTTP 端点 + WebSocket 事件

`transport.ts` 通过 `isElectron()`（检查 `window.aicoBot`）自动检测模式。`api/index.ts` 导出统一的 `api` 对象。

### 添加 IPC 端点

添加新 IPC 通道时，更新以下 3 个文件：
1. `src/preload/index.ts` — 暴露到 `window.aicoBot`
2. `src/renderer/api/transport.ts` — 在 `onEvent()` 中添加到 `methodMap`
3. `src/renderer/api/index.ts` — 导出为 `api.xxx`

### 路径别名

- `@/` → `src/renderer/`（渲染进程代码）
- `@main/` → `src/main/`（测试用）
- `@shared` → `src/shared/`（测试用）

## 远程 Agent 架构

远程空间通过 WebSocket 代理路由：
1. **SSH 隧道**（可选）：`sshTunnelService.establishTunnel()` 创建本地端口转发
2. **WebSocket 客户端**：`RemoteWsClient` 连接远程 Agent
3. **会话恢复**：`sdkSessionId` 实现多轮对话

关键配置：
- `space.claudeSource === 'remote'` 触发远程执行
- `space.remoteServerId` 标识目标服务器
- `space.useSshTunnel`（默认：true）决定连接模式

### 远程空间思考过程流

```
远程服务器 (stream-processor.ts)    本地客户端 (send-message.ts)    前端 (chat.store.ts)
─────────────────────────────    ─────────────────────────────    ─────────────────────
SDK stream_event                 RemoteWsClient 事件              Zustand store 更新
├─ thinking start ──────────────► 'thought' 事件 ───────────────► handleAgentThought()
├─ thinking delta ──────────────► 'thought:delta' 事件 ──────────► handleAgentThoughtDelta()
└─ thinking stop ───────────────► (完成信号) ────────────────────► thought.isStreaming = false
```

## SDK 集成

使用 `@anthropic-ai/claude-agent-sdk` V2 会话（`src/main/services/agent/session-manager.ts`）：
- `unstable_v2_createSession()` — 创建新会话
- `unstable_v2_resumeSession()` — 恢复已有会话

### 关键 SDK 选项（`src/main/services/agent/sdk-config.ts`）

```typescript
{
  model: credentials.sdkModel,          // 从配置动态读取，不硬编码
  cwd: workDir,
  permissionMode: 'bypassPermissions',
  includePartialMessages: true,
}
```

## 环境变量

将 `.env.example` 复制为 `.env.local`。关键变量：
- `AICO_BOT_TEST_API_KEY`、`AICO_BOT_TEST_API_URL`、`AICO_BOT_TEST_MODEL`、`AICO_BOT_TEST_PROVIDER` — i18n 翻译
- `GH_TOKEN` — 发布 Release
- 分析变量（`AICO_BOT_GA_*`、`AICO_BOT_BAIDU_*`）— 可选，默认关闭

## 配置文件

- **`product.json`** — 构建配置和认证 Provider 定义
- **`~/.aico-bot/`** — 用户数据目录（对话、设置、空间）
- **`~/.aico-bot-dev/`** — 开发模式数据目录（`npm run dev` 使用）
- **`.env.local`** — 本地环境变量覆盖（已 gitignore）
- **`electron.vite.config.ts`** — 构建配置（main/preload/renderer 入口）
