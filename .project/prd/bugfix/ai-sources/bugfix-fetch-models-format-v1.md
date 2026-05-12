# PRD [Bug 修复级] — 智谱 AI 等 Anthropic 兼容端点获取模型列表失败

> 版本：bugfix-fetch-models-format-v1
> 日期：2026-05-11
> 状态：in-progress
> 指令人：@mi-saka
> 归属模块：modules/ai-sources
> 严重程度：Major
> 所属功能：features/source-provider

## 问题描述

- **期望行为**：用户配置智谱 AI（open.bigmodel.cn）的 Anthropic 兼容端点后，点击"获取模型"能正常返回可用模型列表
- **实际行为**：控制台报错 `Invalid API response format`，获取模型失败
- **影响范围**：所有使用非标准响应格式的 Anthropic 兼容端点（智谱 AI 及其他类似提供商）

### 控制台日志

```
[API Validator] Fetching models from: https://open.bigmodel.cn/api/anthropic/models
[Settings] config:fetch-models - Failed: Invalid API response format
```

### 附加问题

控制台同时输出 i18n 缺失 key 警告：

```
i18next::translator: missingKey zh-CN translation Add Model Add Model
```

`ProviderSelector.tsx` 第 569 行使用了 `t('Add Model')`，但该 key 在所有 7 个语言文件中均未定义。

## 根因分析

### Bug 1：模型列表响应格式兼容不足

**文件**：`src/main/services/ai-sources/api-validator.service.ts` 第 80-98 行

`fetchModelsFromApi()` 函数当前支持 3 种响应格式：

| 格式 | 结构 | 适用提供商 |
|------|------|-----------|
| Format 1 | `{ data: [...] }` | OpenAI 标准格式 |
| Format 2 | `{ models: [...] }` | Ollama 等 |
| Format 3 | `[...]` | 直接数组 |

智谱 AI 的 Anthropic 兼容端点 `https://open.bigmodel.cn/api/anthropic/models` 返回的响应结构不匹配以上任何一种格式（可能包含 `object: "list"` 或其他顶层字段，但 `data` 字段不是数组或不存在），导致所有格式匹配都失败，最终抛出 `Invalid API response format`。

同时，错误路径中没有任何调试信息，仅抛出通用错误消息，无法从日志中判断实际响应结构，增加了排查难度。

### Bug 2：i18n key "Add Model" 缺失

**文件**：`src/renderer/components/settings/ProviderSelector.tsx` 第 569 行

```tsx
{t('Add Model')}
```

该 key 由 `bugfix-add-model-button-visibility-v1` PRD 引入时添加到代码中，但未同步补充到 i18n 翻译文件。当前 7 个语言文件（zh-CN、zh-TW、en、ja、es、fr、de）中均无此 key，导致运行时 `i18next` 输出 missingKey 警告，UI 回退显示英文原文 `"Add Model"`。

## 技术方案

### 修复 1：增强响应格式兼容性

在 `fetchModelsFromApi()` 的格式匹配逻辑中增加更宽松的解析策略：

#### 1.1 Format 1 增强：`data` 为嵌套对象时尝试深层提取

当 `data.data` 存在且为数组时，从嵌套结构中提取模型列表（兼容分页包装对象）：

```typescript
// Format 1: OpenAI standard { data: [...] }
if (data.data && Array.isArray(data.data)) {
  models = data.data
    .filter((m: any) => typeof m.id === 'string')
    .map((m: any) => ({ id: m.id, name: m.name || m.owned_by || m.id }));
}
// Format 1b: { data: { data: [...] } } (nested/paginated)
else if (data.data && typeof data.data === 'object' && !Array.isArray(data.data) && Array.isArray(data.data.data)) {
  models = data.data.data
    .filter((m: any) => typeof m.id === 'string')
    .map((m: any) => ({ id: m.id, name: m.name || m.owned_by || m.id }));
}
```

#### 1.2 新增 Format 4：遍历响应中所有数组字段

当所有已知格式都匹配失败时，遍历响应对象的所有顶层值，找到第一个包含 `{id: string}` 对象的数组：

```typescript
// Format 4: Fallback — scan all array fields for {id: string} objects
else if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
  for (const key of Object.keys(data)) {
    const value = (data as any)[key];
    if (Array.isArray(value) && value.length > 0 && typeof value[0].id === 'string') {
      models = value
        .filter((m: any) => typeof m.id === 'string')
        .map((m: any) => ({ id: m.id, name: m.name || m.owned_by || m.id }));
      break;
    }
  }
}
```

#### 1.3 改进模型 name 提取优先级

在 Format 1 和 Format 3 中，将 name 提取优先级从 `m.owned_by || m.id` 调整为 `m.name || m.owned_by || m.id`，优先使用提供商返回的模型名称：

```typescript
// 改前
.map((m: any) => ({ id: m.id, name: m.owned_by || m.id }));

// 改后
.map((m: any) => ({ id: m.id, name: m.name || m.owned_by || m.id }));
```

### 修复 2：格式匹配失败时记录原始响应

在 `throw new Error('Invalid API response format')` 之前，记录原始响应体的前 200 字符到控制台日志，便于排查未知格式：

```typescript
if (!models) {
  const preview = JSON.stringify(data).substring(0, 200);
  console.warn('[API Validator] Unrecognized model response format:', preview);
  throw new Error('Invalid API response format');
}
```

### 修复 3：补充 i18n key "Add Model"

在所有 7 个语言文件中添加 `"Add Model"` key 的翻译：

| 语言文件 | key | 翻译 |
|---------|-----|------|
| `zh-CN.json` | `Add Model` | `添加模型` |
| `zh-TW.json` | `Add Model` | `新增模型` |
| `en.json` | `Add Model` | `Add Model` |
| `ja.json` | `Add Model` | `モデルを追加` |
| `es.json` | `Add Model` | `Agregar modelo` |
| `fr.json` | `Add Model` | `Ajouter un modèle` |
| `de.json` | `Add Model` | `Modell hinzufügen` |

添加后运行 `npm run i18n` 验证无新增 missingKey。

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 相关 PRD | `.project/prd/bugfix/ai-sources/bugfix-model-fetch-and-validate-v1.md` | 了解上一次 fetchModelsFromApi 的多格式修复（当前 3 种格式的来源） |
| 相关 PRD | `.project/prd/bugfix/ai-sources/bugfix-add-model-button-visibility-v1.md` | 了解 `t('Add Model')` 引入的上下文 |
| 模块设计 | `.project/modules/ai-sources/ai-sources-v1.md` | 理解 AI 源管理模块的整体架构 |
| 模块设计 | `.project/modules/ai-sources/features/source-provider/design.md` | 理解提供商接口和适配器设计 |
| 变更记录 | `.project/modules/ai-sources/features/source-provider/changelog.md` | 了解最近变更，避免回归 |
| Bug 记录 | `.project/modules/ai-sources/features/source-provider/bugfix.md` | 了解已知问题 |
| 源码 | `src/main/services/ai-sources/api-validator.service.ts`（第 47-113 行） | **核心修改文件**：fetchModelsFromApi 函数的格式匹配逻辑 |
| 源码 | `src/main/ipc/config.ts`（第 77-91 行） | 理解 IPC 层 config:fetch-models 的调用方式 |
| 源码 | `src/renderer/components/settings/ProviderSelector.tsx`（第 569 行） | 确认 `t('Add Model')` 的使用位置 |
| 源码 | `src/renderer/i18n/locales/*.json` | 7 个语言文件，需补充翻译 key |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、IPC 模式、i18n 规范 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/ai-sources/api-validator.service.ts` | 修改 | 增强 fetchModelsFromApi 格式匹配（Format 1b、Format 4）；改进 name 提取优先级；添加调试日志 |
| `src/renderer/i18n/locales/zh-CN.json` | 修改 | 添加 `"Add Model": "添加模型"` |
| `src/renderer/i18n/locales/zh-TW.json` | 修改 | 添加 `"Add Model": "新增模型"` |
| `src/renderer/i18n/locales/en.json` | 修改 | 添加 `"Add Model": "Add Model"` |
| `src/renderer/i18n/locales/ja.json` | 修改 | 添加 `"Add Model": "モデルを追加"` |
| `src/renderer/i18n/locales/es.json` | 修改 | 添加 `"Add Model": "Agregar modelo"` |
| `src/renderer/i18n/locales/fr.json` | 修改 | 添加 `"Add Model": "Ajouter un modèle"` |
| `src/renderer/i18n/locales/de.json` | 修改 | 添加 `"Add Model": "Modell hinzufügen"` |

## 验收标准

- [x] **智谱 AI 获取模型成功**：配置智谱 AI Anthropic 兼容端点（`https://open.bigmodel.cn/api/anthropic`）后，点击"获取模型"能正常返回模型列表
- [x] **Format 1b 嵌套提取**：对返回 `{ data: { data: [...] } }` 格式的端点，能正确提取模型列表
- [x] **Format 4 回退提取**：对返回未知格式但包含数组字段的端点，能通过遍历找到模型数组
- [x] **name 提取改进**：模型显示名称优先使用 `m.name`，其次 `m.owned_by`，最后 `m.id`
- [x] **调试日志**：格式匹配失败时，控制台输出原始响应前 200 字符的预览
- [x] **i18n 补全**：7 个语言文件均包含 "Add Model" key 的正确翻译
- [x] **i18n 无警告**：运行时不再输出 `missingKey zh-CN translation Add Model` 警告
- [x] **回归测试 — OpenAI 标准**：原有 `{ data: [...] }` 格式获取模型仍正常工作
- [x] **回归测试 — Ollama**：原有 `{ models: [...] }` 格式获取模型仍正常工作
- [x] **回归测试 — 直接数组**：原有 `[...]` 格式获取模型仍正常工作
- [x] `npm run typecheck` 通过（api-validator.service.ts 无新增错误）
- [x] `npm run build` 通过
- [x] `npm run i18n` 通过

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-11 | 初始 Bug 修复 PRD | @mi-saka |
