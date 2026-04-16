# PRD [模块级] — 文档-代码模块对齐

> 版本：doc-module-alignment-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 归属模块：codebase（跨模块文档）

## 背景

项目文档模块（`.project/modules/`）目前仅覆盖 6 个模块（agent/ai-browser/automation/chat/remote-agent/space），但代码中存在至少 8 个未覆盖的独立代码区域。同时，现有 6 个模块的「功能列表」表均为空，且部分代码功能未归入任何文档功能（如 chat 模块缺少 canvas/search/artifact）。

这种不对齐导致：
- 无法从文档结构理解系统边界和代码归属
- 跨模块变更时难以确定应更新哪些 changelog
- 新开发者难以从文档定位代码入口

## 需求

### 一、新增文档模块（8 个）

| 模块名 | 代码归属 | 功能划分 |
|--------|---------|---------|
| skill | `services/skill/`、`components/skill/`、`pages/skill/`、`stores/skill/`、`shared/skill/`、`ipc/skill.ts` | skill-editor, skill-market, skill-source |
| terminal | `services/terminal/`、`components/layout/TerminalPanel`、`components/layout/SharedTerminalPanel`、`stores/terminal.store.ts`、`stores/user-terminal.store.ts` | terminal-gateway, terminal-ui |
| health | `services/health/`、`ipc/health.ts` | health-checker, process-guardian |
| ai-sources | `services/ai-sources/`、`components/settings/AISourcesSection`、`components/settings/GitCodeSection`、`components/settings/GitHubSection` | source-provider, source-manager |
| notification | `services/notify-channels/`、`components/notification/`、`stores/notification.store.ts`、`ipc/notification-channels.ts` | notify-channels, notify-ui |
| settings | `components/settings/`、`pages/SettingsPage.tsx`、`services/config.service.ts`、`ipc/config.ts`、`services/secure-storage.service.ts` | settings-page, appearance, system-settings |
| onboarding | `components/onboarding/`、`components/setup/`、`services/onboarding.service.ts`、`services/git-bash.service.ts`、`stores/onboarding.store.ts`、`ipc/onboarding.ts`、`ipc/git-bash.ts` | onboarding-flow, setup-flow |
| observability | `services/analytics/`、`services/perf/`、`stores/perf.store.ts`、`ipc/perf.ts` | analytics, perf-monitoring |

### 二、补充现有模块的缺失功能（4 个）

| 模块 | 新增功能 | 代码归属 |
|------|---------|---------|
| chat | canvas | `components/canvas/`、`stores/canvas.store.ts`、`hooks/useCanvasLifecycle.ts` |
| chat | search | `components/search/`、`stores/search.store.ts`、`services/search.service.ts`、`hooks/useSearchNavigation.ts`、`hooks/useSearchShortcuts.ts`、`ipc/search.ts` |
| chat | artifact | `components/artifact/`、`services/artifact.service.ts`、`ipc/artifact.ts` |
| ai-browser | electron-browser-view | `services/browser-view.service.ts`、`services/browser-menu.service.ts`、`ipc/browser.ts`、`ipc/ai-browser.ts` |

### 三、填充现有模块「功能列表」

6 个现有模块的「功能列表」表均为空，需要填充功能→文档链接。

## 约束

- 不修改任何代码文件
- 模块文档格式遵循 `vibecoding-doc-standard.md`
- 每个功能至少创建 `design.md` + `changelog.md` + `bugfix.md`
- 模块「内部组件」表明确标注代码文件路径，建立文档-代码双向映射
- `hooks/` 文件通过模块文档中的「归属 Hooks」段标注所属模块（物理位置保持平铺不变）

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 PRD | @moonseeker1 |
| 2026-04-16 | 完成：新增 8 个模块（skill/terminal/health/ai-sources/notification/settings/onboarding/observability）共 16 个功能；补充 4 个功能到现有模块（chat: canvas/search/artifact, ai-browser: electron-browser-view）；填充 6 个现有模块功能列表；总计 14 模块 50 功能 164 文档文件 | @moonseeker1 |
