# Bugfix PRD: canUseTool 回调自动放行导致权限确认被绕过

## 元信息

| 字段 | 值 |
|------|------|
| 时间 | 2026-05-11 |
| 状态 | in-progress |
| 指令人 | @mi-saka |
| 级别 | bugfix |
| 模块 | agent |
| 关联 PRD | `.project/prd/bugfix/agent/bugfix-permission-mode-v1.md`（前次修复未生效） |

## 问题描述

Agent 执行高风险操作（删除文件、执行破坏性 Bash 命令等）时不询问用户许可，直接执行。前一次修复（`bugfix-permission-mode-v1`）将 `sdk-config.ts` 的 `permissionMode` 从 `'bypassPermissions'` 改为 `'default'` 并移除了 `extraArgs` 中的 `dangerously-skip-permissions`，但问题未解决。

## 根因分析

### 表面现象

`permission-handler.ts` 第 128-143 行的 `canUseTool` 回调对所有非 `AskUserQuestion` 工具直接返回 `{ behavior: 'allow' }`，导致所有工具调用被自动批准。

### SDK 权限系统完整调用链

通过深入分析 SDK 源码（`@anthropic-ai/claude-agent-sdk` 的 `sdk.mjs` 和 `cli.js`），完整权限链路如下：

```
AICO-Bot (sdk-config.ts)               SDK (sdk.mjs)                  CLI 子进程 (cli.js)
────────────────────────               ─────────────                  ───────────────────
permissionMode: 'default'     ──►      --permission-mode default     ──►  o_7() 解析为 mode='default'
canUseTool: createCanUseTool  ──►      canUseTool: true (布尔标记)    ──►  hasBidirectionalNeeds() = true
                                       canUseTool 函数通过              Query 初始化时注册
                                       initConfig 传给 Query
                                                                     ──►  GVY() 调用 q.checkPermissions()
                                                                     ──►  返回 'ask' 时:
                                                                           wX() 检查 shouldAvoidPermissionPrompts
                                                                           = true (子进程/无头模式)
                                                                     ──►  DVY() 通过 PermissionRequest hook
                                                                           发送 control_request
                                            ◄─────────────────────────────  { subtype: 'can_use_tool',
                                                                           tool_name, input, ... }
                               processControlRequest() 处理
                               调用 this.canUseTool()  ──►
                               (AICO-Bot 的回调)
permission-handler.ts 返回 { behavior: 'allow' }
                               ◄─────────────────────────────  { behavior: 'allow' }
                                                                     ──►  工具调用被批准执行
```

**关键发现：**

1. **`permissionMode: 'default'` 已正确生效**。前次修复成功将 SDK 配置从 `bypassPermissions` 改为 `default`，CLI 子进程确实进入了 `default` 权限模式。

2. **CLI 子进程的权限检查也正常工作**。在 `default` 模式下，`GVY()` 函数正确调用每个工具的 `checkPermissions()` 方法，对 Bash、Write、Edit 等高风险工具返回 `'ask'`。

3. **`shouldAvoidPermissionPrompts: true`**。由于 CLI 以子进程（非交互式）模式运行，无法直接弹出终端权限对话框，因此标记 `shouldAvoidPermissionPrompts = true`，转而通过 PermissionRequest hook 将权限请求发送回 SDK 层。

4. **最终的守门人是 `canUseTool` 回调**。SDK 的 `Query.processControlRequest()` 收到 `subtype: 'can_use_tool'` 的 control_request 后，调用 AICO-Bot 提供的 `canUseTool` 回调。这个回调的返回值就是最终决定。

5. **当前 `canUseTool` 回调无条件放行**。`permission-handler.ts` 第 143 行 `return { behavior: 'allow' as const, updatedInput: input }` 对所有工具（除了禁用技能和 AskUserQuestion）直接返回 allow。

### 根因总结

**`canUseTool` 回调是 SDK 子进程模式下权限确认的唯一通道，当前实现对所有工具无条件返回 `allow`，完全绕过了 SDK 正确触发的权限确认流程。**

前次修复解决了"SDK 没有触发权限检查"的问题（`bypassPermissions` -> `default`），但没有解决"权限请求到达回调后被自动批准"的问题。

### 远程代理同样受影响

`packages/remote-agent-proxy/src/claude-manager.ts` 第 1728-1731 行同样对所有非 AskUserQuestion 工具自动返回 allow，且仍使用 `permissionMode: 'bypassPermissions'` + `extraArgs: { 'dangerously-skip-permissions': null }`。

## 技术方案

### 方案概述

修改 `canUseTool` 回调，根据 SDK 传入的权限建议（`decisionReason`、`suggestions`、`title` 等）将需要确认的工具调用转发到前端，由用户决定是否批准。

### 详细设计

#### 1. 修改 `permission-handler.ts` 的 `createCanUseTool`

当 `canUseTool` 回调收到 SDK 的权限请求时，SDK 会传入以下参数（参见 `Query.processControlRequest()` 中的 `can_use_tool` 处理）：

```typescript
canUseTool(toolName, input, {
  signal,
  suggestions,       // SDK 建议的权限操作（如 "Allow for this session"）
  blockedPath,       // 被阻止的路径（文件操作）
  decisionReason,    // SDK 的决策原因（包含工具自身的 checkPermissions 结果）
  title,             // 工具显示名称
  displayName,       // 工具简短名称
  description,       // 权限请求描述
  toolUseID,         // 工具调用 ID
  agentID,           // 代理 ID（子代理场景）
})
```

修改逻辑：

```typescript
// 对非 AskUserQuestion 工具：
if (toolName !== 'AskUserQuestion') {
  // 保持现有的禁用技能检查...

  // 如果 SDK 传入了 decisionReason，说明 SDK 内部认为此工具需要权限确认
  // 将请求转发到前端让用户决定
  if (deps) {
    return forwardPermissionRequestToRenderer(deps, {
      toolName,
      input,
      signal: options.signal,
      suggestions: (options as any).suggestions,
      blockedPath: (options as any).blockedPath,
      decisionReason: (options as any).decisionReason,
      title: (options as any).title,
      displayName: (options as any).displayName,
      description: (options as any).description,
      toolUseID: (options as any).toolUseID,
      agentID: (options as any).agentID,
    });
  }

  // 无 deps（warmup 等场景）：自动允许
  return { behavior: 'allow' as const, updatedInput: input };
}
```

#### 2. 新增权限请求转发函数

在 `permission-handler.ts` 中新增类似 AskUserQuestion 的 pending request 模式：

```typescript
// 权限请求注册表
const pendingPermissionRequests = new Map<string, {
  resolve: (result: { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown> }) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}>();

export function resolvePermissionRequest(
  id: string,
  approved: boolean,
  updatedInput?: Record<string, unknown>,
): boolean { /* 类似 resolveQuestion */ }

export function rejectPermissionRequest(id: string, reason?: string): boolean { /* 类似 rejectQuestion */ }

export function rejectAllPermissionRequests(): void { /* 类似 rejectAllQuestions */ }
```

#### 3. 前端权限确认 UI

利用已有的 `PermissionRequestDialog.tsx` 组件（当前仅用于 Hyper Space Worker），扩展支持主 Agent 的权限确认：

- 通过 `agent:permission-request` 事件发送权限请求到渲染进程
- 渲染进程展示工具名称、输入预览、操作描述
- 用户点击 Approve/Deny 后通过 IPC 返回结果

#### 4. IPC 通道

复用/扩展已有的 IPC 通道：

| 通道 | 方向 | 用途 |
|------|------|------|
| `agent:permission-request` | Main → Renderer | 发送权限请求 |
| `agent:resolve-permission` | Renderer → Main | 用户批准权限 |
| `agent:reject-permission` | Renderer → Main | 用户拒绝权限 |

`src/main/ipc/agent.ts` 第 125-127 行已有 `agent:approve-tool` 和 `agent:reject-tool` 的 no-op handler，需改为实际处理。

#### 5. 不修改的部分

| 组件 | 原因 |
|------|------|
| `sdk-config.ts` 的 `permissionMode: 'default'` | 已正确设置，无需修改 |
| `mcp-manager.ts` 的 `permissionMode: 'bypassPermissions'` | 仅做一次 MCP 健康检查，不涉及用户操作 |
| `skill-conversation.service.ts` / `temp-agent-session.ts` 的 `bypassPermissions` | 技能创建器内部使用，不涉及用户数据操作 |
| `packages/remote-agent-proxy/` | 远程代理的修复范围更大，需单独 PRD |

### 风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| Agent 频繁弹确认框导致体验差 | 中 | 前端提供 "Always allow for this session" 选项，通过 `updatedPermissions` 回传给 SDK |
| 流式处理阻塞在权限等待 | 中 | 权限请求超时 5 分钟自动拒绝；用户可随时停止生成 |
| 与 Hyper Space Worker 权限系统冲突 | 低 | Worker 权限走 `permission-forwarder.ts`，主 Agent 权限走 `permission-handler.ts`，两者独立 |

## 涉及文件

### 预估修改

| 文件 | 修改内容 |
|------|---------|
| `src/main/services/agent/permission-handler.ts` | 新增权限请求转发逻辑、pending request 注册表、resolve/reject 函数 |
| `src/main/ipc/agent.ts` | 替换 `agent:approve-tool` / `agent:reject-tool` 的 no-op 为实际处理 |
| `src/preload/index.ts` | 暴露权限相关 IPC 通道（如需要新增通道） |
| `src/renderer/api/transport.ts` | 监听 `agent:permission-request` 事件（如需要） |
| `src/renderer/api/index.ts` | 导出权限相关 API（如需要） |

### 需确认

| 文件 | 确认内容 |
|------|---------|
| `src/main/services/agent/send-message.ts` | 流处理中是否需要处理权限等待状态（暂停 token 推送） |
| `src/renderer/stores/chat.store.ts` | 权限请求的 UI 状态管理位置 |

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计文档 | `.project/modules/agent/features/permission-handling/design.md` | 理解现有权限处理架构 |
| 功能设计文档 | `.project/modules/agent/features/stream-processing/design.md` | 理解流式处理引擎 |
| 源码文件 | `src/main/services/agent/permission-handler.ts` | 现有 canUseTool 回调实现 |
| 源码文件 | `src/main/services/agent/sdk-config.ts` | SDK 配置和 canUseTool 传递 |
| 源码文件 | `src/main/ipc/agent.ts` | 现有 IPC 处理器 |
| 源码文件 | `src/renderer/components/chat/PermissionRequestDialog.tsx` | 现有权限确认 UI 组件 |
| 源码文件 | `src/main/services/agent/permission-forwarder.ts` | Hyper Space 权限转发（参考实现） |
| 变更记录 | `.project/modules/agent/features/permission-handling/changelog.md` | 历史变更 |
| 前次 PRD | `.project/prd/bugfix/agent/bugfix-permission-mode-v1.md` | 前次修复内容 |

## 验收标准

- [ ] Agent 执行高风险操作（如 Bash 删除命令、文件覆盖写入）时，前端弹出权限确认对话框
- [ ] 权限确认对话框显示工具名称、操作内容预览
- [ ] 用户点击"批准"后操作正常执行
- [ ] 用户点击"拒绝"后操作被阻断，Agent 收到拒绝反馈并调整行为
- [ ] 用户停止生成时，所有待处理权限请求被正确清理
- [ ] AskUserQuestion 功能不受影响（现有行为保持）
- [ ] 禁用技能检查不受影响（现有行为保持）
- [ ] MCP 健康检查功能正常（mcp-manager.ts 未被修改）
- [ ] 技能创建器功能正常（skill-conversation.service.ts 未被修改）
- [ ] 权限请求 5 分钟超时自动拒绝
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
