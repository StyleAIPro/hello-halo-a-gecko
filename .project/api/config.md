# API -- Configuration

> 最后同步：2026-04-16
> 指令人：@moonseeker1
> **本文档必须与代码保持一致，任何接口变更必须立即更新**

## 认证

- IPC 模式：无需认证
- HTTP 模式：Bearer Token

---

## config:get / GET /api/config

**说明**：获取当前应用配置。自动解密敏感字段（API Key、Token）。

请求参数：无

响应：
```json
{
  "success": true,
  "data": {
    "api": { "apiKey": "decrypted-key", "apiUrl": "...", "model": "..." },
    "aiSources": {
      "version": 2,
      "currentId": "source-1",
      "sources": [
        {
          "id": "source-1",
          "name": "My Source",
          "provider": "anthropic",
          "apiKey": "decrypted-key",
          "apiUrl": "...",
          "model": "..."
        }
      ]
    }
  }
}
```

---

## config:set / POST /api/config

**说明**：更新应用配置。v2 格式下 `aiSources` 整体替换，不做深度合并。变更 AI Sources 时自动运行配置探针验证。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| updates | `Record<string, unknown>` | 是 | 要更新的配置字段（部分更新） |

响应：
```json
{
  "success": true,
  "data": { /* 完整配置 */ }
}
```

---

## config:validate-api / POST /api/config/validate

**说明**：通过 SDK 验证 API 连接是否有效。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| apiKey | `string` | 是 | API 密钥 |
| apiUrl | `string` | 是 | API URL |
| provider | `'anthropic' \| 'openai'` | 是 | 服务提供商 |
| model | `string` | 否 | 可选模型名称 |

响应：
```json
{
  "success": true,
  "data": {
    "valid": true,
    "model": "claude-3-opus",
    "normalizedUrl": "https://api.anthropic.com",
    "message": "Connection successful"
  }
}
```

---

## config:fetch-models / POST /api/config/fetch-models

**说明**：从 OpenAI 兼容 API 端点获取可用模型列表。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| apiKey | `string` | 是 | API 密钥 |
| apiUrl | `string` | 是 | API URL |

响应：
```json
{
  "success": true,
  "data": {
    "models": [
      { "id": "model-1", "name": "Model 1" },
      { "id": "model-2", "name": "Model 2" }
    ]
  }
}
```

---

## config:refresh-ai-sources

**说明**：刷新所有 AI Sources 配置（自动检测已登录的来源）。仅 IPC 通道。

请求参数：无

响应：
```json
{
  "success": true,
  "data": { /* 完整配置 */ }
}
```

---

## AI Sources CRUD（原子操作）

以下接口确保后端先从磁盘读取再写入，防止覆盖轮换 Token。

### ai-sources:switch-source / POST /api/ai-sources/switch-source

**说明**：切换当前使用的 AI Source。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sourceId | `string` | 是 | 目标 Source ID |

响应：
```json
{
  "success": true,
  "data": { "currentId": "source-2" }
}
```

错误：
| 场景 | error 信息 |
|------|-----------|
| Source 不存在 | `Source not found: xxx` |

---

### ai-sources:set-model / POST /api/ai-sources/set-model

**说明**：设置当前 Source 的模型。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| modelId | `string` | 是 | 模型 ID |

响应：
```json
{ "success": true, "data": { "currentId": "source-1", "model": "new-model" } }
```

---

### ai-sources:add-source / POST /api/ai-sources/sources

**说明**：添加新的 AI Source。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| body | `AISource` | 是 | 完整的 Source 配置对象 |

响应：
```json
{ "success": true, "data": { /* 新创建的 Source */ } }
```

---

### ai-sources:update-source / PUT /api/ai-sources/sources/:sourceId

**说明**：更新现有 AI Source（合并更新到磁盘状态）。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sourceId | `string` | 是 | Source ID（URL 路径） |
| body | `Partial<AISource>` | 是 | 要更新的字段 |

响应：
```json
{ "success": true, "data": { /* 更新后的 Source */ } }
```

---

### ai-sources:delete-source / DELETE /api/ai-sources/sources/:sourceId

**说明**：删除指定 AI Source。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sourceId | `string` | 是 | Source ID（URL 路径） |

响应：
```json
{ "success": true, "data": { /* 更新后的 Sources 列表 */ } }
```

---

## Auth 相关 IPC 通道

### auth:get-providers

**说明**：获取可用的 OAuth 认证 Provider 列表。仅 IPC 通道。

响应：
```json
{
  "success": true,
  "data": [
    { "type": "anthropic", "name": "Anthropic", "oauthEnabled": true }
  ]
}
```

### auth:get-builtin-providers

**说明**：获取内置 Provider 列表（用于 UI 展示）。仅 IPC 通道。

### auth:start-login

**说明**：启动指定 Provider 的 OAuth 登录流程。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| providerType | `ProviderId` | 是 | Provider 类型标识 |

### auth:complete-login

**说明**：完成 OAuth 登录。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| providerType | `ProviderId` | 是 | Provider 类型标识 |
| state | `string` | 是 | OAuth state 参数 |

### auth:refresh-token

**说明**：刷新指定 Source 的 Token。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sourceId | `string` | 是 | Source ID |

### auth:check-token

**说明**：检查 Token 有效性。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sourceId | `string` | 是 | Source ID |

### auth:logout

**说明**：登出指定 Source。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sourceId | `string` | 是 | Source ID |

## 变更

| 日期 | 内容 | 指令人 | 来源功能 |
|------|------|--------|---------|
| 2026-04-16 | 初始文档创建 | @moonseeker1 | 初始 |
