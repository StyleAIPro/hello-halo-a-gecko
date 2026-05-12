---
时间: 2026-05-12
状态: in-progress
指令人: misakamikoto
PRD 级别: feature
优先级: P1
---

# 功能权限模式设置

## 需求背景

AICO-Bot 设置页面的"权限"区域（`SystemSection.tsx` 286-315 行）当前是**纯装饰性的**：
- 显示绿色徽章"完全权限模式"
- "信任模式"Toggle 硬编码为 `checked={true}` 且 `disabled`，无状态变量、无 onChange、无配置读写
- 用户无法从 UI 控制权限行为

实际运行时的权限执行由 `permission-handler.ts` 中的 `createCanUseTool()` 控制：
- SDK 层面 `permissionMode` 固定为 `'default'`（`sdk-config.ts:723`）
- `canUseTool` 回调始终对 Bash 中的破坏性命令（rm、sudo 等）要求用户确认
- 远程代理（`remote-agent-proxy`）同样固定为 `'default'` 模式

配置服务（`config.service.ts`）已有 `permissions.trustMode` 字段，但默认值为 `false` 且从未被任何代码读取。

用户需要**两种可选的权限模式**：
1. **完全权限模式**：所有操作自动执行，无需用户确认
2. **部分权限模式**：破坏性操作（Bash 中匹配 `isDestructiveBashCommand()` 的命令）需通过 `ToolPermissionCard` 确认，非破坏性操作自动执行

两种模式需同时适用于**本地 Agent 和远程 Agent**。

## 需求描述

### 功能需求

1. 设置页面"权限"区域支持两种模式切换（Radio Button 或 Toggle）
2. 模式选择写入配置 `permissions.trustMode`（`true` = 完全权限，`false` = 部分权限）
3. 本地 Agent 根据配置动态设置 SDK `permissionMode` 和 `canUseTool` 行为
4. 远程 Agent 通过 `ChatOptions` 传递权限模式，远程代理据此调整 `canUseTool`
5. 模式变更实时生效（下一次消息发送时使用新配置，无需重启应用）

### UI 需求

- 替换当前装饰性的 Toggle，改为两个可选模式的 Radio Group
- 完全权限模式：绿色徽章，描述"所有操作自动执行，无需确认"
- 部分权限模式：黄色徽章，描述"破坏性操作需手动确认"
- 切换时无确认弹窗（即时生效）

## 技术方案

### 1. 配置层 — 复用现有 `trustMode`

**不新增配置字段**，直接复用 `config.service.ts` 中的 `permissions.trustMode`：
- `trustMode: true` → 完全权限模式（Full Permission Mode）
- `trustMode: false` → 部分权限模式（Partial Permission Mode）— 这是默认值

`PermissionConfig` 类型（`src/renderer/types/index.ts:90-95`）保持不变，仅 `trustMode` 字段生效。

**注意**：现有 `fileAccess`、`commandExecution`、`networkAccess` 三个字段目前未被使用（仅存配置），本 PRD 不清理它们以避免不相关变更。

### 2. 设置页面 UI

**文件**：`src/renderer/components/settings/SystemSection.tsx`

替换 286-315 行的装饰性内容：

```tsx
{/* Permissions Section */}
<section id="permissions" className="bg-card rounded-xl border border-border p-6">
  <div className="flex items-center justify-between mb-4">
    <h2 className="text-lg font-medium">{t('Permissions')}</h2>
    <span className={`text-xs px-2 py-1 rounded-full ${
      trustMode ? 'bg-green-500/20 text-green-500' : 'bg-amber-500/20 text-amber-500'
    }`}>
      {trustMode ? t('Full Permission Mode') : t('Partial Permission Mode')}
    </span>
  </div>

  {/* Mode description */}
  <div className="bg-muted/50 rounded-lg p-3 mb-4 text-sm text-muted-foreground">
    {trustMode
      ? t('All operations execute automatically without confirmation.')
      : t('Destructive operations require manual confirmation.')}
  </div>

  {/* Mode selection */}
  <div className="space-y-3">
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="radio"
        name="permissionMode"
        checked={trustMode}
        onChange={() => updateConfig('permissions.trustMode', true)}
        className="mt-0.5"
      />
      <div>
        <p className="font-medium">{t('Full Permission Mode')}</p>
        <p className="text-sm text-muted-foreground">
          {t('Automatically execute all operations, including destructive commands.')}
        </p>
      </div>
    </label>
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="radio"
        name="permissionMode"
        checked={!trustMode}
        onChange={() => updateConfig('permissions.trustMode', false)}
        className="mt-0.5"
      />
      <div>
        <p className="font-medium">{t('Partial Permission Mode')}</p>
        <p className="text-sm text-muted-foreground">
          {t('Destructive commands (rm, sudo, etc.) require manual approval.')}
        </p>
      </div>
    </label>
  </div>
</section>
```

实现要点：
- 从 `useSettingsStore()` 读取 `trustMode`（或从 `config.permissions.trustMode` 读取）
- 调用现有的 `updateConfig()` 方法写入（该组件已有类似模式的引用）
- 需确认 `SystemSection.tsx` 中 `updateConfig` 的签名支持嵌套路径（`permissions.trustMode`），如果不支持需要使用 `configService.set('permissions.trustMode', value)` 方式

### 3. 本地 Agent — SDK 配置与权限处理

#### 3.1 `sdk-config.ts`（约 723 行）

根据 `trustMode` 动态设置 SDK `permissionMode`：

```typescript
// 读取配置
const config = getConfig();
const trustMode = config.permissions?.trustMode ?? false;

// SDK 选项
{
  permissionMode: trustMode ? 'bypassPermissions' : 'default' as const,
  canUseTool: createCanUseTool({
    sendToRenderer,
    spaceId,
    conversationId,
    agentId,
    agentName,
  }),
}
```

**关键**：当 `trustMode=true` 时，SDK 的 `bypassPermissions` 模式会跳过所有 `canUseTool` 调用（包括 `AskUserQuestion`）。但我们需要保留 `AskUserQuestion` 的交互能力。因此，**不能单纯依赖 `bypassPermissions`**，而应在 `canUseTool` 内部处理：

- 更优方案：**始终使用 `permissionMode: 'default'`**，但在 `createCanUseTool` 中根据 `trustMode` 决定是否检查破坏性命令。

#### 3.2 `permission-handler.ts` — `createCanUseTool()` 增加模式感知

修改 `CanUseToolDeps` 接口，增加 `trustMode` 可选字段：

```typescript
interface CanUseToolDeps {
  sendToRenderer: SendToRendererFn;
  spaceId: string;
  conversationId: string;
  agentId?: string;
  agentName?: string;
  trustMode?: boolean;  // 新增：true = 完全权限，跳过破坏性检查
}
```

修改 `createCanUseTool()` 中 Bash 的破坏性命令检查逻辑（约 340-392 行）：

```typescript
// High-risk tools (Bash): smart inspection for destructive commands
if (HIGH_RISK_TOOLS.has(toolName)) {
  if (toolName === 'Bash') {
    // 完全权限模式：跳过破坏性检查，直接允许
    if (deps?.trustMode) {
      console.log(`[PermissionHandler] Bash auto-approved (trust mode): ${command.substring(0, 100)}`);
      return { behavior: 'allow' as const, updatedInput: input };
    }
    // 部分权限模式：检查破坏性命令
    const command = String(input.command || '');
    if (!isDestructiveBashCommand(command)) {
      console.log(`[PermissionHandler] Bash auto-approved (non-destructive): ${command.substring(0, 100)}`);
      return { behavior: 'allow' as const, updatedInput: input };
    }
    // 破坏性命令 → 请求用户确认
    // ... 现有逻辑不变
  }
  // ... 现有逻辑不变
}
```

#### 3.3 调用处传递 `trustMode`

在 `sdk-config.ts` 中调用 `createCanUseTool()` 时传入 `trustMode`：

```typescript
canUseTool: createCanUseTool({
  sendToRenderer,
  spaceId,
  conversationId,
  agentId,
  agentName,
  trustMode: config.permissions?.trustMode ?? false,
}),
```

### 4. 远程 Agent — 通过 ChatOptions 传递权限模式

#### 4.1 `ChatOptions` 增加 `permissionMode` 字段

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`

```typescript
export interface ChatOptions {
  // ... 现有字段
  permissionMode?: 'full' | 'partial'  // 新增：权限模式
}
```

#### 4.2 本地发送端传递

**文件**：`src/main/services/agent/send-message-remote.ts`（约 845-862 行）

在 `client.sendChatWithStream()` 的 options 中添加：

```typescript
const response = await client.sendChatWithStream(
  effectiveSessionId,
  messagesToSend,
  {
    // ... 现有 options
    permissionMode: (config.permissions?.trustMode ?? false) ? 'full' : 'partial',
  },
);
```

#### 4.3 远程代理 `canUseTool` 适配

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`（约 1828-1882 行）

在 `streamChat()` 中构建 `canUseTool` 时，检查 `options.permissionMode`：

```typescript
const isFullPermission = options.permissionMode === 'full';

const canUseTool = (onAskUserQuestion || onPermissionRequest) ? async (toolName, input, opts) => {
  // AskUserQuestion：无论权限模式都转发给客户端
  if (toolName === 'AskUserQuestion' && onAskUserQuestion) {
    // ... 现有逻辑不变
  }

  // Bash: 完全权限模式下跳过破坏性检查
  if (toolName === 'Bash') {
    if (isFullPermission) {
      return { behavior: 'allow' as const, updatedInput: input };
    }
    if (onPermissionRequest) {
      // ... 现有破坏性检测逻辑不变
    }
  }

  // 其他工具：auto-allow
  return { behavior: 'allow' as const, updatedInput: input };
} : undefined
```

#### 4.4 远程代理 `buildSdkOptions()` 适配

**文件**：`packages/remote-agent-proxy/src/claude-manager.ts`（约 982 行）

当 `permissionMode === 'full'` 时，SDK 层面使用 `bypassPermissions` 以跳过 SDK 内部的权限检查（注意：这不会影响 `AskUserQuestion`，因为那是由 `canUseTool` 处理的）：

```typescript
// 在 buildSdkOptions 或 getOrCreateSession 中
permissionMode: sdkOptions.permissionMode, // 由 streamChat 传入
```

**注意**：需要确认当 `canUseTool` 存在时，SDK 是否还会应用 `permissionMode` 的内置行为。如果 SDK 在 `canUseTool` 存在时忽略 `permissionMode`，则只需在 `canUseTool` 内部处理即可，无需修改 SDK 的 `permissionMode`。

### 5. i18n 国际化

**文件**：`src/renderer/i18n/locales/zh-CN.json`、`en.json` 等 7 个语言文件

新增以下 i18n key：

| Key | en | zh-CN |
|-----|----|-------|
| `Partial Permission Mode` | Partial Permission Mode | 部分权限模式 |
| `All operations execute automatically without confirmation.` | All operations execute automatically without user confirmation. | 所有操作自动执行，无需确认。 |
| `Destructive operations require manual confirmation.` | Destructive operations (rm, sudo, etc.) require manual approval. | 破坏性操作需手动确认。 |
| `Automatically execute all operations, including destructive commands.` | Automatically execute all operations, including destructive commands. | 自动执行所有操作，包括破坏性命令。 |
| `Destructive commands (rm, sudo, etc.) require manual approval.` | Destructive commands (rm, sudo, git push --force, etc.) require manual approval before execution. | 破坏性命令（rm、sudo、git push --force 等）需手动审批后方可执行。 |

运行 `npm run i18n` 自动翻译其他语言。

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计文档 | `.project/modules/agent/agent-core-v1.md` | 了解 Agent 模块整体架构、组件关系 |
| 功能设计文档 | `.project/modules/agent/features/permission-handling/design.md` | 了解当前权限处理流程、canUseTool 实现机制、权限转发机制 |
| 源码文件 | `src/renderer/components/settings/SystemSection.tsx:286-315` | 理解当前装饰性权限 UI 的完整代码，确定替换范围 |
| 源码文件 | `src/main/services/config.service.ts:318-323, 530-535` | 理解 `PermissionConfig` 类型定义和默认值 |
| 源码文件 | `src/renderer/types/index.ts:66, 90-95` | 理解 `PermissionLevel` 和 `PermissionConfig` 前端类型 |
| 源码文件 | `src/main/services/agent/permission-handler.ts` | 理解 `createCanUseTool()` 完整实现、`isDestructiveBashCommand()` 检测逻辑 |
| 源码文件 | `src/main/services/agent/sdk-config.ts:700-735` | 理解 SDK 选项构建流程，特别是 `permissionMode` 和 `canUseTool` 的设置 |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts:180-193, 975-990, 1828-1882` | 理解远程代理 `ChatOptions` 接口、`buildSdkOptions()`、`canUseTool` 回调 |
| 源码文件 | `src/main/services/agent/send-message-remote.ts:845-863` | 理解本地如何向远程代理传递 options |
| 源码文件 | `src/renderer/components/chat/ToolPermissionCard.tsx` | 理解权限确认卡片的 UI 和交互逻辑 |
| 编码规范 | `docs/Development-Standards-Guide.md` | 遵循 TypeScript strict、UI 禁止硬编码文本（用 `t()`）、命名规范 |

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/renderer/components/settings/SystemSection.tsx` | 修改 | 替换装饰性权限 UI 为 Radio Group 模式切换，读写 `trustMode` 配置 |
| `src/main/services/agent/permission-handler.ts` | 修改 | `CanUseToolDeps` 增加 `trustMode` 字段，`createCanUseTool()` 在 Bash 检查中根据 `trustMode` 跳过破坏性检测 |
| `src/main/services/agent/sdk-config.ts` | 修改 | 调用 `createCanUseTool()` 时传入 `trustMode`（从 config 读取） |
| `src/main/services/agent/send-message-remote.ts` | 修改 | `sendChatWithStream` 的 options 中添加 `permissionMode` 字段 |
| `packages/remote-agent-proxy/src/claude-manager.ts` | 修改 | `ChatOptions` 增加 `permissionMode` 字段，`streamChat()` 中 `canUseTool` 根据 `permissionMode` 调整破坏性检测行为 |
| `src/renderer/i18n/locales/zh-CN.json` | 修改 | 新增权限模式相关 i18n key |
| `src/renderer/i18n/locales/en.json` | 修改 | 新增权限模式相关 i18n key |

## 验收标准

### UI 验收

- [ ] **1.1** 设置页面"权限"区域显示两个 Radio 选项：「完全权限模式」和「部分权限模式」
- [ ] **1.2** 当前模式对应的徽章颜色正确：完全权限 = 绿色，部分权限 = 黄色
- [ ] **1.3** 切换模式后，描述文案即时更新（无需刷新页面）
- [ ] **1.4** 切换模式后，配置持久化到 `permissions.trustMode`，重启应用后设置保持

### 本地 Agent 验收

- [ ] **2.1** 完全权限模式下，Agent 执行破坏性 Bash 命令（如 `rm -rf`）时，**不弹出** ToolPermissionCard，直接执行
- [ ] **2.2** 部分权限模式下，Agent 执行破坏性 Bash 命令时，**弹出** ToolPermissionCard 等待用户确认
- [ ] **2.3** 部分权限模式下，Agent 执行非破坏性 Bash 命令时，**不弹出** ToolPermissionCard，直接执行
- [ ] **2.4** 两种模式下，`AskUserQuestion` 工具均正常工作（不受 `trustMode` 影响）

### 远程 Agent 验收

- [ ] **3.1** 完全权限模式下，远程 Agent 执行破坏性命令时，**不弹出** ToolPermissionCard，直接执行
- [ ] **3.2** 部分权限模式下，远程 Agent 执行破坏性命令时，**弹出** ToolPermissionCard 等待用户确认
- [ ] **3.3** 远程模式切换时，下一次发送消息即使用新配置（无需重连）

### 通用

- [ ] **4.1** 所有新增用户可见文本均有 i18n 翻译（`npm run i18n` 通过）
- [ ] **4.2** `npm run typecheck && npm run build` 全部通过
- [ ] **4.3** 现有非破坏性工具（Read、Write、Edit、Glob、Grep、MCP 等）在两种模式下行为一致，始终自动执行
- [ ] **4.4** Skill 禁用检查不受 `trustMode` 影响（`createCanUseTool` 中的 Skill 检查逻辑保持不变）
