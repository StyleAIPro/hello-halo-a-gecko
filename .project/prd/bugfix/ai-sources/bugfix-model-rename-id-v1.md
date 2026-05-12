# PRD [Bug 修复级] — 编辑模型名称后 API 调用仍使用旧模型 ID

> 版本：bugfix-model-rename-id-v1
> 日期：2026-05-11
> 状态：in-progress
> 指令人：@mi-saka
> 归属模块：modules/ai-sources
> 严重程度：Major
> 所属功能：features/source-provider

## 问题描述

- **期望行为**：用户在 AI Sources 编辑界面中用铅笔图标修改模型名称后（如从 "gpt-4" 改为 "gpt-4-turbo"），系统调用 API 时应使用新的模型 ID "gpt-4-turbo"
- **实际行为**：系统调用 API 时仍然使用旧的模型 ID "gpt-4"，用户期望改名同时修改底层模型 ID，而非仅修改显示名称

## 问题根因分析

### 根因：handleConfirmEditModelName 仅更新 name 字段，未同步更新 id

**文件**：`src/renderer/components/settings/ProviderSelector.tsx` 第 194-203 行

```typescript
const handleConfirmEditModelName = () => {
    if (!editingModelId || !editingModelName.trim()) {
      setEditingModelId(null);
      return;
    }
    setFetchedModels(prev =>
      prev.map(m => m.id === editingModelId ? { ...m, name: editingModelName.trim() } : m),
    );
    setEditingModelId(null);
};
```

当前实现只修改了 `fetchedModels` 中匹配模型的 `name` 字段，`id` 保持不变。

而 `source.model`（实际发送给 API 的模型标识）使用的是模型 `id`，在 `handleSave` 中（第 301 行）：

```typescript
model: selectedModel,
```

`selectedModel` 始终是模型 `id`。因此当用户将 "gpt-4" 改名为 "gpt-4-turbo" 时：
- `name` 被更新为 "gpt-4-turbo"
- `id` 仍为 "gpt-4"
- `selectedModel` 仍为 "gpt-4"
- 保存后 `source.model` 仍为 "gpt-4"，API 调用使用旧 ID

### 影响链路

```
用户修改 name → fetchedModels[].name 更新 → UI 显示新名称
                                                ↓
fetchedModels[].id 不变 → selectedModel 不变 → source.model = 旧 id → API 调用使用旧 ID
```

## 技术方案

### 修复：handleConfirmEditModelName 同时更新 id 和 name

修改 `handleConfirmEditModelName`，使用户输入的值同时作为新的 `id` 和 `name`：

1. 用户新输入的值同时作为新的 `id` 和 `name`
2. 检查新 id 是否与已有其他模型 id 冲突（排除自身），冲突时提示错误
3. 如果该模型当前被 `selectedModel` 选中，需要同步更新 `selectedModel` 为新 id

```typescript
const handleConfirmEditModelName = () => {
    if (!editingModelId || !editingModelName.trim()) {
      setEditingModelId(null);
      return;
    }
    const newId = editingModelName.trim();

    // 检查新 id 是否与其他模型冲突（排除自身）
    if (fetchedModels.some((m) => m.id === newId && m.id !== editingModelId)) {
      setValidationResult({ valid: false, message: t('Model ID already exists') });
      setEditingModelId(null);
      return;
    }

    setFetchedModels(prev =>
      prev.map(m => m.id === editingModelId ? { ...m, id: newId, name: newId } : m),
    );

    // 同步更新 selectedModel
    if (selectedModel === editingModelId) {
      setSelectedModel(newId);
    }

    setEditingModelId(null);
};
```

### 辅助调整：编辑框 placeholder

将编辑框的 placeholder 调整为提示用户输入的是新的模型 ID，而非仅是显示名称。当前编辑框无 placeholder，建议添加：

```typescript
placeholder={t('Enter new model ID')}
```

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计 | `.project/modules/ai-sources/ai-sources-v1.md` | 理解 AI 源管理模块的整体架构和对外接口 |
| 模块设计 | `.project/modules/ai-sources/features/source-provider/design.md` | 理解提供商适配器设计 |
| 变更记录 | `.project/modules/ai-sources/features/source-provider/changelog.md` | 了解最近的变更，特别是内联编辑名称功能（bugfix-model-name-stale-v1）和移除 custom model ID 的 UX 重构（bugfix-model-add-rename-ux-v1） |
| Bug 记录 | `.project/modules/ai-sources/features/source-provider/bugfix.md` | 了解已知问题，确认此 bug 尚未被记录 |
| 源码 | `src/renderer/components/settings/ProviderSelector.tsx` | **核心修改文件**：handleConfirmEditModelName（第 194-203 行）、handleSave（第 263-317 行）、selectedModel 状态、编辑输入框（第 686-699 行） |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/renderer/components/settings/ProviderSelector.tsx` | 修改 | 修改 `handleConfirmEditModelName` 同时更新 id 和 name；添加模型 ID 冲突检查；同步更新 selectedModel；编辑框添加 placeholder |

## 验收标准

- [ ] **改名同步更新 id**：用铅笔图标将模型名称从 "gpt-4" 改为 "gpt-4-turbo" 后，保存时 `source.model` 为 "gpt-4-turbo"，API 调用使用新 ID
- [ ] **selectedModel 同步**：如果被改名的模型当前是选中状态，改名后 `selectedModel` 自动更新为新 id
- [ ] **id 冲突检查**：改名后的新 id 如果与列表中其他模型 id 冲突，显示错误提示，不执行修改
- [ ] **UI 提示**：编辑输入框有 placeholder 提示用户输入的是模型 ID
- [ ] **回归测试**：铅笔编辑后，模型列表下拉框中该模型显示新名称，不再显示新旧两行
- [ ] **回归测试**："Fetch Models" 功能正常
- [ ] **回归测试**："+ Add custom model" 功能正常
- [ ] **回归测试**：删除模型（X 按钮）功能正常
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-11 | 初始 Bug 修复 PRD | @moonseeker |
