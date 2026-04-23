# PRD [Bug 修复级] — 更新 AI 源配置后主题被重置为浅色

> 版本：bugfix-theme-reset-on-config-update-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 归属模块：modules/ai-sources
> 严重程度：Major
> 所属功能：features/source-manager

## 问题描述

- **期望行为**：在设置页更新 AI 模型配置后，当前主题（深色/浅色）保持不变
- **实际行为**：点击"更新"按钮后，深色主题背景变白，但主题选择器仍显示"深色"已选中。用户需要手动切换到"浅色"再切回"深色"才能恢复
- **复现步骤**：
  1. 确认当前为深色主题
  2. 进入设置页，编辑 AI 源配置，点击"更新"
  3. 页面背景变为白色

## 根因分析

`src/renderer/hooks/useAISources.ts` 中 `setConfig` 以函数回调模式调用：`(prev) => ({...prev, ...})`，出现在第 62、87-91、105 行。

但 `app.store.ts:106` 中 `setConfig` 的定义为 `setConfig: (config) => set({ config })`，**不支持函数式更新器模式**。传入函数后，整个 `config` 状态被替换为该函数对象，导致 `config?.appearance?.theme` 变为 `undefined`。

`App.tsx:223` 中 `const theme = config?.appearance?.theme || 'light'` 对 `undefined` 回退到 `'light'`，触发白色背景。

Store 中已有 `updateConfig` 方法（`app.store.ts:108-112`）正确实现了部分合并：`set({ config: { ...currentConfig, ...updates } })`。

## 修复方案

### 1. 修改 `useAISources.ts`

将 `setConfig` 替换为 `updateConfig`，接口签名从 `(config: AicoBotConfig) => void` 改为 `(updates: Partial<AicoBotConfig>) => void`。

三处调用点改为使用 `updateConfig` 传入部分更新：

- **第 62 行 `switchSource`**：`updateConfig({ aiSources: result.data })`
- **第 87-91 行 `saveSource`**：`updateConfig({ aiSources: switchResult.data, isFirstLaunch: false })`
- **第 105 行 `deleteSource`**：`updateConfig({ aiSources: result.data })`

### 2. 修改 `AISourcesSection.tsx`

- Props 接口：`setConfig` 改为 `updateConfig: (updates: Partial<AicoBotConfig>) => void`
- 传递给 hook：`useAISources({ config, updateConfig })`

## 影响范围

| 文件 | 变更 |
|------|------|
| `src/renderer/hooks/useAISources.ts` | 接口改为 `updateConfig`，3 处调用改为部分更新 |
| `src/renderer/components/settings/AISourcesSection.tsx` | Props 改为传入 `updateConfig` |

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 Bug 修复 PRD | @moonseeker1 |
