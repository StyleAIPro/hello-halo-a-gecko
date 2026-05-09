---
时间: 2026-04-29
状态: done
指令人: misakamikoto
PRD 级别: bugfix
优先级: P1
---

# 技能市场导入仓库 PAT 缺失引导

## 需求背景

前置 PRD `feature-error-guidance-v1.md`（已完成）为技能市场增加了响应式错误引导机制——在加载失败后通过黄色横幅提示用户配置 PAT 或检查网络。但在实际使用中，导入 GitHub/GitCode 仓库源时仍存在多处 PAT 缺失场景未覆盖，用户得不到有效指引：

1. **安装技能时 PAT 缺失**：`installSkillFromSource()` 调用 `adapter.getToken()` 返回 `undefined`，不做任何 PAT 检查，用户只看到通用的 "Could not find skill directory" 错误。
2. **npx fallback 链 PAT 缺失**：npx 安装失败后 fallback 到 GitHub 下载，同样不做 PAT 检查，最终报 "Both npx and GitHub download failed" 无任何引导。
3. **添加源时不校验 PAT**：`addSource()` 对 GitHub/GitCode 类型源不检查 PAT 是否配置，用户可以添加一个注定失败的私有仓库源。
4. **缺少主动预警**：当前方案仅在加载失败后才显示 PAT 警告，缺少在用户切换到 GitHub/GitCode 源时即主动检测 PAT 状态的能力。

## 问题分析

### 现状分析

| 场景 | 文件 | 行号 | 当前行为 | 用户感知 |
|------|------|------|---------|---------|
| 直接安装技能 | `skill.controller.ts` | 99 | `getToken()` 返回 undefined，不提示 | "Could not find skill directory" |
| npx 失败 fallback | `skill.controller.ts` | 354-370 | fallback 到 GitHub 下载，不检查 PAT | "Both npx and GitHub download failed" |
| 添加仓库源 | `skill-market-service.ts` | 172-216 | 不校验 PAT | 源添加成功但后续全部失败 |
| 源列表加载 | `SkillMarket.tsx` | 798-822 | 仅在 loadError 存在时显示横幅 | PAT 缺失时无主动预警 |
| 前端 PAT 状态查询 | 无 | - | 无 IPC 通道 | 无法在前端主动检测 PAT |

### 根因

1. `installSkillFromSource()` 在获取 token 后仅用于 API 认证，不区分"token 为 undefined（未配置）"和"token 无效"两种情况。
2. npx fallback 链直接调用 `installSkillFromSource()`，没有在入口处做 PAT 预检。
3. `addSource()` 是纯数据写入操作，不涉及认证校验。
4. 缺少一个轻量级 IPC 通道让前端查询 GitHub/GitCode 的 PAT 配置状态。

## 技术方案

### 改动一：安装流程 PAT 错误引导

#### 1.1 `installSkillFromSource()` PAT 预检

**文件**：`src/main/controllers/skill.controller.ts`

在 `installSkillFromSource()` 函数中，`getToken()` 之后（第 99-105 行区域），增加 PAT 缺失检查：

```typescript
const token = await adapter.getToken();
if (!token) {
  const sourceLabel = adapter.sourceLabel || 'source';
  const errorMsg = `${sourceLabel} PAT not configured. / ${sourceLabel} PAT 未配置。` +
    `Please configure in Settings > ${sourceLabel}. / 请前往 设置 > ${sourceLabel} 配置。`;
  onOutput?.({ type: 'error', content: `  ${errorMsg}\n` });
  return { success: false, error: errorMsg };
}
```

仅对 GitHub/GitCode 类型的 adapter 触发此检查。通过判断 `adapter.sourceLabel` 或在 adapter 上添加 `requiresToken` 属性来区分。

#### 1.2 npx fallback 链 PAT 预检

**文件**：`src/main/controllers/skill.controller.ts`

在 npx 失败后进入 fallback 之前（第 354 行区域），增加 PAT 预检：

```typescript
// npx 执行失败 -> fallback 到 GitHub 下载
const token = await GITHUB_ADAPTER.getToken();
if (!token) {
  onOutput?.({
    type: 'error',
    content: `\n✗ GitHub PAT not configured. Cannot download skill. / GitHub PAT 未配置，无法下载技能。Please configure in Settings > GitHub.\n`,
  });
  resolve({ success: false, error: 'GitHub PAT not configured' });
  return;
}
```

同理，childProcess.on('error') 的 fallback（第 328-338 行）也做相同检查。

### 改动二：前端主动 PAT 状态检测

#### 2.1 新增 IPC 通道

**文件**：`src/main/ipc/skill.ts`

新增 handler：

```typescript
// ── skill:market:pat-status ───────────────────────────────────
ipcMain.handle('skill:market:pat-status', async () => {
  try {
    const githubToken = getGitHubToken();
    const gitcodeToken = getGitCodeToken();
    return {
      success: true,
      data: {
        github: !!githubToken,
        gitcode: !!gitcodeToken,
      },
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});
```

需要导入 `getGitHubToken` 和 `getGitCodeToken`：
- `getGitHubToken` 来自 `src/main/services/github-auth.service.ts`
- `getGitCodeToken` 来自 `src/main/services/config.service.ts`

#### 2.2 Preload 暴露

**文件**：`src/preload/index.ts`

在 skill 相关 API 区域添加：

```typescript
skillMarketPatStatus: () => ipcRenderer.invoke('skill:market:pat-status'),
```

#### 2.3 Renderer API 层

**文件**：`src/renderer/api/index.ts`

添加：

```typescript
skillMarketPatStatus: async (): Promise<ApiResponse<{ github: boolean; gitcode: boolean }>> => {
  if (isElectron()) {
    return window.aicoBot.skillMarketPatStatus();
  }
  return { success: false, error: 'Only available in desktop app' };
},
```

#### 2.4 SkillMarket UI 主动预警

**文件**：`src/renderer/components/skill/SkillMarket.tsx`

在组件 mount 时和 activeSource 切换时，调用 `api.skillMarketPatStatus()` 获取 PAT 状态，存储在 state 中。

在现有的 Error guidance banner 之前，增加主动 PAT 检查横幅：

```typescript
// 主动 PAT 检查：当源类型为 github/gitcode 且 PAT 未配置时，立即显示警告
{!loadError && activeSource?.type === 'github' && !patStatus?.github && (
  <ProactivePatWarning source="GitHub" onGoToSettings={() => setView('settings')} />
)}
{!loadError && activeSource?.type === 'gitcode' && !patStatus?.gitcode && (
  <ProactivePatWarning source="GitCode" onGoToSettings={() => setView('settings')} />
)}
```

主动预警横幅使用黄色背景 + 信息图标（Info 而非 AlertTriangle，因为还未发生错误），文案如：
- "GitHub PAT 未配置，加载私有仓库技能可能失败。建议前往设置页面配置。"
- 包含"前往设置"按钮

### 改动三：添加源时 PAT 提醒

#### 3.1 添加源后的 PAT 检查提示

**文件**：`src/renderer/components/skill/SkillMarket.tsx`

在"Add Source"操作成功后（调用 `skillMarketAddSource` 返回后），检查新源的类型：

- 如果是 `github` 类型且 `patStatus.github === false`，显示 inline 提示："源已添加，但 GitHub PAT 未配置，私有仓库将无法访问。前往设置配置。"
- 如果是 `gitcode` 类型且 `patcode.gitcode === false`，显示类似提示。
- 仍然允许源添加成功（公开仓库无需 PAT），仅为提醒。

提示使用非阻塞的 toast 或 inline 消息，3 秒后自动消失。

### 改动四：i18n 国际化

**文件**：`src/renderer/i18n/locales/zh-CN.json`、`src/renderer/i18n/locales/en.json`

新增以下 i18n key：

| Key | en | zh-CN |
|-----|----|-------|
| `skill.pat.proactiveWarning` | {source} PAT not configured. Loading private repository skills may fail. Consider configuring it in Settings. | {source} PAT 未配置，加载私有仓库技能可能失败。建议前往设置页面配置。 |
| `skill.pat.addSourceHint` | Source added, but {source} PAT is not configured. Private repositories won't be accessible. | 源已添加，但 {source} PAT 未配置，私有仓库将无法访问。 |
| `skill.pat.installError` | {source} PAT not configured. Cannot install skill. Please configure in Settings > {source}. | {source} PAT 未配置，无法安装技能。请前往 设置 > {source} 配置。 |

> **注意**：主进程 `skill.controller.ts` 中的错误消息不使用 i18n 系统，需要同时提供中英文。

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 前置 PRD | `.project/prd/feature/settings/feature-error-guidance-v1.md` | 了解已实现的错误引导机制（`classifySkillMarketError`、黄色横幅 UI），避免重复实现 |
| 模块设计文档 | `.project/modules/skill/skill-system-v1.md` | 了解技能系统整体架构、IPC 通道、对外接口 |
| 源码文件 | `src/main/controllers/skill.controller.ts:77-216` | 理解 `installSkillFromSource()` 的完整流程，确定 PAT 预检插入位置 |
| 源码文件 | `src/main/controllers/skill.controller.ts:328-380` | 理解 npx fallback 链的 error/close 处理，确定 PAT 预检插入位置 |
| 源码文件 | `src/main/services/skill/skill-market-service.ts:172-216` | 理解 `addSource()` 的逻辑，确认后端不做 PAT 阻断（仅前端提醒） |
| 源码文件 | `src/main/services/skill/github-skill-source.service.ts:60-96` | 理解 `githubApiFetch` 的 token 使用方式和错误处理 |
| 源码文件 | `src/main/services/github-auth.service.ts` | 理解 `getGitHubToken()` 函数签名和返回值 |
| 源码文件 | `src/main/services/config.service.ts` | 理解 `getGitCodeToken()` 函数签名和返回值 |
| 源码文件 | `src/main/services/gitcode-auth.service.ts:25-60` | 理解 GitCode 认证状态检查逻辑 |
| 源码文件 | `src/main/ipc/skill.ts` | 理解 skill IPC handler 注册模式，用于新增 `skill:market:pat-status` |
| 源码文件 | `src/preload/index.ts:1116-1162` | 理解 skill 相关 preload API 暴露模式 |
| 源码文件 | `src/renderer/api/index.ts:2350-2400` | 理解 skillMarket 系列 API 在 renderer 层的注册模式 |
| 源码文件 | `src/renderer/components/skill/SkillMarket.tsx:61-79` | 理解 `classifySkillMarketError()` 的实现，新增主动 PAT 横幅时保持风格一致 |
| 源码文件 | `src/renderer/components/skill/SkillMarket.tsx:798-822` | 理解现有 Error guidance banner UI，新增主动横幅的插入位置 |
| 编码规范 | `docs/Development-Standards-Guide.md` | 遵循 TypeScript strict、IPC handler try/catch 格式、命名规范 |

## 涉及文件

> 实际修改清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/main/controllers/skill.controller.ts` | 修改 | `installSkillFromSource()` 增加 PAT 预检 early return；npx fallback 链增加 PAT 预检 |
| `src/main/ipc/skill.ts` | 修改 | 新增 `skill:market:pat-status` IPC handler |
| `src/preload/index.ts` | 修改 | 新增 `skillMarketPatStatus` API 暴露 |
| `src/renderer/api/index.ts` | 修改 | 新增 `skillMarketPatStatus()` renderer API 方法 |
| `src/renderer/components/skill/SkillMarket.tsx` | 修改 | 新增主动 PAT 状态检测逻辑 + 主动预警横幅 + 添加源后的 PAT 提醒 |
| `src/renderer/i18n/locales/en.json` | 修改 | 新增 PAT 引导相关 i18n key |
| `src/renderer/i18n/locales/zh-CN.json` | 修改 | 新增 PAT 引导相关 i18n key |

## 验收标准

- [x] **1.1** GitHub PAT 未配置时，通过技能市场安装 GitHub 仓库的技能，安装输出中显示明确的 PAT 缺失引导消息（而非 "Could not find skill directory"）
- [x] **1.2** GitCode PAT 未配置时，通过技能市场安装 GitCode 仓库的技能，安装输出中显示明确的 PAT 缺失引导消息
- [x] **1.3** npx 安装失败后 fallback 到 GitHub 下载时，若 GitHub PAT 未配置，显示 PAT 缺失引导消息（而非 "Both npx and GitHub download failed"）
- [x] **1.4** GitHub/GitCode PAT 已正确配置时，安装流程正常执行，不显示任何 PAT 相关警告
- [x] **2.1** 技能市场切换到 GitHub 类型源时，若 PAT 未配置，在列表顶部立即显示主动预警横幅（不需要等加载失败）
- [x] **2.2** 技能市场切换到 GitCode 类型源时，若 PAT 未配置，在列表顶部立即显示主动预警横幅
- [x] **2.3** 主动预警横幅包含"前往设置"按钮，点击可导航到设置页面
- [x] **2.4** 使用 skills.sh 或 custom 类型源时，不显示任何 PAT 相关预警
- [x] **3.1** 添加 GitHub 类型源后，若 PAT 未配置，显示 inline 提示告知用户私有仓库将无法访问（源添加本身不阻断）
- [x] **3.2** 添加 GitCode 类型源后，若 PAT 未配置，同样显示 inline 提示
- [x] **3.3** 所有新增用户可见文本均有中英文 i18n 翻译
- [x] **3.4** `npm run typecheck && npm run lint && npm run build` 全部通过
- [x] **3.5** IPC handler 有 try/catch + `{ success, data/error }` 返回格式
- [x] **3.6** 编辑后运行 `npx eslint --fix <file>` 并 re-read 确认逻辑未被覆盖
