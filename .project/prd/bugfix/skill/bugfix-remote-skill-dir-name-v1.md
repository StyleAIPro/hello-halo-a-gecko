---
时间: 2026-04-25
状态: in-progress
指令人: @moonseeker1
PRD 级别: bugfix
---

# Bugfix: 远程 Direct Upload 安装目录名错误

## 需求分析

### 问题

`installRemoteSkillDirect` 使用传入的 `skillId`（完整市场 ID，如 `gitcode:Ascend/agent-skill:skills/commit`）作为远程目录名，导致技能被安装到：

```
~/.agents/skills/gitcode:Ascend/agent-skill:skills/commit/
```

而通过本地安装→同步到远程的技能在：

```
~/.agents/skills/commit/
```

两者目录不一致，导致远程 Agent 无法正确发现技能。

### 根因

`installSkillMultiTarget` 传入的 `skillId` 是完整市场 ID。本地安装时 `installSkillFromSource`（skill.controller.ts:90-94）会从 `skillName` 派生短目录名（取最后一段 + lowercase + 替换非字母数字），但 `installRemoteSkillDirect` 直接用 `skillId` 做目录名，缺少同样的派生逻辑。

## 技术方案

在 `installRemoteSkillDirect` 中，从 `skillName` 派生目录名，逻辑与本地 `installSkillFromSource` 一致：

```typescript
const lastSegment = skillName.split('/').pop() || skillName;
const dirName = lastSegment.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '-');
const remoteSkillDir = `${remoteHome}/.agents/skills/${dirName}`;
```

同时 `META.json` 中的 `appId` 也使用 `dirName`。

## 涉及文件

| # | 文件 | 说明 |
|---|------|------|
| 1 | `src/main/services/remote-deploy/remote-deploy.service.ts` | `installRemoteSkillDirect` 中从 `skillName` 派生目录名 |

## 验收标准

- [x] 远程 Direct Upload 安装的技能目录名与本地安装一致（短 ID 格式）
- [x] `npm run build` 通过
