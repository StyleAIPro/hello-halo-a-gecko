# PRD [Bug 修复级] — "Add custom model" 入口不显眼，用户难以发现

> 版本：bugfix-add-model-button-visibility-v1
> 日期：2026-05-11
> 状态：in-progress
> 指令人：@mi-saka
> 归属模块：modules/ai-sources
> 严重程度：Minor
> 所属功能：features/source-provider

## 问题描述

- **期望行为**：用户无需打开模型下拉列表即可看到新增自定义模型的入口，该入口在表单中醒目可见
- **实际行为**："+ Add custom model" 按钮位于模型下拉列表内部的底部，用户必须先展开下拉列表、滚动到底部才能看到

### 当前 UI 布局

```
[Model] .......................... [Fetch Models]
[Select model ▼]
  ├─ 模型列表 ...
  ├─ ...
  └─ [+ Add custom model]              ← 隐藏在下拉列表底部，不显眼
```

用户反馈：新增自定义模型是一个常用操作，当前放置位置太隐蔽，容易被忽略。

## 问题根因分析

"+ Add custom model" 入口被放在下拉列表（`showModelDropdown`）的底部区域（第 693-738 行），仅在下拉列表展开时可见。作为与 "Fetch Models" 同级别的常用操作，其可见性不足。

## 技术方案

### 设计目标

将 "+ Add custom model" 从下拉列表内部提升到模型选择区域的标题栏，与 "Fetch Models" 按钮并排显示，使其在表单中始终可见。

### UX 方案

#### 改动 1：将 "+ Add Model" 按钮移至模型标题栏

**当前标题栏**（第 559-575 行）：
```
[Model] .......................... [Fetch Models]
```

**改后标题栏**：
```
[Model] ...................... [Fetch Models] [+ Add Model]
```

"Fetch Models" 和 "+ Add Model" 并排放在标题栏右侧。两个按钮样式一致（`text-primary hover:text-primary/80`），但通过间距分隔（`gap-2`），语义清晰。

#### 改动 2：点击 "+ Add Model" 后在下拉选择器下方展开内联输入区域

点击 "+ Add Model" 后，在模型下拉选择器（`<button>` 选择器）的下方展示一个内联输入区域，而非在下拉列表内部展开。

**展开状态**：
```
[Model] ...................... [Fetch Models] [+ Add Model]
[Select model ▼]
[Enter new model ID ____________] [✓] [✕]   ← 内联输入区域，在选择器下方
```

内联输入区域样式：
- 使用与下拉列表中现有输入框一致的样式（`bg-input border border-border rounded-lg`）
- 确认按钮（Check 图标）使用 `text-primary`
- 取消按钮（X 图标）使用 `text-muted-foreground`
- 输入区域关闭时下拉选择器下方的间距恢复正常

#### 改动 3：移除下拉列表底部的旧 "Add custom model" 区域

移除第 693-738 行的下拉列表底部区域（`{/* Add custom model */}`）。该区域的功能已完全迁移到标题栏按钮 + 内联输入区域。

#### 改动 4：状态管理调整

现有状态无需变更：
- `isAddingCustomModel` (boolean) -- 继续使用，控制内联输入区域的显示/隐藏
- `newCustomModelId` (string) -- 继续使用，存储用户输入的模型 ID

`handleAddCustomModel` 函数（第 209-223 行）逻辑保持不变。仅需调整 UI 中取消操作的重置逻辑，确保关闭输入区域时同步重置 `newCustomModelId`。

### UI 布局变更

**改后完整布局**（模型选择区域）：

```
[Model] .......................... [Fetch Models] [+ Add Model]
[Select model ▼]                                        ← 模型下拉选择器
  ├─ GPT-4 Turbo            [✏️] [✕]                   ← 下拉列表（仅模型列表）
  ├─ GPT-4o                 [✏️] [✕]
  └─ ...
[Enter new model ID ____________] [✓] [✕]               ← 点击 "+ Add Model" 后展开
```

### 代码改动详解

#### 区域 1：标题栏（第 559-575 行）

将现有的单个 "Fetch Models" 按钮包裹在一个 `flex items-center gap-2` 容器中，并在其后添加 "+ Add Model" 按钮。

**改前**：
```tsx
<div className="flex items-center justify-between mb-1">
  <label className="block text-sm font-medium text-muted-foreground">
    {t('Model')}
  </label>
  <button onClick={handleFetchModels} ...>
    ...
    {t('Fetch Models')}
  </button>
</div>
```

**改后**：
```tsx
<div className="flex items-center justify-between mb-1">
  <label className="block text-sm font-medium text-muted-foreground">
    {t('Model')}
  </label>
  <div className="flex items-center gap-2">
    <button onClick={handleFetchModels} ...>
      ...
      {t('Fetch Models')}
    </button>
    <button
      onClick={() => {
        setIsAddingCustomModel(prev => !prev);
        if (isAddingCustomModel) setNewCustomModelId('');
      }}
      disabled={!apiKey}
      className="flex items-center gap-1 text-sm text-primary hover:text-primary/80 disabled:opacity-50"
    >
      <Plus size={14} />
      {t('Add Model')}
    </button>
  </div>
</div>
```

#### 区域 2：下拉列表底部移除（第 693-738 行）

删除 `{/* Add custom model */}` 整个 `<div className="border-t border-border">` 区块。

#### 区域 3：新增内联输入区域（在模型下拉选择器 `</div>` 之后）

在模型下拉选择器闭合 `</div>` 之后、Context Window 区域之前，添加内联输入区域：

```tsx
{/* Inline add custom model input */}
{isAddingCustomModel && (
  <div className="flex items-center gap-1.5 mt-1.5">
    <input
      type="text"
      value={newCustomModelId}
      onChange={(e) => setNewCustomModelId(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') handleAddCustomModel();
        if (e.key === 'Escape') {
          setIsAddingCustomModel(false);
          setNewCustomModelId('');
        }
      }}
      placeholder={t('Enter new model ID')}
      className="flex-1 px-2 py-1 text-sm bg-input border border-border rounded-lg
               text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
      autoFocus
    />
    <button
      onClick={handleAddCustomModel}
      className="p-1 text-primary hover:bg-primary/10 rounded transition-colors shrink-0"
      title={t('Confirm')}
    >
      <Check size={14} />
    </button>
    <button
      onClick={() => {
        setIsAddingCustomModel(false);
        setNewCustomModelId('');
      }}
      className="p-1 text-muted-foreground hover:bg-secondary rounded transition-colors shrink-0"
      title={t('Cancel')}
    >
      <X size={14} />
    </button>
  </div>
)}
```

### 注意事项

1. **`isAddingCustomModel` 与 `showModelDropdown` 独立**：展开内联输入区域时不要求下拉列表同时展开，两者互不影响
2. **`apiKey` 校验**："+ Add Model" 按钮在没有 API Key 时禁用（`disabled:opacity-50`），与 "Fetch Models" 行为一致。但注意：自定义模型不依赖 API Key，实际可考虑不禁用 -- 此处先保持一致，后续可根据反馈调整
3. **点击空白区域关闭**：现有的 `handleClickOutside` 事件监听器（第 120-133 行）仅处理 `showProviderDropdown`，不影响新的内联输入区域。如需点击空白区域关闭内联输入，可在后续版本添加

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 相关 PRD | `.project/prd/bugfix/ai-sources/bugfix-model-add-rename-ux-v1.md` | 了解 "+ Add custom model" 功能的现有实现（本 PRD 在其基础上迁移入口位置） |
| 模块设计 | `.project/modules/ai-sources/features/source-provider/design.md` | 理解提供商适配器设计 |
| 变更记录 | `.project/modules/ai-sources/features/source-provider/changelog.md` | 了解最近变更，确认当前代码状态 |
| Bug 记录 | `.project/modules/ai-sources/features/source-provider/bugfix.md` | 了解已知问题，避免回归 |
| 源码 | `src/renderer/components/settings/ProviderSelector.tsx` | **核心修改文件**：标题栏（第 559-575 行）、下拉列表底部（第 693-738 行）、状态定义（第 77-78 行）、`handleAddCustomModel`（第 209-223 行） |
| 源码 | `src/shared/types/ai-sources.ts`（第 103-107 行） | 理解 `ModelOption` 接口定义 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、React 组件规范、UI 文本必须用 `t()` |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/renderer/components/settings/ProviderSelector.tsx` | 修改 | **核心改动**：标题栏添加 "+ Add Model" 按钮（第 559-575 行）；移除下拉列表底部旧入口（第 693-738 行）；新增内联输入区域（模型选择器下方） |

## 验收标准

- [ ] **按钮可见性**："+ Add Model" 按钮在模型标题栏右侧始终可见，与 "Fetch Models" 并排显示
- [ ] **点击展开**：点击 "+ Add Model" 后，模型选择器下方出现内联输入区域（输入框 + 确认 + 取消按钮）
- [ ] **新增模型**：输入模型 ID 后按 Enter 或点击确认按钮，新模型被追加到列表末尾且自动选中
- [ ] **新增模型去重**：输入已存在的模型 ID 时，显示错误提示
- [ ] **取消操作**：按 Escape 或点击取消按钮可关闭内联输入区域
- [ ] **再次点击收起**：再次点击 "+ Add Model" 按钮可收起内联输入区域
- [ ] **旧入口移除**：下拉列表底部不再显示 "+ Add custom model" 区域
- [ ] **下拉列表独立**：内联输入区域的展开/收起不影响下拉列表的展开/收起
- [ ] **铅笔编辑正常**：模型列表中的铅笔编辑（改名）功能不受影响
- [ ] **删除模型正常**：模型列表中的删除（X）功能不受影响
- [ ] **Fetch Models 正常**：获取模型功能不受影响
- [ ] **编辑模式兼容**：编辑已有 Source 时，新增模型入口正常工作
- [ ] **新增 Source 兼容**：新增 Source 时，新增模型入口正常工作
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] `npm run i18n` 通过（检查是否有新 key 需翻译）

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-11 | 初始 Bug 修复 PRD | @mi-saka |
