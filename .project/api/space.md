# API -- Space

> 最后同步：2026-04-16
> 指令人：@moonseeker1
> **本文档必须与代码保持一致，任何接口变更必须立即更新**

## 认证

- IPC 模式：无需认证
- HTTP 模式：Bearer Token

---

## space:get-aico-bot / GET /api/spaces/aico-bot

**说明**：获取 AICO-Bot 临时空间（内置空间）。

请求参数：无

响应：
```json
{
  "success": true,
  "data": {
    "id": "aico-bot-temp",
    "name": "AICO-Bot",
    "path": "/path/to/aico-bot-temp",
    "icon": "..."
  }
}
```

---

## space:list / GET /api/spaces

**说明**：列出所有工作空间。

请求参数：无

响应：
```json
{
  "success": true,
  "data": [
    {
      "id": "space-1",
      "name": "My Project",
      "icon": "folder",
      "path": "/path/to/space",
      "workingDir": "/path/to/space",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

---

## space:create / POST /api/spaces

**说明**：创建新工作空间。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 空间名称 |
| icon | `string` | 是 | 图标标识 |
| customPath | `string` | 否 | 自定义路径 |
| claudeSource | `'local' \| 'remote'` | 否 | Claude 来源（默认 local） |
| remoteServerId | `string` | 否 | 远程服务器 ID |
| remotePath | `string` | 否 | 远程路径 |
| systemPrompt | `string` | 否 | 系统提示词 |

响应：
```json
{
  "success": true,
  "data": {
    "id": "new-space-id",
    "name": "My Project",
    "path": "/path/to/space"
  }
}
```

---

## space:delete / DELETE /api/spaces/:spaceId

**说明**：删除指定工作空间。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID（URL 路径参数） |

响应：
```json
{ "success": true }
```

错误：
| 场景 | error 信息 |
|------|-----------|
| 删除失败 | 具体错误消息 |

---

## space:get / GET /api/spaces/:spaceId

**说明**：获取指定空间详情（含 UI 偏好设置）。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |

响应：
```json
{
  "success": true,
  "data": {
    "id": "space-1",
    "name": "My Project",
    "path": "/path/to/space",
    "preferences": {
      "layout": {
        "artifactRailExpanded": true,
        "chatWidth": 600
      }
    }
  }
}
```

---

## space:update / PUT /api/spaces/:spaceId

**说明**：更新空间元数据。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |
| name | `string` | 否 | 新名称 |
| icon | `string` | 否 | 新图标 |

响应：
```json
{
  "success": true,
  "data": { "id": "space-1", "name": "Updated", "icon": "new-icon" }
}
```

---

## space:open-folder / POST /api/spaces/:spaceId/open

**说明**：在文件管理器中打开空间目录（IPC）。HTTP 模式返回路径。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |

响应（IPC）：
```json
{ "success": true }
```

响应（HTTP）：
```json
{
  "success": true,
  "data": { "path": "/path/to/space" }
}
```

---

## space:get-default-path / GET /api/spaces/default-path

**说明**：获取默认空间路径。

请求参数：无

响应：
```json
{
  "success": true,
  "data": "/path/to/spaces-dir"
}
```

---

## dialog:select-folder

**说明**：弹出文件夹选择对话框。仅 IPC 通道。

请求参数：无

响应：
```json
{
  "success": true,
  "data": "/selected/path"
}
```

取消时 `data` 为 `null`。

---

## space:update-preferences

**说明**：更新空间布局偏好。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |
| preferences | `Partial<SpacePreferences>` | 是 | 偏好设置 |

SpacePreferences 结构：
```typescript
interface SpacePreferences {
  layout?: {
    artifactRailExpanded?: boolean
    chatWidth?: number
  }
}
```

响应：
```json
{ "success": true, "data": { /* updated space */ } }
```

---

## space:get-preferences

**说明**：获取空间布局偏好。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |

响应：
```json
{
  "success": true,
  "data": {
    "layout": {
      "artifactRailExpanded": true,
      "chatWidth": 600
    }
  }
}
```

---

## space:get-skill-space

**说明**：获取或创建技能空间。仅 IPC 通道。

请求参数：无

响应：
```json
{
  "success": true,
  "data": { "id": "skill-space-id", "name": "Skills", "path": "..." }
}
```

---

## space:get-skill-space-id

**说明**：获取技能空间 ID。仅 IPC 通道。

请求参数：无

响应：
```json
{ "success": true, "data": "skill-space-id" }
```

---

## space:is-skill-space

**说明**：检查指定空间是否为技能空间。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |

响应：
```json
{ "success": true, "data": true }
```

## 变更

| 日期 | 内容 | 指令人 | 来源功能 |
|------|------|--------|---------|
| 2026-04-16 | 初始文档创建 | @moonseeker1 | 初始 |
