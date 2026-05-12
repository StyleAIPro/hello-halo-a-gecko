---
timestamp: 2026-05-11
status: in-progress
module: agent
type: bugfix
assignee: misakamikoto
priority: P0
---

# Bug 修复：远程 Agent 权限系统部署后仍不生效

## 问题描述

前次修复（`bugfix-remote-permission-bypass-v1`）已对远程代理的权限系统进行了完整改造：`permissionMode: 'default'`、`PRE_APPROVED_TOOLS` 拆分、`canUseTool` 破坏性 Bash 检测、WebSocket `permission:request` / `permission:response` 协议。

源码逻辑经审查无误，`npm run build` 和 `npm run build:offline-bundle` 均通过。但用户部署更新后的代码并使用**新对话**测试，远程 Agent 仍然**不请求权限就执行破坏性命令**（如 `rm -rf`）。

## 根因分析

源码逻辑正确但权限系统仍失效，说明问题出在代码之外的环节。以下是按可能性排序的四个假设：

### 假设 1（高概率）：部署缓存导致旧代码持续运行

离线部署（`deployAgentCodeOffline`）通过比较远端和本地 `dist/version.json` 中的 `buildTimestamp` 判断是否需要上传。`build-with-timestamp.js` 每次 build 生成新的 ISO 时间戳，正常情况下 build 后部署时间戳必然不同。

但如果用户在**未重新 build**的情况下通过 UI 触发部署（例如使用上次 build 的旧 Electron），远端时间戳与本地一致，上传被跳过，旧代码持续运行。

### 假设 2（中概率）：`needsSessionRebuild` 不检查 `permissionMode`

`getOrCreateSession()` 在会话复用时调用 `needsSessionRebuild()` 判断是否需要重建。该函数比较 `model`、`workDir`、`apiKey`、`baseUrl`、`contextWindow`，但**不检查 `permissionMode`**。

如果用户在旧代码运行期间创建了会话（`permissionMode: 'bypassPermissions'`），部署新代码后继续在同一会话中发消息，`needsSessionRebuild` 返回 `false`，会话被复用，旧的 `bypassPermissions` 权限模式持续生效。

新对话应该不受影响（会触发新建会话），除非进程未重启（Node.js 长驻进程）。

### 假设 3（中概率）：SDK 子进程 `checkPermissions` 在 subprocess 层面直接放行

`permissionMode: 'default'` 下，SDK CLI 子进程自行运行 `checkPermissions()`。对于 Bash 工具，子进程可能只对**特定命令模式**返回 `'ask'`（例如匹配硬编码的正则表达式）。如果子进程对测试的破坏性命令自动返回 `'allow'`，它不会发送 `control_request`，`canUseTool` 回调永远不会被调用。

### 假设 4（低概率）：`canUseTool` 回调传递链路断裂

`onPermissionRequest` 由 `server.ts` 创建（第 826 行）并通过 `streamChat()` 传递到 `getOrCreateSession()`，最终设置到 `sdkOptions.canUseTool`（第 1427 行）。如果任何一环未正确传递（例如 `streamChat` 参数签名变化），`canUseTool` 为 `undefined`，权限系统静默失效。

## 技术方案

### 总体策略：先诊断、再修复

由于根因不确定，**禁止直接修改业务逻辑**。分两个阶段：

- **Phase 1**：添加诊断日志，定位确切故障点（必须首先完成）
- **Phase 2**：根据日志结论实施针对性修复

---

### Phase 1：诊断日志（关键）

#### 1.1 日志 `canUseTool` 创建和类型

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

在 `streamChat()` 中，构建 `canUseTool` 后立即记录：

```typescript
// streamChat() 内，canUseTool 构建完成后（约第 1837 行之后）：
console.log(`[ClaudeManager][${sessionId}] canUseTool callback: ${typeof canUseTool}, hasPermissionRequest=${!!onPermissionRequest}`)
```

#### 1.2 日志 `canUseTool` 设置到 sdkOptions

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

在 `getOrCreateSession()` 中，设置 `canUseTool` 后记录（约第 1427 行）：

```typescript
if (canUseTool) {
  sdkOptions.canUseTool = canUseTool
  console.log(`[ClaudeManager][${conversationId}] canUseTool SET on sdkOptions`)
} else {
  console.log(`[ClaudeManager][${conversationId}] canUseTool is UNDEFINED — permission checks DISABLED`)
}
```

#### 1.3 日志会话创建 vs 复用

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

在 `getOrCreateSession()` 中：

```typescript
// 会话复用时（约第 1406 行）：
console.log(`[ClaudeManager][${conversationId}] REUSING existing session (lastUsedAt=${existing.lastUsedAt}), canUseTool=${canUseTool ? 'SET' : 'NOT_SET'}`)

// 新建会话时（约第 1414 行）：
console.log(`[ClaudeManager][${conversationId}] Creating NEW session, permissionMode=${sdkOptions.permissionMode}, canUseTool=${!!sdkOptions.canUseTool}`)
```

#### 1.4 日志完整 SDK 选项

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

在创建会话前（约第 1519 行的已有日志之后）追加：

```typescript
console.log(`[ClaudeManager][${conversationId}] SDK options: permissionMode=${sdkOptions.permissionMode}, canUseTool=${typeof sdkOptions.canUseTool}, allowedTools=[${(sdkOptions.allowedTools || []).join(', ')}]`)
```

#### 1.5 日志 `canUseTool` 每次被 SDK 调用

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

在 `canUseTool` 函数体最前面添加：

```typescript
console.log(`[ClaudeManager] canUseTool INVOKED: toolName=${toolName}, input=${JSON.stringify(input).substring(0, 200)}`)
```

#### 1.6 日志 `permission:request` 发送和接收

**文件**：`packages/remote-agent-proxy/src/server.ts`

在 `onPermissionRequest` 回调内（约第 826 行）：

```typescript
console.log(`[PermissionHandler] Sending permission:request to client: id=${id}, tool=${toolName}, sessionId=${sessionId}`)
```

在 `tool:approve` handler 中（检查 `pendingPermissions` 分支）：

```typescript
console.log(`[PermissionHandler] Received tool:approve for permission ${toolId}, approved=${message.payload?.approved}`)
```

#### 1.7 日志 `send-message-remote.ts` 转发

**文件**：`src/main/services/agent/send-message-remote.ts`

在 `permission:request` handler 内（约第 633 行）：

```typescript
console.log(`[RemotePermission] Forwarding permission:request to renderer: id=${data.data.id}, tool=${data.data.toolName}`)
```

#### 1.8 改善部署日志

**文件**：`src/main/services/remote/deploy/agent-deployer.ts`

在 `deployAgentCodeOffline()` 的时间戳比较处（约第 1111 行），增加更多上下文：

```typescript
if (remoteTimestamp && remoteTimestamp === localTimestamp) {
  skipUpload = true;
  service.emitCommandOutput(id, 'output', `远端版本: ${remoteTimestamp}, 本地版本: ${localTimestamp} — 版本一致，跳过上传`);
  service.emitCommandOutput(id, 'output', `如需强制更新，请先执行 npm run build:offline-bundle 重新构建`);
} else {
  service.emitCommandOutput(id, 'output', `远端版本: ${remoteTimestamp || '(无)'}, 本地版本: ${localTimestamp} — 开始上传`);
}
```

同样在 `updateAgentCodeOffline()` 中做类似改进。

---

### Phase 2：针对性修复（待日志分析结论）

#### 修复 A：部署缓存 — 强制版本检查（假设 1 确认后）

如果日志显示远端和本地 `buildTimestamp` 一致（旧代码），说明部署被跳过。修复方案：

1. 确保 `npm run build` 必定调用 `build:offline-bundle`（检查构建脚本链）
2. 在 UI 的部署按钮上添加提示：部署前请确认已执行最新 build
3. 考虑在部署逻辑中加入 code hash 检查（不依赖时间戳）

#### 修复 B：`needsSessionRebuild` 增加 `permissionMode` 检查（假设 2 确认后）

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

```typescript
// needsSessionRebuild() 函数增加 permissionMode 比较：
function needsSessionRebuild(existing: V2SessionInfo, newConfig: SessionConfig): boolean {
  return (
    existing.config.model !== newConfig.model ||
    existing.config.workDir !== newConfig.workDir ||
    existing.config.apiKey !== newConfig.apiKey ||
    existing.config.baseUrl !== newConfig.baseUrl ||
    existing.config.contextWindow !== newConfig.contextWindow ||
    existing.config.permissionMode !== newConfig.permissionMode  // 新增
  )
}
```

同时在创建会话后存储 `permissionMode` 到 session config（约第 1545 行）：

```typescript
// 在 existing.config merge 之后：
existing.config = {
  ...storedConfig,
  permissionMode: sdkOptions.permissionMode,  // 确保存储
}
```

#### 修复 C：SDK 子进程级权限拦截（假设 3 确认后）

如果日志显示 `canUseTool` 根本没有被 SDK 调用（没有 Phase 1.5 的日志输出），说明问题在 SDK 子进程层面。修复方案：

1. 检查 SDK 版本，确认 `canUseTool` 在 `permissionMode: 'default'` 下确实会被调用
2. 如果 SDK 版本过旧不支持，考虑升级 SDK 或改用 SDK 进程的 `--permission-mode` CLI 参数
3. 作为最后手段，在 `streamChat()` 中拦截工具执行事件（`tool_use` stream event），在 SDK 返回结果前进行前端确认

#### 修复 D：会话复用时重新注入 `canUseTool`（假设 4 确认后）

如果日志显示 `REUSING existing session` 且 `canUseTool=NOT_SET`，说明复用的会话没有新的 `canUseTool`。修复方案：

在 `getOrCreateSession()` 的会话复用路径（约第 1402 行），不直接返回 `existing.session`，而是检查 SDK 是否支持动态更新 `canUseTool`：

```typescript
// 在 "Session is healthy and config matches, reuse it" 分支：
if (canUseTool && typeof (existing.session as any).setCanUseTool === 'function') {
  (existing.session as any).setCanUseTool(canUseTool)
  console.log(`[ClaudeManager][${conversationId}] Injected new canUseTool into reused session`)
}
```

如果 SDK 不支持动态更新，则在 `permissionMode` 变化时强制重建（参见修复 B）。

---

### Phase 3：部署验证

部署更新后的代码并执行以下测试：

1. 启动新对话，请求执行 `rm -rf /tmp/test-permission-check.txt`
2. 检查远程代理日志，确认出现以下日志序列：

```
[ClaudeManager] canUseTool callback: function, hasPermissionRequest=true
[ClaudeManager] Creating NEW session, permissionMode=default, canUseTool=true
[ClaudeManager] SDK options: permissionMode=default, canUseTool=function, allowedTools=[Read, Glob, ...]
[ClaudeManager] canUseTool INVOKED: toolName=Bash, input={"command":"rm -rf /tmp/test-permission-check.txt"}
[ClaudeManager] Destructive Bash detected: rm -rf /tmp/test-permission-check.txt, requesting permission
[PermissionHandler] Sending permission:request to client: id=perm-..., tool=Bash, sessionId=...
[RemotePermission] Forwarding permission:request to renderer: id=perm-..., tool=Bash
```

3. 确认本地 UI 弹出权限确认弹窗
4. 点击 Allow → 远程命令执行
5. 再次请求破坏性命令，点击 Deny → 远程命令被阻断
6. 请求非破坏性命令（`git status`）→ 无弹窗，直接执行

#### 日志诊断矩阵

| 观察到的日志 | 结论 | 对应修复 |
|-------------|------|---------|
| `canUseTool is UNDEFINED` | 回调传递链路断裂 | 修复 D |
| `REUSING existing session` + `canUseTool=NOT_SET` | 会话复用未注入新回调 | 修复 D / B |
| `canUseTool INVOKED` 未出现 | SDK 未调用 canUseTool | 修复 C |
| `Sending permission:request` 出现但 UI 无弹窗 | 前端转发链路问题 | 检查 send-message-remote.ts / chat.store.ts |
| `Received tool:approve` 出现 | 全链路正常 | 检查 UI 渲染逻辑 |
| 远端和本地 `buildTimestamp` 一致 | 部署被跳过，旧代码运行 | 修复 A |

## 涉及文件

### Phase 1（诊断日志）

| 文件 | 修改内容 |
|------|---------|
| `packages/remote-agent-proxy/src/claude-manager.ts` | 添加 1.1-1.5 诊断日志（`canUseTool` 创建、设置、会话复用/新建、SDK 选项、每次调用） |
| `packages/remote-agent-proxy/src/server.ts` | 添加 1.6 诊断日志（`permission:request` 发送、`tool:approve` 接收） |
| `src/main/services/agent/send-message-remote.ts` | 添加 1.7 诊断日志（权限请求转发到渲染进程） |
| `src/main/services/remote/deploy/agent-deployer.ts` | 改善 1.8 部署日志（显示远端/本地版本对比） |

### Phase 2（修复，待诊断结论后实施）

| 文件 | 修改内容 | 依赖 |
|------|---------|------|
| `packages/remote-agent-proxy/src/claude-manager.ts` | `needsSessionRebuild` 增加 `permissionMode` 检查；会话创建时存储 `permissionMode` | 假设 2 |
| `packages/remote-agent-proxy/src/claude-manager.ts` | 会话复用时动态注入 `canUseTool` | 假设 4 |
| 构建脚本（待定） | 确保每次 `npm run build` 必定刷新 offline bundle 时间戳 | 假设 1 |
| SDK 版本 / 配置（待定） | 解决 SDK 子进程层面 checkPermissions 放行问题 | 假设 3 |

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 前次 PRD | `.project/prd/bugfix/agent/bugfix-remote-permission-bypass-v1.md` | 理解前次修复的完整方案和所有改动 |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts`（第 656-664 行 `needsSessionRebuild`；第 970-990 行 SDK 配置；第 1280-1440 行 `getOrCreateSession`；第 1785-1840 行 `canUseTool` 构建） | 理解会话复用判断逻辑、SDK 配置、canUseTool 传递链路 |
| 源码文件 | `packages/remote-agent-proxy/src/server.ts`（第 826-843 行 `onPermissionRequest`；第 503-535 行 `tool:approve` handler） | 理解 WebSocket 权限消息收发 |
| 源码文件 | `src/main/services/agent/send-message-remote.ts`（第 632-645 行 `permission:request` handler） | 理解权限请求从远程代理到本地 UI 的转发 |
| 源码文件 | `src/main/services/remote/deploy/agent-deployer.ts`（第 1095-1117 行部署时间戳比较） | 理解部署跳过逻辑 |
| 部署脚本 | `packages/remote-agent-proxy/scripts/build-with-timestamp.js` | 确认时间戳生成逻辑 |

## 验收标准

### Phase 1：诊断日志

- [ ] 远程代理启动后，新对话日志显示 `canUseTool callback: function, hasPermissionRequest=true`
- [ ] 远程代理日志显示 `Creating NEW session, permissionMode=default, canUseTool=true`（新对话时）
- [ ] 远程代理日志显示 `SDK options: permissionMode=default, canUseTool=function, allowedTools=[...]`（不包含 `Bash`）
- [ ] 执行破坏性 Bash 命令时，日志显示 `canUseTool INVOKED: toolName=Bash`
- [ ] 日志显示 `Destructive Bash detected` 和 `Sending permission:request to client`
- [ ] 部署日志显示远端和本地的 `buildTimestamp` 对比信息
- [ ] 根据日志输出，确定问题属于假设 1-4 中的哪一个（或组合）

### Phase 2：修复（待 Phase 1 诊断结论后补充）

- [ ] 根据 Phase 1 诊断结论实施对应修复
- [ ] 本地 UI 弹出权限确认弹窗并显示命令详情
- [ ] 用户点击 Deny 后远程命令被阻断
- [ ] 用户点击 Allow 后远程命令正常执行
- [ ] 非破坏性命令（`npm run build`、`git status`）不触发弹窗
- [ ] `npm run build` 通过
- [ ] `npm run build:offline-bundle` 通过
- [ ] `npm run typecheck` 通过
