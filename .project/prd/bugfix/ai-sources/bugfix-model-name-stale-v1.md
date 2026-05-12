# PRD [Bug 修复级] — 编辑模型显示名称后模型选择框出现新旧名称并存

> 版本：bugfix-model-name-stale-v1
> 日期：2026-05-11
> 状态：in-progress
> 指令人：@mi-saka
> 归属模块：modules/ai-sources
> 严重程度：Major
> 所属功能：features/source-provider, features/source-manager

## 问题描述

- **期望行为**：用户在 AI Sources 配置中编辑了某个已有模型的显示名称后（如从 "GPT-4" 改为 "My GPT-4"），模型选择框的下拉列表应只显示更新后的名称 "My GPT-4"
- **实际行为**：模型选择框的下拉列表中新旧两个名称同时存在（"GPT-4" 和 "My GPT-4" 并存），本地空间（ModelSelector）和远程空间（RemoteModelSelector）都有这个问题
- **数据残留**：这是一个数据残留问题，不是显示名称映射问题。持久化到 config.json 的 `availableModels` 数组中同时包含了新旧两条记录

## 问题根因分析

### 根因 1：ProviderSelector 无模型名称编辑能力，用户通过 Custom Model ID "变相重命名"

**文件**：`src/renderer/components/settings/ProviderSelector.tsx`

当前 UI 不提供编辑单个模型显示名称的功能。用户只能通过以下方式间接修改模型列表：

1. **"Fetch Models"** — 从 API 获取新模型列表，整体替换 `fetchedModels`
2. **"Use custom model ID"** — 输入自定义模型 ID，通过 `handleSave` 追加到 `availableModels`
3. **删除模型（X 按钮）** — 从 `fetchedModels` 中移除

当用户想将 "GPT-4" 改名为 "My GPT-4" 时，最自然的操作是勾选 "Use custom model ID" 并输入 "My GPT-4"。但 `handleSave`（第 222-274 行）的逻辑是：

```typescript
const availableModels: ModelOption[] =
  fetchedModels.length > 0
    ? fetchedModels                                    // 保留旧的 fetchedModels
    : currentProvider?.models || [{ id: finalModel, name: finalModel }];

if (!availableModels.some((m) => m.id === finalModel)) {
  availableModels.unshift({ id: finalModel, name: finalModel });  // 仅按 id 去重
}
```

关键问题：
- `fetchedModels` 在编辑模式下初始化为 `editingSource.availableModels`（第 87-89 行），包含所有旧模型
- 新增的自定义模型 `{id: "My GPT-4", name: "My GPT-4"}` 与旧模型 `{id: "gpt-4", name: "GPT-4"}` 的 **`id` 不同**，不会被去重
- `unshift` 将新模型插入数组头部，旧模型仍保留在数组中
- 结果：`availableModels = [{id: "My GPT-4", name: "My GPT-4"}, {id: "gpt-4", name: "GPT-4"}]`

### 根因 2：删除旧模型的交互不直观

**文件**：`src/renderer/components/settings/ProviderSelector.tsx`（第 177-182 行）

`canDeleteModel()` 仅在 `fetchedModels.length > 1` 时允许删除。当用户添加了自定义模型后，理论上可以删除旧模型（因为此时数量 > 1），但删除按钮（X 图标）仅在模型项的 `hover` 状态时显示，且不提供 "替换" 语义——用户需要自行发现并执行两步操作（添加新 + 删除旧），不符合 "编辑名称" 的心智模型。

### 根因 3：saveConfig 对 aiSources 无深度合并，但此处不是问题所在

**文件**：`src/main/services/config.service.ts`（第 894-896 行）

`saveConfig` 对 `aiSources` 执行顶层替换（非深度合并），这是正确的行为——后端持久化逻辑本身不会导致数据残留。数据残留的根因在前端 `handleSave` 构建 `availableModels` 时的逻辑缺陷。

### 根因 4：syncBuiltinModels 可能在重启后重置用户自定义的模型名称

**文件**：`src/main/services/ai-sources/manager.ts`（第 652-702 行）

`syncBuiltinModels()` 在启动时检测到 source 的 `availableModels` 全部是 builtin 模型 ID 时，会用 `builtin.models`（包含默认名称）完全替换 `availableModels`。如果用户通过自定义模型功能修改了模型名称但 ID 仍是 builtin ID，重启后名称会被重置。虽然这不是 "新旧并存" 的直接原因，但会加剧用户困惑。

## 技术方案

### 修复 1：为每个模型添加内联编辑显示名称的能力

在 `ProviderSelector` 的模型下拉列表中，为每个模型项添加编辑按钮。点击后，模型名称变为可编辑的输入框，用户可以直接修改 `ModelOption.name`。

**核心改动**：

1. 在 `ProviderSelector` 中新增 `editingModelId` state，记录当前正在编辑名称的模型
2. 模型列表项中，当 `editingModelId === model.id` 时，渲染 `<input>` 替代显示文本
3. 编辑确认后，更新 `fetchedModels` 中对应模型的 `name` 字段：
   ```typescript
   const handleUpdateModelName = (modelId: string, newName: string) => {
     setFetchedModels(prev =>
       prev.map(m => m.id === modelId ? { ...m, name: newName } : m)
     );
     setEditingModelId(null);
   };
   ```
4. 保存时，`handleSave` 使用更新后的 `fetchedModels`，自然包含新的名称

### 修复 2（防御性）：handleSave 中对 availableModels 按 id 去重

在 `handleSave` 构建 `availableModels` 后，添加按 `id` 去重的逻辑，防止任何路径导致重复：

```typescript
// Deduplicate by id (keep last occurrence to prefer newer entries)
const uniqueModels = new Map<string, ModelOption>();
for (const m of availableModels) {
  uniqueModels.set(m.id, m);
}
const deduplicatedModels = Array.from(uniqueModels.values());
```

### 修复 3（可选优化）：syncBuiltinModels 保留用户自定义的模型名称

修改 `syncBuiltinModels()` 逻辑，在替换 builtin 模型列表时，如果用户已自定义了某个模型的 `name`（与 builtin 默认 `name` 不同），保留用户自定义的名称：

```typescript
// Build a map of user-customized names (name differs from builtin default)
const userNames = new Map<string, string>();
for (const existing of existing) {
  const builtin = builtin.models.find(m => m.id === existing.id);
  if (builtin && builtin.name !== existing.name) {
    userNames.set(existing.id, existing.name);
  }
}

// Apply user-customized names to new builtin list
const mergedModels = builtin.models.map(m => ({
  ...m,
  ...(userNames.has(m.id) ? { name: userNames.get(m.id)! } : {}),
}));
```

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计 | `.project/modules/ai-sources/ai-sources-v1.md` | 理解 AI 源管理模块的整体架构和对外接口 |
| 模块设计 | `.project/modules/ai-sources/features/source-manager/design.md` | 理解 AI 源管理器的 CRUD 实现 |
| 模块设计 | `.project/modules/ai-sources/features/source-provider/design.md` | 理解提供商适配器设计 |
| 变更记录 | `.project/modules/ai-sources/features/source-provider/changelog.md` | 了解最近的变更 |
| 变更记录 | `.project/modules/ai-sources/features/source-manager/changelog.md` | 了解 source-manager 最近的变更 |
| Bug 记录 | `.project/modules/ai-sources/features/source-manager/bugfix.md` | 了解已知问题（updateConfig 主题重置等） |
| Bug 记录 | `.project/modules/ai-sources/features/source-provider/bugfix.md` | 了解 provider 层已知问题 |
| 相关 PRD | `.project/prd/bugfix/ai-sources/bugfix-model-name-sync-v1.md` | 了解已修复的远程空间模型名称显示不同步问题（不同 bug，相关领域） |
| 源码 | `src/shared/types/ai-sources.ts`（第 103-107 行） | 理解 `ModelOption` 接口定义（id/name/description） |
| 源码 | `src/renderer/components/settings/ProviderSelector.tsx` | **核心修改文件**，handleSave 逻辑（第 222-274 行）、fetchedModels 状态（第 87-89 行）、模型列表渲染（第 598-649 行） |
| 源码 | `src/renderer/hooks/useAISources.ts`（第 69-99 行） | 理解 saveSource 流程（updateSource + switchSource 两步操作） |
| 源码 | `src/main/services/ai-sources/manager.ts`（第 345-359 行） | 理解 updateSource 后端持久化逻辑 |
| 源码 | `src/main/services/ai-sources/manager.ts`（第 652-702 行） | 理解 syncBuiltinModels 启动同步逻辑 |
| 源码 | `src/main/services/config.service.ts`（第 894-980 行） | 理解 saveConfig 的合并策略（确认 aiSources 是顶层替换） |
| 源码 | `src/renderer/components/layout/ModelSelector.tsx`（第 148-165 行） | 理解本地空间模型列表的数据源（getModelsForSource） |
| 源码 | `src/renderer/components/layout/RemoteModelSelector.tsx`（第 176-186 行） | 理解远程空间模型列表的数据源 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、React 组件规范等编码规范 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/renderer/components/settings/ProviderSelector.tsx` | 修改 | **主要改动**：为模型列表项添加内联编辑名称功能；handleSave 中添加 availableModels 按 id 去重逻辑 |
| `src/main/services/ai-sources/manager.ts` | 修改 | **可选改动**：syncBuiltinModels 保留用户自定义模型名称 |

## 验收标准

- [x] **模型名称编辑**：在 ProviderSelector 编辑 Source 时，每个模型项旁边显示编辑按钮，点击后可修改该模型的显示名称
- [x] **模型名称编辑**：修改后的名称实时反映在模型下拉列表的预览中
- [x] **模型名称编辑**：保存 Source 后，config.json 中 `availableModels` 对应模型的 `name` 字段被更新
- [x] **模型名称编辑**：保存后，本地空间（ModelSelector）下拉列表中该模型显示更新后的名称
- [x] **模型名称编辑**：保存后，远程空间（RemoteModelSelector）下拉列表中该模型显示更新后的名称
- [x] **数据残留修复**：编辑模型名称后，`availableModels` 中不会出现新旧两条同名/同 id 记录
- [x] **数据残留修复**：使用 "Use custom model ID" 添加自定义模型后，如果与已有模型 id 重复，旧模型被替换而非新增
- [x] **回归测试**：原有的 "Fetch Models" 功能正常（从 API 获取模型列表并替换）
- [x] **回归测试**：原有的删除模型功能正常（X 按钮）
- [x] **回归测试**：编辑模式下切换 provider 时，模型列表正确初始化
- [x] **回归测试**：新增 Source 的流程不受影响
- [x] **可选：syncBuiltinModels 保留自定义名称**：启动时同步 builtin 模型列表，保留用户已自定义的模型名称
- [x] `npm run typecheck` 通过（修改文件无新增错误）
- [x] `npm run build` 通过（修改文件编译正常）

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-11 | 初始 Bug 修复 PRD | @moonseeker |
