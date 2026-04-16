# API -- App (Digital Humans Automation)

> 最后同步：2026-04-16
> 指令人：@moonseeker1
> **本文档必须与代码保持一致，任何接口变更必须立即更新**

## 认证

- IPC 模式：无需认证
- HTTP 模式：Bearer Token

## 错误码

App Controller 定义了结构化错误码，HTTP 模式下映射到状态码：

| 错误码 | HTTP 状态码 | 说明 |
|--------|-----------|------|
| `NOT_INITIALIZED` | 503 | AppManager 未就绪 |
| `NOT_FOUND` | 404 | App ID 不存在 |
| `INVALID_YAML` | 400 | YAML 解析错误 |
| `VALIDATION_FAILED` | 422 | Spec Schema 验证失败 |

---

## GET /api/apps

**说明**：列出所有已安装的 App。仅 HTTP 端点。

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 否 | 按空间过滤 |

响应：
```json
{
  "success": true,
  "data": [
    {
      "id": "app-1",
      "spec": { "name": "...", "type": "automation", "version": "1.0" },
      "spaceId": "space-1",
      "status": "active"
    }
  ]
}
```

---

## POST /api/apps/install

**说明**：安装一个新 App。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 目标空间 ID |
| spec | `AppSpec` | 是 | App 规格定义 |
| userConfig | `Record<string, unknown>` | 否 | 用户配置 |

响应：
```json
{ "success": true, "data": { "appId": "new-app-id" } }
```

---

## GET /api/apps/:appId

**说明**：获取单个 App 详情。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | App ID（URL 路径） |

响应：
```json
{
  "success": true,
  "data": { "id": "app-1", "spec": { }, "status": "active" }
}
```

---

## DELETE /api/apps/:appId

**说明**：卸载（软删除）App。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | App ID |

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| purge | `'true'` | 否 | 是否永久删除 |

响应：
```json
{ "success": true }
```

---

## POST /api/apps/:appId/reinstall

**说明**：重新安装已卸载的 App。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | App ID |

响应：
```json
{
  "success": true,
  "data": { "activationWarning": "..." }
}
```

---

## DELETE /api/apps/:appId/permanent

**说明**：永久删除已卸载的 App。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | App ID |

响应：
```json
{ "success": true }
```

---

## POST /api/apps/:appId/pause

**说明**：暂停 App。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | App ID |

响应：
```json
{ "success": true }
```

---

## POST /api/apps/:appId/resume

**说明**：恢复暂停的 App。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | App ID |

响应：
```json
{ "success": true }
```

---

## POST /api/apps/:appId/trigger

**说明**：手动触发一次 App 运行。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | App ID |

响应：
```json
{
  "success": true,
  "data": {
    "outcome": "completed",
    "runId": "run-1"
  }
}
```

---

## GET /api/apps/:appId/activity

**说明**：获取 App 运行活动记录。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | App ID |

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| limit | `number` | 否 | 返回条数限制 |
| before | `number` | 否 | 时间戳，获取此时间之前的记录 |

响应：
```json
{
  "success": true,
  "data": [
    {
      "id": "entry-1",
      "ts": 1713244800000,
      "outcome": "completed",
      "duration": 5000
    }
  ]
}
```

---

## POST /api/apps/:appId/escalation/:entryId/respond

**说明**：回应 App 的升级请求。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | App ID |
| entryId | `string` | 是 | 活动 Entry ID |
| choice | `string` | 否 | 用户选择 |
| text | `string` | 否 | 用户文本回复 |

响应：
```json
{ "success": true }
```

---

## GET /api/apps/:appId/runs/:runId/session

**说明**：获取运行会话的消息记录（查看进程）。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | App ID |
| runId | `string` | 是 | 运行 ID |

响应：
```json
{
  "success": true,
  "data": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

---

## POST /api/apps/:appId/config

**说明**：更新 App 的用户配置。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | App ID |
| body | `Record<string, unknown>` | 是 | 新的用户配置 |

响应：
```json
{ "success": true }
```

---

## POST /api/apps/:appId/frequency

**说明**：更新 App 订阅的调度频率。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | App ID |
| subscriptionId | `string` | 是 | 订阅 ID |
| frequency | `string` | 是 | 新频率（如 `30m`、`1h`、`1d`） |

响应：
```json
{ "success": true }
```

---

## PATCH /api/apps/:appId/spec

**说明**：更新 App Spec（JSON Merge Patch）。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | App ID |
| body | `Record<string, unknown>` | 是 | 要合并的 Spec 字段 |

响应：
```json
{ "success": true }
```

注意：如果 `subscriptions` 字段变更，运行时会自动停用再重新激活 App。

---

## GET /api/apps/:appId/state

**说明**：获取 App 实时运行状态。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | App ID |

响应：
```json
{
  "success": true,
  "data": {
    "status": "active",
    "lastRun": "2026-04-16T00:00:00Z",
    "isRunning": false
  }
}
```

---

## GET /api/apps/:appId/export-spec

**说明**：导出 App Spec 为 YAML 字符串。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | App ID |

响应：
```json
{
  "success": true,
  "data": {
    "yaml": "name: My App\nversion: '1.0'\n...",
    "filename": "my-app-1.0.yaml"
  }
}
```

---

## POST /api/apps/import-spec

**说明**：从 YAML 字符串导入并安装 App。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 目标空间 ID |
| yamlContent | `string` | 是 | YAML 格式的 App Spec |
| userConfig | `Record<string, unknown>` | 否 | 用户配置 |

响应：
```json
{
  "success": true,
  "data": {
    "appId": "new-app-id",
    "activationWarning": "..."
  }
}
```

---

## POST /api/apps/:appId/chat/send

**说明**：向 App 的 AI Agent 发送聊天消息。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | App ID |
| body | `AppChatRequest` | 是 | 聊天请求 |

响应：
```json
{
  "success": true,
  "data": { "conversationId": "conv-id" }
}
```

---

## POST /api/apps/:appId/chat/stop

**说明**：停止 App 聊天生成。仅 HTTP 端点。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | App ID |

响应：
```json
{ "success": true }
```

---

## GET /api/apps/:appId/chat/status

**说明**：获取 App 聊天状态。仅 HTTP 端点。

响应：
```json
{
  "success": true,
  "data": {
    "isGenerating": false,
    "conversationId": "conv-id"
  }
}
```

---

## GET /api/apps/:appId/chat/messages

**说明**：获取 App 的持久化聊天消息。仅 HTTP 端点。

响应：
```json
{
  "success": true,
  "data": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

---

## GET /api/apps/:appId/chat/session-state

**说明**：获取 App 聊天会话状态（恢复用）。仅 HTTP 端点。

响应：
```json
{
  "success": true,
  "data": { "isGenerating": false, "messages": [] }
}
```

## 变更

| 日期 | 内容 | 指令人 | 来源功能 |
|------|------|--------|---------|
| 2026-04-16 | 初始文档创建 | @moonseeker1 | 初始 |
