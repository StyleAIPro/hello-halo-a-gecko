# 远程空间模型选择机制

本文档描述远程空间中模型服务的配置、切换机制，以及与本地空间模型选择的差异。

---

## 一、整体架构

```
本地 AICO-Bot 客户端                           远程服务器
======================                         ==========
AI Sources 配置 (config.json)                   Remote Agent Proxy
┌──────────────────────┐                        ┌─────────────────┐
│ Source A (智谱)       │  per-request          │ ClaudeManager    │
│   apiUrl: zhipu.cn    │ ──────────────────►   │  sessions Map   │
│   apiKey: ***         │  apiKey + baseUrl     │  ┌───────────┐  │
│   availableModels:    │  + model              │  │ Session A │  │
│     - glm-5-turbo     │                       │  │ (SDK进程)  │  │
│     - glm-5.1         │                       │  └───────────┘  │
│     - glm-5.1-plus    │                       └─────────────────┘
│   model: glm-5-turbo  │
├──────────────────────┤
│ Source B (阿里 DashScope)│
│   apiUrl: dashscope.cn│
│   apiKey: ***         │
│   availableModels:    │
│     - qwen3.6-plus    │
│     - qwen3.6-max     │
│   model: qwen3.6-plus │
└──────────────────────┘

远程服务器卡片 (per-server config)
┌──────────────────────────────┐
│ aiSourceId: source-a         │  ← 绑定到 Source A
│ claudeApiKey: ***            │  ← Source A 的 API Key 快照
│ claudeBaseUrl: zhipu.cn      │  ← Source A 的 API URL 快照
│ claudeModel: glm-5.1         │  ← 用户选择的模型 (覆盖 source 默认)
└──────────────────────────────┘
```

**核心设计**: 模型服务的 URL、API Key、Model 全部在本地 AICO-Bot 客户端管理，每次发送消息时 per-request 传给远程 proxy。远程 proxy 不存储任何凭证。

---

## 二、凭证解析优先级

`send-message.ts` 中的解析逻辑 (line 828-837):

```typescript
// 1. 通过 aiSourceId 找到绑定的 AI 源
const sourceId = server.aiSourceId || config.aiSources?.currentId
const currentSource = sourceId
  ? config.aiSources?.sources?.find(s => s.id === sourceId)
  : undefined

// 2. 逐字段解析: 服务器卡片 > AI 源配置 > 全局配置 > 默认值
const apiKey = server.claudeApiKey || currentSource?.apiKey || config.api?.apiKey
const baseUrl = server.claudeBaseUrl || currentSource?.apiUrl
const model = server.claudeModel || currentSource?.model || 'claude-sonnet-4-6'
```

| 字段 | 优先级 1 | 优先级 2 | 优先级 3 | 优先级 4 |
|------|---------|---------|---------|---------|
| API Key | `server.claudeApiKey` | `currentSource.apiKey` | `config.api.apiKey` | — |
| Base URL | `server.claudeBaseUrl` | `currentSource.apiUrl` | — | — |
| Model | `server.claudeModel` | `currentSource.model` | `config.api.model` | `claude-sonnet-4-6` |

**重要**: `server.aiSourceId` 决定了 `currentSource`，进而决定 fallback 的 URL 和 API Key。切换 AI 源时，`aiSourceId`、`claudeApiKey`、`claudeBaseUrl` 三个字段必须同时更新。

---

## 三、两个模型选择入口

### 3.1 远程服务器管理 (RemoteServersSection)

**位置**: 设置页 → 远程服务器管理 → 添加/编辑对话框

**功能**: 配置服务器绑定的 AI 源和模型。这是初始配置入口。

**UI 结构**:
```
AI Provider 下拉框 (选择 AI 源)
  ├── 智谱 (Source A)
  └── 阿里 DashScope (Source B)

  选择模型 (5) 手风琴          ← 选择源后自动展开
    ├── glm-5-turbo
    ├── glm-5.1          ✓    ← CheckCircle 高亮
    └── glm-5.1-plus
```

**数据流**:
```
用户选择 AI 源 → formData.aiSourceId
                 → formData.claudeApiKey = source.apiKey
                 → formData.claudeBaseUrl = source.apiUrl
                 → formData.claudeModel = source.model (默认)

用户选择具体模型 → formData.claudeModel = 选中的模型 ID

保存 → api.updateRemoteServer() → remote-deploy.service.ts
     → 服务器卡片持久化到 config.json
```

**关键代码**:
- `src/renderer/components/settings/RemoteServersSection.tsx`
  - `loadAiSources()` (line 168): 加载 AI 源列表，包含 `availableModels`
  - `getModelsForSource()` (line 78): 获取源下所有可用模型
  - `handleAddServer()` (line 338): 保存时同时写入 `aiSourceId` + 凭证快照 + 模型

### 3.2 远程空间对话框 (RemoteModelSelector)

**位置**: 远程空间页面顶部 Header 的模型名称按钮

**功能**: 快速切换当前远程空间使用的模型或 AI 源。这是运行时切换入口。

**UI 结构**: 与本地空间 `ModelSelector` 相同的手风琴式下拉菜单
```
┌─────────────────────────┐
│ ▼ 智谱 (当前绑定)  ●    │  ← ● = 当前活跃源
│   glm-5-turbo           │
│ ✓ glm-5.1               │  ← CheckCircle = 当前选中模型
│   glm-5.1-plus          │
│ ─────────────────────── │
│ ▶ 阿里 DashScope    ○   │  ← ○ = 点击可切换到该源
└─────────────────────────┘
```

**数据流**:
```
点击模型 (同源) → handleSelectModel(sourceId, modelId)
                → api.remoteServerUpdateModel(serverId, modelId)
                → remote-deploy.service.ts: updateServerModel()
                → 仅更新 server.claudeModel
                → 重新加载 remoteServers 状态

点击模型 (跨源) → handleSelectModel(sourceId, modelId)
                → api.remoteServerUpdateAiSource(serverId, sourceId)  ← 先切换源
                → 更新 aiSourceId + claudeApiKey + claudeBaseUrl + claudeModel
                → api.remoteServerUpdateModel(serverId, modelId)      ← 再设置模型
                → 仅更新 server.claudeModel
                → 重新加载 remoteServers 状态
```

**关键代码**:
- `src/renderer/components/layout/RemoteModelSelector.tsx`
  - `handleSelectModel(sourceId, modelId)` (line 144): 先切换源再设置模型
  - `handleSelectSource(sourceId)` (line 128): 切换 AI 源 (更新凭证快照)
  - `currentModelName` (line 49): 优先显示 `server.claudeModel` 而非 `source.model`

---

## 四、后端 IPC 链路

### 4.1 更新 AI 源

```
Renderer                          Main Process                      remote-deploy.service.ts
────────                          ────────────                      ──────────────────────
api.remoteServerUpdateAiSource()  →  IPC: remote-server:update-ai-source
                                                                      ↓
                                                                   updateServerAiSource()
                                                                      ↓
                                                                   从 config.aiSources 读取源凭证
                                                                      ↓
                                                                   updateServer({
                                                                     aiSourceId,
                                                                     claudeApiKey,    ← 源的 API Key
                                                                     claudeBaseUrl,    ← 源的 API URL
                                                                     claudeModel,      ← 源的默认模型
                                                                   })
                                                                      ↓
                                                                   saveServers() → config.json
```

### 4.2 更新模型

```
Renderer                          Main Process                      remote-deploy.service.ts
────────                          ────────────                      ──────────────────────
api.remoteServerUpdateModel()     →  IPC: remote-server:update-model
                                                                      ↓
                                                                   updateServerModel()
                                                                      ↓
                                                                   校验 server.aiSourceId 存在
                                                                      ↓
                                                                   updateServer({ claudeModel })
                                                                      ↓
                                                                   saveServers() → config.json
```

### 4.3 发送消息时凭证解析

```
send-message.ts (line 828-837)
  ↓
server = deployService.getServer(serverId)   ← 从内存读取最新服务器卡片
  ↓
sourceId = server.aiSourceId                 ← 通过 aiSourceId 找到 AI 源
currentSource = config.aiSources.sources.find(...)
  ↓
apiKey = server.claudeApiKey || currentSource.apiKey   ← 逐字段优先级解析
baseUrl = server.claudeBaseUrl || currentSource.apiUrl
model = server.claudeModel || currentSource.model
  ↓
通过 WebSocket per-request 传给远程 proxy:
  { type: 'claude:chat', payload: { apiKey, baseUrl, model, messages, ... } }
```

---

## 五、与本地空间模型选择的差异

| 维度 | 本地空间 (ModelSelector) | 远程空间 (RemoteModelSelector) |
|------|------------------------|------------------------------|
| 配置存储 | `config.aiSources.currentId` + `source.model` | `server.aiSourceId` + `server.claudeModel` |
| 切换源 | `api.aiSourcesSwitchSource(sourceId)` | `api.remoteServerUpdateAiSource(serverId, sourceId)` |
| 切换模型 | `api.aiSourcesSetModel(modelId)` | `api.remoteServerUpdateModel(serverId, modelId)` |
| 凭证传递 | 本地 SDK 直接使用 | per-request 传给远程 proxy |
| 显示名称 | `source.model` (因为就是当前源) | `server.claudeModel` (可能覆盖源默认) |
| 影响范围 | 全局所有本地空间 | 仅当前远程服务器卡片 |

---

## 六、历史问题与修复记录

### 6.1 require() 在 ESM 环境崩溃

**问题**: `getModelsForSource()` 中使用 `require('../../types')` 获取 `AVAILABLE_MODELS`，在 Vite/ESM 环境下报 `require is not defined`。

**修复**: 改为顶部 ES `import { AVAILABLE_MODELS } from '../../types'`，后续进一步移除了 Anthropic 默认模型的 fallback 逻辑。

### 6.2 DashScope 模型名称替换

**问题**: `claude-manager.ts` 检测到 `/anthropic` URL 且模型名非 Claude 时，自动替换为 `claude-sonnet-4-6`。这对智谱 (内部映射) 有效，但 DashScope 要求使用自己的模型名。

**修复**: 移除 `claude-manager.ts` 中的模型替换逻辑 (line 864-872)，让模型名透传。

### 6.3 模型显示名为 "claude"

**问题**: `claude-manager.ts` 中显示模型名使用 `this.model || 'claude'`，但 `this.model` 在移除全局凭证后变为 `undefined`。

**修复**: 改为 `options.model || this.model || 'claude'`，优先使用 per-request 传入的模型名。

### 6.4 远程服务器管理只显示单一模型

**问题**: `RemoteServersSection` 的 `<select>` 只展示 `source.model`（源的默认模型），不展示 `source.availableModels`（所有可用模型）。

**修复**: 改为手风琴式 UI，先选 AI 源，再展开展示所有可用模型。

### 6.5 RemoteModelSelector 切换不生效

**问题**:
1. `handleSelectModel(modelId)` 只更新模型名，不切换 AI 源 → URL 和 API Key 不变
2. `currentModelName` 优先用 `serverSource.model` 而非 `server.claudeModel` → 显示不更新
3. `isSelected` 高亮判断不准确

**修复**:
1. `handleSelectModel(sourceId, modelId)` 增加源 ID 参数，跨源时先调 `remoteServerUpdateAiSource`
2. `currentModelName` 改为 `server?.claudeModel || serverSource?.model`
3. `isSelected` 直接比较 `server?.claudeModel === modelId`

### 6.6 AI 源列表不刷新

**问题**: 在设置页添加新的 AI 源后，返回远程服务器管理页面，下拉框不显示新源。

**修复**: 打开添加/编辑对话框时调用 `loadAiSources()` 刷新。

---

## 七、关键代码位置索引

| 文件 | 关键位置 | 说明 |
|------|---------|------|
| `src/renderer/components/layout/RemoteModelSelector.tsx` | 全文 | 远程空间模型选择器组件 |
| `src/renderer/components/layout/ModelSelector.tsx` | 全文 | 本地空间模型选择器 (参考) |
| `src/renderer/components/settings/RemoteServersSection.tsx` | line 168 `loadAiSources()` | 加载 AI 源列表 |
| `src/renderer/components/settings/RemoteServersSection.tsx` | line 78 `getModelsForSource()` | 获取源下可用模型 |
| `src/renderer/components/settings/RemoteServersSection.tsx` | line 338 `handleAddServer()` | 添加服务器 (含模型配置) |
| `src/main/services/remote-deploy/remote-deploy.service.ts` | line 405 `updateServerAiSource()` | 更新服务器 AI 源 |
| `src/main/services/remote-deploy/remote-deploy.service.ts` | line 445 `updateServerModel()` | 更新服务器模型 |
| `src/main/services/agent/send-message.ts` | line 828-837 | 凭证解析 (3 级优先级) |
| `src/main/ipc/remote-server.ts` | line 139 `remote-server:update-ai-source` | IPC: 更新 AI 源 |
| `src/main/ipc/remote-server.ts` | line 146 `remote-server:update-model` | IPC: 更新模型 |
| `src/preload/index.ts` | remoteServer 段 | Preload 暴露 API |
| `src/renderer/api/index.ts` | `remoteServerUpdateAiSource()` | Renderer API |
| `src/renderer/api/index.ts` | `remoteServerUpdateModel()` | Renderer API |

---

*文档生成时间: 2026-04-14*
