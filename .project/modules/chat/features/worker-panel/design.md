# 功能 -- Worker 代理面板与标签栏

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（从现有代码逆向生成）
> 所属模块：modules/chat

## 描述

Hyper Space 中 Worker 代理的实时工作状态展示。包含 WorkerTabBar（标签栏切换）、WorkerPanel（单个 Worker 面板）和 WorkerView（标签页视图），显示每个 Worker 的思考过程、流式回复内容、任务状态和 AskUserQuestion 交互。

## 依赖

- `stores/chat.store.ts` -- WorkerSessionState 数据和交互方法
- `components/chat/WorkerPanel.tsx` -- 单个 Worker 面板
- `components/chat/WorkerTabBar.tsx` -- Worker 标签栏和标签页视图
- `components/chat/ThoughtProcess.tsx` -- 思考过程时间线
- `components/chat/MarkdownRenderer.tsx` -- Markdown 渲染
- `components/chat/AskUserQuestionCard.tsx` -- 用户问答卡片

## 实现逻辑

### 正常流程

1. **WorkerTabBar 渲染**：
   a. 从 chatStore 获取当前会话的 workerSessions Map
   b. 为每个活跃 Worker 创建标签（显示名称、状态图标）
   c. 支持标签切换，显示对应 Worker 的 WorkerView
2. **WorkerPanel 渲染**：
   a. 头部：状态图标（运行中/完成/失败）+ Worker 名称 + 任务描述
   b. 可折叠的 ThoughtProcess（Worker 的独立思考过程）
   c. 流式回复内容（MarkdownRenderer）
   d. AskUserQuestion 卡片（当 Worker 需要用户输入时）
3. **Worker 会话状态管理**：
   a. `worker:started` 事件创建 WorkerSessionState
   b. `agent:thought` / `agent:thought-delta` 事件带 agentId 时路由到对应 Worker
   c. `agent:message` 事件更新 Worker 流式内容（节流更新避免性能问题）
   d. `worker:completed` 事件标记完成状态
   e. mention 模式：Worker 输出同时显示在主对话和 Worker 标签
   f. delegation 模式：Worker 输出仅在 Worker 标签中显示
4. **标签页恢复**：页面刷新后通过 `getWorkerSessionStates()` 恢复 Worker 标签状态

### 异常流程

1. **Worker 失败**：显示红色失败图标和错误信息
2. **AskUserQuestion 超时**：Worker 未收到回答时继续执行
3. **mention 模式 Worker 完成**：发送 worker:completed 事件，主对话中保持内联内容

## 涉及 API

- `chatStore.answerWorkerQuestion(agentId, answers)` -- 回答 Worker 的 AskUserQuestion
- `chatStore.handleWorkerStarted()` / `handleWorkerCompleted()` -- Worker 生命周期事件处理

## 涉及数据

- `WorkerSessionState` -- Worker 会话运行时状态（agentId、agentName、taskId、status、streamingContent、thoughts、interactionMode、pendingQuestion、turnStartedAt）
- `workerSessions: Map<agentId, WorkerSessionState>` -- 每会话的 Worker 状态映射
- `WorkerConversationMeta` -- Worker 对话元数据（用于侧边栏显示）

## 变更

-> changelog.md
