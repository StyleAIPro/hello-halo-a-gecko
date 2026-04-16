# 功能 -- 主聊天视图与消息列表

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（从现有代码逆向生成）
> 所属模块：modules/chat

## 描述

聊天的主视图组件和消息列表展示。ChatView 是用户与 AI Agent 交互的核心界面，编排消息列表、输入区域、Worker 标签栏和滚动控制。MessageList 使用 react-virtuoso 实现虚拟滚动，支持大量消息的高性能渲染。ChatHistoryPanel 提供对话历史搜索和导航。

## 依赖

- `stores/chat.store.ts` -- 聊天状态管理（Zustand）
- `stores/space.store.ts` -- 空间状态（当前空间、空间类型）
- `components/chat/InputArea.tsx` -- 消息输入区域
- `components/chat/MessageList.tsx` -- 消息列表虚拟滚动
- `components/chat/MessageItem.tsx` -- 单条消息渲染
- `components/chat/WorkerTabBar.tsx` / `WorkerView.tsx` -- Worker 标签和视图
- `components/chat/ScrollToBottomButton.tsx` -- 滚动到底部按钮
- `components/chat/ConversationList.tsx` -- 对话列表（侧边栏）
- `components/chat/ChatHistoryPanel.tsx` -- 对话历史搜索面板

## 实现逻辑

### 正常流程

1. **ChatView 渲染**：
   a. 从 chatStore 获取当前对话、会话状态
   b. 从 spaceStore 获取当前空间和空间类型
   c. 判断是否为 Hyper Space（显示 Worker 标签栏和任务板）
   d. 布局模式：全宽模式（默认）和紧凑模式（Canvas 打开时）
2. **消息发送**：
   a. 用户输入消息后调用 `chatStore.sendMessage()`
   b. 通过 IPC 调用主进程的 `sendMessage`
   c. 更新会话状态为 generating
3. **停止生成**：调用 `chatStore.stopGeneration()`，通过 IPC 中断主进程会话
4. **消息列表渲染**（MessageList）：
   a. 使用 react-virtuoso 虚拟滚动，仅渲染可见区域的消息
   b. 智能自动滚动：用户浏览历史时停止自动滚动，新消息时显示"滚动到底部"按钮
   c. 每条消息由 MessageItem 组件渲染（区分用户/AI 消息、工具调用、错误状态）
5. **对话切换**：
   a. 用户点击侧边栏对话时更新 `currentConversationId`
   b. 按需加载完整对话数据（LRU 缓存，最多 10 条）
   c. 保留跨空间会话状态

### 异常流程

1. **中断消息**：显示 InterruptedBubble 组件，提供"继续"按钮
2. **错误消息**：显示错误气泡，包含错误详情
3. **新用户引导**：Onboarding 模式下显示模拟 AI 响应

## 涉及 API

- `chatStore.sendMessage()` -- 发送消息
- `chatStore.stopGeneration()` -- 停止生成
- `chatStore.continueAfterInterrupt()` -- 中断后继续
- `chatStore.answerQuestion()` -- 回答 AskUserQuestion

## 涉及数据

- `chatStore.sessions: Map<conversationId, SessionState>` -- 每对话运行时状态
- `chatStore.spaceStates: Map<spaceId, SpaceState>` -- 每空间对话元数据
- `chatStore.conversationCache: Map<conversationId, Conversation>` -- LRU 对话缓存

## 变更

-> changelog.md
