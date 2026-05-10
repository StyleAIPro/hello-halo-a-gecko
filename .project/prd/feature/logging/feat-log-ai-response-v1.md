# PRD [Feature] — AI 响应日志聚合标记

| 字段 | 值 |
|------|------|
| 版本 | v1 |
| 日期 | 2026-05-06 |
| 作者 | 用户 |
| 模块 | 全链路日志（Agent 流式处理） |
| 状态 | done |
| 优先级 | P1 |
| 影响范围 | 仅主进程 |

## 需求分析

### 背景

现有日志系统已实现用户操作高亮（`feat-log-noise-reduction-v1`）：每次用户操作在日志中用 `========== [USER ACTION] ==========` 分隔线包裹，方便快速定位。同时 Agent 流式日志已做降噪处理（高频中间日志降为 debug）。

**当前问题**：AI 的最终回复内容分散在日志中，没有醒目的聚合标记。用户在日志中能看到 `[USER ACTION]` 分隔线，但 AI 的回复淹没在中间处理日志中，无法一眼看出 AI 回复了什么、调用了哪些工具、耗时多久。

### 期望效果

与 `[USER ACTION]` 对称，在 stream 结束后用 `========== [AI RESPONSE] ==========` 分隔线将 AI 的完整输出单独标记出来：

```
========== [USER ACTION] ==========
[event] sendMessage: conversationId=abc, spaceId=xyz, agentId=leader, message=帮我排序
==================================

（... 中间的 Agent 处理日志 ...）

========== [AI RESPONSE] ==========
[event] aiResponse: conversationId=abc, duration=12.5s, status=completed
[event] text: 以下是排序函数的实现代码...\n\nfunction sort(arr) { ... }
[event] toolCalls: [Bash: npm test] [Read: src/index.ts]
==================================
```

### 边界场景

1. **finalContent 为空**：不输出 `[event] text:` 行
2. **无 tool_use thoughts**：不输出 `[event] toolCalls:` 行
3. **用户中断**：status 标记为 `aborted`
4. **stream 异常中断**：status 标记为 `interrupted`
5. **长文本**：finalContent 超过 500 字符时截断，附加 `... (truncated, N chars total)`
6. **tool input 摘要**：格式为 `[toolName]` 或 `[toolName: input前50字符]`

## 技术方案

### 核心思路

在 `stream-processor.ts` 的 `processStream()` 函数中，stream 循环结束后、构建 `StreamResult` 返回之前，输出 AI 响应摘要日志。这里拥有所有需要的数据（`finalContent`、`sessionState.thoughts`、`conversationId`、耗时），且是统一的出口点（本地 Agent 和 Hyper Space Worker 都经过此处）。

### 方案 1：新增 `logAiResponse()` 工具函数（修改 `src/main/utils/logger.ts`）

在 `logger.ts` 中新增 `logAiResponse()` 函数，与现有 `logUserAction()` 对称：

```typescript
export interface AiResponseLogOptions {
  conversationId: string;
  duration: number; // 毫秒
  status: 'completed' | 'aborted' | 'interrupted' | 'error' | 'empty';
  finalContent?: string;
  toolCalls?: Array<{ name: string; input?: string }>;
  /** 最大文本截断长度，默认 500 */
  maxContentLength?: number;
  /** 最大 tool input 摘要长度，默认 50 */
  maxToolInputLength?: number;
}

/**
 * Log an AI response summary with visible separators for quick scanning.
 * Wraps the response log with ========== [AI RESPONSE] ========== borders.
 */
export function logAiResponse(options: AiResponseLogOptions): void {
  const {
    conversationId,
    duration,
    status,
    finalContent,
    toolCalls,
    maxContentLength = 500,
    maxToolInputLength = 50,
  } = options;

  const durationSec = (duration / 1000).toFixed(1);

  console.info('========== [AI RESPONSE] ==========');
  console.info(
    `[event] aiResponse: conversationId=${conversationId}, duration=${durationSec}s, status=${status}`,
  );

  // Text content (truncated if too long)
  if (finalContent && finalContent.length > 0) {
    const truncated =
      finalContent.length > maxContentLength
        ? finalContent.substring(0, maxContentLength) +
          `... (truncated, ${finalContent.length} chars total)`
        : finalContent;
    console.info(`[event] text: ${truncated}`);
  }

  // Tool calls summary
  if (toolCalls && toolCalls.length > 0) {
    const summaries = toolCalls.map((tc) => {
      if (tc.input && tc.input.length > 0) {
        const inputPreview =
          tc.input.length > maxToolInputLength
            ? tc.input.substring(0, maxToolInputLength) + '...'
            : tc.input;
        return `[${tc.name}: ${inputPreview}]`;
      }
      return `[${tc.name}]`;
    });
    console.info(`[event] toolCalls: ${summaries.join(' ')}`);
  }

  console.info('==================================');
}
```

关键设计决策：
- 使用 `console.info` 而非 `console.log`，确保与 `logUserAction` 一致（info 级别写入文件）
- 参数接口化，方便未来扩展（如 token usage、model name）
- 截断逻辑内置，防止日志膨胀
- toolCalls 参数由调用方从 `sessionState.thoughts` 中提取，`logAiResponse` 不依赖 Thought 类型

### 方案 2：在 stream-processor.ts 中调用 `logAiResponse()`（修改 `stream-processor.ts`）

在 `processStream()` 函数的 **Stream End Handling** 段落中（约第 1594 行 `const finalContent = ...` 之后、第 1649 行 `const result: StreamResult = {` 之前），添加 AI 响应日志输出：

```typescript
// ========== AI Response Log ==========
// 从 sessionState.thoughts 中提取 tool_use 类型的 thoughts 作为 tool 调用摘要
const toolUseThoughts = sessionState.thoughts.filter(
  (t: Thought) => t.type === 'tool_use' && t.toolName,
);
const toolCallsSummary = toolUseThoughts.map((t: Thought) => ({
  name: t.toolName!,
  input: t.toolInput ? JSON.stringify(t.toolInput).substring(0, 50) : undefined,
}));

// 确定 status
let responseStatus: 'completed' | 'aborted' | 'interrupted' | 'error' | 'empty';
if (wasAborted) {
  responseStatus = 'aborted';
} else if (hasErrorThought) {
  responseStatus = 'error';
} else if (isInterrupted) {
  responseStatus = 'interrupted';
} else if (!finalContent) {
  responseStatus = 'empty';
} else {
  responseStatus = 'completed';
}

logAiResponse({
  conversationId,
  duration: Date.now() - params.t0,
  status: responseStatus,
  finalContent: finalContent || undefined,
  toolCalls: toolCallsSummary.length > 0 ? toolCallsSummary : undefined,
});
```

插入位置说明：
- 在 `finalContent`、`wasAborted`、`isInterrupted`、`hasErrorThought` 等变量都已计算完毕之后
- 在 `callbacks.onComplete(result)` 之前（此时 StreamResult 尚未构建，但所需数据已齐全）
- 在子代理清理逻辑（`subagentStates.forEach`）之前也可以，但放在变量计算完成后更清晰

### 方案 3：远程 Agent 路径的日志标记（修改 `send-message.ts`）

远程 Agent 路径（`executeRemoteMessage`）不经过 `processStream()`，需要单独处理。在 `send-message.ts` 的 `executeRemoteMessage()` 函数中，response 接收完成后（约第 1600 行 `log.info('Received response from remote Claude')` 之后）添加类似的日志输出：

```typescript
// AI Response Log for remote execution
const remoteToolCalls = toolCalls.map((tc) => ({
  name: tc.name || 'Unknown',
  input: tc.input ? JSON.stringify(tc.input).substring(0, 50) : undefined,
}));

logAiResponse({
  conversationId,
  duration: Date.now() - t0Remote, // 需要在函数开头记录 t0Remote
  status: 'completed',
  finalContent: streamingContent || response.content || undefined,
  toolCalls: remoteToolCalls.length > 0 ? remoteToolCalls : undefined,
});
```

注意：`executeRemoteMessage` 函数需要在开头添加 `const t0Remote = Date.now()` 来记录起始时间。

### 不做的事

- **不修改 Thought 类型**：不新增任何字段，仅从现有字段提取信息
- **不修改远程代理端（`packages/remote-agent-proxy/`）**：远程端的响应日志在本地客户端记录
- **不增加 token usage 到日志**：token usage 格式复杂且已有独立日志行，不重复
- **不捕获子代理的独立响应**：子代理 thoughts 已包含在主 sessionState.thoughts 中，tool 摘要自然覆盖
- **不处理 Hyper Space 路由路径的独立日志**：Hyper Space 路由到 `orchestrator.executeOnSingleAgent()`，内部仍调用 `processStream()`，自动覆盖

## 开发前必读

### 模块设计文档

| # | 文件 | 阅读目的 |
|---|------|---------|
| 1 | `.project/modules/agent/features/stream-processing/design.md` | 理解 processStream 的完整流程和 stream end handling 逻辑 |
| 2 | `.project/modules/agent/features/message-send/design.md` | 理解 sendMessage 的三种路由路径（本地/远程/Hyper Space） |
| 3 | `.project/prd/feature/logging/feat-log-noise-reduction-v1.md` | 了解现有 `logUserAction()` 的实现和日志降噪方案，确保风格一致 |

### 源码文件

| # | 文件路径 | 阅读目的 |
|---|---------|---------|
| 1 | `src/main/utils/logger.ts` | 了解现有 `logUserAction()` 签名和实现，确定 `logAiResponse()` 添加位置 |
| 2 | `src/main/services/agent/stream-processor.ts` (lines 1578-1730) | 理解 stream end handling 段落的变量和逻辑流，确定日志输出插入点 |
| 3 | `src/main/services/agent/send-message.ts` (lines 1590-1650) | 理解远程路径的 response 接收和持久化逻辑 |
| 4 | `src/main/services/agent/types.ts` (Thought interface) | 了解 Thought 类型的 `toolName`、`toolInput` 等字段，用于提取 tool 调用摘要 |

### 编码规范

| # | 文档 | 阅读目的 |
|---|------|---------|
| 1 | `docs/Development-Standards-Guide.md` | TypeScript strict、纯类型导入、命名规范 |

## 涉及文件

| # | 文件路径 | 变更类型 | 说明 |
|---|---------|---------|------|
| 1 | `src/main/utils/logger.ts` | 修改 | 新增 `AiResponseLogOptions` 接口和 `logAiResponse()` 函数 |
| 2 | `src/main/services/agent/stream-processor.ts` | 修改 | 在 stream end handling 中调用 `logAiResponse()`，新增 import |
| 3 | `src/main/services/agent/send-message.ts` | 修改 | 在 `executeRemoteMessage()` 中调用 `logAiResponse()`，新增 import 和计时变量 |

## 验收标准

### 正常场景

- [ ] 一次完整的本地 Agent 对话后，日志中出现 `========== [AI RESPONSE] ==========` 分隔行
- [ ] 分隔行内包含 `[event] aiResponse:` 行，包含 conversationId、耗时（秒）、status=completed
- [ ] 分隔行内包含 `[event] text:` 行，内容为 AI 最终回复文本
- [ ] 若 AI 调用了工具，分隔行内包含 `[event] toolCalls:` 行，格式为 `[toolName]` 或 `[toolName: input摘要]`
- [ ] 若 AI 未调用工具，不输出 `[event] toolCalls:` 行
- [ ] 分隔行上下边框完整（`========== [AI RESPONSE] ==========` 和 `==================================`）

### 边界场景

- [ ] AI 回复超过 500 字符时，text 行截断并附加 `... (truncated, N chars total)`
- [ ] 用户中断生成时，status 标记为 `aborted`
- [ ] stream 异常中断时，status 标记为 `interrupted`
- [ ] AI 返回错误 thought 时，status 标记为 `error`
- [ ] AI 最终回复为空时，不输出 `[event] text:` 行，status 标记为 `empty`
- [ ] tool input 摘要超过 50 字符时截断并附加 `...`

### 远程场景

- [ ] 远程 Agent 对话完成后，日志中出现 `========== [AI RESPONSE] ==========` 分隔行
- [ ] 远程路径的 AI 响应日志包含正确的耗时、文本内容和 tool 调用摘要

### 兼容性

- [ ] 与 `logUserAction()` 的分隔线风格一致（`console.info`、相同格式）
- [ ] 不影响现有日志降噪方案（heartbeat 过滤、debug 降级等）
- [ ] Hyper Space Worker 路径也正确输出 AI 响应日志（通过 processStream 自动覆盖）
- [ ] `npm run typecheck && npm run lint && npm run build` 通过
- [ ] 应用正常启动，无崩溃或白屏

## 变更记录

| 日期 | 内容 | 作者 |
|------|------|------|
| 2026-05-06 | 初始版本：提出 AI 响应日志聚合标记方案，与 USER ACTION 对称 | 用户 |
