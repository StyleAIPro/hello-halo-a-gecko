# 模块 — Chat UI chat-ui-v1

> 版本：chat-ui-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源架构：无（初始版本）

## 职责

管理聊天界面的完整状态和渲染，包括对话列表、消息展示、流式文本显示、思考过程可视化、工具调用展示、图片附件处理、终端输出和 Hyper Space 多 Agent 面板。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Chat UI Module                            │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  chat.store.ts (Zustand)                  │   │
│  │  ┌────────────┐  ┌────────────┐  ┌──────────────────┐   │   │
│  │  │ spaceStates │  │ sessions   │  │ conversationCache│   │   │
│  │  │ (每空间元数据)│  │ (每会话状态)│  │ (LRU 对话缓存)   │   │   │
│  │  └────────────┘  └────────────┘  └──────────────────┘   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    组件树 (React)                          │   │
│  │                                                           │   │
│  │  ChatView                                                 │   │
│  │  ├── ConversationList (侧栏对话列表)                       │   │
│  │  ├── ChatHistoryPanel (历史对话面板)                        │   │
│  │  ├── WorkerTabBar (Hyper Space Worker 标签栏)              │   │
│  │  ├── MessageList (react-virtuoso 虚拟滚动)                 │   │
│  │  │   ├── MessageItem (单条消息)                            │   │
│  │  │   │   ├── ThoughtProcess (思考过程时间线)                │   │
│  │  │   │   │   └── ThinkingBlock (思考内容块)                │   │
│  │  │   │   ├── MarkdownRenderer (Markdown 渲染)              │   │
│  │  │   │   └── ToolResultViewer (工具结果展示)                │   │
│  │  │   ├── CollapsedThoughtProcess (折叠态)                  │   │
│  │  │   ├── CompactNotice (压缩通知)                          │   │
│  │  │   └── InterruptedBubble (中断气泡)                      │   │
│  │  ├── InputArea (输入区 + 底部工具栏)                       │   │
│  │  │   ├── ImageAttachmentPreview (图片预览)                 │   │
│  │  │   └── AgentMentionInput (@提及 Agent)                   │   │
│  │  ├── ScrollToBottomButton (回到底部按钮)                   │   │
│  │  ├── PermissionRequestDialog (权限请求对话框)               │   │
│  │  ├── WorkerPanel (Worker 执行面板)                         │   │
│  │  └── TokenUsageIndicator (Token 用量指示器)                │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘

外部依赖:
  → api (IPC/HTTP 适配层，调用 agent:* 通道)
  → space.store.ts (当前空间状态)
  → terminal.store.ts (终端输出状态)
  → ai-browser.store.ts (AI Browser 状态)
```

## 对外接口

### Store 暴露的状态和操作（chat.store.ts）

| 方法/状态 | 输入 | 输出 | 说明 |
|-----------|------|------|------|
| `sendMessage` | `{ spaceId, conversationId, message, images?, thinkingEnabled?, aiBrowserEnabled?, agentId? }` | `void` | 发送消息（主入口） |
| `stopGeneration` | `conversationId?` | `void` | 停止当前生成 |
| `selectConversation` | `spaceId, conversationId` | `void` | 选择并加载对话 |
| `listConversations` | `spaceId` | `ConversationMeta[]` | 列出对话元数据 |
| `createConversation` | `spaceId, title?` | `Conversation` | 创建新对话 |
| `deleteConversation` | `spaceId, conversationId` | `void` | 删除对话 |
| `sessions` | `Map<conversationId, SessionState>` | — | 每会话运行时状态（isGenerating, thoughts, streamingContent 等） |
| `spaceStates` | `Map<spaceId, SpaceState>` | — | 每空间状态（conversations, currentConversationId） |

### Store 暴露的事件处理器

| 方法 | 对应 IPC 通道 | 说明 |
|------|--------------|------|
| `handleAgentMessage` | `agent:message` | 处理流式文本消息 |
| `handleAgentThought` | `agent:thought` | 处理思考过程条目 |
| `handleAgentThoughtDelta` | `agent:thought-delta` | 处理思考过程增量 |
| `handleAgentToolCall` | `agent:tool-call` | 处理工具调用 |
| `handleAgentToolResult` | `agent:tool-result` | 处理工具结果 |
| `handleAgentError` | `agent:error` | 处理错误 |
| `handleAgentComplete` | `agent:complete` | 处理生成完成 |
| `handleAgentCompact` | `agent:compact` | 处理上下文压缩通知 |
| `handleAskQuestion` | `agent:ask-question` | 处理 Agent 提问 |

## 内部组件

| 组件 | 职责 | 文件 |
|------|------|------|
| chat.store.ts | 聊天核心状态管理（Zustand store），管理对话列表、消息、会话状态、流式内容、思考过程 | `renderer/stores/chat.store.ts` |
| ChatView | 聊天主界面容器，整合 MessageList + InputArea + WorkerTabBar | `renderer/components/chat/ChatView.tsx` |
| MessageList | 消息列表，使用 react-virtuoso 虚拟滚动，管理流式气泡动画 | `renderer/components/chat/MessageList.tsx` |
| MessageItem | 单条消息展示（用户/助手），包含思考过程、工具结果、文件变更摘要 | `renderer/components/chat/MessageItem.tsx` |
| InputArea | 消息输入区（自动调整高度、快捷键、图片粘贴、底部工具栏） | `renderer/components/chat/InputArea.tsx` |
| ThinkingBlock | 思考内容展示（可折叠） | `renderer/components/chat/ThinkingBlock.tsx` |
| ThoughtProcess | 思考过程时间线（完整展开视图，含嵌套 Worker 时间线） | `renderer/components/chat/ThoughtProcess.tsx` |
| CollapsedThoughtProcess | 思考过程折叠视图（延迟加载） | `renderer/components/chat/CollapsedThoughtProcess.tsx` |
| MarkdownRenderer | Markdown 内容渲染 | `renderer/components/chat/MarkdownRenderer.tsx` |
| ToolResultViewer | 工具结果展示路由器（代码/文件列表/JSON/搜索结果等） | `renderer/components/chat/tool-result/` |
| ImageAttachmentPreview | 图片附件预览 | `renderer/components/chat/ImageAttachmentPreview.tsx` |
| ScrollToBottomButton | 回到底部浮动按钮 | `renderer/components/chat/ScrollToBottomButton.tsx` |
| WorkerTabBar / WorkerPanel | Hyper Space Worker 标签栏和执行面板 | `renderer/components/chat/WorkerTabBar.tsx`, `WorkerPanel.tsx` |
| WorkerTabBar / WorkerView | Worker 视图组件 | `renderer/components/chat/WorkerTabBar.tsx` |
| PermissionRequestDialog | 工具权限请求对话框 | `renderer/components/chat/PermissionRequestDialog.tsx` |
| AskUserQuestionCard | Agent 提问卡片 | `renderer/components/chat/AskUserQuestionCard.tsx` |
| TokenUsageIndicator | Token 用量指示器 | `renderer/components/chat/TokenUsageIndicator.tsx` |
| CompactNotice | 上下文压缩通知条 | `renderer/components/chat/CompactNotice.tsx` |
| InterruptedBubble | 中断消息气泡 | `renderer/components/chat/InterruptedBubble.tsx` |
| ConversationList | 对话列表（侧栏） | `renderer/components/chat/ConversationList.tsx` |
| ChatHistoryPanel | 历史对话面板 | `renderer/components/chat/ChatHistoryPanel.tsx` |
| AgentMentionInput | @提及 Agent 输入组件 | `renderer/components/chat/AgentMentionInput.tsx` |
| thought-utils | 思考过程工具函数（操作摘要、步骤计数） | `renderer/components/chat/thought-utils.ts` |
| CanvasTabs / ContentCanvas | 内容画布标签和视图容器 | `renderer/components/canvas/` |
| canvas.store | 画布前端状态管理（活跃视图、视图切换） | `renderer/stores/canvas.store.ts` |
| SearchPanel / SearchHighlightBar | 搜索面板和高亮条 | `renderer/components/search/` |
| search.store | 搜索前端状态管理 | `renderer/stores/search.store.ts` |
| search.service | 搜索后端服务 | `services/search.service.ts` |
| ArtifactCard / ArtifactRail / ArtifactTree | 产物展示卡片/侧栏/树 | `renderer/components/artifact/` |
| artifact.service | 产物后端服务（缓存、管理） | `services/artifact.service.ts` |

### 归属 Hooks

| Hook | 职责 | 文件 |
|------|------|------|
| useCanvasLifecycle | 画布生命周期管理 | `renderer/hooks/useCanvasLifecycle.ts` |
| useSearchNavigation | 搜索结果滚动定位与 DOM 高亮 | `renderer/hooks/useSearchNavigation.ts` |
| useSearchShortcuts | 搜索快捷键 | `renderer/hooks/useSearchShortcuts.ts` |
| useWorkerTabs | Worker tab 构建、未读追踪、tab 切换 | `renderer/hooks/useWorkerTabs.ts` |
| useMentionSystem | @mention 自动补全与键盘导航 | `renderer/hooks/useMentionSystem.ts` |
| useSlashCommand | 斜杠命令自动补全、键盘导航、命令执行 | `renderer/hooks/slash-command/useSlashCommand.ts` |
| useImageAttachments | 图片粘贴/拖拽/选择、压缩验证 | `renderer/hooks/useImageAttachments.ts` |
| useSmartScroll | 智能滚动（自动跟随/用户滚动检测） | `renderer/hooks/useSmartScroll.ts` |
| useAsyncHighlight | 异步内容高亮 | `renderer/hooks/useAsyncHighlight.ts` |
| useIsMobile | 移动端检测 | `renderer/hooks/useIsMobile.ts` |

### 归属 IPC Handler

| Handler | 文件 |
|---------|------|
| conversation | `ipc/conversation.ts` |
| search | `ipc/search.ts` |
| artifact | `ipc/artifact.ts` |

## 功能列表

| 功能 | 状态 | 文档 |
|------|------|------|
| chat-view | 已完成 | features/chat-view/design.md |
| input-area | 已完成 | features/input-area/design.md |
| message-render | 已完成 | features/message-render/design.md |
| thought-process | 已完成 | features/thought-process/design.md |
| worker-panel | 已完成 | features/worker-panel/design.md |
| canvas | 已完成 | features/canvas/design.md |
| search | 已完成 | features/search/design.md |
| artifact | 已完成 | features/artifact/design.md |

## 绑定的 API

- 无（通过 IPC 通道与主进程通信）

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始模块文档 | @moonseeker1 |
| 2026-04-19 | 新增斜杠命令框架：SlashCommandMenu 组件、useSlashCommand hook、命令注册表/执行器、/skill 系列 5 个子命令 | @MoonSeeker |
