# 功能 -- 消息渲染

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（从现有代码逆向生成）
> 所属模块：modules/chat

## 描述

聊天消息的富文本渲染系统，包括 Markdown 渲染、代码高亮、图片查看、工具调用结果展示和流式文本气泡。MessageItem 是消息渲染的核心组件，根据消息角色和内容类型选择不同的渲染策略。

## 依赖

- `components/chat/MarkdownRenderer.tsx` -- Markdown 渲染（代码高亮、表格、链接）
- `components/chat/ImageViewer.tsx` -- 图片查看器（缩放、拖拽）
- `components/chat/ImageAttachmentPreview.tsx` -- 图片附件预览
- `components/chat/InterruptedBubble.tsx` -- 中断消息气泡
- `components/chat/CompactNotice.tsx` -- 上下文压缩通知
- `components/chat/TokenUsageIndicator.tsx` -- Token 用量显示
- `components/chat/tool-result/` -- 工具调用结果渲染器集合
- `components/chat/AgentMessageBadge.tsx` -- Agent 角色徽章

## 实现逻辑

### 正常流程

1. **MessageItem 渲染决策**：
   a. 用户消息：渲染文本 + 图片附件
   b. AI 消息（有内容）：渲染 MarkdownRenderer
   c. AI 消息（流式中）：渲染流式文本气泡（StreamingBubble）
   d. AI 消息（有错误）：渲染错误状态
   e. Hyper Space 消息：显示 Agent 角色/名称徽章
2. **MarkdownRenderer**：
   a. 解析 Markdown 语法（标题、列表、代码块、表格、链接）
   b. 代码块语法高亮
   c. 安全渲染（XSS 防护）
3. **工具结果渲染**（tool-result/ 目录）：
   a. `ToolResultViewer` -- 根据工具类型分发到专用渲染器
   b. `CodeResultViewer` -- 代码输出
   c. `DiffResultViewer` -- 文件差异
   d. `FileListViewer` -- 文件列表
   e. `JsonResultViewer` -- JSON 结构化展示
   f. `MarkdownResultViewer` -- Markdown 格式结果
   g. `SearchResultViewer` -- 搜索结果
   h. `PlainTextViewer` -- 纯文本
   i. `detection.ts` -- 工具输出类型自动检测
4. **ImageViewer**：全屏图片查看，支持缩放和拖拽
5. **TokenUsageIndicator**：显示输入/输出 Token 用量和上下文占比

### 异常流程

1. **Markdown 解析失败**：降级为纯文本渲染
2. **图片加载失败**：显示错误占位符
3. **工具输出格式不识别**：降级为 PlainTextViewer

## 涉及 API

- `chatStore` -- 消息数据和流式内容

## 涉及数据

- `Message` -- 消息数据结构（role、content、thoughts、images、toolCalls、metadata）
- `Artifact` -- 生成物数据（代码、HTML 等）
- `FileChangesSummary` -- 文件变更摘要（metadata.fileChanges）

## 变更

-> changelog.md
