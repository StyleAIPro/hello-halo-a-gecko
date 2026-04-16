# PRD [模块级] — 代码审计违规修复

> 版本：code-audit-refactor-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 归属模块：codebase（跨模块重构）

## 背景

基于 `Development-Standards-Guide.md` 对项目进行全面审计，发现 39 处违规，分布在 IPC 层、组件层、Store 层和函数设计四个维度。这些违规影响代码的可维护性和架构一致性，需要系统性修复。

## 需求

将审计发现的违规逐一修复，使代码符合编码规范。

### 审计发现汇总

| 维度 | 违规数 | 严重度分布 |
|------|--------|-----------|
| IPC 层：handler 含业务逻辑 | 18 | HIGH×4, MEDIUM×7, LOW×7 |
| 组件层：含业务逻辑 | 7 | SEVERE×1, MODERATE×6 |
| Store 层：绕过 api 层 | 2 | HIGH×1, LOW×1 |
| 函数设计：参数过多 | 14 | MEDIUM×14 |

## 修复清单

### 一、IPC 层重构（18 处）

**P0 — 必须修复：**

| # | 文件 | 问题 | 修复方案 |
|---|------|------|---------|
| 1 | `ipc/git-bash.ts` | `initializeGitBashOnStartup()` 70 行初始化逻辑、`setGitBashSkipped()` 在 IPC 模块 | 移入 `git-bash.service.ts`，handler 只做转发 |
| 2 | `ipc/git-bash.ts` | `git-bash:status` handler 含多分支检测逻辑 | 提取为 `gitBashService.getStatus()` |
| 3 | `ipc/remote-server.ts` | `remote-agent:fs-list` 含 `ls` 输出解析 | 移入 `deployService.listFiles()` |
| 4 | `ipc/remote-server.ts` | `remote-agent:fs-write` 含 shell 转义写文件 | 移入 `deployService.writeFile()` |
| 5 | `ipc/remote-server.ts` | `remote-server:update-agent` 55 行多步骤编排+通知 | 移入 `deployService.updateAgent()` |
| 6 | `ipc/browser.ts` | `browser:show-context-menu` 58 行菜单构建 | 提取为 `browserMenuService.buildContextMenu()` |
| 7 | `ipc/browser.ts` | `canvas:show-tab-context-menu` 65 行条件菜单构建 | 提取为 `browserMenuService.buildTabContextMenu()` |

**P1 — 应该修复：**

| # | 文件 | 问题 | 修复方案 |
|---|------|------|---------|
| 8 | `ipc/config.ts` | `config:get` 15 行解密/数据转换 | 移入 `configService.getDecryptedConfig()` |
| 9 | `ipc/config.ts` | `config:set` 20 行诊断+后保存编排 | 移入 `configService.saveAndNotify()` |
| 10 | `ipc/hyper-space.ts` | `hyper-space:update-config` 直接修改 `team.config` 深合并 | 移入 `agentOrchestrator.updateTeamConfig()` |
| 11 | `ipc/hyper-space.ts` | `hyper-space:get-members` 双源成员拼接 | 移入 `agentOrchestrator.getMembers()` |
| 12 | `ipc/hyper-space.ts` | `hyper-space:dispatch-task` 字段投影 | 移入 service 层 |
| 13 | `ipc/system.ts` | `system:get-terminal-websocket-url` URL 拼接 | 移入 service |
| 14 | `ipc/system.ts` | `terminal:get-output` 动态导入+session 查找 | 移入 service |
| 15 | `ipc/git-bash.ts` | `git-bash:install` 后安装编排 | 移入 service |

**P2 — 逐步改进：**

| # | 文件 | 问题 | 修复方案 |
|---|------|------|---------|
| 16 | `ipc/conversation.ts` | Map→Object 序列化 | service 返回可序列化对象 |
| 17 | `ipc/system.ts` | `window:toggle-maximize` 条件逻辑 | 提取为 service |
| 18 | `ipc/hyper-space.ts` | 字段投影（同 #12） | 合并处理 |

### 二、组件层重构（7 处）

| # | 文件 | 问题 | 修复方案 |
|---|------|------|---------|
| 1 | `RemoteServersSection.tsx` | 1186 行，900+ 行业务逻辑，直接 `window.electron.ipcRenderer` | 拆分 `useRemoteServers()` hook + 瘦组件，事件迁入 api 层 |
| 2 | `ChatView.tsx` | onboarding 动画编排、搜索导航 DOM、worker tab 管理 | 提取 hooks |
| 3 | `InputArea.tsx` | @mention 解析系统、图片处理管线、上下文压缩 | 提取 hooks |
| 4 | `AppChatView.tsx` | 数据加载、发送、重载编排 | 提取 `useAppChat()` hook |
| 5 | `SessionDetailView.tsx` | 轮询逻辑 | 提取 hook |
| 6 | `AISourcesSection.tsx` | Config 管理编排 | 提取 hook |
| 7 | `AgentPanel.tsx` | Agent 配置构建 | 提取 hook |

### 三、Store 层修正（2 处）

| # | 文件 | 问题 | 修复方案 |
|---|------|------|---------|
| 1 | `agent-command.store.ts` | `window.aicoBot.saveFile/showMessage` 是死代码（从未实现） | 删除死代码，直接用 `downloadMarkdown()` fallback |
| 2 | `chat.store.ts` + `canvas.store.ts` | 直接 import `services/canvas-lifecycle` | 改为通过 api 层调用 |

### 四、函数参数封装（14 处）

将参数 ≥ 5 个的函数封装为参数对象（`interface XxxOptions`），分布在 services 和 ipc 层。

## 约束

- 不改变任何外部行为和功能逻辑
- 每次修改后确认 `npm run typecheck` 通过
- 遵循编码规范中的所有规则

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 PRD | @moonseeker1 |
| 2026-04-16 | 全部 39 处违规修复完成：IPC 层 18 处（P0×7 业务逻辑移入 service、P1×8 配置/成员/URL 移入 service 或已精简）、组件层 7 处（5 个 hook 提取 + 2 个事件迁移）、Store 层 2 处、函数参数 4 个函数对象化 | @moonseeker1 |
