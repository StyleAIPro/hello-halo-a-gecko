# PRD — Bugfix: 禁用的 Skill 仍被 Agent 检测和调用（v3）

> 版本：v3（v1 invalidateAllSessions 无效，v2 refreshSkillDirectories 无效）
> 状态：done
> 日期：2026-05-09
> 指令人：@misakamikoto
> 优先级：P0
> 模块：Agent 核心 / 技能系统

## 问题描述

在技能库页面将 Skill 禁用后，BOT（Agent）仍然能检测并调用该 Skill。v1（invalidateAllSessions）和 v2（+ refreshSkillDirectories）均未解决。

## v1/v2 失效根因

经过完整调用链排查（UI → Store → API → Preload → IPC → Controller → SkillManager → mergeSkillsDirs → invalidateAllSessions），链路本身完整无断裂。

**真正根因：SDK resume 机制绕过了 junction 过滤。**

```
1. 用户发送消息 → getOrCreateV2Session 创建会话 S1，SDK 扫描 configSkillsDir 获取技能列表（含 skill-A）
2. saveSessionId() 将 sessionId 保存到对话文件
3. 用户禁用 skill-A → toggleSkill → refreshSkillDirectories（移除 junction）→ invalidateAllSessions（从 v2Sessions Map 移除 S1）
4. 用户发送新消息 → send-message-local 读取 conversation.sessionId（仍是旧值）
5. getOrCreateV2Session 发现 v2Sessions 中无该会话 → 创建新会话
6. effectiveSessionId = 旧 sessionId → sdkOptions.resume = 旧 sessionId
7. SDK 从磁盘恢复旧会话 → 恢复缓存的技能列表 → skill-A 仍然可见！
```

关键：SDK resume 时从会话磁盘存储恢复技能列表，**不重新扫描 configSkillsDir**。因此即使 junction 已被 `refreshSkillDirectories()` 移除，resumed 会话仍使用旧缓存。

## 技术方案

### 方案：Skill 切换时清除所有活跃对话的 sessionId

在 `toggleSkill` 成功后，遍历 `v2Sessions`（包含所有活跃会话的 spaceId 和 conversationId），清除每个对话磁盘文件中的 `sessionId`，阻止 SDK resume，强制创建全新会话。

#### 修改点

**文件 1：`src/main/services/conversation.service.ts`**

新增 `clearSessionId()` 函数：

```typescript
export function clearSessionId(spaceId: string, conversationId: string): void {
  const result = cachedRead(spaceId, conversationId);
  if (!result) return;
  const { conversation, filePath, conversationsDir } = result;
  if (conversation.sessionId) {
    delete conversation.sessionId;
    cachedWrite(conversationId, conversation, filePath, conversationsDir, spaceId);
  }
}
```

**文件 2：`src/main/controllers/skill.controller.ts`**

在 `toggleSkill` 中遍历 `v2Sessions` 清除 sessionId：

```typescript
import { v2Sessions } from '../services/agent/session-lifecycle';
import { clearSessionId } from '../services/conversation.service';

// 在 toggleSkill 的 if (result) 块中：
if (result) {
  refreshSkillDirectories();
  for (const info of v2Sessions.values()) {
    clearSessionId(info.spaceId, info.conversationId);
  }
  invalidateAllSessions();
}
```

执行顺序很重要：
1. `refreshSkillDirectories()` — 更新 junction（文件系统即时生效）
2. `clearSessionId()` — 清除磁盘上的 sessionId（阻止 SDK resume）
3. `invalidateAllSessions()` — 关闭内存中的 SDK 会话

### 风险评估

- 清除 sessionId 后，新会话不会 resume 旧会话的内存上下文。对话历史（消息记录）仍然保存在对话文件中，不会丢失。SDK 从消息历史恢复上下文（而非从 session 缓存），功能等价但可能略慢（首次消息需重新加载）。
- 仅清除 v2Sessions 中的活跃对话。未活跃的对话在下次发消息时会自然创建新会话，此时 `buildSdkEnv` IIFE 会执行 `mergeSkillsDirs` 更新 junction，新 SDK 子进程扫描到正确的技能列表。因此不受影响。

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|----------|
| 源码文件 | `src/main/services/agent/session-lifecycle.ts` (L282-310) | getOrCreateV2Session 中 resume 逻辑 |
| 源码文件 | `src/main/services/agent/session-lifecycle.ts` (L208-219) | V2SessionInfo 包含 spaceId/conversationId |
| 源码文件 | `src/main/services/conversation.service.ts` (L1318-1325) | saveSessionId 实现（需对应 clearSessionId） |
| 源码文件 | `src/main/services/conversation.service.ts` (L305-340) | cachedRead/cachedWrite 内部实现 |
| 源码文件 | `src/main/services/agent/send-message-local.ts` (L286) | sessionId 从对话文件读取并传入 session 创建 |
| 源码文件 | `src/main/controllers/skill.controller.ts` (L880-894) | 当前 toggleSkill 实现 |

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/main/services/conversation.service.ts` | 修改 | 新增 clearSessionId 函数 |
| `src/main/controllers/skill.controller.ts` | 修改 | toggleSkill 中遍历 v2Sessions 清除 sessionId |

## 验收标准

- [ ] 禁用 Skill 后，在同对话中发送新消息，Agent 无法检测和调用该 Skill
- [ ] 禁用 Skill 后，创建新对话，Agent 无法检测和调用该 Skill
- [ ] 启用 Skill 后，Agent 能正常检测和调用该 Skill
- [ ] 禁用 Skill 后对话历史不丢失（消息记录完整）
- [ ] `npm run typecheck` 无新增错误
- [ ] `npm run build` 通过
