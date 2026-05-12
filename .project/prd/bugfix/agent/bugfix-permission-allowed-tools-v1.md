---
timestamp: 2026-05-11
status: in-progress
module: agent
type: bugfix
assignee: misakamikoto
priority: P0
---

# Bug 修复：Agent 高风险操作未触发权限确认弹窗

## 问题描述

Agent 执行高风险操作（Bash 删除命令、文件覆盖写入等）时不会弹出权限确认弹窗，直接执行。该问题在本地 Agent 和远程 Agent 模式下均存在。

用户无法在 Agent 执行危险操作前介入确认，存在数据丢失风险。尽管 `permission-handler.ts` 中已经实现了完整的权限检查逻辑（HIGH_RISK_TOOLS 分类、pending request 注册表、超时机制），且前端已有 `ToolPermissionCard` 组件展示权限请求，但这些代码从未被触发。

### 触发条件

1. 用户发送消息，Agent 开始处理
2. Agent 判断需要执行高风险操作（如 `rm -rf`、文件覆盖写入等）
3. SDK 调用工具时，应触发 `canUseTool` 回调
4. **Bug**：`canUseTool` 回调未被调用，工具直接执行

### 影响范围

- **本地 Agent**：所有高风险工具（Bash、Write、Edit）绕过权限确认
- **远程 Agent**：同样绕过权限确认
- **MCP 工具**：完全不受权限系统约束
- **安全性**：P0 — 用户数据可能被 Agent 无确认地删除或覆盖

## 根因分析

### 根因：`allowedTools` 预授权了高风险工具

`src/main/services/agent/system-prompt.ts` 第 19-27 行定义了 `DEFAULT_ALLOWED_TOOLS`：

```typescript
// system-prompt.ts line 19-27
export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Write',   // <-- 高风险，不应预授权
  'Edit',    // <-- 高风险，不应预授权
  'Grep',
  'Glob',
  'Bash',    // <-- 高风险，不应预授权
  'Skill',
] as const;
```

该列表被传递给 SDK 的 `allowedTools` 选项（`sdk-config.ts` 第 714 行）：

```typescript
// sdk-config.ts line 714
allowedTools: [...DEFAULT_ALLOWED_TOOLS],
```

**SDK 对 `allowedTools` 的语义是「预授权工具」**，SDK 会将这些工具视为已获用户批准的工具，调用时自动放行，不触发 `canUseTool` 回调。因此 `permission-handler.ts` 中精心设计的权限检查逻辑（第 237-278 行 HIGH_RISK_TOOLS 判断、pending request 等待、超时等）从未被到达。

### 概念混淆

当前 `DEFAULT_ALLOWED_TOOLS` 被用于两个不同目的：

| 用途 | 期望语义 | 当前行为 |
|------|---------|---------|
| **系统提示词**（system prompt） | 告诉模型可以使用哪些工具 | Write/Edit/Bash 在列表中，模型知道可以用 |
| **SDK `allowedTools`** | 预授权工具，跳过权限检查 | Write/Edit/Bash 被预授权，`canUseTool` 永远不被调用 |

这两个用途需要不同的列表：
- 系统提示词需要**完整工具列表**（包含高风险工具），否则模型不知道可以使用它们
- SDK `allowedTools` 应只包含**安全工具**（Read、Glob、Grep），高风险工具必须走 `canUseTool` 回调

### 关联问题

前两次修复均未解决此根因：

1. **`bugfix-permission-mode-v1`**（PRD 存在）：将 `permissionMode` 从 `bypassPermissions` 改为 `default`，并移除 `dangerously-skip-permissions` — 修复了 SDK 权限模式的配置，但 `allowedTools` 预授权使修复无效
2. **`bugfix-permission-bypass-v1`**（PRD 存在，状态 in-progress）：发现 `canUseTool` 回调无条件放行，计划修复回调逻辑 — 但实际上 `canUseTool` 根本不被 SDK 调用，因为 `allowedTools` 预授权

### 附带问题

除了核心根因外，还有三个附带问题需要在本次修复中一并解决：

#### 附带问题 1：MCP 工具未覆盖权限系统

`permission-handler.ts` 第 282 行对所有非 HIGH_RISK_TOOLS 的工具自动放行。MCP 提供的工具（如 `mcp__fetch`、`mcp__database_query` 等）不在 HIGH_RISK_TOOLS 集合中，会走到 `return { behavior: 'allow' }` 分支，未经任何权限检查。

```typescript
// permission-handler.ts line 281-282
// All other tools: auto-allow
return { behavior: 'allow' as const, updatedInput: input };
```

#### 附带问题 2：远程 Agent 权限未转发

`src/main/ipc/agent.ts` 第 197-210 行的 `agent:resolve-permission` handler 直接调用本地 `resolvePermission()`，不像 `agent:answer-question`（第 161-192 行）那样检查远程会话并通过 WebSocket 转发。远程 Agent 的权限确认结果无法回传。

#### 附带问题 3：ToolPermissionCard 信息不足

`ToolPermissionCard.tsx` 第 63-65 行对 Write/Edit 工具只显示文件路径，不显示要写入/修改的内容：

```typescript
// ToolPermissionCard.tsx line 63-65
if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Create' || toolName === 'MultiEdit') {
  const filePath = String(toolInput.file_path || toolInput.path || '');
  return filePath;  // <-- 只显示路径，没有内容预览
}
```

用户无法判断 Write/Edit 操作是否安全，只能盲目批准。

## 技术方案

### 方案概述

将 `DEFAULT_ALLOWED_TOOLS` 拆分为两个概念：`AVAILABLE_TOOLS`（模型可用工具，用于系统提示词）和 `PRE_APPROVED_TOOLS`（预授权工具，用于 SDK `allowedTools`）。同时修复附带问题。

### 步骤 1：拆分工具列表

**文件**：`src/main/services/agent/system-prompt.ts`

1. 重命名 `DEFAULT_ALLOWED_TOOLS` 为 `AVAILABLE_TOOLS`（或保留原名但明确语义为"模型可用工具"）
2. 新增 `PRE_APPROVED_TOOLS`，仅包含安全工具：

```typescript
/** Tools available to the model (used in system prompt) */
export const AVAILABLE_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
  'Bash',
  'Skill',
] as const;

/** Tools that are pre-approved and skip canUseTool callback (safe/read-only only) */
export const PRE_APPROVED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
] as const;
```

3. 更新 `SystemPromptContext.allowedTools` 的类型引用（如有使用 `AllowedTool` 类型的地方）

### 步骤 2：修改 SDK 配置

**文件**：`src/main/services/agent/sdk-config.ts`

1. 将第 714 行从 `allowedTools: [...DEFAULT_ALLOWED_TOOLS]` 改为 `allowedTools: [...PRE_APPROVED_TOOLS]`
2. 更新 import：`import { buildSystemPrompt, AVAILABLE_TOOLS, PRE_APPROVED_TOOLS } from './system-prompt'`
3. 确认系统提示词构建（第 711 行 `buildSystemPrompt`）如果需要工具列表，应传入 `AVAILABLE_TOOLS`

### 步骤 3：MCP 工具权限策略

**文件**：`src/main/services/agent/permission-handler.ts`

修改第 281-282 行的 auto-allow 逻辑。MCP 工具的名称格式为 `mcp__<server>__<tool>`（例如 `mcp__fetch__web_reader`）。策略：

- MCP 工具默认自动放行（大多数 MCP 工具是只读的信息获取工具，如搜索、查询）
- 如果需要限制特定 MCP 工具，可以通过配置添加 `MCP_BLOCKED_TOOLS` 集合
- 添加日志记录 MCP 工具调用，便于审计

```typescript
// After HIGH_RISK_TOOLS check and before auto-allow:
// MCP tools: auto-allow with logging (most MCP tools are read-only)
if (toolName.startsWith('mcp__')) {
  console.log(`[PermissionHandler] MCP tool auto-allowed: ${toolName}`);
  return { behavior: 'allow' as const, updatedInput: input };
}
```

### 步骤 4：远程 Agent 权限转发

**文件**：`src/main/ipc/agent.ts`

参考 `agent:answer-question`（第 161-192 行）的远程转发模式，修改 `agent:resolve-permission` handler：

```typescript
wrapIpcHandle(
  'agent:resolve-permission',
  async (_event, data: { id: string; approved: boolean; conversationId?: string }) => {
    try {
      // Check if this is a remote session — forward via WebSocket
      if (data.conversationId) {
        const remoteClient = getRemoteWsClient(data.conversationId);
        if (remoteClient && remoteClient.isConnected()) {
          remoteClient.send({
            type: 'tool:approve',  // 复用已有类型或新增 'permission:resolve'
            sessionId: data.conversationId,
            payload: { id: data.id, approved: data.approved },
          });
          return { success: true };
        }
      }

      // Local session — resolve directly
      const resolved = resolvePermission(data.id, data.approved);
      if (!resolved) {
        return { success: false, error: 'No pending permission found for this ID' };
      }
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  },
);
```

同时确认 `ws-types.ts` 的 `ClientMessage` 类型已包含 `'tool:approve'`（已确认存在，第 29 行）。

**额外检查**：确认远程 Agent 侧的 `canUseTool` 回调是否正确发送权限请求事件到 WebSocket，使本地 UI 能收到 `agent:permission-request` 事件。

### 步骤 5：ToolPermissionCard 增强

**文件**：`src/renderer/components/chat/ToolPermissionCard.tsx`

修改 `formatToolPreview()` 函数，为 Write/Edit 增加 diff/内容预览：

```typescript
if (toolName === 'Write') {
  const filePath = String(toolInput.file_path || '');
  const content = String(toolInput.content || '');
  const preview = filePath + '\n' + (content.length > 200 ? content.substring(0, 200) + '...' : content);
  return preview;
}
if (toolName === 'Edit') {
  const filePath = String(toolInput.file_path || '');
  const oldStr = String(toolInput.old_string || '');
  const newStr = String(toolInput.new_string || '');
  return `${filePath}\n- ${oldStr.length > 100 ? oldStr.substring(0, 100) + '...' : oldStr}\n+ ${newStr.length > 100 ? newStr.substring(0, 100) + '...' : newStr}`;
}
```

### 步骤 6：传递 conversationId 给 resolve-permission

**文件**：`src/renderer/stores/chat.store.ts`

`resolveToolPermission` 方法调用 `api.resolveAgentPermission()` 时，需要额外传递 `conversationId` 以支持远程转发判断：

```typescript
resolveToolPermission: async (conversationId: string, approved: boolean) => {
  const session = get().sessions.get(conversationId);
  if (!session?.pendingToolPermission) return;
  const { id } = session.pendingToolPermission;
  await api.resolveAgentPermission({ id, approved, conversationId });
  // ... update status
},
```

**文件**：`src/renderer/api/index.ts`

确认 `resolveAgentPermission` 接口签名支持传递 `conversationId`。

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计文档 | `.project/modules/agent/features/permission-handling/design.md` | 理解现有权限处理架构、正常/异常流程 |
| 模块设计文档 | `.project/modules/agent/features/stream-processing/design.md` | 理解流式处理引擎、事件分发 |
| 模块设计文档 | `.project/modules/agent/features/tool-orchestration/design.md` | 理解多代理编排中的权限处理 |
| 功能 bugfix | `.project/modules/agent/features/permission-handling/bugfix.md` | 了解历史 bug（AskUserQuestion 卡死） |
| 功能 changelog | `.project/modules/agent/features/permission-handling/changelog.md` | 了解最近变更 |
| 前次 PRD | `.project/prd/bugfix/agent/bugfix-permission-mode-v1.md` | 前次修复（permissionMode），理解为什么未生效 |
| 前次 PRD | `.project/prd/bugfix/agent/bugfix-permission-bypass-v1.md` | 前次修复（canUseTool 回调），理解为什么未生效 |
| 源码文件 | `src/main/services/agent/system-prompt.ts` | `DEFAULT_ALLOWED_TOOLS` 定义和用途 |
| 源码文件 | `src/main/services/agent/sdk-config.ts`（第 700-735 行） | SDK 配置项，`allowedTools` 和 `canUseTool` 传递 |
| 源码文件 | `src/main/services/agent/permission-handler.ts` | 完整的权限处理逻辑、HIGH_RISK_TOOLS 分类 |
| 源码文件 | `src/main/ipc/agent.ts`（第 155-210 行） | IPC handler：`answer-question` 和 `resolve-permission` |
| 源码文件 | `src/renderer/components/chat/ToolPermissionCard.tsx` | 前端权限确认卡片组件 |
| 源码文件 | `src/renderer/stores/chat.store.ts`（第 2497-2570 行） | `handlePermissionRequest` 和 `resolveToolPermission` |
| 源码文件 | `src/renderer/types/index.ts`（第 679-687 行） | `ToolPermissionRequest` 类型定义 |
| 源码文件 | `src/preload/index.ts`（第 837-853 行） | Preload 暴露的权限相关 IPC 通道 |
| 源码文件 | `src/renderer/api/transport.ts`（第 297-300 行） | 事件监听映射 |
| 源码文件 | `src/main/services/remote/ws/ws-types.ts` | WebSocket 消息类型定义 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript 规范、IPC 通道规范 |

## 涉及文件

### 实际修改

| 文件 | 修改内容 |
|------|---------|
| `src/main/services/agent/system-prompt.ts` | 拆分 `DEFAULT_ALLOWED_TOOLS` 为 `AVAILABLE_TOOLS` + `PRE_APPROVED_TOOLS`，保留 `DEFAULT_ALLOWED_TOOLS` 作为向后兼容别名 |
| `src/main/services/agent/sdk-config.ts` | `allowedTools` 改用 `PRE_APPROVED_TOOLS`，更新 import |
| `src/main/services/agent/permission-handler.ts` | 添加 MCP 工具日志记录和自动放行逻辑 |
| `src/main/ipc/agent.ts` | `resolve-permission` handler 增加远程会话 WebSocket 转发 |
| `src/renderer/components/chat/ToolPermissionCard.tsx` | Write/Edit 增加 diff/内容预览 |
| `src/renderer/stores/chat.store.ts` | `resolveToolPermission` 传递 `conversationId` |
| `src/renderer/api/index.ts` | `resolveAgentPermission` 接口签名增加 `conversationId` 可选字段 |
| `src/preload/index.ts` | `resolveAgentPermission` 类型声明同步更新 |

### 未修改（待跟进）

| 文件 | 确认内容 |
|------|---------|
| `src/main/services/agent/send-message.ts` | 确认远程 Agent 的 `canUseTool` 回调是否通过 WebSocket 发送权限请求事件 |
| `packages/remote-agent-proxy/` | 确认远程 Agent 的 `allowedTools` 配置是否也存在同样问题 |

## 验收标准

- [ ] Agent 执行 Bash 删除命令（如 `rm`）时，前端弹出权限确认弹窗
- [ ] Agent 执行 Write 工具（文件写入）时，前端弹出权限确认弹窗
- [ ] Agent 执行 Edit 工具（文件编辑）时，前端弹出权限确认弹窗
- [ ] 权限确认弹窗显示操作详情：Bash 显示完整命令，Write/Edit 显示内容和文件路径
- [ ] 用户点击"Allow"后操作正常执行
- [ ] 用户点击"Deny"后操作被阻断，Agent 收到拒绝反馈并调整行为
- [ ] Read、Glob、Grep 等安全工具不触发权限确认弹窗
- [ ] AskUserQuestion 功能不受影响
- [ ] Skill 禁用检查不受影响
- [ ] MCP 工具调用正常工作（自动放行 + 日志记录）
- [ ] 远程 Agent 权限确认结果通过 WebSocket 正确转发
- [ ] 用户停止生成时，所有待处理权限请求被正确清理
- [ ] 权限请求 5 分钟超时自动拒绝
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
