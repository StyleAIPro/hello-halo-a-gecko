# PRD [Bugfix] — Skill 日志噪声治理

| 字段 | 值 |
|------|------|
| 版本 | v1 |
| 日期 | 2026-05-07 |
| 指令人 | @misakamikoto |
| 模块 | main（SDK Config + Skill Manager + Skill Market） |
| 状态 | done |
| 优先级 | P1 |
| 影响范围 | 仅主进程日志文件 |

## 需求分析

### 背景

AICO-Bot 安装了多个 Skill 后，日志文件中出现大量 Skill 相关日志。其中大部分在对话创建、进入会话时产生，与用户实际使用 Skill 的场景无关。用户反馈：**对话创建和进入时不需要显示 skill 相关信息，只有在实际调用 skill 时才显示**。

### 噪声源分析

**最高优先级 — 每次 SDK 子进程创建时触发（每次对话）：**

`src/main/services/agent/sdk-config.ts` 中的 `mergeSkillsDirs()` 被 `buildSdkEnv()` 调用，而 `buildSdkEnv()` 在每次 SDK 子进程创建时执行。每个已安装 skill 产生一行日志：

```
[SDK Config] Linked skill: claude-code-skill → /path/to/skill (行 344)
```

假设安装了 10 个 Skill，每次对话开始就产生 10 行无用的 "Linked skill" 日志。此外还有 "Removed stale skill link"（行 322）。

**中等优先级 — Skill Manager 加载/刷新时的逐个 skill 日志：**

`src/main/services/skill/skill-manager.ts` 的 `loadSkills()`/`refresh()` 中，每个 skill 产生 2-3 行日志（Candidate skill、Skipping duplicate、Loaded skill）。startup 时可接受，但 post-install refresh 时噪声大。

**低优先级 — Skill Market 交互日志：**

`src/main/services/skill/skill-market-service.ts` 中 `getSkills`（行 244）、`getSkillDetail`（行 549-589）在用户浏览技能市场时产生多条日志。属于 UI 交互，不是对话噪声，但过于冗余。

**不需要修改的：**

- `ipc/skill.ts` 行 465（startup 单行）— 可接受
- `bootstrap/extended.ts` 行 228（startup 单行）— 可接受
- skill 安装/卸载/执行相关的日志 — 用户要求保留

## 技术方案

### 核心策略

将非 skill 执行场景下的 skill 日志降级为 `console.debug`。`console.debug` 在生产环境 `fileLevel='info'` 配置下不写入文件，但 dev 模式仍可见。

### 1. `sdk-config.ts` — SDK 子进程 skill 链接日志（最高优先级）

| 行号 | 当前 | 处理 |
|------|------|------|
| 322 | `console.log('[SDK Config] Removed stale skill link: ...')` | → `console.debug` |
| 344 | `console.log('[SDK Config] Linked skill: ...')` | → `console.debug` |
| 346 | `console.warn('[SDK Config] Failed to link skill ...')` | **保留** `console.warn`（错误必须可见） |
| 469 | `console.log('[SDK Config] Created skills directory: ...')` | → `console.debug`（一次性信息） |
| 478 | `console.log('[SDK Config] Replaced legacy junction: ...')` | → `console.debug`（一次性信息） |
| 500 | `console.log('[SDK Config] Created .claude/skills junction: ...')` | → `console.debug`（一次性信息） |

### 2. `skill-manager.ts` — skill 加载逐行日志

将 `loadSkills()` 中的逐 skill 详细日志降级。保留 startup 初始化日志和 refresh 完成日志。

| 行号 | 当前 | 处理 |
|------|------|------|
| 107 | `console.log('Loading skills from: ...')` | → `console.debug` |
| 111 | `console.log('Found N entries in ...')` | → `console.debug` |
| 130-138 | `console.log('Candidate skill: ...')` | → `console.debug` |
| 140-147 | `console.log('Skipping older duplicate: ...')` | → `console.debug` |
| 162 | `console.log('Loaded skill: ...')` | → `console.debug` |
| 62-68 | `console.log('Initialized with N skills ...')` | **保留**（startup 摘要） |
| 544 | `console.log('Refreshed skills')` | **保留**（refresh 完成摘要） |
| 123, 150, 154 | warn/error | **保留**（错误必须可见） |

### 3. `skill-market-service.ts` — 技能市场浏览日志

将 UI 交互触发的 skill market 请求日志降级。保留 skill 下载/安装和错误日志。

| 行号 | 当前 | 处理 |
|------|------|------|
| 244 | `console.log('getSkills called: ...')` | → `console.debug` |
| 408 | `console.log('Parsed N skills from HTML')` | → `console.debug` |
| 419 | `console.log('Fetching from skills.sh API: ...')` | → `console.debug` |
| 444 | `console.log('skills.sh API returned: N skills')` | → `console.debug` |
| 481 | `console.log('searchSkills called: ...')` | → `console.debug` |
| 524 | `console.log('getSkillDetail called: ...')` | → `console.debug` |
| 549-589 | getSkillDetail 详情日志 | → `console.debug`（6 处） |
| 668, 727 | downloadSkill 日志 | → `console.debug` |
| 301, 304 | skills.sh homepage 日志 | → `console.debug` |
| 270 | Cache reset | → `console.debug` |
| 所有 `console.error`/`console.warn` | | **保留** |
| 806, 904 | PAT 未配置警告 | **保留** |

### 4. `skill.controller.ts` — 控制器转发日志

| 行号 | 当前 | 处理 |
|------|------|------|
| 932 | `console.log('listMarketSkills called: ...')` | → `console.debug` |
| 934 | `console.log('listMarketSkills result: ...')` | → `console.debug` |
| 1827 | `console.log('listRepoDirectories for: ...')` | → `console.debug` |
| 1829 | `console.log('listRepoDirectories result: ...')` | → `console.debug` |
| 1385 | `console.log('Using provided context: ...')` | → `console.debug` |
| 所有 `console.error` | | **保留** |

### 不修改的文件

- `ipc/skill.ts` — `[event] installSkill/uninstallSkill` 日志保留（实际 skill 操作）
- `bootstrap/extended.ts` — startup 日志保留（单行，可接受）
- `skill-conversation.service.ts` — skill-creator 会话日志保留（实际 skill 执行）
- `temp-agent-session.ts` — temp session 创建日志保留（实际 skill 操作）
- `agent/` 目录中的 `send-message-local.ts`、`process-stream.ts` — 无 skill 相关日志

## 涉及文件

| # | 文件路径 | 变更类型 | 说明 |
|---|---------|---------|------|
| 1 | `src/main/services/agent/sdk-config.ts` | 修改 | 5 处 skill link 日志降为 debug |
| 2 | `src/main/services/skill/skill-manager.ts` | 修改 | ~6 处逐 skill 日志降为 debug |
| 3 | `src/main/services/skill/skill-market-service.ts` | 修改 | ~15 处 market UI 日志降为 debug |
| 4 | `src/main/controllers/skill.controller.ts` | 修改 | ~5 处转发日志降为 debug |

## 验收标准

- [ ] 安装 10 个 Skill 后，开始一次新对话，日志文件中不再出现 `[SDK Config] Linked skill:` 行
- [ ] 安装 10 个 Skill 后，开始一次新对话，日志文件中不再出现 `Candidate skill:` / `Loaded skill:` 逐行日志
- [ ] 浏览技能市场时（列表、搜索、详情），日志文件中不再出现 `getSkills called` / `getSkillDetail called` 日志
- [ ] skill 安装/卸载操作仍产生 `[event] installSkill` / `[event] uninstallSkill` 日志
- [ ] skill 执行时（skill-creator 会话、temp session）相关日志保留
- [ ] SkillManager startup 摘要日志（`Initialized with N skills`）仍保留
- [ ] SkillManager refresh 完成日志（`Refreshed skills`）仍保留
- [ ] 所有 skill 相关的 `console.error` 和 `console.warn` 日志保留
- [ ] `npm run build` 通过
- [ ] 应用正常启动

## 变更记录

| 日期 | 内容 | 作者 |
|------|------|------|
| 2026-05-07 | 初始版本：4 个文件共 ~31 处 skill 日志降级为 debug | subagent |
