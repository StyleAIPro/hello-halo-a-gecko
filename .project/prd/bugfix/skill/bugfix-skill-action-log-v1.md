# PRD [Bug 修复级] — 技能操作日志补全

> 版本：bugfix-skill-action-log-v1
> 日期：2026-05-06
> 指令人：用户
> 归属模块：modules/skill
> 严重程度：Minor（功能正常，但操作审计不完整）
> 所属功能：features/skill-management
> 状态：done

## 问题描述

- **期望行为**：所有用户主动触发的技能操作均应通过 `logUserAction()` 记录到日志的 `[USER ACTION]` 区段，便于排查问题
- **实际行为**：`skill:install`（market/yaml）和 `skill:uninstall` 已有 `logUserAction()` 调用，但其余 9 个用户主动操作（toggle、多目标安装/卸载、同步、推送、导出、生成）缺少日志记录
- **影响**：日志中无法追溯这些操作的发生时间和参数，影响问题排查和用户行为审计

## 根因分析

`src/main/ipc/skill.ts` 在添加新 handler 时遗漏了 `logUserAction()` 调用。文件顶部已导入 `logUserAction`（L25），无需新增依赖。

## 技术方案

在以下 9 个 handler 入口处添加 `logUserAction()` 调用，放在 handler 函数体最前面（业务逻辑之前）。

| # | IPC 通道 | 位置 | action 名称 | 日志详情 |
|---|---------|------|------------|---------|
| 1 | `skill:toggle` (L148) | handler 体首行 | `toggleSkill` | `skillId=${input.skillId}, enabled=${input.enabled}` |
| 2 | `skill:install-multi` (L80) | `onOutput` 定义之前 | `installSkillMulti` | `skillId=${input.skillId}, targets=${input.targets.map(t => t.type === 'local' ? 'local' : 'remote:' + t.serverId).join(',')}` |
| 3 | `skill:uninstall-multi` (L100) | `onOutput` 定义之前 | `uninstallSkillMulti` | `appId=${input.appId}, targets=${input.targets.map(t => t.type === 'local' ? 'local' : 'remote:' + t.serverId).join(',')}` |
| 4 | `skill:sync-to-remote` (L120) | `onOutput` 定义之前 | `syncSkillToRemote` | `skillId=${input.skillId}, serverId=${input.serverId}` |
| 5 | `skill:sync-from-remote` (L134) | `onOutput` 定义之前 | `syncSkillFromRemote` | `skillId=${input.skillId}, serverId=${input.serverId}` |
| 6 | `skill:market:push-to-github` (L391) | handler 体首行 | `pushSkillToGitHub` | `skillId=${skillId}, targetRepo=${targetRepo}` |
| 7 | `skill:market:push-to-gitcode` (L413) | handler 体首行 | `pushSkillToGitCode` | `skillId=${skillId}, targetRepo=${targetRepo}` |
| 8 | `skill:export` (L152) | handler 体首行 | `exportSkill` | `skillId=${skillId}` |
| 9 | `skill:generate` (L158) | `if (input.mode === 'conversation')` 内首行 + `else if` 内首行 | `generateSkill` | conversation 模式：`mode=conversation, spaceId=${input.spaceId}, conversationId=${input.conversationId}`；prompt 模式：`mode=prompt, name=${input.name}` |

### 改动示例

**`skill:toggle`（L148-150）：**
```typescript
ipcMain.handle('skill:toggle', async (_event, input: { skillId: string; enabled: boolean }) => {
  logUserAction('toggleSkill', `skillId=${input.skillId}, enabled=${input.enabled}`);
  return skillController.toggleSkill(input.skillId, input.enabled);
});
```

**`skill:generate`（L158-188）— 两个分支各一条：**
```typescript
if (input.mode === 'conversation') {
  logUserAction('generateSkill', `mode=conversation, spaceId=${input.spaceId}, conversationId=${input.conversationId}`);
  return skillController.generateSkillFromConversation(input.spaceId, input.conversationId);
} else if (input.mode === 'prompt' && input.name && input.description) {
  logUserAction('generateSkill', `mode=prompt, name=${input.name}`);
  return skillController.generateSkillFromPrompt({ ... });
}
```

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/ipc/skill.ts` | 修改 | 9 个 handler 入口添加 `logUserAction()` 调用 |
| `.project/modules/skill/features/skill-management/changelog.md` | 更新 | 追加变更记录 |

## 开发前必读

| 分类 | 文档/文件 | 阅读目的 |
|------|----------|---------|
| 源码文件 | `src/main/ipc/skill.ts` | 理解现有 handler 结构和已有 `logUserAction` 调用模式 |
| 源码文件 | `src/main/utils/logger.ts` | 了解 `logUserAction` 函数签名和日志格式 |

## 验收标准

- [ ] 9 个 handler 入口均有 `logUserAction()` 调用
- [ ] 执行以上操作后，日志中出现对应的 `[USER ACTION]` 条目，内容包含预期参数
- [ ] 已有 `installSkill` / `uninstallSkill` 的日志不受影响
- [ ] `npm run typecheck && npm run lint && npm run build` 通过

## 变更记录

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-06 | 初始 Bug 修复 PRD | 用户 |
