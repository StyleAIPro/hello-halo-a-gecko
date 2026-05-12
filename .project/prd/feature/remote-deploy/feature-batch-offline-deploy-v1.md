---
timestamp: 2026-05-11
status: in-progress
author: moonseeker
---

# PRD: 批量离线部署

## 元信息

- 模块: remote-deploy
- 优先级: P1
- 影响范围: 仅前端
- 级别: feature
- 指令人: moonseeker

## 需求分析

### 背景

2026-05-08（commit d184d3c）移除在线部署模式时，连同批量更新按钮一起删除了。当时的设计决策是「Batch Update 仅配合在线模式使用，在线模式移除后该按钮也无意义」（见 `feature-offline-only-deploy-v1.md`）。

但用户实际使用中仍然有批量部署到多台服务器的场景：每次版本更新后，需要逐台点击部署按钮，效率低下。

### 现状

代码中仍保留了大量与批量操作相关的遗留代码：

| 遗留代码 | 位置 | 当前状态 |
|---------|------|---------|
| `batchUpdating` state | 第 110 行 | 声明但无 UI 使用 |
| `batchProgress` state | 第 111-114 行 | 声明但仅在第 1127-1135 行渲染进度文本 |
| `handleBatchUpdate()` 函数体 | 第 970-1007 行 | 函数体完整保留，但调用的是 `handleUpdateAgent`（在线更新）而非 `handleDeployOffline`（离线部署） |
| 部署按钮的 `batchUpdating` disabled 条件 | 第 1249 行 | `disabled={... batchUpdating ...}` 引用了该 state |
| 进度文本渲染 | 第 1127-1135 行 | 有条件渲染，但 `batchProgress` 永远为 null |
| i18n key `"Updating agents... {{current}}/{{total}}"` | en.json 第 1133 行 | 翻译已存在 |

唯一缺失的是：标题栏中的批量部署按钮（触发 `handleBatchUpdate` 的 UI 入口）。

### 目标

将遗留的批量操作代码适配到离线部署流程，恢复批量部署按钮，让用户可以一键对所有服务器执行离线部署。

---

## 技术方案

### 核心改动

**1. 修改 `handleBatchUpdate()` 函数体（第 970-1007 行）**

当前函数调用 `handleUpdateAgent(server.id, true)`（在线更新），需改为调用 `handleDeployOffline(server.id)`（离线部署）。

改动要点：
- 将 `handleUpdateAgent(server.id, true)` 替换为 `handleDeployOffline(server.id)`
- 确认对话框文案从「批量更新」改为「批量离线部署」
- 完成摘要从 "Batch update completed" 改为 "Batch deploy completed"
- `handleDeployOffline` 内部已管理 `updatingAgent` state，但批量模式下多个服务器并行，需要确保不冲突（当前 `updatingAgent` 是单值 `string | null`，并行时需要跳过 spinner 设置）

**2. 解决 `updatingAgent` 单值冲突**

当前 `handleDeployOffline` 在第 920 行设置 `setUpdatingAgent(serverId)`，用于单个服务器部署时显示 spinner。批量模式下 `Promise.allSettled` 并行执行，多个 `setUpdatingAgent` 会互相覆盖。

方案：为 `handleDeployOffline` 添加可选参数 `skipSpinner?: boolean`，批量调用时传入 `true` 跳过 `updatingAgent` state 设置，改为通过 `batchProgress` 统一展示进度。同时跳过 `alertDialog` 弹窗（由批量完成后统一弹摘要）。

```typescript
const handleDeployOffline = async (serverId: string, options?: { skipSpinner?: boolean; skipAlert?: boolean }): Promise<boolean> => {
  if (!options?.skipSpinner) {
    setUpdatingAgent(serverId);
    pendingUpdateRef.current = serverId;
  }
  // ... 部署逻辑不变 ...

  // 成功/失败时
  if (!options?.skipAlert) {
    await alertDialog(t('Agent deployed offline successfully'));
  }
  // ...
};
```

**3. 添加批量部署按钮**

在标题栏右侧「Add Server」按钮左侧，添加「Batch Deploy」按钮：

```tsx
{servers.length > 0 && offlineBundleReady && (
  <button
    onClick={handleBatchUpdate}
    disabled={batchUpdating}
    className="px-4 py-2 bg-green-600 text-white rounded-lg flex items-center gap-2 hover:bg-green-700 transition-colors disabled:opacity-50 whitespace-nowrap"
  >
    {batchUpdating ? (
      <Loader2 className="w-4 h-4 animate-spin" />
    ) : (
      <Package className="w-4 h-4" />
    )}
    {t('Batch Deploy')}
  </button>
)}
```

位置：第 1137-1150 行的 `<div className="flex items-center gap-2">` 内，在「Add Server」按钮之前。

**4. 修改 `handleBatchUpdate()` 函数体**

```typescript
const handleBatchUpdate = async () => {
  if (servers.length === 0) return;
  if (!(await confirmDialog(
    t('Batch offline deploy all servers? This will deploy the latest agent bundle to all servers.')
  ))) return;

  setBatchUpdating(true);
  // 展开所有服务器以显示终端输出
  setExpandedServers((prev) => new Set([...prev, ...servers.map((s) => s.id)]));
  const total = servers.length;
  setBatchProgress({ current: 0, total });
  let completed = 0;
  let succeeded = 0;

  const results = await Promise.allSettled(
    servers.map((server) =>
      handleDeployOffline(server.id, { skipSpinner: true, skipAlert: true })
        .then((ok) => {
          if (ok) succeeded++;
        })
        .finally(() => {
          completed++;
          setBatchProgress({ current: completed, total });
        }),
    ),
  );

  const failed = total - succeeded;
  setBatchProgress(null);
  setBatchUpdating(false);
  await alertDialog(
    t('Batch deploy completed: {{succeeded}}/{{total}} succeeded{{failed}}', {
      succeeded,
      total,
      failed: failed > 0 ? `, ${failed} failed` : '',
    })
  );
  await loadServers();
};
```

**5. i18n 新增翻译 key**

| key | en | zh-CN |
|-----|----|----|
| `Batch Deploy` | Batch Deploy | 批量部署 |
| `Batch offline deploy all servers? This will deploy the latest agent bundle to all servers.` | Batch offline deploy all servers? This will deploy the latest agent bundle to all servers. | 确认对所有服务器执行批量离线部署？这将部署最新的 Agent 离线包到所有服务器。 |
| `Batch deploy completed: {{succeeded}}/{{total}} succeeded{{failed}}` | Batch deploy completed: {{succeeded}}/{{total}} succeeded{{failed}} | 批量部署完成：{{succeeded}}/{{total}} 成功{{failed}} |

已有的 i18n key 可复用：
- `"Updating agents... {{current}}/{{total}}"` — 进度显示文本（第 1127-1135 行）

### 不改动的部分

| 项目 | 原因 |
|------|------|
| `handleDeployOffline` 核心部署逻辑 | 仅增加可选参数，不修改部署流程 |
| 后端 IPC handler (`remote-server:deploy-offline`) | 无需修改，纯前端改动 |
| `api.remoteServerDeployOffline()` | 无需修改 |
| 终端输出面板 | 已有，批量部署时自动通过 `expandServer` 展开所有服务器 |
| `offlineBundleReady` 检测逻辑 | 复用已有逻辑，按钮依赖该 state 显示/隐藏 |

---

## 开发前必读

### 模块设计文档

| 文档路径 | 阅读目的 |
|---------|---------|
| `.project/modules/remote-agent/features/offline-deploy/design.md` | 理解离线部署完整流程（构建 → 上传 → 解压 → 启动），确认批量场景不会产生冲突 |
| `.project/modules/remote-agent/features/remote-deploy/design.md` | 理解 `startUpdate`/`completeUpdate`/`failUpdate` 操作状态管理，确认并行部署不会互相覆盖状态 |

### 源码文件

| 文件路径 | 阅读目的 |
|---------|---------|
| `src/renderer/components/settings/RemoteServersSection.tsx` | **核心文件**：修改 `handleBatchUpdate`（第 970 行）、`handleDeployOffline`（第 919 行）、标题栏按钮区域（第 1137 行）；理解 `batchUpdating`/`batchProgress`/`updatingAgent` 三个 state 的交互 |
| `src/renderer/i18n/locales/en.json` | 确认已有翻译 key 和新增 key 的位置 |

### 编码规范

| 文档路径 | 阅读目的 |
|---------|---------|
| `docs/Development-Standards-Guide.md` | React 组件规范、图标使用、i18n 规范 |

---

## 涉及文件

| 文件路径 | 修改内容 |
|---------|---------|
| `src/renderer/components/settings/RemoteServersSection.tsx` | 修改 `handleDeployOffline` 签名（增加 options 参数）；重写 `handleBatchUpdate` 函数体；在标题栏添加「Batch Deploy」按钮 |
| `src/renderer/i18n/locales/en.json` | 新增 3 个翻译 key |
| `src/renderer/i18n/locales/zh-CN.json` | 新增 3 个翻译 key |
| `src/renderer/i18n/locales/de.json` | 新增 3 个翻译 key（空值，待 AI 翻译） |
| `src/renderer/i18n/locales/es.json` | 新增 3 个翻译 key（空值，待 AI 翻译） |
| `src/renderer/i18n/locales/fr.json` | 新增 3 个翻译 key（空值，待 AI 翻译） |
| `src/renderer/i18n/locales/ja.json` | 新增 3 个翻译 key（空值，待 AI 翻译） |
| `src/renderer/i18n/locales/zh-TW.json` | 新增 3 个翻译 key（空值，待 AI 翻译） |

---

## 验收标准

- [ ] **V1**: 标题栏「Add Server」按钮左侧出现「Batch Deploy」按钮（绿色，`Package` 图标）
- [ ] **V2**: 服务器列表为空或离线包未构建时，按钮不显示
- [ ] **V3**: 点击按钮弹出确认对话框，文案为「批量离线部署」相关内容
- [ ] **V4**: 确认后所有服务器并行执行离线部署（`Promise.allSettled`）
- [ ] **V5**: 部署过程中按钮显示 spinner 且 disabled，每个服务器展开终端输出
- [ ] **V6**: 标题区域显示进度文本 "Updating agents... X/Y"
- [ ] **V7**: 批量部署期间，单个服务器的 deploy 按钮被 disabled（`batchUpdating` 条件已存在）
- [ ] **V8**: 完成后弹出摘要对话框："Batch deploy completed: X/Y succeeded, Z failed"
- [ ] **V9**: 批量部署期间单个服务器部署不会弹出成功/失败 alert（由 `skipAlert` 控制）
- [ ] **V10**: 非批量场景（单击 deploy 按钮）行为不变，仍弹出成功/失败 alert
- [ ] **V11**: `npm run typecheck && npm run build` 全部通过
- [ ] **V12**: `npm run i18n` 提取并翻译新增 key
