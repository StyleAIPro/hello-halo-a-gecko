# Changelog

## [Unreleased]

### Fixed
- BUG-001: AskUserQuestion 工具导致 Bot 卡死 — `src/main/services/agent/permission-handler.ts`、`src/renderer/stores/chat.store.ts`
- BUG-001: MAX_IMAGES 未定义导致 InputArea 崩溃 — `src/renderer/hooks/useImageAttachments.ts`、`src/renderer/components/chat/InputArea.tsx`
- BUG-001: sessionId 未定义导致 sendMessage 崩溃 — `src/main/services/agent/session-manager.ts`

### Added
- 文档模块：skill（3 功能）、terminal（2 功能）、health（2 功能）、ai-sources（2 功能）、notification（2 功能）、settings（3 功能）、onboarding（2 功能）、observability（2 功能） — `.project/modules/`
- 功能文档：chat/canvas、chat/search、chat/artifact、ai-browser/electron-browser-view — `.project/modules/chat/features/`、`.project/modules/ai-browser/features/`
- 填充 6 个现有模块的「功能列表」表 — `.project/modules/*/`

### Refactored
- 提取 git-bash 业务逻辑到 service 层（状态检测、安装流程、跳过/完成），IPC handler 仅做转发 — `src/main/ipc/git-bash.ts`、`src/main/services/git-bash.service.ts`
- 提取 remote-deploy fs/update 编排到 service 层（listRemoteFiles、readRemoteFile、writeRemoteFile、deleteRemoteFile、updateAgent） — `src/main/ipc/remote-server.ts`、`src/main/services/remote-deploy/remote-deploy.service.ts`
- 提取浏览器上下文菜单构建到独立 service（buildBrowserContextMenu、buildCanvasTabContextMenu），IPC handler 动态导入 — `src/main/ipc/browser.ts`、`src/main/services/browser-menu.service.ts`
- config IPC handler 瘀为薄代理：getDecryptedConfig()、saveConfigAndNotify() 移入 config.service — `src/main/ipc/config.ts`、`src/main/services/config.service.ts`
- hyper-space IPC handler 瘀为薄代理：updateTeamConfig() 深合并、getTeamMembers() 双源成员列表移入 orchestrator — `src/main/ipc/hyper-space.ts`、`src/main/services/agent/orchestrator.ts`
- chat.store 移除直接 canvasLifecycle 依赖，改用 useCanvasStore.getState()，消除重复 buildCanvasContext — `src/renderer/stores/chat.store.ts`
- RemoteServersSection 4 个 window.electron.ipcRenderer 事件迁移至 api 层（preload 暴露 + transport methodMap + api 导出） — `src/preload/index.ts`、`src/renderer/api/transport.ts`、`src/renderer/api/index.ts`、`src/renderer/components/settings/RemoteServersSection.tsx`
- 提取 useWorkerTabs hook（worker tab 构建、未读追踪、tab 切换）— `src/renderer/hooks/useWorkerTabs.ts`、`src/renderer/components/chat/ChatView.tsx`
- 提取 useSearchNavigation hook（搜索结果滚动定位、DOM 高亮、重试逻辑）— `src/renderer/hooks/useSearchNavigation.ts`
- 提取 useMentionSystem hook（@mention 自动补全、键盘导航、光标定位、targetAgentIds 同步）— `src/renderer/hooks/useMentionSystem.ts`、`src/renderer/components/chat/InputArea.tsx`
- 提取 useImageAttachments hook（图片粘贴/拖拽/文件选择、压缩、验证、错误自动清除）— `src/renderer/hooks/useImageAttachments.ts`
- 提取 useAISources hook（CRUD 编排：switch/add/update/delete source + UI 状态管理）— `src/renderer/hooks/useAISources.ts`、`src/renderer/components/settings/AISourcesSection.tsx`
- queueInjection 参数对象化（QueueInjectionOptions） — `src/main/services/agent/stream-processor.ts`、`src/main/ipc/agent.ts`、`src/main/services/agent/orchestrator.ts`
- createHyperSpaceMcpServer 参数对象化（HyperSpaceMcpOptions）— `src/main/services/agent/hyper-space-mcp.ts`、`src/main/services/agent/orchestrator.ts`
- emitHealthEvent 参数对象化（EmitHealthEventOptions），更新全部 9 个调用方 — `src/main/services/health/health-checker/event-listener.ts`、`src/main/services/health/orchestrator.ts`
- getOrCreateV2Session 参数对象化（GetOrCreateSessionOptions）— `src/main/services/agent/session-manager.ts`、`src/main/services/agent/send-message.ts`、`src/main/services/agent/orchestrator.ts`、`src/main/apps/runtime/app-chat.ts`
- 移除 agent-command.store.ts 中未实现的死代码（window.aicoBot.saveFile/showMessage）— `src/renderer/stores/agent-command.store.ts`

---

## [2.0.2] - 2026-04-14

### Added
- OpenAI 兼容路由，支持通过 OpenAI 格式接入多种模型 — `src/main/services/agent/`
- Worker 持久化机制，Hyper Space 工作进程跨会话保持 — `src/main/apps/runtime/`
- 任务看板（Taskboard），可视化追踪多 Agent 任务状态 — `src/renderer/pages/`
- 多客户端隔离，不同远程客户端独立会话空间 — `src/main/services/remote-ws/`
- GitCode 技能源，支持从 GitCode 平台安装技能 — `src/main/services/ai-sources/`
- GitHub/GitCode PR 推送与 MR 创建诊断改进 — `src/main/services/github-auth.service.ts`、`src/main/services/gitcode-auth.service.ts`
- GitHub 直接 PAT 认证（无需 gh CLI） — `src/main/services/github-auth.service.ts`
- Worker 子会话支持，工作 Agent 拥有独立对话上下文 — `src/main/services/agent/`
- 终端与思考过程 UI 改进 — `src/renderer/components/`
- 结构化日志与 WebSocket 连接池 — `src/main/services/remote-ws/`
- 远程模型选择优化，重构 ProviderSelector，改进 API 配置流程 — `src/renderer/components/`、`src/main/services/agent/`

### Changed
- 重构远程模型选择器组件，统一模型配置入口 — `src/renderer/components/`

### Fixed
- GitCode 技能安装/推送兼容性问题 — `src/main/services/ai-sources/`
- 内网环境下 GitCode/GitHub API 请求的 HTTPS 代理支持 — `src/main/services/github-auth.service.ts`、`src/main/services/gitcode-auth.service.ts`
- resolveLocalizedText 缺失 i18n 字段导致的崩溃问题，增加 null 保护 — `src/renderer/i18n/`
- 开发模式下 DevTools 以独立窗口打开 — `src/main/`
- 对话导出功能，修复空间删除和剪贴板问题 — `src/renderer/pages/`

---

## [2.0.1] - 2026-04-10

### Added
- 多目录技能支持 — `src/main/services/skill/`
- 对话导出功能 — `src/renderer/pages/`
- 自定义远程空间系统提示词 — `src/main/services/remote-deploy/`
- 使用 ConfirmDialog 替换原生弹窗 — `src/renderer/components/`
- 首页空间创建拆分为 Local/Remote/Hyper 按钮入口 — `src/renderer/pages/HomePage.tsx`
- 远程技能管理与 MCP 代理 — `src/main/services/skill/`、`src/main/services/mcp-proxy/`
- GitHub 回退机制用于技能安装，改进市场 UI — `src/main/services/ai-sources/`
- Token 白名单机制，支持多 PC 远程认证 — `src/main/services/remote-deploy/`
- GitHub 集成与 Pulse TaskCard — `src/main/components/`
- Windows DWM 清理优化，使用原生 Win32 API — `src/main/services/win32-hwnd-cleanup.ts`
- 页面过渡动画与 UI 精调 — `src/renderer/`
- Windows 开发指南文档 — `docs/`

### Changed
- 项目从 Halo 更名为 AICO-Bot — 全局
- 移除技能同步与迁移功能 — `src/main/services/skill/`

### Fixed
- 终端事件泄漏与输出重复 — `src/main/services/terminal/`
- BrowserView 在 Windows 上阻塞点击的问题 — `src/main/services/browser-view.service.ts`
- 远程部署产物中 Windows 不兼容路径的处理 — `src/main/services/remote-deploy/`
- 防止过期的 onExit 监听器关闭替换会话 — `src/main/services/agent/`
- 移除错误放置的 agent config 目录，添加 gitignore 规则 — 项目根目录
- Leader 通过 spawn_subagent 正确委派任务给 Worker — `src/main/apps/`

---

## [2.0.0] - 2026-04-08

### Added
- Hyper Space 多 Agent 编排系统，包含完整的类型定义 — `src/main/apps/`
- Hyper Space 编排器与 Worker 管理 — `src/main/apps/manager/`
- Hyper Space MCP 工具与 IPC 基础设施 — `src/main/apps/`、`src/main/ipc/`
- Hyper Space MCP 代理到远程 Agent — `src/main/services/mcp-proxy/`
- 远程 Agent 增量代码更新部署 — `src/main/services/remote-deploy/`
- Hyper Space UI 组件 — `src/renderer/pages/`
- Hyper Space 多 Agent 集成到聊天 UI — `src/renderer/stores/`
- 空间类型标识与批量服务器操作 — `src/renderer/pages/`
- Hyper Space 国际化翻译与依赖更新 — `src/renderer/i18n/`
- SDK turn injection 补丁，支持消息注入 — `src/main/services/agent/`
- 回合级消息注入实现 — `src/main/services/agent/`
- 生成过程中的消息排队机制 — `src/main/services/agent/`
- SDK 升级，改进流式传输与思考过程 UI，增强远程部署 — `src/main/services/agent/`
- Hyper Space 独立 Agent 对话重新设计 — `src/main/apps/`

### Fixed
- 增加 turn-boundary 等待时间并正确跟踪注入标志 — `src/main/services/agent/`
- 当 hasStreamEvent 为 true 时跳过文本思考累积 — `src/main/services/agent/`
- Windows 兼容性改进：终端、SSH 隧道、构建脚本 — `src/main/services/terminal/`、`src/main/services/remote-ssh/`
- 远程服务器终端输出持久化改进 — `src/main/services/remote-ws/`
- Skill Generator 重命名为 Skill Editor — `src/renderer/pages/skill/`

---

[Unreleased]: https://github.com/StyleAIPro/AICO-Bot/compare/v2.0.2...HEAD
[2.0.2]: https://github.com/StyleAIPro/AICO-Bot/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/StyleAIPro/AICO-Bot/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/StyleAIPro/AICO-Bot/releases/tag/v2.0.0
