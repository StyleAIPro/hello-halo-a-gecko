# PRD — Bugfix: 禁用的 Skill 仍被 Agent 检测和调用（v5）

> 版本：v5（v1-v4 均在文件系统层面修复，但 SDK 内部有独立的技能发现和注入机制）
> 状态：done
> 日期：2026-05-09
> 指令人：@misakamikoto
> 优先级：P0
> 模块：Agent 核心 / 技能系统

## 问题描述

在技能库页面将 Skill 禁用后，BOT 仍然能检测并调用该 Skill。v1（invalidateAllSessions）、v2（+ refreshSkillDirectories）、v3（+ clearSessionId）、v4（+ hideDisabledSkillsInSource）均未解决。

## v1-v4 失效根因

前四次修复都在**文件系统层面**操作（更新 junction、重命名目录、清除 sessionId），但 SDK 的技能发现机制不仅依赖文件系统：

1. **SDK preset 自动注入**：`systemPrompt: { type: 'preset' }` 使用 `claude_code` 预设，SDK 内部自动扫描技能目录，将技能列表通过 `<system-reminder>` 标签注入对话消息
2. **Skill 工具独立发现**：SDK 的 `Skill` 工具有独立的技能发现机制（`getSystemPrompt` + `toolUseContext.options.commands`），不依赖 AICO-Bot 管理的 junction 目录
3. **系统提示词告知 BOT 可用技能**：SDK 在 system prompt 中列出所有发现的技能（`Available custom skills in this project: /name: description`），BOT 据此决定是否调用

文件系统层面的修改无法拦截 SDK 内部的技能注入和 Skill 工具的独立发现。

## 技术方案

### 方案：双层拦截 — 代码层 deny + 提示词层禁止

#### 层 1：代码层 — `canUseTool` 拦截 Skill 工具调用

在 `permission-handler.ts` 的 `createCanUseTool` 中，对 `Skill` 工具调用检查目标技能是否在禁用集合中。如果是，返回 `deny`。

#### 层 2：提示词层 — system prompt 追加禁用信息

在 `sdk-config.ts` 的 `buildBaseSdkOptions` 中，在 system prompt 的 `append` 部分前追加禁用技能列表，明确告知 LLM 不要使用这些技能。

#### 修改点

**文件 1：`src/main/services/skill/skill-manager.ts`**

添加内存中的禁用技能注册表，与 `installedSkills` 同步维护：

- 新增 `disabledSkillIds: Set<string>` 实例属性
- 新增 `getDisabledSkillIds()` 实例方法和 `getGlobalDisabledSkillIds()` 静态方法
- `toggleSkill` 中维护集合（enable → delete, disable → add）
- `loadSkills` 中从已加载技能同步集合（启动时恢复状态）

**文件 2：`src/main/services/agent/permission-handler.ts`**

在 `createCanUseTool` 返回的回调中，对 `toolName === 'Skill'` 检查：

```typescript
if (toolName === 'Skill') {
  const disabledIds = SkillManager.getGlobalDisabledSkillIds();
  const cmd = String(input.command || input.name || input.skill || '');
  const skillName = cmd.replace(/^\/+/, '').trim();
  if (skillName && disabledIds.has(skillName)) {
    return { behavior: 'deny', updatedInput: input };
  }
}
```

**文件 3：`src/main/services/agent/sdk-config.ts`**

新增 `buildDisabledSkillsPrompt()` 函数，在 system prompt 中追加：

```
IMPORTANT: The following skills are DISABLED and must NOT be used or invoked: /skill-a, /skill-b.
Do not call the Skill tool for these commands.
```

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/main/services/skill/skill-manager.ts` | 修改 | 新增 disabledSkillIds 集合 + getGlobalDisabledSkillIds + loadSkills 同步 |
| `src/main/services/agent/permission-handler.ts` | 修改 | canUseTool 中拦截禁用技能的 Skill 工具调用 |
| `src/main/services/agent/sdk-config.ts` | 修改 | system prompt 追加禁用技能信息 |

## 验收标准

- [ ] 禁用 Skill 后，在同对话中发送新消息，Agent 无法调用该 Skill
- [ ] 禁用 Skill 后，创建新对话，Agent 无法调用该 Skill
- [ ] 启用 Skill 后，Agent 能正常调用该 Skill
- [ ] 禁用/启用状态在应用重启后保持
- [ ] `npm run typecheck` 无新增错误
- [ ] `npm run build` 通过
