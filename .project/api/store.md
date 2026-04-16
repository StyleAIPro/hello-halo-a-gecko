# API -- Store (App Registry)

> 最后同步：2026-04-16
> 指令人：@moonseeker1
> **本文档必须与代码保持一致，任何接口变更必须立即更新**

## 认证

- IPC 模式：无需认证
- HTTP 模式：Bearer Token

---

## store:list-apps / GET /api/store/apps

**说明**：列出商店中的应用，支持过滤。

请求参数（查询参数 / IPC 参数）：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| search | `string` | 否 | 搜索关键词 |
| locale | `string` | 否 | 语言区域 |
| category | `string` | 否 | 分类过滤 |
| type | `string` | 否 | 类型过滤（automation/skill/mcp/extension） |
| tags | `string[]` | 否 | 标签过滤（HTTP 逗号分隔） |

响应：
```json
{
  "success": true,
  "data": [
    {
      "slug": "my-app",
      "name": "My App",
      "description": "...",
      "type": "automation",
      "version": "1.0",
      "category": "...",
      "tags": []
    }
  ]
}
```

---

## store:get-app-detail / GET /api/store/apps/:slug

**说明**：获取商店应用的详细信息。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| slug | `string` | 是 | 应用 slug 标识 |

响应：
```json
{
  "success": true,
  "data": {
    "slug": "my-app",
    "name": "My App",
    "description": "...",
    "readme": "...",
    "spec": {},
    "versions": []
  }
}
```

错误：
| 场景 | error 信息 |
|------|-----------|
| slug 为空 | `App slug is required` |

---

## store:install / POST /api/store/install

**说明**：从商店安装应用到指定空间。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| slug | `string` | 是 | 应用 slug |
| spaceId | `string` | 是 | 目标空间 ID |
| userConfig | `Record<string, unknown>` | 否 | 用户配置 |

响应：
```json
{ "success": true, "data": { "appId": "installed-app-id" } }
```

错误：
| 场景 | error 信息 |
|------|-----------|
| slug 为空 | `App slug is required` |
| spaceId 为空 | `Space ID is required` |

HTTP 替代路由：`POST /api/store/apps/:slug/install`（slug 在 URL 路径中）。

---

## store:refresh / POST /api/store/refresh

**说明**：从远程源刷新注册表索引。

请求参数：无

响应：
```json
{ "success": true }
```

---

## store:check-updates / GET /api/store/updates

**说明**：检查所有已安装应用的可用更新。

请求参数：无

响应：
```json
{
  "success": true,
  "data": [
    {
      "appId": "app-1",
      "currentVersion": "1.0",
      "latestVersion": "1.1",
      "slug": "my-app"
    }
  ]
}
```

错误：
| 场景 | error 信息 |
|------|-----------|
| AppManager 未初始化 | `App Manager is not yet initialized. Please try again shortly.` |

---

## store:get-registries / GET /api/store/registries

**说明**：获取已配置的注册表源列表。

请求参数：无

响应：
```json
{
  "success": true,
  "data": [
    {
      "id": "reg-1",
      "name": "Official",
      "url": "https://registry.example.com",
      "enabled": true
    }
  ]
}
```

---

## store:add-registry / POST /api/store/registries

**说明**：添加新的注册表源。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 注册表名称 |
| url | `string` | 是 | 注册表 URL（http/https） |

响应：
```json
{
  "success": true,
  "data": { "id": "new-reg-id", "name": "...", "url": "...", "enabled": true }
}
```

错误：
| 场景 | error 信息 |
|------|-----------|
| 名称为空 | `Registry name is required` |
| URL 为空 | `Registry URL is required` |
| URL 格式无效 | `Invalid registry URL format` |
| 协议不支持 | `Registry URL must use http:// or https://` |

---

## store:remove-registry / DELETE /api/store/registries/:registryId

**说明**：删除注册表源。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| registryId | `string` | 是 | 注册表 ID |

响应：
```json
{ "success": true }
```

---

## store:toggle-registry / POST /api/store/registries/:registryId/toggle

**说明**：启用或禁用注册表源。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| registryId | `string` | 是 | 注册表 ID |
| enabled | `boolean` | 是 | 是否启用 |

响应：
```json
{ "success": true }
```

## 变更

| 日期 | 内容 | 指令人 | 来源功能 |
|------|------|--------|---------|
| 2026-04-16 | 初始文档创建 | @moonseeker1 | 初始 |
