# API -- Skill

> 最后同步：2026-04-16
> 指令人：@moonseeker1
> **本文档必须与代码保持一致，任何接口变更必须立即更新**

## 认证

- IPC 模式：无需认证
- HTTP 模式：Bearer Token

---

## skill:list

**说明**：列出已安装的技能。仅 IPC 通道。

请求参数：无

响应：
```json
{
  "success": true,
  "data": [
    { "appId": "skill-1", "spec": { "name": "My Skill" }, "enabled": true }
  ]
}
```

---

## skill:get-detail

**说明**：获取指定技能的详情。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| skillId | `string` | 是 | 技能 ID |

响应：
```json
{
  "success": true,
  "data": { "appId": "skill-1", "spec": { }, "enabled": true }
}
```

错误：
| 场景 | error 信息 |
|------|-----------|
| 技能不存在 | `Skill not found` |

---

## skill:install

**说明**：安装技能（从市场或 YAML）。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| mode | `'market' \| 'yaml'` | 是 | 安装来源 |
| skillId | `string` | 条件必填 | mode=market 时的技能 ID |
| yamlContent | `string` | 条件必填 | mode=yaml 时的 YAML 内容 |

mode=`market` 时，流式输出通过 `skill:install-output` 事件推送到渲染进程。

响应（mode=market）：
```json
{ "success": true }
```

响应（mode=yaml）：
```json
{ "success": true, "skillId": "new-skill-id" }
```

---

## skill:uninstall

**说明**：卸载指定技能。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| skillId | `string` | 是 | 技能 ID |

响应：
```json
{ "success": true }
```

---

## skill:install-multi

**说明**：安装技能到多个目标（本地和/或远程）。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| skillId | `string` | 是 | 技能 ID |
| targets | `Array<{ type: 'local' } \| { type: 'remote'; serverId: string }>` | 是 | 目标列表 |

流式输出通过 `skill:install-output` 事件推送，带有 `targetKey` 字段。

响应：
```json
{
  "success": true,
  "data": {
    "results": {
      "local": { "success": true },
      "remote:server-1": { "success": true }
    }
  }
}
```

---

## skill:uninstall-multi

**说明**：从多个目标卸载技能。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appId | `string` | 是 | 技能 App ID |
| targets | `Array<{ type: 'local' } \| { type: 'remote'; serverId: string }>` | 是 | 目标列表 |

---

## skill:sync-to-remote

**说明**：将本地技能同步到远程服务器。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| skillId | `string` | 是 | 技能 ID |
| serverId | `string` | 是 | 远程服务器 ID |

---

## skill:toggle

**说明**：启用或禁用技能。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| skillId | `string` | 是 | 技能 ID |
| enabled | `boolean` | 是 | 是否启用 |

---

## skill:export

**说明**：导出技能为 YAML。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| skillId | `string` | 是 | 技能 ID |

响应：
```json
{
  "success": true,
  "data": "name: My Skill\ntrigger: /myskill\n..."
}
```

---

## skill:generate

**说明**：从对话或提示词生成技能。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| mode | `'conversation' \| 'prompt'` | 是 | 生成模式 |
| spaceId | `string` | 是 | 空间 ID |
| conversationId | `string` | 否 | mode=conversation 时必填 |
| name | `string` | 否 | mode=prompt 时必填 |
| description | `string` | 否 | mode=prompt 时必填 |
| triggerCommand | `string` | 否 | 触发命令 |

---

## skill:market:list

**说明**：列出技能市场中的技能。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| page | `number` | 否 | 页码 |
| pageSize | `number` | 否 | 每页数量 |

响应：
```json
{
  "success": true,
  "data": {
    "skills": [],
    "total": 100,
    "hasMore": true
  }
}
```

---

## skill:market:search

**说明**：搜索技能市场。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | `string` | 是 | 搜索关键词 |
| page | `number` | 否 | 页码 |
| pageSize | `number` | 否 | 每页数量 |

---

## skill:market:detail

**说明**：获取市场技能详情。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| skillId | `string` | 是 | 技能 ID |

---

## skill:market:sources

**说明**：获取市场源列表。仅 IPC 通道。

请求参数：无

---

## skill:market:add-source

**说明**：添加市场源。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 源名称 |
| url | `string` | 是 | 源 URL |
| repos | `string[]` | 否 | 仓库列表 |
| description | `string` | 否 | 描述 |

---

## skill:market:remove-source

**说明**：删除市场源。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sourceId | `string` | 是 | 源 ID |

---

## skill:market:toggle-source

**说明**：启用或禁用市场源。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sourceId | `string` | 是 | 源 ID |
| enabled | `boolean` | 是 | 是否启用 |

---

## skill:market:set-active

**说明**：设置活跃的市场源。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sourceId | `string` | 是 | 源 ID |

---

## skill:config:get

**说明**：获取技能库配置。仅 IPC 通道。

请求参数：无

---

## skill:config:update

**说明**：更新技能库配置。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| body | `Record<string, unknown>` | 是 | 配置更新 |

---

## skill:refresh

**说明**：刷新已安装技能列表。仅 IPC 通道。

请求参数：无

响应：返回刷新后的技能列表。

---

## skill:files

**说明**：获取技能的文件列表。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| skillId | `string` | 是 | 技能 ID |

---

## skill:file-content

**说明**：获取技能文件内容。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| skillId | `string` | 是 | 技能 ID |
| filePath | `string` | 是 | 文件路径 |

---

## skill:file-save

**说明**：保存技能文件内容。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| skillId | `string` | 是 | 技能 ID |
| filePath | `string` | 是 | 文件路径 |
| content | `string` | 是 | 文件内容 |

---

## skill:analyze-conversations

**说明**：分析对话，提取技能模式。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| spaceId | `string` | 是 | 空间 ID |
| conversationIds | `string[]` | 是 | 对话 ID 列表 |

响应包含分析结果、相似技能、建议名称和触发命令。

---

## skill:create-temp-session

**说明**：创建临时 Agent 会话（技能生成器）。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| skillName | `string` | 是 | 技能名称 |
| context | `unknown` | 是 | 上下文（含分析结果、相似技能、模式、初始提示词） |

流式输出通过 `skill:temp-message-chunk` 事件推送。

---

## skill:send-temp-message

**说明**：发送消息到临时会话。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sessionId | `string` | 是 | 会话 ID |
| message | `string` | 是 | 消息内容 |

---

## skill:close-temp-session

**说明**：关闭临时会话。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sessionId | `string` | 是 | 会话 ID |

---

## skill:conversation:list

**说明**：列出技能生成器的持久化会话。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| relatedSkillId | `string` | 否 | 按技能 ID 过滤 |

---

## skill:conversation:get

**说明**：获取技能生成器会话详情。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| conversationId | `string` | 是 | 会话 ID |

---

## skill:conversation:create

**说明**：创建新的技能生成器会话。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | `string` | 否 | 会话标题 |
| relatedSkillId | `string` | 否 | 关联的技能 ID |

---

## skill:conversation:delete

**说明**：删除技能生成器会话。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| conversationId | `string` | 是 | 会话 ID |

---

## skill:conversation:send

**说明**：发送消息到技能生成器会话。使用标准 `agent:*` IPC 事件发送流式数据。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| conversationId | `string` | 是 | 会话 ID |
| message | `string` | 是 | 消息内容 |
| metadata | `object` | 否 | 附加元数据 |

metadata 结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| selectedConversations | `Array<{id, title, spaceName, messageCount, formattedContent?}>` | 选中的对话 |
| sourceWebpages | `Array<{url, title?, content?}>` | 来源网页 |

---

## skill:conversation:stop

**说明**：停止技能生成器消息生成。仅 IPC 通道。

---

## skill:conversation:close

**说明**：关闭技能生成器会话。仅 IPC 通道。

---

## skill:fetch-webpage

**说明**：获取网页内容（用于从网页创建技能）。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | `string` | 是 | 网页 URL |

响应：
```json
{
  "success": true,
  "data": {
    "title": "Page Title",
    "content": "Markdown content (max 5000 chars)"
  }
}
```

---

## skill:market:push-to-github

**说明**：推送本地技能到 GitHub 仓库（通过 PR）。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| skillId | `string` | 是 | 技能 ID |
| targetRepo | `string` | 是 | 目标仓库（格式：owner/repo） |
| targetPath | `string` | 否 | 目标路径 |

响应：
```json
{ "success": true, "prUrl": "https://github.com/..." }
```

---

## skill:market:list-repo-dirs

**说明**：列出 GitHub 仓库 skills/ 目录下的子目录。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| repo | `string` | 是 | 仓库（格式：owner/repo） |

---

## skill:market:validate-repo

**说明**：验证 GitHub 仓库是否可用作技能源。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| repo | `string` | 是 | 仓库 |

响应：
```json
{
  "success": true,
  "data": {
    "valid": true,
    "hasSkillsDir": true,
    "skillCount": 5
  }
}
```

---

## skill:market:push-to-gitcode

**说明**：推送技能到 GitCode 仓库（通过 MR）。仅 IPC 通道。

请求参数：同 push-to-github。

---

## skill:market:list-gitcode-repo-dirs

**说明**：列出 GitCode 仓库目录。仅 IPC 通道。

---

## skill:market:validate-gitcode-repo

**说明**：验证 GitCode 仓库。仅 IPC 通道。

---

## skill:market:set-gitcode-token

**说明**：设置 GitCode Token。仅 IPC 通道。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| token | `string` | 是 | GitCode API Token |

## 变更

| 日期 | 内容 | 指令人 | 来源功能 |
|------|------|--------|---------|
| 2026-04-16 | 初始文档创建 | @moonseeker1 | 初始 |
