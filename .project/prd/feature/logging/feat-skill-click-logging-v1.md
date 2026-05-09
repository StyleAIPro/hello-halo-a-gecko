# PRD [Feature] — 技能库点击操作日志

| 字段 | 值 |
|------|------|
| 版本 | v1 |
| 日期 | 2026-05-07 |
| 指令人 | @misakamikoto |
| 模块 | main（IPC System + Preload + Renderer API + Skill 组件） |
| 状态 | done |
| 优先级 | P2 |
| 影响范围 | 主进程日志文件 |

## 需求分析

### 背景

`wrapIpcHandle` 已覆盖所有 IPC handler 的自动日志记录，但技能库中点击技能卡片选中是纯前端 Zustand/React state 变化，不触发 IPC 调用，因此无法被拦截。

### 问题

在技能库（Library）和技能市场（Market）中点击技能卡片时，日志文件中没有对应记录。

### 方案

1. 新增 `log:user-action` IPC 通道，渲染进程通过 preload 调用
2. 主进程 handler 使用 `console.info('[event] action: detail')` 记录
3. 在 `SkillLibrary` 和 `SkillMarket` 组件的点击 handler 中添加 `api.logUserAction()` 调用

### 日志格式

```
[event] skill:select: claude-code-skill -> ok 1ms
[event] skill:market-select: skills.sh:owner/repo/skillName -> ok 1ms
```

## 涉及文件

| # | 文件路径 | 变更类型 | 说明 |
|---|---------|---------|------|
| 1 | `src/main/ipc/system.ts` | 修改 | 添加 `log:user-action` handler |
| 2 | `src/preload/index.ts` | 修改 | 暴露 `logUserAction` 方法 |
| 3 | `src/renderer/api/index.ts` | 修改 | 添加 `api.logUserAction()` |
| 4 | `src/renderer/components/skill/SkillLibrary.tsx` | 修改 | 点击技能卡片时调用 `api.logUserAction` |
| 5 | `src/renderer/components/skill/SkillMarket.tsx` | 修改 | 点击市场技能卡片时调用 `api.logUserAction` |

## 验收标准

- [ ] 技能库中点击技能卡片时，日志出现 `[event] skill:select: <appId>` + `-> ok Nms`
- [ ] 技能市场中点击技能卡片时，日志出现 `[event] skill:market-select: <skillId>` + `-> ok Nms`
- [ ] `npm run build` 通过

## 变更记录

| 日期 | 内容 | 作者 |
|------|------|------|
| 2026-05-07 | 初始版本：新增 log:user-action 通道 + 技能组件点击日志 | subagent |
