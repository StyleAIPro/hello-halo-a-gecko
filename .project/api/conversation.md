# API -- Conversation

> 最后同步：2026-04-16
> 指令人：@moonseeker1
> **本文档必须与代码保持一致，任何接口变更必须立即更新**

## 认证

- IPC 模式：无需认证
- HTTP 模式：Bearer Token

---

## conversation:list / GET /api/spaces/:spaceId/conversations

**说明**：列出指定空间下所有对话。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |

响应：
```json
{
  "success": true,
  "data": [
    {
      "id": "conv-1",
      "title": "Chat about X",
      "createdAt": "...",
      "updatedAt": "...",
      "messageCount": 5
    }
  ]
}
```

---

## conversation:create / POST /api/spaces/:spaceId/conversations

**说明**：创建新对话。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |
| title | `string` | 否 | 对话标题 |

响应：
```json
{
  "success": true,
  "data": {
    "id": "new-conv-id",
    "title": "New Chat",
    "messages": [],
    "createdAt": "..."
  }
}
```

---

## conversation:get / GET /api/spaces/:spaceId/conversations/:conversationId

**说明**：获取指定对话详情。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |
| conversationId | `string` | 是 | 对话 ID |

响应：
```json
{
  "success": true,
  "data": {
    "id": "conv-1",
    "title": "Chat",
    "messages": [],
    "meta": {}
  }
}
```

错误：
| 场景 | error 信息 |
|------|-----------|
| 对话不存在 | `Conversation not found` |

---

## conversation:update / PUT /api/spaces/:spaceId/conversations/:conversationId

**说明**：更新对话属性。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |
| conversationId | `string` | 是 | 对话 ID |
| updates | `Record<string, unknown>` | 是 | 更新字段 |

响应：
```json
{
  "success": true,
  "data": { "id": "conv-1", "title": "Updated Title" }
}
```

---

## conversation:delete / DELETE /api/spaces/:spaceId/conversations/:conversationId

**说明**：删除指定对话。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |
| conversationId | `string` | 是 | 对话 ID |

响应：
```json
{ "success": true, "data": true }
```

---

## conversation:add-message / POST /api/spaces/:spaceId/conversations/:conversationId/messages

**说明**：向对话添加一条消息。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |
| conversationId | `string` | 是 | 对话 ID |
| role | `'user' \| 'assistant' \| 'system'` | 是 | 消息角色 |
| content | `string` | 是 | 消息内容 |

响应：
```json
{
  "success": true,
  "data": {
    "id": "msg-id",
    "role": "user",
    "content": "Hello",
    "timestamp": "..."
  }
}
```

---

## conversation:update-last-message / PUT /api/spaces/:spaceId/conversations/:conversationId/messages/last

**说明**：更新对话中最后一条消息（用于保存内容和思考）。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |
| conversationId | `string` | 是 | 对话 ID |
| updates | `Record<string, unknown>` | 是 | 更新字段 |

响应：
```json
{
  "success": true,
  "data": { "id": "msg-id", "content": "updated" }
}
```

---

## conversation:get-thoughts / GET /api/spaces/:spaceId/conversations/:conversationId/messages/:messageId/thoughts

**说明**：获取指定消息的思考内容（懒加载）。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |
| conversationId | `string` | 是 | 对话 ID |
| messageId | `string` | 是 | 消息 ID |

响应：
```json
{
  "success": true,
  "data": "思考内容文本..."
}
```

---

## conversation:toggle-star / POST /api/spaces/:spaceId/conversations/:conversationId/star

**说明**：切换对话的收藏状态。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |
| conversationId | `string` | 是 | 对话 ID |
| starred | `boolean` | 是 | 是否收藏 |

响应：
```json
{ "success": true, "data": { "starred": true } }
```

---

## conversation:get-agent-commands

**说明**：获取对话中 Agent 使用过的命令。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |
| conversationId | `string` | 是 | 对话 ID |

响应：
```json
{ "success": true, "data": ["command-1", "command-2"] }
```

---

## conversation:list-children / GET /api/spaces/:spaceId/conversations/:conversationId/children

**说明**：列出父对话下的子（Worker）对话。用于 Hyper Space。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |
| parentConversationId | `string` | 是 | 父对话 ID |

响应：
```json
{
  "success": true,
  "data": [
    { "id": "child-1", "title": "Worker 1", "agentId": "agent-1" }
  ]
}
```

---

## conversation:list-all-workers / GET /api/spaces/:spaceId/conversations/workers

**说明**：列出空间中所有父对话的 Worker 对话（Hyper Space）。返回按父对话 ID 分组的 Map。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |

响应：
```json
{
  "success": true,
  "data": {
    "parent-conv-1": [
      {
        "id": "worker-1",
        "title": "Worker Task",
        "agentId": "agent-1",
        "createdAt": "...",
        "updatedAt": "...",
        "messageCount": 3
      }
    ]
  }
}
```

## 变更

| 日期 | 内容 | 指令人 | 来源功能 |
|------|------|--------|---------|
| 2026-04-16 | 初始文档创建 | @moonseeker1 | 初始 |
