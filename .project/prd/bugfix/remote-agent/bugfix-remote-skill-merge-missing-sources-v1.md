# PRD [Bug 修复级] — 远程 Agent Proxy 技能合并逻辑缺失导致技能无法加载

> 版本：bugfix-remote-skill-merge-missing-sources-v1
> 日期：2026-04-17
> 指令人：@moonseeker1
> 反馈人：@moonseeker1
> 归属模块：modules/remote-agent
> 严重程度：Major

## 问题描述
- **期望行为**：远程 Agent Proxy 应与本地 AICO-Bot 一致，从 `~/.agents/skills/` 和 `~/.claude/skills/` 两个目录合并加载技能，并支持去重、清理过期链接、通过 `.claude/skills` 软链接让 SDK 原生发现技能。
- **实际行为**：远程 Agent Proxy 仅链接 `~/.agents/skills/`，完全遗漏 `~/.claude/skills/`（Claude Code 原生技能目录）。此外使用单层目录符号链接（而非逐技能链接+去重），且 `!fs.existsSync(configSkillsDir)` 守卫导致合并逻辑只在首次运行时执行，后续新安装的技能不会被识别。
- **复现步骤**：
  1. 在远程服务器上通过 Claude Code 原生方式安装一个 skill（存放在 `~/.claude/skills/<name>/`）
  2. 通过 AICO-Bot 桌面端向该远程服务器发送消息触发 Agent
  3. 观察 Agent 日志：该 skill 未被加载，Agent 不知道该 skill 的存在
  4. 在远程服务器首次部署后安装新 skill，重启 remote-agent-proxy 后新 skill 仍未被识别

## 根因分析

问题由四个因素共同导致：

### 1. 遗漏 `~/.claude/skills/` 源目录

`packages/remote-agent-proxy/src/claude-manager.ts` 第 1017-1028 行：

```typescript
const agentsDir = path.join(os.homedir(), '.agents')
const configDir = path.join(agentsDir, 'claude-config')
const skillsDir = path.join(agentsDir, 'skills')
const configSkillsDir = path.join(configDir, 'skills')

if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true })
}
if (fs.existsSync(skillsDir) && !fs.existsSync(configSkillsDir)) {
  fs.symlinkSync(skillsDir, configSkillsDir)  // 仅链接 ~/.agents/skills/
}
```

仅将 `~/.agents/skills/` 整体链接为 `configSkillsDir`，完全忽略了 `~/.claude/skills/`。本地实现（`src/main/services/agent/sdk-config.ts` 第 450 行）则正确地扫描两个目录：

```typescript
mergeSkillsDirs([skillsDir, claudeSkillsDir], configSkillsDir);
```

### 2. 使用单层目录符号链接而非逐技能链接+去重

远程代理将整个 `~/.agents/skills/` 目录作为单个符号链接指向 `configSkillsDir`。当 `~/.claude/skills/` 中存在同名技能时，无法实现去重（mtime 最新的胜出）。本地 `mergeSkillsDirs()` 为每个技能创建独立链接，并在重复时保留修改时间最新的版本。

### 3. `!fs.existsSync(configSkillsDir)` 守卫导致仅首次运行有效

第 1026 行的 `!fs.existsSync(configSkillsDir)` 条件意味着：一旦 `configSkillsDir` 已存在（首次运行后），后续启动不会再执行任何合并逻辑。用户在远程服务器上新安装的 skill 不会被识别，必须手动删除 `configSkillsDir` 后重启。

### 4. 缺少 `.claude/skills` 软链接

本地实现在 `configDir` 下创建 `.claude/skills` 软链接指向 `configSkillsDir`（第 452-468 行），这是 SDK "bare" 模式下项目级技能发现的关键路径。远程代理未创建此链接，导致 `settingSources: ['user']` 模式下 SDK 可能无法通过 `<add-dir>/.claude/skills/` 发现合并后的技能。

### 5. 本地 `mergeSkillsDirs()` 未过滤已禁用技能（次要问题）

本地 `mergeSkillsDirs()` 在扫描源目录时不检查 `META.json` 中的 `enabled` 字段。即使用户在 AICO-Bot 中禁用了某个 skill（`META.json.enabled = false`），该 skill 仍会被链接到 `configSkillsDir` 并被 SDK 加载。

`META.json` 结构参考（`src/main/services/skill/skill-manager.ts` 第 412-419 行）：

```typescript
const meta: InstalledSkill = {
  appId: skillId,
  spec: fullSpec,
  enabled: true,           // ← 此字段控制是否启用
  installedAt: new Date().toISOString(),
};
await fs.writeFile(path.join(skillDir, 'META.json'), JSON.stringify(meta, null, 2), 'utf-8');
```

### 对比总结

| 特性 | 本地 (`sdk-config.ts`) | 远程 (`claude-manager.ts`) |
|------|----------------------|--------------------------|
| 扫描 `~/.agents/skills/` | 有 | 有（但仅此一个） |
| 扫描 `~/.claude/skills/` | 有 | **缺失** |
| 逐技能去重（mtime 最新胜出） | 有 | **缺失** |
| 清理过期链接 | 有 | **缺失** |
| 每次启动都执行合并 | 有 | **缺失**（仅首次） |
| `.claude/skills` 软链接 | 有 | **缺失** |
| 过滤 `META.json.enabled=false` | **缺失** | **缺失** |

## 修复方案

### 修复一：远程 Agent Proxy — 移植完整技能合并逻辑（P0）

**目标**：将本地 `mergeSkillsDirs()` 的核心逻辑移植到 `claude-manager.ts`，同时适配 Linux 环境。

#### 修改文件：`packages/remote-agent-proxy/src/claude-manager.ts`

替换第 1017-1028 行的简化逻辑为：

```typescript
// Merge skills from both ~/.agents/skills/ and ~/.claude/skills/ into configSkillsDir
const agentsDir = path.join(os.homedir(), '.agents')
const configDir = path.join(agentsDir, 'claude-config')
const skillsDir = path.join(agentsDir, 'skills')
const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills')
const configSkillsDir = path.join(configDir, 'skills')

// Ensure base directories exist
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true })
}
if (!fs.existsSync(configSkillsDir)) {
  fs.mkdirSync(configSkillsDir, { recursive: true })
}

// Replace legacy single-dir symlink with real directory
const configSkillsStat = fs.existsSync(configSkillsDir)
  ? fs.lstatSync(configSkillsDir)
  : null
if (configSkillsStat && configSkillsStat.isSymbolicLink()) {
  try {
    fs.unlinkSync(configSkillsDir)
    fs.mkdirSync(configSkillsDir, { recursive: true })
  } catch (err) {
    console.warn('[ClaudeManager] Failed to replace legacy symlink:', err)
  }
}

// Collect candidates: skillName -> { sourcePath, mtime }
const candidates = new Map<string, { sourcePath: string; mtime: number }>()
for (const sourceDir of [skillsDir, claudeSkillsDir]) {
  try {
    if (!fs.existsSync(sourceDir)) continue
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sourcePath = path.join(sourceDir, entry.name)
      try {
        const stat = fs.statSync(sourcePath)
        const existing = candidates.get(entry.name)
        if (!existing || stat.mtimeMs > existing.mtime) {
          candidates.set(entry.name, { sourcePath, mtime: stat.mtimeMs })
        }
      } catch {
        // stat failed, skip
      }
    }
  } catch (err) {
    console.warn('[ClaudeManager] Failed to read source dir:', sourceDir, err)
  }
}

// Clean up stale symlinks in configSkillsDir
try {
  const existingEntries = fs.readdirSync(configSkillsDir, { withFileTypes: true })
  for (const entry of existingEntries) {
    if (!entry.isDirectory()) continue
    if (!candidates.has(entry.name)) {
      try {
        fs.unlinkSync(path.join(configSkillsDir, entry.name))
      } catch {
        // ignore
      }
    }
  }
} catch {
  // ignore
}

// Create per-skill symlinks (use 'dir' type on Linux instead of 'junction')
for (const [name, { sourcePath }] of candidates) {
  const targetPath = path.join(configSkillsDir, name)
  try { fs.unlinkSync(targetPath) } catch { /* doesn't exist */ }
  try {
    fs.symlinkSync(sourcePath, targetPath, 'dir')
  } catch (err) {
    console.warn('[ClaudeManager] Failed to link skill:', name, err)
  }
}

// Create .claude/skills symlink for SDK project-level discovery
const dotClaudeDir = path.join(configDir, '.claude')
const dotClaudeSkillsDir = path.join(dotClaudeDir, 'skills')
if (!fs.existsSync(dotClaudeDir)) {
  fs.mkdirSync(dotClaudeDir, { recursive: true })
}
if (!fs.existsSync(dotClaudeSkillsDir)) {
  try {
    fs.symlinkSync(configSkillsDir, dotClaudeSkillsDir, 'dir')
  } catch (err) {
    console.warn('[ClaudeManager] Failed to create .claude/skills symlink:', err)
  }
}
```

**关键差异点**：
- Linux 使用 `symlinkSync(target, link, 'dir')` 而非 Windows 的 `'junction'` 类型
- 每次启动都执行合并（移除 `!fs.existsSync(configSkillsDir)` 守卫）
- 新增 `~/.claude/skills/` 作为第二扫描源

#### 附加修改：`settingSources` 和 `additionalDirectories`

当前远程代理第 1031 行设置 `options.settingSources = ['user']`，本地设置为 `['user', 'project']` 并配合 `additionalDirectories`。需同步调整：

```typescript
options.settingSources = ['user', 'project']
// additionalDirectories 需在 options 对象支持时添加
```

### 修复二：本地 `mergeSkillsDirs()` 增加 `enabled` 字段检查（P1）

**目标**：本地技能合并时跳过 `META.json.enabled === false` 的技能。

#### 修改文件：`src/main/services/agent/sdk-config.ts`

在 `mergeSkillsDirs()` 的候选人收集循环中（第 256-273 行），增加 `META.json` 检查：

```typescript
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const sourcePath = path.join(sourceDir, entry.name);
  try {
    // Skip disabled skills (META.json.enabled === false)
    const metaPath = path.join(sourcePath, 'META.json');
    try {
      const metaContent = readFileSync(metaPath, 'utf-8');
      const meta = JSON.parse(metaContent);
      if (meta.enabled === false) continue;
    } catch {
      // META.json missing or invalid — not a fatal error, proceed
    }

    const stat = statSync(sourcePath);
    const mtime = stat.mtimeMs;
    const existing = candidates.get(entry.name);
    if (!existing || mtime > existing.mtime) {
      candidates.set(entry.name, { sourcePath, mtime });
    }
  } catch {
    // stat failed, skip
  }
}
```

### 实现优先级

| 优先级 | 修改 | 影响文件 | 效果 |
|--------|------|---------|------|
| P0 | 修复一：远程完整技能合并逻辑 | `packages/remote-agent-proxy/src/claude-manager.ts` | 远程 Agent 能加载所有来源的技能 |
| P0 | 修复一附加：settingSources 对齐 | `packages/remote-agent-proxy/src/claude-manager.ts` | SDK 能通过项目路径发现合并后的技能 |
| P1 | 修复二：本地 enabled 过滤 | `src/main/services/agent/sdk-config.ts` | 已禁用的技能不再被 SDK 加载 |

## 影响范围
- [ ] 涉及 API 变更 -> 无，修复内部技能合并逻辑，不暴露新 IPC 端点
- [ ] 涉及数据结构变更 -> 无
- [ ] 涉及功能设计变更 -> 无

## 验证方式

### 远程 Agent 验证
1. 在远程服务器 `~/.claude/skills/` 下手动创建一个测试 skill 目录（含 `SKILL.md`），确认远程 Agent 能加载该 skill
2. 在远程服务器 `~/.agents/skills/` 下创建同名测试 skill（修改时间更新），确认去重逻辑正确（使用 mtime 更新的版本）
3. 删除其中一个 skill，重启 remote-agent-proxy，确认过期链接被清理
4. 首次部署后安装新 skill，重启 remote-agent-proxy，确认新 skill 被正确合并
5. 检查 `~/.agents/claude-config/.claude/skills` 软链接是否存在并指向 `configSkillsDir`
6. 通过远程 Agent 发送消息，确认加载的 skill 列表包含两个目录中的所有技能

### 本地 enabled 过滤验证
1. 安装一个 skill，确认 SDK 正常加载
2. 在 AICO-Bot UI 中禁用该 skill（`META.json.enabled = false`）
3. 重启应用，发起新对话，确认被禁用的 skill 不再出现在 SDK 的可用 skill 列表中
4. 重新启用 skill，确认恢复加载

## 变更
| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-17 | 初始 PRD | @moonseeker1 |
