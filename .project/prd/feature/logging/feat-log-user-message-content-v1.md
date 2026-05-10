# PRD [Feature] — 用户聊天消息内容记录

| 字段 | 值 |
|------|------|
| 版本 | v1 |
| 日期 | 2026-05-06 |
| 作者 | 用户 |
| 模块 | 主进程日志（IPC Agent） |
| 状态 | done |
| 优先级 | P1 |
| 影响范围 | 仅主进程 |

## 需求分析

### 背景

`feat-log-noise-reduction-v1` PRD 已实现 `logUserAction` 机制，在用户发送消息时记录操作日志。当前日志输出如下：

```
========== [USER ACTION] ==========
[event] sendMessage: conversationId=abc, spaceId=xyz, agentId=leader
==================================
```

### 问题

用户发送消息的**实际内容**（`request.message`）没有被记录到日志中。当需要排查用户交互问题时，无法从日志中得知用户具体输入了什么，只能看到会话 ID 和空间 ID 等元信息。

### 预期效果

日志中能看到用户发送的消息内容，方便问题排查：

```
========== [USER ACTION] ==========
[event] sendMessage: conversationId=abc, spaceId=xyz, agentId=leader, message=帮我写一个排序函数
==================================
```

## 技术方案

### 修改位置

修改 `src/main/ipc/agent.ts` 中 `agent:send-message` handler 的 `logUserAction` 调用，在 `detail` 参数中追加 `request.message` 字段。

### 具体改动

**文件**：`src/main/ipc/agent.ts`（第 47-50 行）

**修改前**：
```typescript
logUserAction(
  'sendMessage',
  `conversationId=${request.conversationId}, spaceId=${request.spaceId}, agentId=${request.agentId || 'leader'}`,
);
```

**修改后**：
```typescript
logUserAction(
  'sendMessage',
  `conversationId=${request.conversationId}, spaceId=${request.spaceId}, agentId=${request.agentId || 'leader'}, message=${request.message}`,
);
```

### 不做的事

- **不记录图片内容**：`request.images` 包含 base64 编码的图片数据，体积大且写入日志无意义，不记录
- **不截断/脱敏消息内容**：`request.message` 是用户主动输入的文本，不包含敏感字段（API key 等），无需脱敏或截断
- **不修改 `logUserAction` 函数签名**：仅在调用处追加参数内容，不改动工具函数本身

## 开发前必读

### 模块设计文档

| # | 文件 | 阅读目的 |
|---|------|---------|
| 1 | `.project/prd/feature/logging/feat-log-noise-reduction-v1.md` | 了解 `logUserAction` 机制的设计和实现背景 |

### 源码文件

| # | 文件路径 | 阅读目的 |
|---|---------|---------|
| 1 | `src/main/ipc/agent.ts`（第 24-58 行） | 确认 `agent:send-message` handler 中 `request.message` 字段类型为 `string`，了解当前日志调用位置 |
| 2 | `src/main/utils/logger.ts` | 了解 `logUserAction(action, detail)` 函数签名，确认 detail 为字符串拼接 |

### 编码规范

| # | 文档 | 阅读目的 |
|---|------|---------|
| 1 | `docs/Development-Standards-Guide.md` | 了解 TypeScript strict 规范 |

## 涉及文件

| # | 文件路径 | 变更类型 | 说明 |
|---|---------|---------|------|
| 1 | `src/main/ipc/agent.ts` | 修改 | `logUserAction` 调用的 detail 参数追加 `message=${request.message}` |

## 验收标准

- [ ] 用户发送文本消息后，日志文件中出现 `message=<用户输入的内容>`
- [ ] 日志输出格式保持 `========== [USER ACTION] ==========` 分隔线包裹
- [ ] `request.message` 为空字符串时，日志显示 `message=`（不中断、不报错）
- [ ] 含多行文本的消息正常记录（不转义换行，保持原始内容）
- [ ] 附带图片发送消息时，日志仅记录文本内容，不记录图片数据
- [ ] `npm run typecheck && npm run lint && npm run build` 通过
- [ ] 应用正常启动，无崩溃或白屏
