# PRD — Bugfix: 禁用的 Skill 仍被 Agent 检测和调用（v2）

> 版本：v2（v1 方案 `invalidateAllSessions` 经验证无效，需更直接的方式）
> 状态：done
> 日期：2026-05-09
> 指令人：@misakamikoto
> 优先级：P0
> 模块：Agent 核心 / 技能系统

## 问题描述

在技能库页面将 Skill 禁用后，BOT（Agent）仍然能检测并调用该 Skill。期望行为：禁用的 Skill 不应被 Agent 检测和调用。

## v1 方案回顾与失效原因

v1 在 `toggleSkill()` 成功后调用 `invalidateAllSessions()` 强制会话重建。理论上新会话创建时会执行 `buildSdkEnv()` → IIFE → `mergeSkillsDirs()`，重新读取 `META.json` 并过滤禁用 Skill。但实际测试无效。

可能原因：
1. `ensureSessionWarm` 在 `invalidateAllSessions` 之后的微任务中重新创建了 warm session，时序上存在竞争
2. `session.close()` 有 5 秒延迟才发送 SIGTERM，旧子进程可能在新会话创建后仍持有文件锁
3. SDK 子进程内部对技能列表有额外的缓存层（`dq3` memoize），即使文件系统已更新，正在运行的子进程仍使用旧缓存

## 问题根因分析（v2）

### 技能发现完整路径

SDK CLI 在 bare mode 下通过以下路径发现技能：

| # | 路径 | 管理 |
|---|------|------|
| 1 | `<add-dir>/.claude/skills/` = `~/.agents/claude-config/.claude/skills/` → junction → `configSkillsDir` | `mergeSkillsDirs` 管理 ✅ |
| 2 | 从 `cwd` 向上查找 `*/.claude/skills/`（project-level） | 无人管理 ❌ |

路径 1 由 `mergeSkillsDirs` 管理，但仅在 `buildSdkEnv()` 调用时执行。**`toggleSkill` 不会触发 `mergeSkillsDirs`，因此 `configSkillsDir` 中的 junction 不会立即更新。**

### 根因

`toggleSkill()` 仅做了两件事：
1. 更新内存缓存（`installedSkills` Map）
2. 写入 `META.json`

**但没有立即更新 `configSkillsDir` 中的文件系统 junction。** `configSkillsDir` 中被禁用的 Skill junction 仍然存在。虽然 `invalidateAllSessions` 理论上会在下次会话创建时触发 `mergeSkillsDirs`，但由于 SDK 子进程生命周期管理的复杂性（5 秒延迟关闭、warm session 竞争等），不能保证 junction 一定在新子进程启动前被移除。

## 技术方案

### 方案：`toggleSkill` 中直接调用 `refreshSkillDirectories()` 立即更新文件系统

在 `skill.controller.ts` 的 `toggleSkill()` 中，`skillManager.toggleSkill()` 成功后：
1. **立即调用 `refreshSkillDirectories()`** — 直接执行 `mergeSkillsDirs()` 更新 `configSkillsDir` junction
2. **再调用 `invalidateAllSessions()`** — 强制 SDK 会话重建（使用更新后的 junction）

这样即使存在时序竞争，文件系统也已经是最新的。

#### 修改点

**文件 1：`src/main/services/agent/sdk-config.ts`**

导出一个 `refreshSkillDirectories()` 函数：

```typescript
export function refreshSkillDirectories(): void {
  const agentsDir = path.join(os.homedir(), '.agents');
  const skillsDir = path.join(agentsDir, 'skills');
  const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  const configSkillsDir = path.join(agentsDir, 'claude-config', 'skills');
  mergeSkillsDirs([skillsDir, claudeSkillsDir], configSkillsDir);
}
```

**文件 2：`src/main/controllers/skill.controller.ts`**

在 `toggleSkill()` 中添加 `refreshSkillDirectories()` 调用（保留 `invalidateAllSessions()`）：

```typescript
import { invalidateAllSessions } from '../services/agent/session-lifecycle';
import { refreshSkillDirectories } from '../services/agent/sdk-config';

export async function toggleSkill(skillId: string, enabled: boolean) {
  try {
    const result = await skillManager.toggleSkill(skillId, enabled);
    if (result) {
      refreshSkillDirectories();
      invalidateAllSessions();
    }
    return { success: result, error: result ? undefined : 'Failed to toggle skill' };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to toggle skill',
    };
  }
}
```

### 风险评估

- `refreshSkillDirectories()` 是同步函数，执行 `mergeSkillsDirs` 耗时极短（仅读取目录和操作 junction），不会阻塞事件循环
- 与 v1 方案相比，增加了文件系统即时更新的保障，即使会话重建存在时序问题，junction 也已正确移除
- `invalidateAllSessions()` 仍然保留，确保正在运行的 SDK 子进程最终被替换

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|----------|
| 源码文件 | `src/main/services/agent/sdk-config.ts` (L277-354) | `mergeSkillsDirs` 实现细节 |
| 源码文件 | `src/main/services/agent/sdk-config.ts` (L447-513) | `buildSdkEnv` IIFE 中的目录路径计算 |
| 源码文件 | `src/main/services/skill/skill-manager.ts` (L454-471) | `toggleSkill` 实现（更新 META.json） |
| 源码文件 | `src/main/controllers/skill.controller.ts` (L878-892) | IPC 层 `toggleSkill`（当前已有 v1 的 `invalidateAllSessions`） |
| 源码文件 | `src/main/services/agent/session-lifecycle.ts` (L584-605) | `invalidateAllSessions` 实现 |

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/main/services/agent/sdk-config.ts` | 修改 | 导出 `refreshSkillDirectories()` 函数 |
| `src/main/controllers/skill.controller.ts` | 修改 | `toggleSkill` 中添加 `refreshSkillDirectories()` 调用 |

## 验收标准

- [ ] 禁用 Skill 后，在同对话中发送新消息，Agent 无法检测和调用该 Skill
- [ ] 禁用 Skill 后，创建新对话，Agent 无法检测和调用该 Skill
- [ ] 启用 Skill 后，Agent 能正常检测和调用该 Skill
- [ ] 禁用/启用 Skill 时有正在执行的请求，请求正常完成后 SDK 会话才关闭
- [ ] `npm run typecheck` 无新增错误
- [ ] `npm run build` 通过
