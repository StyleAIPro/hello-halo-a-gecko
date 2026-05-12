# PRD [Bug 修复级] — 编辑模型显示名称后聊天界面模型选择框不同步

> 版本：bugfix-model-name-sync-v1
> 日期：2026-05-11
> 状态：in-progress
> 指令人：@mi-saka
> 归属模块：modules/ai-sources
> 严重程度：Major
> 所属功能：features/source-manager, features/source-provider

## 问题描述

- **期望行为**：用户在 AI Sources 配置中编辑了 AI Source 的配置（如获取新模型列表、更换 provider、编辑显示名称等）后，聊天界面顶部的模型选择框应立即反映更新后的模型显示名称（`ModelOption.name`）
- **实际行为**：聊天界面顶部的模型选择框仍显示旧的模型 ID（原始字符串），本地和远程空间都受影响，对用户造成误导

## 问题根因分析

### 根因 1：RemoteModelSelector 使用 model ID 而非显示名称

**文件**：`src/renderer/components/layout/RemoteModelSelector.tsx` 第 50 行

```typescript
const currentModelName = server?.claudeModel || serverSource?.model || t('Not configured');
```

`server?.claudeModel` 和 `serverSource?.model` 都是模型 **ID**（原始字符串，如 `claude-sonnet-4-6` 或 `gpt-4-turbo`），而非用户友好的显示名称（如 `Claude Sonnet 4.6` 或 `GPT-4 Turbo`）。

对比本地空间的 `ModelSelector`（`ModelSelector.tsx` 第 108 行），它使用 `getCurrentModelName(aiSources)` 来查找 `availableModels` 中的 `name` 字段：

```typescript
export function getCurrentModelName(config: AISourcesConfig): string {
  const source = getCurrentSource(config);
  if (!source) return 'No model';
  const modelOption = source.availableModels.find((m) => m.id === source.model);
  return modelOption?.name || source.model;
}
```

`RemoteModelSelector` 完全没有使用 `getCurrentModelName` 或类似的查找逻辑，直接使用了 `model ID` 作为显示文本。

### 根因 2：RemoteServersSection 服务器卡片也直接显示 model ID

**文件**：`src/renderer/components/settings/RemoteServersSection.tsx` 第 1204 行

```typescript
<span className="inline-flex items-center text-xs text-muted-foreground mt-0.5">
  {source.provider} / {server.claudeModel || source.model}
</span>
```

以及第 1209-1210 行：

```typescript
{!server.aiSourceId && server.claudeModel && (
  <span className="inline-flex items-center text-xs text-muted-foreground mt-0.5">
    {server.claudeModel}
  </span>
)}
```

同样直接使用了 `server.claudeModel`（model ID）作为显示文本，未查找 `availableModels` 中的 `name`。

### 根因 3：远程服务器配置仅存储 model ID，未同步 model name

**文件**：`src/renderer/components/settings/RemoteServersSection.tsx` 第 558-563 行、第 1499-1508 行

当用户在远程服务器配置中绑定 AI Source 时，表单仅将 `source.model`（model ID）写入 `formData.claudeModel`：

```typescript
claudeModel: selectedSource?.model || undefined,
```

远程服务器的数据模型（`RemoteServer`）中 `claudeModel` 字段存储的始终是 model ID，不包含显示名称。当 AI Source 的 `availableModels` 中的模型名称更新后，远程服务器配置中存储的 `claudeModel` 仍然是旧的 model ID，而显示逻辑也无法将其映射到新的显示名称。

## 技术方案

### 修复 1：RemoteModelSelector 使用 getCurrentModelName 或等价查找

将 `RemoteModelSelector` 中第 50 行的 `currentModelName` 计算逻辑改为通过 `availableModels` 查找显示名称：

```typescript
// 当前（Bug）：
const currentModelName = server?.claudeModel || serverSource?.model || t('Not configured');

// 修复后：
const currentModelId = server?.claudeModel || serverSource?.model || '';
let currentModelName: string;
if (serverSource && currentModelId) {
  const modelOption = serverSource.availableModels?.find((m) => m.id === currentModelId);
  currentModelName = modelOption?.name || currentModelId;
} else {
  currentModelName = t('Not configured');
}
```

这样当 AI Source 的 `availableModels` 中包含更新后的模型显示名称时，`RemoteModelSelector` 会正确显示。

### 修复 2：RemoteServersSection 服务器卡片使用 model name 显示

将 `RemoteServersSection.tsx` 中第 1204 行的 model 显示改为查找 `availableModels` 中的 `name`：

```typescript
// 获取 model 显示名称的辅助函数
const getModelDisplayName = (source: AISource | undefined, modelId: string): string => {
  if (!source) return modelId;
  const modelOption = source.availableModels?.find((m) => m.id === modelId);
  return modelOption?.name || modelId;
};

// 使用：
{source.provider} / {getModelDisplayName(source, server.claudeModel || source.model)}
```

### 修复 3（可选优化）：远程服务器配置同步 model name

在 `RemoteServersSection` 中绑定 AI Source 时，除了存储 `claudeModel`（model ID），额外存储 `claudeModelName`（model 显示名称）。这样即使 AI Source 配置发生变化，已保存的显示名称仍然可用（作为 fallback）。

此修复为可选，修复 1 和 2 已能解决核心问题。

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计 | `.project/modules/ai-sources/ai-sources-v1.md` | 理解 AI 源管理模块的整体架构和对外接口 |
| 模块设计 | `.project/modules/ai-sources/features/source-manager/design.md` | 理解 AI 源管理器的 CRUD 实现 |
| 模块设计 | `.project/modules/ai-sources/features/source-provider/design.md` | 理解提供商适配器设计 |
| 变更记录 | `.project/modules/ai-sources/features/source-provider/changelog.md` | 了解最近的变更 |
| Bug 记录 | `.project/modules/ai-sources/features/source-provider/bugfix.md` | 了解已知问题 |
| 源码 | `src/shared/types/ai-sources.ts`（第 344-350 行） | 理解 `getCurrentModelName` 的查找逻辑，作为修复参考 |
| 源码 | `src/renderer/components/layout/RemoteModelSelector.tsx` | **核心修改文件**，修复 `currentModelName` 的计算逻辑 |
| 源码 | `src/renderer/components/layout/ModelSelector.tsx`（第 108 行） | **参考文件**，理解本地空间正确的 model name 获取方式 |
| 源码 | `src/renderer/components/settings/RemoteServersSection.tsx`（第 1200-1212 行） | **修改文件**，修复服务器卡片中的 model 显示 |
| 源码 | `src/renderer/hooks/useAISources.ts` | 理解 AI Source 保存后 config 的更新流程 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、IPC 模式等编码规范 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/renderer/components/layout/RemoteModelSelector.tsx` | 修改 | 修复 `currentModelName` 计算：通过 `availableModels` 查找 model name 而非直接使用 model ID |
| `src/renderer/components/settings/RemoteServersSection.tsx` | 修改 | 修复服务器卡片中 model 显示：通过 `availableModels` 查找 model name 而非直接使用 model ID |

## 验收标准

- [x] **远程空间模型选择框**：AI Source 模型配置更新后（如获取新模型列表），远程空间的 `RemoteModelSelector` 顶栏显示更新后的模型显示名称（`ModelOption.name`），而非原始 model ID
- [x] **远程空间模型选择框**：当 `availableModels` 中找到对应 model ID 的 name 时，优先显示 name；找不到时 fallback 显示 model ID
- [x] **服务器卡片 model 显示**：`RemoteServersSection` 中服务器列表的 model 显示使用 `availableModels` 中的 name 而非 raw ID
- [x] **本地空间回归测试**：本地空间的 `ModelSelector` 行为不变（它已经正确使用 `getCurrentModelName`）
- [x] **模型选择下拉列表**：`RemoteModelSelector` 下拉列表中模型的显示名称（`model.name`）正确无误（此逻辑已正确，验证不回归即可）
- [x] `npm run typecheck` 通过（修改的两个文件无类型错误，已有错误与本次无关）
- [x] `npm run build` 通过（修改的两个文件编译正常）

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-11 | 初始 Bug 修复 PRD | @moonseeker |
