# PRD [Bug 修复级] — 远程 Agent SDK 补丁未生效及 Skill 加载不全

> 版本：bugfix-remote-sdk-patch-and-skill-loading-v1
> 日期：2026-04-17
> 指令人：@moonseeker1
> 反馈人：@moonseeker1
> 归属模块：modules/remote-agent
> 严重程度：Critical

## 问题描述

远程 Agent 服务器上存在两个独立问题，导致自定义 Skill 无法被 SDK 加载，以及 SDK 补丁未生效。

- **期望行为**：
  - 远程 Agent 应与本地 AICO-Bot 一致，SDK 补丁正常生效（`setMaxThinkingTokens`、`interrupt` 等运行时方法可用）
  - 远程 Agent 应通过 `systemPrompt: { type: 'preset', append: ... }` 格式让 SDK 内置预设注入 skill 信息
  - 远程 Agent 应通过 `additionalDirectories` 让 SDK 额外扫描 configDir 下的技能目录
- **实际行为**：
  - 远程服务器日志显示 `setMaxThinkingTokens not available - SDK patch may not be applied`，SDK 补丁未生效
  - 即使 skill 文件已合并到磁盘（通过 `bugfix-remote-skill-merge-missing-sources-v1` 修复），SDK 仍无法发现技能
- **复现步骤**：
  1. 部署远程 Agent 服务器
  2. 在远程服务器上安装自定义 skill（存放在 `~/.agents/skills/` 或 `~/.claude/skills/`）
  3. 通过 AICO-Bot 桌面端向远程服务器发送消息触发 Agent
  4. 观察远程服务器日志：出现 `setMaxThinkingTokens not available - SDK patch may not be applied` 警告
  5. Agent 不具备自定义 skill 知识，即使用户明确要求使用某个已安装的 skill

## 根因分析

### 问题 1：Skill 加载不全 — `buildSdkOptions()` 缺少关键配置

远程 `packages/remote-agent-proxy/src/claude-manager.ts` 的 `buildSdkOptions()` 方法存在两个缺陷（对照本地 `src/main/services/agent/sdk-config.ts`）：

#### 1.1 `systemPrompt` 传的是原始字符串

- **本地代码**（`src/main/services/agent/sdk-config.ts` 第 581-584 行）使用 `{ type: 'preset', append: ... }` 格式，告诉 SDK 先使用内置预设（包含 skill 注入逻辑），再追加自定义内容：
  ```typescript
  systemPrompt: {
    type: 'preset' as const,
    append: buildSystemPrompt({ workDir, modelInfo: credentials.displayModel }),
  },
  ```
- **远程代码**（`packages/remote-agent-proxy/src/claude-manager.ts` 第 657 行原始版本）直接传字符串：
  ```typescript
  systemPrompt,  // 原始字符串，SDK 不会注入 skill 信息
  ```

  当 `systemPrompt` 是字符串时，SDK 会**完全覆盖**内置预设，包括 skill 注入部分。这意味着即使 skill 文件已正确合并到磁盘，SDK 也不知道它们的存在。

#### 1.2 缺少 `additionalDirectories`

- **本地代码**（`src/main/services/agent/sdk-config.ts` 第 594 行）设置：
  ```typescript
  additionalDirectories: [String(env.CLAUDE_CONFIG_DIR)],
  ```
  让 SDK 额外扫描 `configDir` 下的 `.claude/skills/` 目录，这是项目级 skill 发现的关键路径。

- **远程代码**缺少此配置。即使 skill 文件合并到 `configSkillsDir` 且 `.claude/skills` 软链接已创建，SDK 在 bare 模式下也不会扫描该路径。

#### 1.3 缺少 `settingSources: ['user', 'project']`

- **本地代码**（第 593 行）设置 `settingSources: ['user', 'project']`，配合 `additionalDirectories` 让 SDK 同时加载用户级和项目级设置。
- **远程代码**原版缺少 `settingSources` 配置或仅设置了 `['user']`，导致 SDK 无法从项目级路径发现技能。

### 问题 2：SDK 补丁未生效

远程服务器日志显示：`setMaxThinkingTokens not available - SDK patch may not be applied`

根因链路分析：

#### 2.1 部署流程的补丁检查逻辑有缺陷

部署逻辑（`src/main/services/remote-deploy/remote-deploy.service.ts` 第 1214-1228 行）检查 `packages/remote-agent-proxy/patches/` 目录有无 `.patch` 文件：

```typescript
const patchesDir = path.join(packageDir, 'patches');
const hasPatch =
  fs.existsSync(patchesDir) &&
  fs.readdirSync(patchesDir).some((f: string) => f.endsWith('.patch'));

if (hasPatch && fs.existsSync(path.join(localSdkPath, 'sdk.mjs'))) {
  // 上传本地已补丁的 sdk.mjs 到远程
} else if (!hasPatch) {
  this.emitCommandOutput(id, 'output', '无 SDK 补丁，使用远程 npm 安装版本');
}
```

**问题**：`packages/remote-agent-proxy/patches/` 目录**不存在**（项目使用 `scripts/patch-sdk.mjs` 脚本直接修改 `sdk.mjs`，不使用 `.patch` 文件），因此 `hasPatch` 始终为 `false`，走"无 SDK 补丁，使用远程 npm 安装版本"分支。

#### 2.2 远程 `npm install` 后未自动执行补丁脚本

远程 proxy 的 `package.json` 没有 `postinstall` 钩子：

```json
{
  "scripts": {
    "build": "node scripts/build-with-timestamp.js",
    "start": "node dist/index.js",
    "dev": "tsc && node dist/index.js"
  }
}
```

缺少 `"postinstall": "node scripts/patch-sdk.mjs"`，导致 `npm install` 之后 SDK 不会被补丁。

#### 2.3 `scripts/patch-sdk.mjs` 已包含在部署包中但未被调用

`createDeployPackage()` 方法（第 1600-1602 行）已正确包含 `scripts/` 目录：

```typescript
if (fs.existsSync(path.join(packageDir, 'scripts'))) {
  includes.push('scripts');
}
```

`packages/remote-agent-proxy/scripts/patch-sdk.mjs` 文件也存在且内容与根目录 `scripts/patch-sdk.mjs` 一致（共 5 个补丁，包括 `setMaxThinkingTokens` 等运行时方法注入）。但由于上述两个原因，该脚本从未在远程服务器上被执行。

### 对比总结

| 特性 | 本地 | 远程（修复前） |
|------|------|----------------|
| `systemPrompt` 格式 | `{ type: 'preset', append: ... }` | 原始字符串（skill 注入被覆盖） |
| `additionalDirectories` | `[configDir]` | **缺失** |
| `settingSources` | `['user', 'project']` | **缺失或仅 `['user']`** |
| SDK 补丁执行 | `bootstrap/essential.ts` 启动时自动执行 | **从未执行** |
| `postinstall` 钩子 | 根 `package.json` 有 | **远程 proxy 缺失** |
| `patches/` 检查 | N/A（使用脚本直接修改） | 检查空目录 → 跳过补丁上传 |

## 修复方案

### 修复一：`buildSdkOptions()` 补全 SDK 配置（P0）

**目标**：让远程 SDK 配置与本地完全一致，确保 skill 注入和项目级技能发现正常工作。

#### 修改文件：`packages/remote-agent-proxy/src/claude-manager.ts`

在 `buildSdkOptions()` 方法中：

1. 将 `systemPrompt` 从原始字符串改为预设追加格式：
```typescript
systemPrompt: {
  type: 'preset',
  append: systemPrompt,
},
```

2. 添加 `additionalDirectories` 和 `settingSources`（在 `options` 对象中）：
```typescript
settingSources: ['user', 'project'],
additionalDirectories: [configDir],
```

3. 设置 `options.env.CLAUDE_CONFIG_DIR = configDir`，确保 SDK 知道 configDir 路径。

> **注**：当前工作树中 `buildSdkOptions()` 已包含上述修复（第 913-916 行 `systemPrompt` 预设格式、第 1126-1130 行 `settingSources` 和 `additionalDirectories`），属于已开发未提交的修复。

### 修复二：远程 SDK 补丁自动执行机制（P0）

**目标**：确保远程服务器上 `npm install` 之后自动执行 SDK 补丁脚本。

#### 方案：在远程 proxy 的 `package.json` 添加 `postinstall` 钩子

##### 修改文件：`packages/remote-agent-proxy/package.json`

```json
{
  "scripts": {
    "build": "node scripts/build-with-timestamp.js",
    "start": "node dist/index.js",
    "dev": "tsc && node dist/index.js",
    "postinstall": "node scripts/patch-sdk.mjs"
  }
}
```

**为什么选择 `postinstall` 而非部署流程上传 `sdk.mjs`**：
- `npm install` 会安装/更新 SDK 到 `node_modules/`，此时 `sdk.mjs` 是 npm 的原始未补丁版本
- `postinstall` 在 `npm install` 完成后自动运行，此时 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` 已就位，可以安全执行补丁
- 该方案不依赖本地打包环境，远程服务器可独立完成补丁
- 部署流程已有的 `npm install` 步骤（第 1401-1418 行）无需额外修改

#### 附加修改：部署流程补丁检查逻辑优化（P1）

当前部署流程检查 `patches/` 目录的 `.patch` 文件（该目录不存在），可以优化为：检查本地 SDK 是否已被补丁（通过 `[PATCHED]` 标记），然后上传已补丁的 `sdk.mjs` 作为备用方案。

##### 修改文件：`src/main/services/remote-deploy/remote-deploy.service.ts`

将第 1216-1228 行的补丁上传逻辑从检查 `.patch` 文件改为检查本地 SDK 补丁标记：

```typescript
// Check if local SDK has been patched (by unified patch-sdk.mjs script)
const localSdkMjs = path.join(localSdkPath, 'sdk.mjs');
let localSdkPatched = false;
if (fs.existsSync(localSdkMjs)) {
  const sdkContent = fs.readFileSync(localSdkMjs, 'utf-8');
  localSdkPatched = sdkContent.includes('[PATCHED] AICO-Bot SDK patch applied');
}

if (localSdkPatched) {
  await manager.executeCommand(`mkdir -p ${remoteSdkPath}`);
  await manager.uploadFile(localSdkMjs, `${remoteSdkPath}/sdk.mjs`);
  this.emitCommandOutput(id, 'success', '✓ SDK 补丁上传完成');
} else {
  this.emitCommandOutput(id, 'output', '本地 SDK 未补丁，依赖远程 postinstall 自动补丁');
}
```

> **注**：此为可选优化。有了 `postinstall` 钩子后，即使不修改部署流程，远程 `npm install` 后也会自动执行补丁。上传已补丁的 `sdk.mjs` 可作为双重保险。

### 实现优先级

| 优先级 | 修改 | 影响文件 | 效果 |
|--------|------|---------|------|
| P0 | 修复一：`systemPrompt` 预设格式 | `packages/remote-agent-proxy/src/claude-manager.ts` | SDK 内置预设不被覆盖，skill 信息正常注入 |
| P0 | 修复一：`additionalDirectories` + `settingSources` | `packages/remote-agent-proxy/src/claude-manager.ts` | SDK 能通过 configDir 发现项目级技能 |
| P0 | 修复二：`postinstall` 钩子 | `packages/remote-agent-proxy/package.json` | `npm install` 后自动执行 SDK 补丁 |
| P1 | 附加：部署流程补丁检查优化 | `src/main/services/remote-deploy/remote-deploy.service.ts` | 上传已补丁 sdk.mjs 作为双重保险 |

## 影响范围
- [ ] 涉及 API 变更 -> 无，修复内部 SDK 配置和补丁执行逻辑，不暴露新 IPC 端点
- [ ] 涉及数据结构变更 -> 无
- [x] 涉及功能设计变更 -> `modules/agent/features/sdk-patch/design.md`（远程补丁执行机制需更新）

## 验证方式

### 验证修复一：Skill 加载

1. 部署远程 Agent 服务器（使用修复后的代码）
2. 在远程服务器 `~/.agents/skills/` 下安装一个测试 skill（含 `SKILL.md`）
3. 通过 AICO-Bot 桌面端向远程服务器发送消息
4. 检查远程 Agent 日志：确认 `systemPrompt` 使用 `{ type: 'preset', append: ... }` 格式
5. 确认 Agent 具备已安装 skill 的知识，能正确使用 skill 工具

### 验证修复二：SDK 补丁

1. 部署远程 Agent 服务器（使用修复后的代码）
2. 检查远程服务器日志：应出现 `[patch-sdk] Applied N patch(es)` 输出
3. 不应再出现 `setMaxThinkingTokens not available - SDK patch may not be applied` 警告
4. 验证 `setMaxThinkingTokens`、`interrupt`、`setModel` 等运行时方法在远程 Agent 上可用
5. 模拟远程服务器 `npm install` 重新执行场景（删除 `node_modules` 后重新部署），确认补丁自动生效

### 回归验证

1. 本地 AICO-Bot 正常启动和运行（确认 `postinstall` 修改不影响本地）
2. 远程 Agent 基本消息收发功能正常
3. 远程 Agent 非 Anthropic 后端（OpenAI 兼容路由）正常工作

## 变更
| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-17 | 初始 PRD | @moonseeker1 |
