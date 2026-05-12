# PRD - 权限拒绝后模型提供替代方案

## 元信息

| 字段 | 值 |
|------|-----|
| 日期 | 2026-05-12 |
| 状态 | in-progress |
| 类型 | feature |
| 优先级 | P1 |
| 指令人 | @moonseeker1 |
| 模块 | agent（权限处理） |

## 需求描述

### 现状

当 Agent 尝试执行破坏性 Bash 命令（如 `rm`、`sudo` 等）时，前端会展示 `ToolPermissionCard`，用户可以点击「允许」或「拒绝」。当用户点击「拒绝」时，`canUseTool` 回调返回 `{ behavior: 'deny', updatedInput: { ...input, _permissionDenied: true } }`，SDK 接收到拒绝信号后，模型**静默跳过**该操作并继续后续任务，不会向用户解释发生了什么。

### 问题

1. 用户拒绝操作后，模型不解释原因也不提供替代方案，用户可能困惑于为什么任务未完成
2. 对于常见场景（如 `rm -rf node_modules` 被拒绝），模型有义务告知更安全的替代方式（如 `npm cache clean --force`）
3. 拒绝信息丢失：`_permissionDenied: true` 被注入到 `updatedInput` 中，但 SDK 的 deny 分支**不使用 updatedInput**，模型根本看不到这条信息

### 期望行为

用户拒绝破坏性操作后，模型应：
1. **确认拒绝**：向用户说明该操作已被用户拒绝
2. **分析风险**：简要解释为什么该操作可能存在风险
3. **提供替代方案**：建议更安全的替代操作供用户选择
4. **自然呈现**：替代方案在对话中自然展示（不使用单独 UI 弹窗）

## 技术方案

### 方案选择：Option D（系统提示 + SDK `message` 字段双管齐下）

经过分析，推荐**组合方案**：

1. **`message` 字段（实时指令）**：SDK 的 `PermissionResult` deny 分支原生支持 `message: string` 字段。SDK 会将此消息作为工具拒绝的反馈传给模型，模型据此调整行为。这是最直接有效的方式。

2. **系统提示指令（兜底行为）**：在系统提示中添加关于权限拒绝处理的通用指导，确保即使 `message` 字段在某些边界场景未生效，模型仍能正确应对。

> **为什么不用 `updatedInput`**：SDK 的 deny 分支（`sdk.d.ts:1552-1558`）类型定义中，deny 路径**没有 `updatedInput` 字段**，只有 `message`、`interrupt` 和 `toolUseID`。当前代码将 `_permissionDenied` 注入到 `updatedInput` 是无效的——SDK 会忽略它。

### 改动点

#### 1. `permission-handler.ts` — deny 路径添加 `message` 字段

**文件**：`src/main/services/agent/permission-handler.ts`

**当前类型定义（第 21-24 行）**：
```typescript
type PermissionResult = {
  behavior: 'allow' | 'deny';
  updatedInput: Record<string, unknown>;
};
```

需要修改为与 SDK 类型对齐的联合类型：
```typescript
type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput: Record<string, unknown>;
    }
  | {
      behavior: 'deny';
      message: string;
    };
```

**deny 路径改动**（第 381-384 行，用户主动拒绝；第 392-394 行，超时/取消）：

当前：
```typescript
return {
  behavior: 'deny' as const,
  updatedInput: { ...input, _permissionDenied: true },
};
```

改为：
```typescript
return {
  behavior: 'deny' as const,
  message: `The user denied permission to execute this ${toolName} command: ${String(input.command || '').substring(0, 200)}. ` +
    `Explain to the user that this operation was not performed because they declined it. ` +
    `Then suggest safer alternative approaches to accomplish the same goal. ` +
    `Present the alternatives clearly and ask the user which approach they prefer.`,
};
```

同样适用于 Skill 阻断（第 277-279 行）和 AskUserQuestion 取消（第 330-332 行）的 deny 路径，分别使用适当的 message 内容。

#### 2. `system-prompt.ts` — 添加权限拒绝处理指导

**文件**：`src/main/services/agent/system-prompt.ts`

在 `SYSTEM_PROMPT_TEMPLATE` 的 `# Tool usage policy` 部分末尾添加权限拒绝处理指令：

```
## Handling Denied Tool Permissions

When a tool permission request is denied by the user, you MUST:
1. Acknowledge the denial to the user — explain that the specific operation was not performed because they declined it
2. Briefly explain why the operation may carry risk (e.g., irreversible data loss, system changes)
3. Propose safer alternative approaches to accomplish the same goal, if alternatives exist
4. Ask the user which alternative they prefer, or ask if they want to proceed differently

Never silently skip a denied operation. Always inform the user and offer alternatives.
```

#### 3. `claude-manager.ts`（远程 Agent）— 同步 deny 路径改动

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

远程 Agent 的 `canUseTool` 回调（约第 1830 行起）有独立的 deny 路径。需要同步添加 `message` 字段。

具体改动位置：
- **第 1844 行**：AskUserQuestion abort → 添加 `message`
- **第 1853 行**：AskUserQuestion cancel → 添加 `message`
- **第 1872 行**：Bash permission abort → 添加 `message`
- **第 1880 行**：Bash permission denied → 添加 `message`
- **第 1883 行**：Bash permission cancel → 添加 `message`

远程系统提示通过 `/opt/claude-deployment/config/system-prompt.txt` 从本地同步（`system-prompt.ts` 的 `SYSTEM_PROMPT_TEMPLATE`），因此本地系统提示改动会自动同步到远程，**无需单独修改远程系统提示**。

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计 | `.project/modules/agent/features/permission-handling/design.md` | 理解权限处理的整体架构和流程 |
| 源码文件 | `src/main/services/agent/permission-handler.ts` | 定位所有 deny 返回路径，理解 `PermissionResult` 类型 |
| 源码文件 | `src/main/services/agent/system-prompt.ts` | 理解系统提示模板结构，找到插入指令的位置 |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts`（第 1830-1890 行） | 定位远程 Agent 的 `canUseTool` 回调和 deny 路径 |
| SDK 类型 | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（第 1546-1558 行） | 确认 `PermissionResult` deny 分支支持 `message` 字段 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、命名规范、import 规范 |

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/permission-handler.ts` | 修改 | 更新 `PermissionResult` 类型定义；所有 deny 路径添加 `message` 字段 |
| `src/main/services/agent/system-prompt.ts` | 修改 | 在 `SYSTEM_PROMPT_TEMPLATE` 中添加权限拒绝处理指令 |
| `packages/remote-agent-proxy/src/claude-manager.ts` | 修改 | 远程 `canUseTool` 回调的所有 deny 路径添加 `message` 字段 |

## 验收标准

- [ ] **deny 返回类型正确**：`permission-handler.ts` 的 `PermissionResult` 类型与 SDK 的联合类型对齐，deny 分支包含 `message: string`
- [ ] **本地 deny 路径全部覆盖**：`permission-handler.ts` 中所有返回 `behavior: 'deny'` 的路径（约 4 处）均包含 `message` 字段
- [ ] **远程 deny 路径全部覆盖**：`claude-manager.ts` 中所有返回 `behavior: 'deny'` 的路径（约 5 处）均包含 `message` 字段
- [ ] **系统提示包含拒绝处理指令**：`SYSTEM_PROMPT_TEMPLATE` 中包含权限拒绝处理的指导段落
- [ ] **模型行为验证**：拒绝破坏性 Bash 命令后，模型在对话中解释原因并提供替代方案（不是静默跳过）
- [ ] **TypeScript 类型检查通过**：`npm run typecheck` 无错误
- [ ] **构建通过**：`npm run build` 无错误
