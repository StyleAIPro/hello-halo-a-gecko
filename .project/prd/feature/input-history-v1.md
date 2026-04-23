# PRD [功能级] -- 输入框历史记录翻阅

> 版本：input-history-v1
> 时间：2026-04-20T12:00:00+08:00
> 指令人：StyleAIPro
> 状态：done
> 归属模块：modules/chat

## 需求分析

### 背景

在 AICO-Bot 聊天界面中，用户经常需要重新编辑或修改之前的提问。当前输入框在发送消息后会清空，用户想要引用之前的提问只能手动重新输入。主流终端和聊天工具（如 terminal shell、ChatGPT、iTerm2）普遍支持上下键翻阅输入历史，这是用户预期的标准交互模式。

### 问题

1. **重复输入成本高**：用户想要修改之前的提问时，必须手动重新输入整段文字
2. **缺乏行业标准交互**：上下键翻阅历史是终端/聊天工具的通用模式，当前缺失
3. **体验断裂**：用户在长对话中需要反复参考和调整历史提问时，体验不佳

### 预期效果

- 用户在聊天输入框中按上键（ArrowUp），输入框内容自动填充为当前对话中上一条用户消息
- 用户按下键（ArrowDown），输入框内容自动填充为下一条用户消息
- 翻阅范围限定在当前对话的用户消息，不跨对话
- 翻阅状态仅在当前会话有效，不持久化

## 技术方案

### 整体思路

在 `InputArea.tsx` 中添加一个自定义 hook `useInputHistory`，管理翻阅状态。数据源从 chat store 的 `conversationCache` 中提取当前对话的用户消息列表。

### 数据流

```
conversationCache.get(conversationId).messages
        │
        ▼ 过滤 role === 'user'
  userMessages: string[]
        │
        ▼ useInputHistory hook
  historyIndex: number  (-1 表示不在翻阅状态)
        │
        ▼ handleKeyDown 拦截 ArrowUp/ArrowDown
  setContent(userMessages[historyIndex])
```

### 1. 核心状态

```typescript
// useInputHistory hook 内部状态
const historyIndex = useRef(-1);       // -1 = 不在翻阅状态, 0 = 最新一条, N-1 = 最老一条
const savedDraft = useRef('');          // 用户编辑中的草稿，按上键时暂存
```

### 2. 历史消息提取

从 `useChatStore` 的 `conversationCache` 中获取当前对话消息，过滤出 `role === 'user'` 的消息：

```typescript
const userMessages = useMemo(() => {
  if (!conversationId) return [];
  const conversation = useChatStore.getState().conversationCache.get(conversationId);
  if (!conversation) return [];
  return conversation.messages
    .filter((msg) => msg.role === 'user')
    .map((msg) => msg.content)
    .filter((content) => content.trim().length > 0);  // 过滤空消息（如图片-only 消息）
}, [conversationId, conversationCache]);  // conversationCache 变化时重新计算
```

注意：消息列表中最新消息在数组末尾，即 `userMessages[userMessages.length - 1]` 是最新的用户消息。翻阅时 `historyIndex` 从数组末尾向头部递减。

### 3. 按键处理逻辑

在 `handleKeyDown` 中，在 mention 和 slash command 处理之后、Enter 发送之前，添加历史翻阅逻辑：

```typescript
// 伪代码
const handleKeyDown = (e) => {
  // 1. 优先级：mention > slash command > input history > send
  if (handleMentionKeyDown(e)) return;
  if (handleSlashKeyDown(e)) return;

  // 2. 输入历史翻阅（仅在输入框无选中文本时生效）
  if (e.key === 'ArrowUp' && !isSelectionActive(textareaRef)) {
    e.preventDefault();
    navigateHistory(-1);  // 往前翻（更老的消息）
    return;
  }
  if (e.key === 'ArrowDown' && !isSelectionActive(textareaRef)) {
    e.preventDefault();
    navigateHistory(1);   // 往后翻（更新的消息）
    return;
  }

  // 3. Enter 发送 ...
};
```

### 4. 翻阅导航函数

```typescript
function navigateHistory(direction: -1 | 1): void {
  const total = userMessages.length;
  if (total === 0) return;

  if (historyIndex.current === -1) {
    // 首次进入翻阅模式：从最新一条开始
    if (direction === -1) {
      savedDraft.current = content;  // 暂存当前编辑内容
      historyIndex.current = total - 1;
      setContent(userMessages[historyIndex.current]);
    }
    // direction === 1 时不在翻阅模式，忽略
    return;
  }

  // 已在翻阅模式
  const newIndex = historyIndex.current + direction;

  if (newIndex < 0) {
    // 已到最老消息，不继续
    return;
  }

  if (newIndex >= total) {
    // 翻出最新消息，恢复草稿并退出翻阅模式
    historyIndex.current = -1;
    setContent(savedDraft.current);
    savedDraft.current = '';
    return;
  }

  historyIndex.current = newIndex;
  setContent(userMessages[newIndex]);
}
```

### 5. 退出翻阅模式的条件

以下情况应重置 `historyIndex` 为 -1（退出翻阅模式）：

- 用户手动输入文字（`onChange` 中检测到非程序设置的内容变化）
- 用户发送消息（`handleSend` 成功后）
- 切换对话（`conversationId` 变化时，通过 `useEffect` 重置）
- 输入框失焦（可选，按需决定）

```typescript
// 在 onChange 回调中重置
const handleInputChange = (e) => {
  // 如果当前在翻阅模式，且用户主动输入，退出翻阅
  if (historyIndex.current !== -1) {
    historyIndex.current = -1;
    savedDraft.current = '';
  }
  // ... 原有逻辑
};

// conversationId 变化时重置
useEffect(() => {
  historyIndex.current = -1;
  savedDraft.current = '';
}, [conversationId]);
```

### 6. 与现有系统的兼容性

- **mention 系统**：`handleMentionKeyDown` 优先级高于历史翻阅，`@` 弹出列表时上键用于列表导航，不冲突
- **slash command 系统**：`handleSlashKeyDown` 优先级高于历史翻阅，`/` 弹出列表时上键用于列表导航，不冲突
- **Enter 发送**：翻阅到历史消息后按 Enter，走正常的发送流程（发送的是当前输入框中的内容）
- **Shift+Enter 换行**：不受影响

### 7. 光标位置

填充历史消息后，将光标移到文本末尾：

```typescript
setContent(userMessages[newIndex]);
// 光标移到末尾
setTimeout(() => {
  textareaRef.current?.setSelectionRange(
    textareaRef.current.value.length,
    textareaRef.current.value.length,
  );
}, 0);
```

## 开发前必读

- [ ] `src/renderer/components/chat/InputArea.tsx` -- 输入框组件，理解 handleKeyDown 事件处理链、onChange 逻辑、setContent 状态管理
- [ ] `src/renderer/stores/chat.store.ts` -- 聊天状态管理，理解 conversationCache 数据结构、消息获取方式
- [ ] `.project/modules/chat/features/input-area/design.md` -- 输入区功能设计文档，理解现有功能布局和依赖关系

## 涉及文件

开发完成后更新为实际修改清单：

### 前端
- `src/renderer/hooks/useInputHistory.ts` -- 新增，输入历史翻阅 hook
- `src/renderer/components/chat/InputArea.tsx` -- 集成 useInputHistory hook

### 文档
- `.project/modules/chat/features/input-area/design.md` -- 更新功能设计文档
- `.project/modules/chat/features/input-area/changelog.md` -- 追加变更记录
- `.project/changelog/CHANGELOG.md` -- 追加全局变更记录

## 验收标准

- [x] 在有历史消息的对话中，按上键可以将上一条用户消息填入输入框
- [x] 连续按上键可以依次翻阅更早的用户消息
- [x] 按下键可以从较早的消息翻回较新的消息
- [x] 翻阅到最老消息时，再按上键无反应（不越界）
- [x] 翻阅到最新消息时，再按下键恢复用户之前编辑的草稿内容
- [x] 在翻阅过程中，用户手动输入文字后，翻阅模式自动退出
- [x] 用户发送消息后，翻阅状态重置
- [x] 切换到其他对话再切回来，翻阅状态已重置
- [x] 历史消息中仅包含当前对话的用户消息，不包含 assistant 消息
- [x] 历史消息中不包含空消息（纯图片消息等 content 为空的过滤掉）
- [x] `@` mention 弹出列表时，上键仍用于列表导航，不触发历史翻阅
- [x] `/` slash command 弹出列表时，上键仍用于列表导航，不触发历史翻阅
- [x] 填充历史消息后光标位于文本末尾
- [x] 新对话（无历史消息）中按上键无反应
- [x] 翻阅状态不持久化，刷新页面后历史翻阅状态重置

## 功能设计

-> modules/chat/features/input-area/design.md

## 变更

| 时间 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-21 | 创建 PRD，状态 draft → in-progress | StyleAIPro |
| 2026-04-23 | 验收通过，状态 in-progress → done；PRD 从 feature/chat/ 移至 feature/ | StyleAIPro |
