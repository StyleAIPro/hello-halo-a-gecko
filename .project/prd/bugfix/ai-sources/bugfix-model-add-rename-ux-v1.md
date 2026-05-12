# PRD [Bug 修复级] — "使用自定义模型 ID" 与内联改名操作混淆导致意外新增模型

> 版本：bugfix-model-add-rename-ux-v1
> 日期：2026-05-11
> 状态：in-progress
> 指令人：@mi-saka
> 归属模块：modules/ai-sources
> 严重程度：Major
> 所属功能：features/source-provider

## 问题描述

- **期望行为**：用户修改已有模型的显示名称时，仅更新该模型的 `name` 字段，`id` 不变。用户新增一个不在列表中的模型时，系统创建新的 `{id, name}` 记录。两个操作有清晰的 UI 入口，不会产生歧义
- **实际行为**：用户使用铅笔图标编辑模型名称后（如将 "GPT-4" 改为 "My GPT-4"），如果曾经勾选过 "Use custom model ID" 并在该输入框中输入了值，保存时系统会将自定义输入的值作为新模型 `unshift` 到 `availableModels` 中，而不是更新已选中模型的名称

### 当前用户操作流程与困惑点

**场景 A：用户想改已有模型的名称**

1. 用户在模型下拉列表中用铅笔图标将 `{id: "gpt-4", name: "GPT-4"}` 的 name 改为 "My GPT-4" -- 此时 `fetchedModels` 已正确更新
2. 用户（之前或之后）勾选 "Use custom model ID"，在输入框中填入 "My GPT-4"
3. 点击保存 -- `handleSave` 中 `finalModel = "My GPT-4"`，由于 `availableModels` 中没有 `id === "My GPT-4"` 的记录，触发 `unshift({id: "My GPT-4", name: "My GPT-4"})`
4. **结果**：`availableModels` 中同时存在 `{id: "gpt-4", name: "My GPT-4"}`（铅笔编辑改了 name）和 `{id: "My GPT-4", name: "My GPT-4"}`（custom model 新增的），模型 ID 被错误地改变了

**场景 B：用户想新增一个自定义模型**

1. 用户勾选 "Use custom model ID"，输入 "my-custom-model"
2. 保存 -- `finalModel = "my-custom-model"`，`unshift({id: "my-custom-model", name: "my-custom-model"})` -- 行为正确

**核心困惑**："Use custom model ID" 输入框只有一个，用户既可能理解为「新增一个模型 ID」，也可能理解为「改名当前模型」。特别是当用户先通过铅笔编辑了名称，再注意到 custom model 输入框时，极易产生误解。两个操作的目标不同（改名 vs 新增），但 UI 没有在概念上做出区分。

## 问题根因分析

### 根因 1："Use custom model ID" 同时承担「新增」和「选择」两个语义

**文件**：`src/renderer/components/settings/ProviderSelector.tsx` 第 252 行、第 268-270 行

```typescript
const finalModel = showCustomModel && customModelInput ? customModelInput : selectedModel;
```

当 `showCustomModel` 为 true 时，`finalModel` 取 `customModelInput` 的值。这个值随后被用作：
1. `source.model` -- 作为 Source 的当前选中模型
2. `availableModels` 去重判断的依据 -- 如果 `finalModel` 不在已有模型列表中，就 `unshift` 新记录

这意味着 `customModelInput` 既是「模型选择」又是「模型 ID 定义」，两个语义耦合在一起。

### 根因 2：铅笔编辑与 custom model 输入框各自独立，状态无联动

**文件**：`src/renderer/components/settings/ProviderSelector.tsx` 第 187-206 行 vs 第 76-77 行

铅笔编辑（`editingModelId` / `editingModelName`）只修改 `fetchedModels` 中对应模型的 `name` 字段，不影响 `customModelInput` 或 `showCustomModel`。Custom model 输入框（`showCustomModel` / `customModelInput`）也独立于铅笔编辑。两者没有联动机制，导致：

- 用户用铅笔改了 name，但 `selectedModel` 仍然是原始 id
- `handleSave` 中 `finalModel` 的计算完全不看铅笔编辑的结果，只看 `customModelInput` 和 `selectedModel`
- 如果用户在 custom model 输入框中输入了与铅笔编辑相同的新名称，会导致新增一条 id 等于新名称的重复记录

### 根因 3：unshift 逻辑无法区分「用户想新增」和「用户想改名」

**文件**：`src/renderer/components/settings/ProviderSelector.tsx` 第 268-270 行

```typescript
if (!availableModels.some((m) => m.id === finalModel)) {
  availableModels.unshift({ id: finalModel, name: finalModel });
}
```

这段代码的唯一判断依据是 `finalModel` 的值是否已存在于 `availableModels` 的 `id` 中。它无法区分以下两种用户意图：
- 用户确实想新增一个全新的模型 ID
- 用户想使用一个已有模型，只是手动输入了 ID 而非从下拉列表选择

## 技术方案

### 设计目标

将「新增模型」和「改名模型」两个操作在 UI 上彻底分离，让每个操作有独立的入口、清晰的文案和不同的视觉样式，消除用户的心智模型混淆。

### UX 方案

#### 改动 1：将 "Use custom model ID" 重构为 "Add custom model" 按钮

移除当前的 checkbox + 输入框组合，改为在模型下拉列表底部放置一个 "Add custom model" 按钮。点击后弹出内联输入框，用户输入模型 ID 后点击确认（Enter 或按钮），新模型被追加到 `fetchedModels` 中。

**交互流程**：
1. 模型下拉列表底部显示 "+ Add custom model" 按钮（与列表项有视觉分隔，如分割线 + 不同背景色）
2. 点击后，按钮位置变为输入框 + 确认/取消按钮
3. 用户输入模型 ID，按 Enter 或点击确认按钮
4. 新模型 `{id: 输入值, name: 输入值}` 被 `push` 到 `fetchedModels` 末尾，并自动选中新模型
5. 输入框恢复为按钮状态

**关键 UX 细节**：
- 输入框 placeholder 明确提示 "Enter new model ID"（区别于改名的 "Enter display name"）
- 新模型 `push` 到末尾而非 `unshift` 到头部，避免打乱已有排序
- 不再影响 `selectedModel` 的选择逻辑 -- custom model 输入不再是「选择模型」的方式，而是「新增模型」的方式

#### 改动 2：铅笔图标编辑仅修改 name，交互保持不变

铅笔图标的内联编辑功能（上一 PRD bugfix-model-name-stale-v1 新增）保持不变，继续只修改 `fetchedModels` 中已有模型的 `name` 字段。

#### 改动 3：移除 `showCustomModel` / `customModelInput` 状态，简化 `handleSave` 逻辑

移除以下状态：
- `showCustomModel` (boolean)
- `customModelInput` (string)

新增状态：
- `isAddingCustomModel` (boolean) -- 控制 "Add custom model" 输入框的显示/隐藏
- `newCustomModelId` (string) -- 新增模型的 ID 输入

**`handleSave` 简化**：

```typescript
const handleSave = async () => {
  if (!apiKey) { /* ... */ return; }

  if (!selectedModel) {
    setValidationResult({ valid: false, message: t('Please select a model') });
    return;
  }

  // 不再有 finalModel 的双路径逻辑
  // selectedModel 始终指向 fetchedModels 中已存在的模型 id

  let availableModels: ModelOption[] =
    fetchedModels.length > 0
      ? [...fetchedModels]
      : currentProvider?.models ? [...currentProvider.models] : [];

  // Deduplicate by id (防御性，保留已有逻辑)
  const seen = new Set<string>();
  availableModels = availableModels.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  // ... 构建 source 对象，model = selectedModel
};
```

#### 改动 4：新增模型的辅助函数

```typescript
const handleAddCustomModel = () => {
  const trimmed = newCustomModelId.trim();
  if (!trimmed) return;

  // 检查是否已存在（按 id 去重）
  if (fetchedModels.some((m) => m.id === trimmed)) {
    setValidationResult({ valid: false, message: t('Model ID already exists') });
    return;
  }

  // 追加到末尾
  setFetchedModels(prev => [...prev, { id: trimmed, name: trimmed }]);
  setSelectedModel(trimmed); // 自动选中新模型
  setNewCustomModelId('');
  setIsAddingCustomModel(false);
  setValidationResult(null);
};
```

### 状态管理变更

| 旧状态 | 新状态 | 说明 |
|--------|--------|------|
| `showCustomModel` (boolean) | 移除 | 不再需要 checkbox 切换 |
| `customModelInput` (string) | 移除 | 不再需要独立输入框 |
| -- | `isAddingCustomModel` (boolean) | 控制内联 "新增模型" 输入框 |
| -- | `newCustomModelId` (string) | 新增模型 ID 输入值 |

其余状态（`fetchedModels`、`selectedModel`、`editingModelId`、`editingModelName` 等）保持不变。

### UI 布局变更

**当前布局**（模型选择区域）：
```
[Model] .......................... [Fetch Models]
[x] Use custom model ID
[Enter model ID _______________]          ← checkbox + 输入框
```

**改后布局**：
```
[Model] .......................... [Fetch Models]
[Select model ▼]                           ← 只有模型下拉选择，不再有 checkbox
  ├─ GPT-4 Turbo            [✏️] [✕]
  ├─ GPT-4o                 [✏️] [✕]
  ├─ ...
  ├─ ─────────────────────────────
  └─ [+ Add custom model]              ← 底部按钮，视觉分隔
      [Enter new model ID __] [✓] [✕]   ← 点击后展开的内联输入
```

### handleTestConnection 同步修改

`handleTestConnection` 中第 315 行也有 `finalModel` 的计算：

```typescript
const finalModel = showCustomModel && customModelInput ? customModelInput : selectedModel;
```

移除 `showCustomModel` 和 `customModelInput` 后，直接使用 `selectedModel`：

```typescript
// 直接使用 selectedModel，无需 finalModel 双路径
const testModel = selectedModel;
```

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 相关 PRD | `.project/prd/bugfix/ai-sources/bugfix-model-name-stale-v1.md` | 了解铅笔内联编辑功能的实现（本 PRD 保持该功能不变） |
| 相关 PRD | `.project/prd/bugfix/ai-sources/bugfix-model-name-sync-v1.md` | 了解远程空间模型名称同步修复（确认不影响本次改动） |
| 模块设计 | `.project/modules/ai-sources/features/source-provider/design.md` | 理解提供商适配器设计 |
| 变更记录 | `.project/modules/ai-sources/features/source-provider/changelog.md` | 了解最近变更，避免回归 |
| Bug 记录 | `.project/modules/ai-sources/features/source-provider/bugfix.md` | 了解已知问题 |
| 源码 | `src/shared/types/ai-sources.ts`（第 103-107 行） | 理解 `ModelOption` 接口定义（id/name/description） |
| 源码 | `src/renderer/components/settings/ProviderSelector.tsx` | **核心修改文件**：handleSave（第 246-306 行）、handleTestConnection（第 309-347 行）、custom model UI（第 568-590 行）、模型下拉列表（第 606-710 行）、状态定义（第 66-97 行） |
| 源码 | `src/renderer/hooks/useAISources.ts`（第 69-99 行） | 理解 saveSource 流程（确认 handleSave 返回的 source 结构正确） |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、React 组件规范、UI 文本必须用 t() |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/renderer/components/settings/ProviderSelector.tsx` | 修改 | **核心改动**：移除 `showCustomModel` / `customModelInput`；新增 `isAddingCustomModel` / `newCustomModelId`；模型下拉列表底部添加 "+ Add custom model" 内联输入；简化 `handleSave` 和 `handleTestConnection` 中的 finalModel 逻辑 |

## 验收标准

- [x] **新增模型**：模型下拉列表底部显示 "+ Add custom model" 按钮，点击后展开内联输入框，输入模型 ID 后按 Enter 或点击确认按钮，新模型 `{id: 输入值, name: 输入值}` 被追加到模型列表末尾
- [x] **新增模型**：新增模型后自动选中新模型（`selectedModel` 更新为新模型 id）
- [x] **新增模型去重**：输入已存在的模型 ID 时，显示错误提示 "Model ID already exists"，不重复添加
- [x] **新增模型取消**：按 Escape 或点击取消按钮可关闭内联输入框，不添加模型
- [x] **改名模型**：铅笔图标编辑功能不受影响，仍然只能修改已有模型的 `name` 字段
- [x] **改名 vs 新增分离**：不再有 "Use custom model ID" checkbox 和独立输入框，两个操作通过不同 UI 入口触发
- [x] **保存逻辑**：`handleSave` 中 `source.model` 始终等于 `selectedModel`（不再有 `customModelInput` 双路径），`availableModels` 直接取 `fetchedModels`（已有的去重逻辑保留作为防御）
- [x] **测试连接**：`handleTestConnection` 使用 `selectedModel` 而非 `customModelInput`，行为正确
- [x] **编辑模式**：编辑已有 Source 时，"Use custom model ID" checkbox 不再出现，用户通过下拉列表选择模型或通过底部按钮新增模型
- [x] **新增 Source**：新增 Source 时，行为与编辑模式一致
- [x] **回归测试**：原有的 Fetch Models 功能正常
- [x] **回归测试**：原有的删除模型功能正常（X 按钮）
- [x] **回归测试**：铅笔编辑功能正常（改名已有模型）
- [x] **回归测试**：编辑模式下切换 provider 时，模型列表正确初始化，`isAddingCustomModel` 被重置
- [x] `npm run typecheck` 通过（ProviderSelector.tsx 无新增错误）
- [x] `npm run build` 通过
- [x] `npm run i18n` 通过（0 个新 key 需翻译）

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-11 | 初始 Bug 修复 PRD | @moonseeker |
