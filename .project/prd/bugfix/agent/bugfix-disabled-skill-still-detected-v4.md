# PRD — Bugfix: 禁用的 Skill 仍被 Agent 检测和调用（v4）

> 版本：v4（v1-v3 均无效。v1-v3 只管理了 configSkillsDir，但 SDK 还通过项目 walk-up 从 `~/.claude/skills/` 加载技能）
> 状态：done
> 日期：2026-05-09
> 指令人：@misakamikoto
> 优先级：P0
> 模块：Agent 核心 / 技能系统

## 问题描述

在技能库页面将 Skill 禁用后，BOT 仍然能检测并调用该 Skill。v1（invalidateAllSessions）、v2（+ refreshSkillDirectories）、v3（+ clearSessionId）均未解决。

## v1-v3 失效根因

SDK CLI 在 bare mode 下通过**项目 walk-up**发现技能：从 `cwd` 向上查找 `*/.claude/skills/`。

用户 workspace 在 `C:\Users\26243\` 下，walk-up 路径：
```
cwd/.claude/skills/        → 通常不存在
cwd/..`
/.claude/skills/    → 通常不存在
...
C:\Users\26243\.claude\skills/   → 存在！包含所有源技能（含 SKILL.md）
```

**`~/.claude/skills/` 是 mergeSkillsDirs 的源目录之一，但 mergeSkillsDirs 只管理目标目录 `configSkillsDir`，不修改源目录。** 禁用的技能在源目录中仍然完整存在（含 SKILL.md），SDK 通过 walk-up 直接发现并加载。

之前的修复链路（junction 更新 → sessionId 清除 → 会话失效）全部正确，但 SDK 从源目录加载的技能完全不经过 configSkillsDir，所以这些修复对 walk-up 路径无效。

## 技术方案

### 方案：在源目录中隐藏禁用的技能

在 `refreshSkillDirectories()` 中，除了更新 configSkillsDir junction，还对源目录中的禁用技能做重命名处理：
- 禁用时：`<sourceDir>/my-skill/` → `<sourceDir>/.disabled-my-skill/`
- 启用时：`<sourceDir>/.disabled-my-skill/` → `<sourceDir>/my-skill/`

SDK walk-up 通常不识别 `.disabled-` 前缀的目录为技能（不是有效 skill 目录），从而跳过。

同步修改 `skill-manager.ts` 的 `loadSkills()`，使其也扫描 `.disabled-` 前缀的目录（以在 UI 中显示禁用技能）。

#### 修改点

**文件 1：`src/main/services/agent/sdk-config.ts`**

在 `refreshSkillDirectories()` 中增加源目录隐藏逻辑：

```typescript
export function refreshSkillDirectories(): void {
  const agentsDir = path.join(os.homedir(), '.agents');
  const skillsDir = path.join(agentsDir, 'skills');
  const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  const configSkillsDir = path.join(agentsDir, 'claude-config', 'skills');
  mergeSkillsDirs([skillsDir, claudeSkillsDir], configSkillsDir);
  // 隐藏源目录中的禁用技能，防止 SDK 项目 walk-up 发现
  hideDisabledSkillsInSource(skillsDir);
  hideDisabledSkillsInSource(claudeSkillsDir);
}

function hideDisabledSkillsInSource(sourceDir: string): void {
  if (!existsSync(sourceDir)) return;
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const metaPath = path.join(sourcePath, 'META.json');
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      if (meta.enabled === false) {
        const hiddenPath = path.join(sourceDir, `.disabled-${entry.name}`);
        if (!existsSync(hiddenPath)) {
          renameSync(sourcePath, hiddenPath);
          console.debug(`[SDK Config] Hidden disabled skill: ${entry.name}`);
        }
      }
    } catch { /* META.json missing or invalid */ }

    // 恢复已启用的技能
    if (entry.name.startsWith('.disabled-')) {
      const originalName = entry.name.slice('.disabled-'.length);
      const metaPath = path.join(sourcePath, 'META.json');
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        if (meta.enabled !== false) {
          const restoredPath = path.join(sourceDir, originalName);
          renameSync(sourcePath, restoredPath);
          console.debug(`[SDK Config] Restored enabled skill: ${originalName}`);
        }
      } catch { /* META.json missing */ }
    }
  }
}
```

**文件 2：`src/main/services/skill/skill-manager.ts`**

修改 `loadSkills()` 中的目录扫描逻辑，识别 `.disabled-` 前缀的目录：

```typescript
// 在 readdir 循环中：
const isDisabled = entry.name.startsWith('.disabled-');
const skillName = isDisabled ? entry.name.slice('.disabled-'.length) : entry.name;
```

然后在 `loadSkillFromDir` 调用和 candidates Map 中使用 `skillName` 而非 `entry.name`。

### 执行顺序

`toggleSkill` 成功后的完整流程：
1. `refreshSkillDirectories()` — 更新 configSkillsDir junction + 隐藏源目录中的禁用技能
2. `clearSessionId()` — 清除活跃对话的 sessionId（阻止 SDK resume）
3. `invalidateAllSessions()` — 关闭内存中的 SDK 会话

### 风险评估

- 重命名源目录是原子操作（`renameSync`），不会导致数据损坏
- `.disabled-` 前缀的目录不会被 SDK 识别为技能目录
- skill-manager 修改后仍能加载禁用技能（用于 UI 显示）
- 如果 rename 失败（文件被占用），try/catch 静默忽略，不会导致 toggle 失败

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|----------|
| 源码文件 | `src/main/services/agent/sdk-config.ts` (L415-421) | 当前 refreshSkillDirectories 实现 |
| 源码文件 | `src/main/services/agent/sdk-config.ts` (L281-354) | mergeSkillsDirs 实现（不需修改） |
| 源码文件 | `src/main/services/skill/skill-manager.ts` (L99-164) | loadSkills 目录扫描逻辑（需修改） |
| 源码文件 | `src/main/services/skill/skill-manager.ts` (L171-219) | loadSkillFromDir 实现 |
| 源码文件 | `src/main/services/skill/skill-manager.ts` (L454-471) | toggleSkill 实现（不需修改） |

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/main/services/agent/sdk-config.ts` | 修改 | refreshSkillDirectories 中新增 hideDisabledSkillsInSource |
| `src/main/services/skill/skill-manager.ts` | 修改 | loadSkills 支持 .disabled- 前缀目录 |

## 验收标准

- [ ] 禁用 Skill 后，在同对话中发送新消息，Agent 无法检测和调用该 Skill
- [ ] 禁用 Skill 后，创建新对话，Agent 无法检测和调用该 Skill
- [ ] 启用 Skill 后，Agent 能正常检测和调用该 Skill
- [ ] 禁用的 Skill 在技能库 UI 中仍然可见（显示为已禁用状态）
- [ ] 应用重启后，禁用状态保持
- [ ] `npm run typecheck` 无新增错误
- [ ] `npm run build` 通过
