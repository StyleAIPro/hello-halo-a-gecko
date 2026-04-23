# 功能 -- 用户输入区域

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（从现有代码逆向生成）
> 所属模块：modules/chat

## 描述

消息输入区域组件，提供文本输入、图片附件、Agent @提及、扩展思考模式切换和 AI 浏览器模式切换。布局遵循行业标准（Qwen/ChatGPT 风格），底部工具栏常驻可见，支持键盘快捷键和图片粘贴/拖放。

## 依赖

- `stores/chat.store.ts` -- 发送消息、停止生成、待处理消息队列
- `stores/space.store.ts` -- 当前空间信息和 Agent 列表
- `stores/onboarding.store.ts` -- 新用户引导模式
- `stores/ai-browser.store.ts` -- AI 浏览器状态
- `hooks/useInputHistory.ts` -- 输入历史翻阅（上/下键浏览用户消息）
- `components/chat/ImageAttachmentPreview.tsx` -- 图片附件预览
- `components/chat/AgentMentionInput.tsx` -- Agent @提及输入
- `components/chat/SlashCommandMenu.tsx` -- 斜杠命令下拉菜单
- `hooks/slash-command/` -- 斜杠命令框架（注册表、执行器、hook、内置命令）
- `utils/imageProcessor.ts` -- 图片压缩和处理

## 实现逻辑

### 正常流程

1. **文本输入**：
   a. 自动调整高度的 textarea
   b. Enter 发送消息，Shift+Enter 换行
   c. 新用户引导模式下显示欢迎提示
2. **图片处理**：
   a. 支持粘贴（Ctrl+V）、拖放和文件选择器添加图片
   b. 自动压缩：超过 20MB 的图片拒绝，最大 10 张/消息
   c. ImageAttachmentPreview 显示缩略图预览，支持删除
3. **Agent @提及**（Hyper Space）：
   a. 输入 `@` 触发 Agent 列表下拉
   b. 选择 Agent 后显示 AgentMessageBadge
   c. 发送消息时附带 agentId 参数
4. **模式切换**（底部工具栏）：
   a. 扩展思考模式（Atom 图标）：启用 Thinking mode（maxThinkingTokens=10240）
   b. AI 浏览器模式（Globe 图标）：启用 AI Browser MCP
   c. Hyper Space 信息（Boxes 图标）：显示空间类型和 Agent 数量
5. **待处理消息**：生成进行中时，新消息加入 pendingMessages 队列，显示排队数量
6. **输入历史翻阅**（useInputHistory）：
   a. 按 ArrowUp 从最新用户消息开始往前翻阅
   b. 按 ArrowDown 从较早消息往回翻阅，翻出最新时恢复草稿
   c. 仅在输入框无选中文本时生效，不干扰正常光标移动
   d. 优先级：mention > slash command > input history > send
   e. 用户手动输入、发送消息、切换对话时自动退出翻阅模式

### 异常流程

1. **图片过大**：显示错误提示，拒绝添加
2. **图片格式不支持**：过滤非图片文件
3. **发送失败**：保留输入内容不丢失

## 涉及 API

- `onSend(content, images?, thinkingEnabled?, aiBrowserEnabled?, agentId?)` -- 发送回调
- `onStop()` -- 停止生成回调
- `onClearPending()` -- 清空待处理消息

## 涉及数据

- `ImageAttachment` -- 图片附件（data、mediaType、name、size）
- `PendingMessage` -- 待处理消息（content、images、thinkingEnabled、aiBrowserEnabled、agentId）
- `AgentMember` -- Agent 成员（id、name、role、type、capabilities）

## 变更

-> changelog.md
