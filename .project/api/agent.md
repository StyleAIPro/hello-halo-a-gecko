# API -- Agent

> 最后同步：2026-04-16
> 指令人：@moonseeker1
> **本文档必须与代码保持一致，任何接口变更必须立即更新**

## 认证

- IPC 模式：无需认证
- HTTP 模式：Bearer Token（远程访问启用后自动生成）

---

## agent:send-message / POST /api/agent/message

**说明**：向 Agent 发送消息，启动 AI 对话流程。支持图片附件、扩展思考模式、AI 浏览器和 Hyper Space 多 Agent。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 工作空间 ID |
| conversationId | `string` | 是 | 对话 ID |
| message | `string` | 是 | 用户消息文本 |
| resumeSessionId | `string` | 否 | 恢复会话的 Session ID |
| images | `ImageAttachment[]` | 否 | 图片附件列表 |
| thinkingEnabled | `boolean` | 否 | 启用扩展思考模式 |
| aiBrowserEnabled | `boolean` | 否 | 启用 AI 浏览器工具 |
| agentId | `string` | 否 | Hyper Space 中目标 Agent ID |

ImageAttachment 结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | `string` | 图片唯一标识 |
| type | `'image'` | 固定值 |
| mediaType | `'image/jpeg' \| 'image/png' \| 'image/gif' \| 'image/webp'` | MIME 类型 |
| data | `string` | Base64 编码图片数据 |
| name | `string` | 可选文件名 |
| size | `number` | 可选文件大小（字节） |

响应：
```json
{ "success": true }
```

错误：
| 场景 | error 信息 |
|------|-----------|
| Agent 服务异常 | 具体错误消息 |

---

## agent:stop / POST /api/agent/stop

**说明**：停止指定对话或全部对话的生成。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| conversationId | `string` | 否 | 对话 ID，不传则停止全部 |

响应：
```json
{ "success": true }
```

---

## agent:inject-message

**说明**：在回合边界注入消息（用于消息队列注入）。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| conversationId | `string` | 是 | 对话 ID |
| content | `string` | 是 | 注入的消息内容 |
| images | `Array<{type: string; data: string; mediaType: string}>` | 否 | 图片附件 |
| thinkingEnabled | `boolean` | 否 | 启用扩展思考 |
| aiBrowserEnabled | `boolean` | 否 | 启用 AI 浏览器 |

响应：
```json
{ "success": true }
```

---

## agent:approve-tool / POST /api/agent/approve

**说明**：批准工具执行。当前为 no-op（所有权限自动放行）。

请求参数：无（HTTP 需要 `conversationId`，但实际不使用）

响应：
```json
{ "success": true }
```

---

## agent:reject-tool / POST /api/agent/reject

**说明**：拒绝工具执行。当前为 no-op。

响应：
```json
{ "success": true }
```

---

## agent:get-session-state / GET /api/agent/session/:conversationId

**说明**：获取指定对话的会话状态，用于页面刷新后恢复。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| conversationId | `string` | 是 | 对话 ID |

响应：
```json
{
  "success": true,
  "data": {
    "isGenerating": false,
    "messages": [],
    "lastUserMessage": "..."
  }
}
```

---

## agent:ensure-session-warm

**说明**：预热 V2 会话，切换对话时调用以加速首次消息发送。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 工作空间 ID |
| conversationId | `string` | 是 | 对话 ID |

响应：
```json
{ "success": true }
```

---

## agent:answer-question / POST /api/agent/answer-question

**说明**：回答 Agent 提出的 AskUserQuestion。支持远程 WebSocket 转发。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| conversationId | `string` | 是 | 对话 ID |
| id | `string` | 是 | 问题 ID |
| answers | `Record<string, string>` | 是 | 回答映射 |

响应：
```json
{ "success": true }
```

错误：
| 场景 | error 信息 |
|------|-----------|
| 问题 ID 不存在 | `No pending question found for this ID` |

---

## agent:test-mcp / POST /api/agent/test-mcp

**说明**：测试 MCP 服务器连接状态。

请求参数：无

响应：
```json
{
  "success": true,
  "data": {
    "servers": [
      { "name": "...", "status": "connected" }
    ]
  }
}
```

---

## agent:compact-context

**说明**：手动触发指定对话的上下文压缩。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| conversationId | `string` | 是 | 对话 ID |

响应：
```json
{
  "success": true,
  "data": {
    "compressed": true,
    "tokenCount": 1234
  }
}
```

---

## GET /api/agent/sessions

**说明**：获取所有活跃会话的对话 ID 列表。仅 HTTP 端点。

响应：
```json
{
  "success": true,
  "data": ["conv-id-1", "conv-id-2"]
}
```

---

## GET /api/agent/generating/:conversationId

**说明**：检查指定对话是否正在生成。仅 HTTP 端点。

响应：
```json
{
  "success": true,
  "data": false
}
```

## 变更

| 日期 | 内容 | 指令人 | 来源功能 |
|------|------|--------|---------|
| 2026-04-16 | 初始文档创建 | @moonseeker1 | 初始 |
