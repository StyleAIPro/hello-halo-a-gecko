---
timestamp: 2026-05-11
status: done
module: agent
type: bugfix
assignee: misakamikoto
priority: P1
---

# Bug 修复：权限确认粒度优化

## 问题描述

前次修复（`bugfix-permission-allowed-tools-v1`）将 `DEFAULT_ALLOWED_TOOLS` 拆分为 `AVAILABLE_TOOLS` 和 `PRE_APPROVED_TOOLS`，成功使高风险工具走 `canUseTool` 权限检查流程。但当前实现将所有文件操作工具（Write、Edit、Create、MultiEdit、NotebookEdit、TodoWrite）与 Bash 统一归为 `HIGH_RISK_TOOLS`，导致以下体验问题：

1. **文件操作过度拦截**：Write/Edit/Create 等文件操作每次都弹权限确认，但这些操作本质上是安全的——它们在项目工作区内操作，可以通过 git 撤销，不会造成不可逆损害。Agent 一次编码任务可能触发数十次 Write/Edit，每次都需要用户手动确认，严重打断工作流。
2. **Bash 命令粒度不足**：所有 Bash 命令都被同等对待。`npm run build`、`git status`、`ls` 等无害命令与 `rm -rf`、`sudo shutdown` 等破坏性命令触发相同的权限确认弹窗，用户容易产生「确认疲劳」，对真正危险的命令反而降低警惕。

### 期望行为

| 工具/操作 | 当前行为 | 期望行为 |
|-----------|---------|---------|
| Read/Glob/Grep | 自动放行 | 自动放行（无变化） |
| Write/Edit/Create/MultiEdit/NotebookEdit/TodoWrite | 弹权限确认 | 自动放行 |
| Bash：`npm`, `git`, `ls`, `cat`, `echo`, `node`, `npx` 等 | 弹权限确认 | 自动放行 |
| Bash：`rm`, `rmdir`, `mv`, `cp`, `chmod`, `chown`, `sudo`, `kill`, `pkill`, `dd`, `mkfs`, `fdisk`, `shutdown`, `reboot` 等 | 弹权限确认 | 弹权限确认（无变化） |

## 根因分析

### 根因：`HIGH_RISK_TOOLS` 分类过于粗粒度

`permission-handler.ts` 第 50-58 行将所有写入类工具和 Bash 统一归为高风险：

```typescript
const HIGH_RISK_TOOLS = new Set([
  'Bash',
  'Write',
  'Edit',
  'Create',
  'NotebookEdit',
  'TodoWrite',
  'MultiEdit',
]);
```

这个分类没有区分「破坏性风险」和「可撤销风险」：

- **Write/Edit/Create/MultiEdit/NotebookEdit**：在 git 项目中完全可撤销（`git checkout`、`git restore`），不属于破坏性操作
- **TodoWrite**：仅是内部任务状态管理，不涉及文件系统变更
- **Bash**：内部差异极大，需要按命令内容分级判断

### 安全性评估

将 Write/Edit/Create 等文件操作改为自动放行的安全性依据：

1. **可撤销性**：所有文件操作都在 git 工作区内执行，可通过 `git checkout` / `git restore` 一键撤销
2. **可审计性**：`permission-handler.ts` 的日志机制已记录所有工具调用，文件操作可通过 git diff 审计
3. **操作范围**：SDK 的 `cwd` 限制确保文件操作只在用户指定的工作目录内进行
4. **用户控制**：用户仍可通过停止生成来中断 Agent 操作

## 技术方案

### 方案概述

分两部分实施：

1. **将文件操作工具从 HIGH_RISK 迁移到 PRE_APPROVED**：Write/Edit/Create/MultiEdit/NotebookEdit/TodoWrite 不再触发权限确认
2. **对 Bash 工具实现智能分级检测**：根据命令内容判断是否为破坏性命令，只有破坏性命令才触发权限确认

### 步骤 1：扩展 PRE_APPROVED_TOOLS

**文件**：`src/main/services/agent/system-prompt.ts`

将 Write、Edit、Create、MultiEdit、NotebookEdit、TodoWrite 加入 `PRE_APPROVED_TOOLS`：

```typescript
export const PRE_APPROVED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  // 文件操作工具 — 在 git 工作区内可撤销
  'Write',
  'Edit',
  'Create',
  'MultiEdit',
  'NotebookEdit',
  // 任务管理 — 不涉及文件系统变更
  'TodoWrite',
] as const;
```

同时更新注释说明这些工具的安全性依据。

### 步骤 2：清理 HIGH_RISK_TOOLS

**文件**：`src/main/services/agent/permission-handler.ts`

从 `HIGH_RISK_TOOLS` 中移除已迁移到 PRE_APPROVED 的工具：

```typescript
/** Bash is the only tool that always requires content-level inspection */
const HIGH_RISK_TOOLS = new Set([
  'Bash',
]);
```

更新 `SAFE_TOOLS` 注释，同步反映新的分类语义。

### 步骤 3：实现 Bash 智能分级检测

**文件**：`src/main/services/agent/permission-handler.ts`

#### 3.1 定义破坏性命令模式

新增常量，定义需要确认的 Bash 命令模式：

```typescript
/**
 * Destructive Bash command patterns.
 * Matches the command name as the first token (after pipes/chains are handled separately).
 * Only these commands require user confirmation; all others are auto-approved.
 */
const DESTRUCTIVE_COMMANDS = new Set([
  // 文件系统破坏
  'rm',
  'rmdir',
  'shred',
  'truncate',

  // 文件移动/复制（可能覆盖目标）
  'mv',
  'cp',

  // 权限/所有权变更
  'chmod',
  'chown',
  'chgrp',

  // 进程管理
  'kill',
  'pkill',
  'killall',

  // 系统级操作
  'sudo',
  'su',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',

  // 磁盘/分区操作
  'dd',
  'mkfs',
  'fdisk',
  'parted',
  'mkswap',
  'swapon',
  'swapoff',

  // 包管理（卸载/清除）
  'apt-get',
  'apt',
  'yum',
  'dnf',
  'pacman',
  'brew',
]);

/**
 * Subcommands that make an otherwise safe command destructive.
 * E.g., `npm uninstall`, `git push --force`, `docker rm`.
 */
const DESTRUCTIVE_SUBCOMMANDS: Record<string, Set<string>> = {
  npm: new Set(['uninstall', 'publish']),
  npx: new Set(['prisma:migrate:reset', 'prisma:db:push']),  // 需后续评估
  yarn: new Set(['remove']),
  pnpm: new Set(['remove', 'uninstall']),
  git: new Set(['push --force', 'push -f', 'clean', 'reset --hard']),
  docker: new Set(['rm', 'rmi', 'system prune', 'volume rm']),
  kubectl: new Set(['delete', 'cordon', 'drain']),
};
```

#### 3.2 实现检测函数

```typescript
/**
 * Check if a Bash command is potentially destructive.
 *
 * Logic:
 * 1. Extract the first command token (handle leading `env`, `sudo -E`, etc.)
 * 2. Check against DESTRUCTIVE_COMMANDS set
 * 3. If the command has a subcommand (e.g., `npm uninstall`), check DESTRUCTIVE_SUBCOMMANDS
 * 4. Check for dangerous shell operators: `>` or `>>` redirecting to sensitive paths
 *
 * @param command - The full Bash command string
 * @returns true if the command is considered destructive and requires confirmation
 */
function isDestructiveBashCommand(command: string): boolean {
  // Trim and extract first meaningful token
  const trimmed = command.trim();
  if (!trimmed) return false;

  // Skip comments and echo (echo is informational)
  if (trimmed.startsWith('#') || trimmed.startsWith('echo ')) return false;

  // Split by common command separators to get the first command
  // Handle: `&&`, `||`, `;`, `|`, pipes
  const firstCommand = trimmed.split(/\s*[;&|]\s*/)[0]?.trim();
  if (!firstCommand) return false;

  // Handle chained commands: check ALL segments, not just the first
  const segments = trimmed.split(/\s*[;&|]\s*/).filter(Boolean);

  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/);
    if (tokens.length === 0) continue;

    // Get the base command (skip `env`, `sudo -E`, etc.)
    let cmdIndex = 0;
    while (cmdIndex < tokens.length && ['env', 'sudo'].includes(tokens[cmdIndex])) {
      // Skip sudo/env flags
      cmdIndex++;
      while (cmdIndex < tokens.length && tokens[cmdIndex].startsWith('-')) {
        cmdIndex++;
      }
    }

    if (cmdIndex >= tokens.length) continue;
    const baseCmd = tokens[cmdIndex];
    const nextToken = tokens[cmdIndex + 1];

    // Check direct destructive commands
    if (DESTRUCTIVE_COMMANDS.has(baseCmd)) {
      return true;
    }

    // Check destructive subcommands
    const subCmds = DESTRUCTIVE_SUBCOMMANDS[baseCmd];
    if (subCmds && nextToken) {
      // Check if the rest of the command matches any destructive subcommand pattern
      const restOfCommand = tokens.slice(cmdIndex + 1).join(' ');
      for (const pattern of subCmds) {
        if (restOfCommand.startsWith(pattern)) {
          return true;
        }
      }
    }
  }

  // Check for dangerous redirects (overwrite system files)
  if (/>/.test(trimmed) && /\/(etc|usr|bin|sbin|boot|var|sys|proc)/.test(trimmed)) {
    return true;
  }

  return false;
}
```

#### 3.3 修改 canUseTool 中的 Bash 处理逻辑

修改 `createCanUseTool` 函数中 HIGH_RISK_TOOLS 分支，对 Bash 进行命令内容检测：

```typescript
// High-risk tools: require user confirmation
if (HIGH_RISK_TOOLS.has(toolName)) {
  // Special handling for Bash: only require confirmation for destructive commands
  if (toolName === 'Bash') {
    const command = String(input.command || '');
    if (!isDestructiveBashCommand(command)) {
      console.log(`[PermissionHandler] Bash auto-approved (non-destructive): ${command.substring(0, 100)}`);
      return { behavior: 'allow' as const, updatedInput: input };
    }
    console.log(`[PermissionHandler] Bash destructive command detected, requiring confirmation: ${command.substring(0, 100)}`);
  }

  // ... existing permission request logic for destructive Bash ...
}
```

### 步骤 4：更新注释和文档

**文件**：`src/main/services/agent/permission-handler.ts`

更新文件顶部注释和工具分类注释，反映新的三级风险模型：

```
风险等级：
- 自动放行（PRE_APPROVED）：Read, Glob, Grep, Write, Edit, Create, MultiEdit, NotebookEdit, TodoWrite
- 智能检测（Bash）：根据命令内容判断是否需要确认
- 始终拦截（特殊）：Skill（禁用技能检查）、AskUserQuestion（用户交互）
```

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 前次 PRD | `.project/prd/bugfix/agent/bugfix-permission-allowed-tools-v1.md` | 理解前次修复的完整方案和剩余问题 |
| 模块设计文档 | `.project/modules/agent/features/permission-handling/design.md` | 理解权限处理架构、正常/异常流程、pending request 机制 |
| 功能 bugfix | `.project/modules/agent/features/permission-handling/bugfix.md` | 了解 BUG-001（AskUserQuestion 卡死）和 BUG-002（高风险工具绕过确认） |
| 功能 changelog | `.project/modules/agent/features/permission-handling/changelog.md` | 了解最近变更（AVAILABLE_TOOLS/PRE_APPROVED_TOOLS 拆分） |
| 源码文件 | `src/main/services/agent/permission-handler.ts` | 权限处理主逻辑，HIGH_RISK_TOOLS 和 SAFE_TOOLS 定义 |
| 源码文件 | `src/main/services/agent/system-prompt.ts` | PRE_APPROVED_TOOLS 定义，系统提示词模板 |
| 源码文件 | `src/main/services/agent/sdk-config.ts`（第 710-730 行） | SDK 配置，allowedTools 和 canUseTool 传递 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript 规范、命名规范 |

## 涉及文件

### 实际修改

| 文件 | 修改内容 |
|------|---------|
| `src/main/services/agent/system-prompt.ts` | `PRE_APPROVED_TOOLS` 增加 Write/Edit/Create/MultiEdit/NotebookEdit/TodoWrite，更新注释 |
| `src/main/services/agent/permission-handler.ts` | HIGH_RISK_TOOLS 精简为仅 Bash；新增 `DESTRUCTIVE_COMMANDS`、`DESTRUCTIVE_SUBCOMMANDS`、`isDestructiveBashCommand()`；Bash 分支实现智能分级；更新文件顶部注释 |

### 未修改（确认无需改动）

| 文件 | 修改内容 |
|------|---------|
| `src/main/services/agent/system-prompt.ts` | `PRE_APPROVED_TOOLS` 增加 Write/Edit/Create/MultiEdit/NotebookEdit/TodoWrite，更新注释 |
| `src/main/services/agent/permission-handler.ts` | HIGH_RISK_TOOLS 精简为仅 Bash；新增 `DESTRUCTIVE_COMMANDS`、`DESTRUCTIVE_SUBCOMMANDS`、`isDestructiveBashCommand()`；修改 canUseTool 中 Bash 分支逻辑；更新注释 |

### 不需要修改（确认）

| 文件 | 确认内容 |
|------|---------|
| `src/main/services/agent/sdk-config.ts` | `allowedTools: [...PRE_APPROVED_TOOLS]` 已正确，无需改动 |
| `src/renderer/components/chat/ToolPermissionCard.tsx` | 仅 Bash 弹窗时显示，已有的 Bash 命令展示逻辑足够 |
| `src/main/ipc/agent.ts` | 权限请求 IPC handler 无需改动 |

## 验收标准

### 文件操作自动放行

- [ ] Write 工具不触发权限确认弹窗，直接执行
- [ ] Edit 工具不触发权限确认弹窗，直接执行
- [ ] Create 工具不触发权限确认弹窗，直接执行
- [ ] MultiEdit 工具不触发权限确认弹窗，直接执行
- [ ] NotebookEdit 工具不触发权限确认弹窗，直接执行
- [ ] TodoWrite 工具不触发权限确认弹窗，直接执行

### Bash 智能分级

- [ ] Bash 破坏性命令（`rm`, `rmdir`）触发权限确认弹窗
- [ ] Bash 文件移动/复制（`mv`, `cp`）触发权限确认弹窗
- [ ] Bash 权限变更（`chmod`, `chown`）触发权限确认弹窗
- [ ] Bash 系统级操作（`sudo`, `kill`, `pkill`, `shutdown`, `reboot`）触发权限确认弹窗
- [ ] Bash 磁盘操作（`dd`, `mkfs`, `fdisk`）触发权限确认弹窗
- [ ] Bash 包管理卸载（`npm uninstall`, `apt-get remove`）触发权限确认弹窗
- [ ] Bash `git push --force` / `git clean` / `git reset --hard` 触发权限确认弹窗
- [ ] Bash `docker rm` / `docker rmi` 触发权限确认弹窗
- [ ] Bash 重定向写入系统路径（`echo > /etc/...`）触发权限确认弹窗

### Bash 非破坏性命令自动放行

- [ ] `npm run build` / `npm run dev` / `npm install` 不触发权限确认弹窗
- [ ] `git status` / `git log` / `git add` / `git commit` 不触发权限确认弹窗
- [ ] `git diff` / `git branch` / `git checkout` / `git switch` 不触发权限确认弹窗
- [ ] `ls` / `cat` / `head` / `tail` / `find` 不触发权限确认弹窗
- [ ] `echo` 不触发权限确认弹窗
- [ ] `node` / `npx` / `tsx` 不触发权限确认弹窗
- [ ] `tsc` / `eslint` / `prettier` 不触发权限确认弹窗

### 已有功能不受影响

- [ ] Read/Glob/Grep 仍然自动放行
- [ ] AskUserQuestion 功能正常
- [ ] Skill 禁用检查正常
- [ ] MCP 工具自动放行 + 日志记录正常
- [ ] 远程 Agent 权限请求转发正常
- [ ] 用户停止生成时，待处理权限请求正确清理
- [ ] 权限请求 5 分钟超时自动拒绝

### 构建验证

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
