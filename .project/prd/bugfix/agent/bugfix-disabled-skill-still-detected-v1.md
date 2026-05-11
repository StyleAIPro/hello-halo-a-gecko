# PRD — Bugfix: 禁用的 Skill 仍被 Agent 检测和调用

> 版本：v1
> 状态：done
> 日期：2026-05-09
> 指令人：@misakamikoto
> 优先级：P1
> 模块：Agent 核心 / 技能系统

## 问题描述

在技能库页面将 Skill 禁用后，BOT（Agent）仍然能检测并调用该 Skill。期望行为：禁用的 Skill 不应被 Agent 检测和调用。

## 问题根因分析

### 技能加载机制

Agent 通过 Claude Code SDK 发现可用技能，流程如下：

1. `buildBaseSdkOptions()` ( sdk-config.ts:570 ) 调用 `buildSdkEnv()`
2. `buildSdkEnv()` 内部 IIFE 执行 `mergeSkillsDirs()` ( sdk-config.ts:281 )
3. `mergeSkillsDirs()` 将 `~/.agents/skills/` 和 `~/.claude/skills/` 合并到 `~/.agents/claude-config/skills/`，创建 junction 链接
4. **关键**：`mergeSkillsDirs()` 会读取每个 Skill 的 `META.json`，检查 `enabled === false`，跳过禁用的 Skill 并移除对应 junction ( sdk-config.ts:293-300 )
5. SDK 通过 `additionalDirectories: [CLAUDE_CONFIG_DIR]` 从 `~/.agents/claude-config/.claude/skills/` (junction → configSkillsDir) 加载技能

### 根因：两层缓存均未更新

**问题一：SDK 会话重用（主因）**

`getOrCreateV2Session()` ( session-lifecycle.ts:214 ) 在已有会话存活时直接复用，不再调用 `buildBaseSdkOptions()`，因此 `mergeSkillsDirs()` 不会重新执行。SDK 子进程在创建时已将可用技能列表缓存在内存中，后续 turn 直接使用缓存。

用户禁用 Skill → `SkillManager.toggleSkill()` 仅更新 `META.json` 和内存缓存 → 正在运行的 SDK 子进程无感知 → Agent 仍可调用该 Skill。

**问题二：Skill 切换未触发会话失效**

`SkillManager.toggleSkill()` ( skill-manager.ts:454 ) 和 `skillController.toggleSkill()` ( skill.controller.ts:878 ) 仅修改 `META.json`，没有通知 Agent 子系统刷新技能列表。对比 API 配置变更会调用 `invalidateAllSessions()` ( session-lifecycle.ts:584 ) 强制重建所有会话。

**问题三：新会话是否正常**

对于全新会话，`buildSdkEnv()` 会重新执行 IIFE → `mergeSkillsDirs()` 会读取更新后的 `META.json` → 正确跳过禁用 Skill 并移除 junction。因此**新会话**在理论上应该能正确过滤禁用 Skill。

但需注意：`settingSources: ['user', 'project']` 中的 `'user'` 可能导致 SDK 直接从 `~/.claude/skills/` 读取技能（绕过 mergeSkillsDirs 过滤），这取决于 SDK 内部实现。如果存在此路径，则新会话也无法过滤。需在开发时验证此路径是否存在。

## 技术方案

### 方案：Skill 切换时触发 SDK 会话失效

在 `skill.controller.ts` 的 `toggleSkill()` 中，切换成功后调用 `invalidateAllSessions()` 强制所有活跃 SDK 会话在下次消息时重建，从而触发 `buildSdkEnv()` → `mergeSkillsDirs()` 重新过滤禁用 Skill。

#### 修改点

**文件 1：`src/main/controllers/skill.controller.ts`**

在 `toggleSkill()` 函数中，`skillManager.toggleSkill()` 成功后，调用 `invalidateAllSessions()`：

```typescript
import { invalidateAllSessions } from '../services/agent/session-lifecycle';

export async function toggleSkill(skillId: string, enabled: boolean) {
  try {
    const result = await skillManager.toggleSkill(skillId, enabled);
    if (result) {
      // 禁用/启用技能后，强制所有 SDK 会话重建
      // SDK 子进程在创建时缓存了可用技能列表，
      // 需要通过重建会话来重新执行 mergeSkillsDirs() 过滤
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

#### 验证点

开发时需验证：
1. 禁用 Skill 后，**同对话**中 Agent 是否还能检测到该 Skill（应该不能）
2. 禁用 Skill 后，**新对话**中 Agent 是否还能检测到该 Skill（应该不能）
3. 启用 Skill 后，Agent 是否能重新检测到该 Skill（应该能）
4. 禁用 Skill 时是否有请求正在执行（SDK 会话延迟关闭）

### 风险评估

- `invalidateAllSessions()` 会关闭所有空闲的 SDK 子进程，正在执行的会话会延迟到请求完成后关闭。这与 API 配置变更时使用的行为一致，是安全的。
- 频繁切换 Skill 可能导致 SDK 子进程频繁重建，但这是预期行为（用户主动操作）。

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|----------|
| 模块设计文档 | `.project/modules/skill/skill-system-v1.md` | 理解技能系统整体架构和组件关系 |
| 模块设计文档 | `.project/modules/agent/agent-core-v1.md` | 理解 Agent 会话生命周期管理 |
| 源码文件 | `src/main/services/skill/skill-manager.ts` (L454-471) | 理解 toggleSkill 实现（仅修改 META.json 和内存缓存） |
| 源码文件 | `src/main/controllers/skill.controller.ts` (L878-888) | 理解 IPC 层 toggleSkill 调用（需在此处添加失效逻辑） |
| 源码文件 | `src/main/services/agent/sdk-config.ts` (L277-354) | 理解 mergeSkillsDirs 如何过滤禁用 Skill |
| 源码文件 | `src/main/services/agent/sdk-config.ts` (L430-513) | 理解 buildSdkEnv IIFE 何时执行 mergeSkillsDirs |
| 源码文件 | `src/main/services/agent/session-lifecycle.ts` (L214-280) | 理解 getOrCreateV2Session 会话复用逻辑 |
| 源码文件 | `src/main/services/agent/session-lifecycle.ts` (L584-605) | 理解 invalidateAllSessions 失效机制 |
| 源码文件 | `src/main/services/agent/send-message-local.ts` (L315-383) | 理解 sendMessage 中 buildBaseSdkOptions 和会话创建流程 |

## 涉及文件

> 以下为预估修改清单，开发完成后更新为实际修改清单

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/main/controllers/skill.controller.ts` | 修改 | 添加 invalidateAllSessions 导入；toggleSkill 成功后调用 invalidateAllSessions 强制 SDK 会话重建 |

## 验收标准

- [ ] 禁用 Skill 后，在同对话中发送新消息，Agent 无法检测和调用该 Skill
- [ ] 禁用 Skill 后，创建新对话，Agent 无法检测和调用该 Skill
- [ ] 启用 Skill 后，Agent 能正常检测和调用该 Skill
- [ ] 禁用/启用 Skill 时有正在执行的请求，请求正常完成后 SDK 会话才关闭
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
