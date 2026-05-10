# PRD [Feature] -- 用户输入与模型输出日志摘要

| 字段 | 值 |
|------|------|
| 版本 | v1 |
| 日期 | 2026-05-07 |
| 指令人 | @misakamikoto |
| 模块 | main（IPC Agent + 日志模块） |
| 状态 | done |
| 优先级 | P1 |
| 影响范围 | 仅主进程日志文件 |

## 需求分析

### 背景

当前日志中用户操作以 `[event]` 前缀记录（来自 logging-enhancement-v2），但只记录了 ID 信息（conversationId、spaceId），不包含实际内容：

```
[event] sendMessage: conversationId=xxx, spaceId=xxx
```

模型输出日志（process-stream.ts）在完成时记录了 token 用量，但没有响应内容的摘要。整个 Agent 对话过程中，用户发送了什么、模型回答了什么，在日志文件中无法一目了然。

### 问题

1. **用户输入内容不可见**：`[event] sendMessage` 只记录 ID，不记录用户实际发送的消息文本
2. **模型输出无摘要**：Agent 完成响应后，日志中没有输出内容的摘要
3. **缺少视觉分隔**：用户的操作和模型的响应混在大量 debug/info 日志中，不方便快速定位

### 预期效果

日志文件中每次用户交互都能看到类似这样的结构化摘要：

```
================================================================================
[USER INPUT] conversationId=abc | spaceId=workspace
  Message: "帮我写一个排序函数" (42 chars)
  Images: 2 attachments
  Mode: thinking=off, aiBrowser=off
--------------------------------------------------------------------------------
[MODEL OUTPUT] conversationId=abc | 3 tool calls | 8.2s
  Response: "这是你需要的排序函数实现..." (356 chars, truncated)
  Tokens: input=1247 output=892 cache=204 | cost=$0.0123
================================================================================
```

## 技术方案

### 核心策略

在现有日志流中增加两处结构化日志，使用分隔线包裹，不改变现有日志逻辑：

1. **用户输入摘要**：增强 `agent.ts` 中已有的 `[event] sendMessage` 日志
2. **模型输出摘要**：在 `send-message-local.ts` 的 `onComplete` 回调中添加输出摘要
3. **分隔线**：使用 `console.info` 输出 `=` 分隔线，file 级别写入

### 1. 用户输入摘要（修改 `src/main/ipc/agent.ts`）

将现有的单行 `[event] sendMessage` 扩展为多行结构化摘要：

```typescript
// 修改前
console.info(`[event] sendMessage: conversationId=${request.conversationId}, spaceId=${request.spaceId}`);

// 修改后
const inputSummary = [
  `================================================================================`,
  `[USER INPUT] conversationId=${request.conversationId} | spaceId=${request.spaceId}`,
  `  Message: "${request.message}" (${request.message.length} chars)`,
];
if (request.images?.length) {
  inputSummary.push(`  Images: ${request.images.length} attachment(s)`);
}
const modes = [];
if (request.thinkingEnabled) modes.push('thinking=on');
if (request.aiBrowserEnabled) modes.push('aiBrowser=on');
if (request.resumeSessionId) modes.push(`resume=${request.resumeSessionId}`);
if (modes.length) inputSummary.push(`  Mode: ${modes.join(', ')}`);
inputSummary.push('================================================================================');
console.info(inputSummary.join('\n'));
```

### 2. 模型输出摘要（修改 `src/main/services/agent/send-message-local.ts`）

在 `processStream()` 的 `onComplete` 回调中添加输出摘要。`onComplete` 回调的位置在函数末尾，能拿到完整的 `streamResult`。

```typescript
// 在 callbacks 对象的 onComplete 中添加（streamResult 包含所有数据）
const toolCallCount = streamResult.thoughts.filter(t => t.type === 'tool_use').length;
const responsePreview = streamResult.finalContent
  ? `"${streamResult.finalContent.substring(0, 200)}${streamResult.finalContent.length > 200 ? '...' : ''}" (${streamResult.finalContent.length} chars, truncated)`
  : '(empty response)';

const duration = ((Date.now() - t1) / 1000).toFixed(1);
const outputSummary = [
  '--------------------------------------------------------------------------------',
  `[MODEL OUTPUT] conversationId=${conversationId} | ${toolCallCount} tool call(s) | ${duration}s`,
  `  Response: ${responsePreview}`,
];
if (streamResult.tokenUsage) {
  const t = streamResult.tokenUsage;
  outputSummary.push(`  Tokens: input=${t.inputTokens} output=${t.outputTokens} cache=${t.cacheReadTokens} | cost=$${t.totalCostUsd.toFixed(4)}`);
}
if (streamResult.isInterrupted) outputSummary.push('  Status: INTERRUPTED');
if (streamResult.hasErrorThought && streamResult.errorThought) {
  outputSummary.push(`  Error: ${streamResult.errorThought.content}`);
}
outputSummary.push('================================================================================');
console.info(outputSummary.join('\n'));
```

### 3. 注意事项

- **分隔线使用 `=` 字符（64 个）**，与 `[event]` 前缀日志形成视觉区分
- **用户消息截断**：`request.message` 通常不会太长（用户输入），完整记录
- **模型输出截断**：`finalContent` 可能很长，只显示前 200 字符 + 总长度
- **图片附件**：只记录数量，不记录 base64 数据（隐私 + 日志体积）
- **token 用量**：直接使用 `tokenUsage` 对象的字段，无需额外计算
- **错误情况**：模型出错时在输出摘要中标记 `Error:` 行

### 不做的事

- **不改变现有 `[event]` 日志格式**：用户操作日志（stopGeneration、createSpace 等）保持单行 `[event]` 不变
- **不在 console 层面添加分隔线函数**：直接在调用点内联，保持简单
- **不记录 AI 的完整思考过程**：只记录最终输出摘要，不记录 thinking content
- **不记录 tool input/output 的完整内容**：只记录 tool call 数量
- **不新增文件或依赖**：在现有文件中增量修改

## 涉及文件

| # | 文件路径 | 变更类型 | 说明 |
|---|---------|---------|------|
| 1 | `src/main/ipc/agent.ts` | 修改 | 增强 `[event] sendMessage` 为多行结构化摘要 |
| 2 | `src/main/services/agent/send-message-local.ts` | 修改 | 在 `onComplete` 回调中添加 `[MODEL OUTPUT]` 摘要 |

## 验收标准

- [ ] 用户发送消息时，日志文件中出现 `[USER INPUT]` 摘要块（含消息内容、长度、图片数量）
- [ ] 用户发送空消息时，消息显示为 `"" (0 chars)` 而不报错
- [ ] 用户发送带图片的消息时，摘要显示附件数量
- [ ] 用户开启 thinking 或 AI Browser 时，摘要显示模式信息
- [ ] 用户恢复会话时，摘要显示 resumeSessionId
- [ ] 模型完成响应后，日志文件中出现 `[MODEL OUTPUT]` 摘要块
- [ ] 输出摘要包含响应预览（前 200 字 + 总长度）
- [ ] 输出摘要包含 tool call 数量和响应耗时
- [ ] 输出摘要包含 token 用量和费用
- [ ] 模型输出为空时，显示 `(empty response)` 而不报错
- [ ] 模型中断时，摘要显示 `Status: INTERRUPTED`
- [ ] 模型出错时，摘要显示 `Error:` 行
- [ ] 摘要块上下各有 80 个 `=` 分隔线
- [ ] `[USER INPUT]` 和 `[MODEL OUTPUT]` 使用不同分隔线（上边 `=`，下边 `-`）
- [ ] 用户操作日志（stopGeneration、createSpace 等）不受影响，仍为单行
- [ ] `npm run build` 通过
- [ ] 应用正常启动，发送消息后日志文件中可见摘要块

## 变更记录

| 日期 | 内容 | 作者 |
|------|------|------|
| 2026-05-07 | 初始版本：用户输入摘要 + 模型输出摘要 + 分隔线 | subagent |
