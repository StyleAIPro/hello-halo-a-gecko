# 功能 -- 思考过程展示

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（从现有代码逆向生成）
> 所属模块：modules/chat

## 描述

实时展示 Agent 的推理过程，包括 thinking 块（模型内部思考）、tool_use 块（工具调用及输入参数）、tool_result（工具执行结果）、text 块（中间文本）和 system 事件。支持折叠/展开、子代理嵌套时间线展示和智能滚动。

## 依赖

- `stores/chat.store.ts` -- thoughts 数据和 isThinking 状态
- `components/chat/ThoughtProcess.tsx` -- 主思考过程时间线组件
- `components/chat/CollapsedThoughtProcess.tsx` -- 折叠状态摘要
- `components/chat/ThinkingBlock.tsx` -- 单个 thinking 块展示
- `components/chat/thought-utils.ts` -- 工具函数（图标、颜色、标签、分组）
- `components/chat/tool-result/` -- 工具结果渲染器
- `components/tool/TodoCard.tsx` -- TodoWrite 任务卡片
- `hooks/useSmartScroll.ts` -- 智能滚动 Hook
- `hooks/useLazyVisible.ts` -- 懒加载可见性检测

## 实现逻辑

### 正常流程

1. **ThoughtProcess 渲染**：
   a. 从 chatStore 获取当前会话的 thoughts 数组和 isThinking 状态
   b. 使用 `groupSubagentThoughts()` 将 thoughts 分组（主线程 + 各子代理）
   c. 每个 thought 根据类型渲染不同 UI：
      - thinking：ThinkingBlock 组件，支持折叠/展开
      - tool_use：工具名称 + 输入参数 JSON + 执行状态
      - tool_result：合并到对应 tool_use 中展示
      - text：中间文本内容
      - system：系统事件通知
2. **折叠模式**（isThinking=true 时）：
   a. 使用 `getActionSummary()` 从 thought 列表末尾查找最近操作
   b. 显示操作摘要（如"正在读取 src/main/index.ts..."）
3. **流式更新**：
   a. 收到 `agent:thought` 事件时添加新 thought
   b. 收到 `agent:thought-delta` 事件时更新对应 thought 的内容/状态
   c. 工具输入 JSON 增量更新，完成时解析并标记 isReady
4. **子代理嵌套**：
   a. SDK 子代理（Agent 工具）的 thoughts 带 agentId/agentName
   b. 使用 NestedWorkerTimeline 嵌套时间线展示
   c. 子代理 thoughts 折叠到父级 tool_use thought 下

### 异常流程

1. **thought 无内容**：显示占位文本（如"准备中..."）
2. **工具输入 JSON 解析失败**：显示原始文本
3. **子代理未完成**：流结束时自动发送 worker:completed 事件

## 涉及 API

- `chatStore.handleAgentThought()` -- 处理新 thought 事件
- `chatStore.handleAgentThoughtDelta()` -- 处理 thought 增量更新

## 涉及数据

- `SessionState.thoughts: Thought[]` -- 当前会话的所有 thoughts
- `SessionState.isThinking: boolean` -- 是否正在思考中
- `Thought` -- thought 数据结构（id、type、content、toolName、toolInput、toolResult、agentId 等）
- `WorkerSessionState.thoughts` -- Worker 独立 thoughts 列表

## 变更

-> changelog.md
