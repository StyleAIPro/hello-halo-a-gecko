# PRD [Feature] — AI 响应日志结构化摘要

| 字段 | 值 |
|------|------|
| 版本 | v1 |
| 日期 | 2026-05-06 |
| 作者 | 用户 |
| 模块 | 主进程日志（Agent 流式处理 + 远程消息发送） |
| 状态 | done |
| 优先级 | P2 |
| 影响范围 | 仅主进程 |

## 需求分析

### 背景

`feat-log-ai-response-v1` PRD 已实现 `[AI RESPONSE]` 日志聚合标记。当前日志输出如下：

```
========== [AI RESPONSE] ==========
[event] aiResponse: conversationId=abc, duration=12.5s, status=completed
[event] text: 以下是排序函数的实现代码...（截断 500 字符）
[event] toolCalls: [Bash: npm test] [Read: src/index.ts] [Write: src/utils.ts] [Grep: pattern]
==================================
```

### 问题

AI 的回复往往很长，用户在日志中看到的是截断的文本（500 字符）和一列工具调用。对于一次涉及大量文件变更的复杂任务，用户需要逐条阅读 toolCalls 行才能理解 AI 做了什么，难以快速获取关键指标。

**缺失的信息**：
- AI 一共改了多少文件？（需要人工数 toolCalls 行中的 Read/Write/Edit）
- 总共调用了多少次工具？（需要人工数 toolCalls 行的条目数）
- 完整文本有多长？（截断后只显示 "... (truncated, N chars total)"，不直观）
- 是否有错误？（需要看 status 行，但 error 可能隐藏在中间日志中）

### 期望效果

在 `aiResponse` 行之后、`text` 行之前，新增一行结构化摘要：

```
========== [AI RESPONSE] ==========
[event] aiResponse: conversationId=abc, duration=12.5s, status=completed
[event] summary: filesChanged=3, toolCalls=5, textLength=1234, hasError=false
[event] text: 以下是排序函数的实现代码...（截断 500 字符）
[event] toolCalls: [Bash: npm test] [Read: src/index.ts]
==================================
```

其中 `summary` 行包含：
- `filesChanged` — 文件变更相关工具调用数（Read / Write / Edit / MultiEdit / NotebookEdit）
- `toolCalls` — 总工具调用次数（所有 tool_use 类型 thoughts）
- `textLength` — AI 最终文本的完整长度（非截断后的长度）
- `hasError` — 本次响应中是否包含 error 类型 thought（布尔值）

### 边界场景

1. **无工具调用**：`toolCalls=0, filesChanged=0`，仍输出 summary 行
2. **无文本回复**：`textLength=0`，仍输出 summary 行
3. **用户中断**：`hasError=false`（aborted 不是 error thought），其余指标统计中断前已有的数据
4. **stream 异常中断**：`hasError` 取决于是否实际存在 error thought

## 技术方案

### 核心思路

1. 在 `AiResponseLogOptions` 接口中新增可选的 `summary` 字段
2. 在 `logAiResponse()` 中，如果 `summary` 提供则输出 `[event] summary: ...` 行
3. 调用方（`stream-processor.ts` 和 `send-message.ts`）负责在调用前计算 summary 数据
4. summary 计算不引入新的类型或复杂逻辑，仅利用已有的 `sessionState.thoughts`（本地路径）和 `toolCalls` 数组（远程路径）

### 方案 1：扩展 `AiResponseLogOptions` 接口（修改 `src/main/utils/logger.ts`）

在现有接口中新增可选字段：

```typescript
export interface AiResponseSummary {
  /** 文件变更相关工具调用数（Read/Write/Edit/MultiEdit/NotebookEdit） */
  filesChanged: number;
  /** 总工具调用次数 */
  toolCalls: number;
  /** AI 最终文本的完整长度（字符数） */
  textLength: number;
  /** 本次响应中是否包含 error 类型 thought */
  hasError: boolean;
}

export interface AiResponseLogOptions {
  conversationId: string;
  duration: number;
  status: 'completed' | 'aborted' | 'interrupted' | 'error' | 'empty';
  finalContent?: string;
  toolCalls?: Array<{ name: string; input?: string }>;
  maxContentLength?: number;
  maxToolInputLength?: number;
  /** 结构化摘要，可选 */
  summary?: AiResponseSummary;
}
```

在 `logAiResponse()` 函数中，在 `aiResponse` 行之后、`text` 行之前输出 summary 行：

```typescript
export function logAiResponse(options: AiResponseLogOptions): void {
  const {
    conversationId,
    duration,
    status,
    finalContent,
    toolCalls,
    maxContentLength = 500,
    maxToolInputLength = 50,
    summary,
  } = options;

  const durationSec = (duration / 1000).toFixed(1);

  console.info('========== [AI RESPONSE] ==========');
  console.info(
    `[event] aiResponse: conversationId=${conversationId}, duration=${durationSec}s, status=${status}`,
  );

  // 新增：结构化摘要行
  if (summary) {
    console.info(
      `[event] summary: filesChanged=${summary.filesChanged}, toolCalls=${summary.toolCalls}, textLength=${summary.textLength}, hasError=${summary.hasError}`,
    );
  }

  if (finalContent && finalContent.length > 0) {
    const truncated =
      finalContent.length > maxContentLength
        ? finalContent.substring(0, maxContentLength) +
          `... (truncated, ${finalContent.length} chars total)`
        : finalContent;
    console.info(`[event] text: ${truncated}`);
  }

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
- `summary` 是可选字段，不传则不输出 summary 行（向后兼容）
- 输出位置在 `aiResponse` 行之后、`text` 行之前，便于快速扫描关键指标
- `filesChanged` 的判断基于工具名称白名单，不解析 tool input（避免额外开销）

### 方案 2：本地路径 summary 计算（修改 `stream-processor.ts`）

在 `processStream()` 函数的 **AI Response Log** 段落中（约第 1645 行），在调用 `logAiResponse()` 之前计算 summary：

```typescript
// ========== AI Response Log ==========
const toolUseThoughts = sessionState.thoughts.filter(
  (t: Thought) => t.type === 'tool_use' && t.toolName,
);

// 文件变更相关工具名称白名单
const FILE_CHANGE_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

const filesChangedCount = toolUseThoughts.filter(
  (t: Thought) => t.toolName && FILE_CHANGE_TOOLS.includes(t.toolName),
).length;

const toolCallsSummary = toolUseThoughts.map((t: Thought) => ({
  name: t.toolName!,
  input: t.toolInput ? JSON.stringify(t.toolInput) : undefined,
}));

// ... responseStatus 计算（不变） ...

logAiResponse({
  conversationId,
  duration: Date.now() - params.t0,
  status: responseStatus,
  finalContent: finalContent || undefined,
  toolCalls: toolCallsSummary.length > 0 ? toolCallsSummary : undefined,
  summary: {
    filesChanged: filesChangedCount,
    toolCalls: toolUseThoughts.length,
    textLength: finalContent?.length ?? 0,
    hasError: hasErrorThought,
  },
});
```

要点：
- `FILE_CHANGE_TOOLS` 常量定义在调用处附近，不导出（仅此处使用）
- `hasError` 直接复用已有的 `hasErrorThought` 变量（布尔值），无需重新计算
- `toolUseThoughts` 已在现有代码中计算，summary 计算零额外遍历开销

### 方案 3：远程路径 summary 计算（修改 `send-message.ts`）

在 `executeRemoteMessage()` 函数的 AI Response Log 段落中（约第 1594 行），类似地计算 summary：

```typescript
// AI Response Log for remote execution
const FILE_CHANGE_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

const remoteToolCallsSummary = toolCalls.map((tc: any) => ({
  name: tc.name || 'Unknown',
  input: tc.input ? JSON.stringify(tc.input) : undefined,
}));

const filesChangedCount = toolCalls.filter(
  (tc: any) => tc.name && FILE_CHANGE_TOOLS.includes(tc.name),
).length;

const remoteHasError = thoughts.some((t: any) => t.type === 'error');

logAiResponse({
  conversationId,
  duration: Date.now() - t0Remote,
  status: 'completed',
  finalContent: streamingContent || response.content || undefined,
  toolCalls: remoteToolCallsSummary.length > 0 ? remoteToolCallsSummary : undefined,
  summary: {
    filesChanged: filesChangedCount,
    toolCalls: toolCalls.length,
    textLength: (streamingContent || response.content || '').length,
    hasError: remoteHasError,
  },
});
```

要点：
- 远程路径的 `toolCalls` 和 `thoughts` 数组已在 WebSocket 事件处理中填充（约第 887 行）
- `thoughts.some(t => t.type === 'error')` 与本地路径的 `hasErrorThought` 逻辑等价
- `FILE_CHANGE_TOOLS` 常量在两处分别定义（避免跨模块导出一个简单数组常量）

### 不做的事

- **不修改 Thought 类型**：不新增任何字段
- **不修改远程代理端（`packages/remote-agent-proxy/`）**：所有计算在本地完成
- **不将 `FILE_CHANGE_TOOLS` 提取为共享常量**：仅在两个文件各定义一次，避免为 5 个字符串常量新建文件
- **不做 `summary` 行的格式化美化**：保持 key=value 扁平格式，与 `aiResponse` 行风格一致
- **不统计 Bash 写入文件的场景**：Bash 的 tool input 可能包含 `echo > file` 等文件操作，但解析 Bash 命令成本过高，不纳入统计

## 开发前必读

### 模块设计文档

| # | 文件 | 阅读目的 |
|---|------|---------|
| 1 | `.project/modules/agent/features/stream-processing/design.md` | 理解 processStream 的完整流程和 stream end handling 逻辑 |
| 2 | `.project/modules/agent/features/message-send/design.md` | 理理 sendMessage 的远程路由路径（executeRemoteMessage） |

### PRD 文档

| # | 文件 | 阅读目的 |
|---|------|---------|
| 1 | `.project/prd/feature/logging/feat-log-ai-response-v1.md` | 了解现有 `logAiResponse()` 的接口设计和日志格式，本次在其上扩展 |

### 源码文件

| # | 文件路径 | 阅读目的 |
|---|---------|---------|
| 1 | `src/main/utils/logger.ts` | 现有 `AiResponseLogOptions` 接口和 `logAiResponse()` 实现，确定新增字段和输出位置 |
| 2 | `src/main/services/agent/stream-processor.ts` (lines 1620-1680) | 理解 stream end handling 段落的变量（`toolUseThoughts`、`hasErrorThought`、`finalContent`），确定 summary 计算插入点 |
| 3 | `src/main/services/agent/send-message.ts` (lines 880-890, 1590-1610) | 理解远程路径的 `toolCalls` 和 `thoughts` 数组来源，确定 summary 计算插入点 |
| 4 | `src/main/services/agent/types.ts` (Thought interface) | 了解 Thought 类型的 `type`、`toolName` 字段，用于筛选 tool_use 和计算 filesChanged |

### 编码规范

| # | 文档 | 阅读目的 |
|---|------|---------|
| 1 | `docs/Development-Standards-Guide.md` | TypeScript strict、纯类型导入、命名规范 |

## 涉及文件

| # | 文件路径 | 变更类型 | 说明 |
|---|---------|---------|------|
| 1 | `src/main/utils/logger.ts` | 修改 | 新增 `AiResponseSummary` 接口、`AiResponseLogOptions.summary` 可选字段、`logAiResponse()` 中输出 summary 行 |
| 2 | `src/main/services/agent/stream-processor.ts` | 修改 | 在 AI Response Log 段落新增 `FILE_CHANGE_TOOLS` 常量和 summary 计算，传入 `logAiResponse()` |
| 3 | `src/main/services/agent/send-message.ts` | 修改 | 在远程路径 AI Response Log 段落新增 summary 计算，传入 `logAiResponse()` |

## 验收标准

### 正常场景

- [ ] 一次完整的本地 Agent 对话后，日志中 `aiResponse` 行之后出现 `[event] summary:` 行
- [ ] summary 行包含 `filesChanged`、`toolCalls`、`textLength`、`hasError` 四个指标
- [ ] `filesChanged` 正确统计 Read / Write / Edit / MultiEdit / NotebookEdit 五种工具的调用次数
- [ ] `toolCalls` 等于所有 tool_use 类型 thoughts 的总数
- [ ] `textLength` 等于 AI 最终回复文本的完整字符数（非截断后的长度）
- [ ] `hasError` 为 `true`（当存在 error thought 时）或 `false`（无 error thought 时）
- [ ] summary 行位于 `aiResponse` 行之后、`text` 行之前

### 边界场景

- [ ] 无工具调用时：`filesChanged=0, toolCalls=0`，summary 行仍输出
- [ ] 无文本回复时：`textLength=0`，summary 行仍输出
- [ ] AI 回复超过 500 字符时：`textLength` 为完整长度，`text` 行仍截断显示
- [ ] 用户中断时：summary 行输出中断前已有的统计数据
- [ ] stream 异常中断时：summary 行正确反映当前状态

### 远程场景

- [ ] 远程 Agent 对话完成后，日志中出现 `[event] summary:` 行
- [ ] 远程路径的 summary 指标与本地路径一致（相同计算逻辑）

### 兼容性

- [ ] `summary` 为可选字段，不传时不影响现有日志格式
- [ ] 与 `logUserAction()` 的分隔线风格一致
- [ ] 不影响现有日志降噪方案（heartbeat 过滤、debug 降级等）
- [ ] `npm run typecheck && npm run lint && npm run build` 通过
- [ ] 应用正常启动，无崩溃或白屏

## 变更记录

| 日期 | 内容 | 作者 |
|------|------|------|
| 2026-05-06 | 初始版本：提出 AI 响应日志结构化摘要方案，新增 summary 行包含 filesChanged / toolCalls / textLength / hasError 四个指标 | 用户 |
