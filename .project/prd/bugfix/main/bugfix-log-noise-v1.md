# PRD [Bugfix] — 日志文件噪音过滤

| 字段 | 值 |
|------|------|
| 版本 | v1 |
| 日期 | 2026-04-29 |
| 作者 | @misakamikoto |
| 模块 | main |
| 状态 | in-progress |
| 优先级 | P1 |
| 影响范围 | 仅主进程 |

## 问题分析

日志文件 `app-logs/aico-bot-YYYY-MM-DD.log` 中约 30% 内容是无意义噪音，主要原因：

1. **SkillManager** — 每次启动列出 19 个技能的 Candidate/Loaded/Initialized 日志（~156 行/次）
2. **SDK Config** — 每次会话预热列出 21 个链接技能（168 行/次 sendMessage）
3. **SSH 心跳** — 每 30s 重复 curl health 检查
4. **Win32Cleanup** — 重复 forceFrameRecalc 失败
5. **Health 被动检查** — 每 120s 重复 "degraded"
6. **AgentService** — 重复的 getApiCredentials/getBackendConfig 调用
7. **GitCodeSkillSource** — 市场浏览时重复 400 错误

这些日志对控制台调试有用，但写入文件后淹没了关键信息（用户操作、错误、API 调用）。

根因：`Object.assign(console, log.functions)` 将所有 `console.log` 重定向到 electron-log，导致调试用途的日志也进入文件。

## 技术方案

使用 electron-log 原生 `log.hooks` 机制，在 `transportName === 'file'` 时过滤噪音消息。`hook` 返回 `false` 可阻止消息写入文件，但不影响 console 输出。

### 改动范围

仅修改 `src/main/index.ts`，在 `log.errorHandler.startCatching()` 之后添加 hook 过滤器。

## 涉及文件

| # | 文件路径 | 变更类型 |
|---|---------|---------|
| 1 | `src/main/index.ts` | 修改 |

## 验收标准

- [ ] 日志文件中不再出现 SkillManager Candidate/Loaded 噪音
- [ ] 日志文件中不再出现 SDK Config Linked skill 噪音
- [ ] 日志文件中不再出现 SSH 心跳 curl 命令
- [ ] 日志文件中不再出现 Win32Cleanup forceFrameRecalc failed
- [ ] 日志文件中仍然保留用户操作事件（[event] 前缀）
- [ ] 日志文件中仍然保留错误和警告
- [ ] 控制台输出不受影响（开发者仍可看到完整日志）
- [ ] `npm run typecheck && npm run lint && npm run build` 通过

## 变更

| 日期 | 内容 | 作者 |
|------|------|------|
| 2026-04-29 | 初始版本 | @misakamikoto |
