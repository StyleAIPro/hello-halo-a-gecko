# GitCode OpenAPI 总结文档

> 数据来源：https://docs.gitcode.com/docs/apis/
> 统计时间：2026-04-25 | API 端点总数：250（不含 Release Notes）

---

## 1. 基础信息

### Base URL

```
https://api.gitcode.com/api/v5
```

所有请求必须包含 `/api/v5` 路径前缀。

### 请求示例

```bash
curl "https://api.gitcode.com/api/v5/users/{username}"
```

---

## 2. 认证方式

GitCode API 提供 **三种** 认证方式，均使用 **个人访问令牌 (Personal Access Token)**：

### 方式一：Authorization Header（推荐）

```bash
curl --location 'https://api.gitcode.com/api/v5/user' \
--header 'Authorization: Bearer {your-token}'
```

### 方式二：PRIVATE-TOKEN Header

```bash
curl --location 'https://api.gitcode.com/api/v5/user' \
--header 'PRIVATE-TOKEN: {your-token}'
```

### 方式三：Query Parameter

```bash
curl "https://api.gitcode.com/api/v5/users/{username}?access_token={your-token}"
```

> 未认证时仅返回公开数据；认证信息无效返回 `401 Unauthorized`。

---

## 3. 状态码

| 状态码 | 含义 |
|--------|------|
| `200 OK` | GET / PUT / DELETE 请求成功 |
| `201 Created` | POST 创建资源成功 |
| `202 Accepted` | 请求已接受，计划处理中 |
| `204 No Content` | 删除成功，无响应体 |
| `301 Moved Permanently` | 资源已永久跳转 |
| `304 Not Modified` | 资源未修改 |
| `400 Bad Request` | 缺少必要参数 |
| `401 Unauthorized` | 未认证或 token 无效 |
| `403 Forbidden` | 无权限执行此操作 |
| `404 Not Found` | 资源不存在或无权访问 |
| `405 Method Not Allowed` | HTTP 方法不支持 |
| `409 Conflict` | 资源冲突（如重名） |
| `412 Precondition Failed` | 前置条件不满足 |
| `418 I'm a teapot` | 请求疑似不安全，被拒绝 |
| `422 Unprocessable` | 无法处理实体 |
| `429 Too Many Requests` | 超过速率限制（默认 400/分，4000/小时） |
| `500 Server Error` | 服务器内部错误 |
| `503 Service Unavailable` | 服务暂时过载 |
| `504 Time Out` | 响应超时 |

---

## 4. API 分类总览

| 分类 | 端点数 | 主要方法 |
|------|--------|----------|
| Pull Requests | 42 | GET:18, POST:10, DELETE:6, PATCH:4, PUT:4 |
| Repository Info | 26 | GET:15, PUT:6, POST:3 |
| Organizations | 26 | GET:12, POST:5, PUT:4, DELETE:4 |
| User | 23 | GET:18, POST:2, DELETE:2 |
| Issues | 25 | GET:17, DELETE:3, POST:2, PUT:2 |
| Enterprise | 21 | GET:13, POST:3, PUT:3, DELETE:2 |
| AI Services | 7 | POST:7 |
| Branches | 7 | GET:2, PUT:2, DELETE:2, POST:1 |
| Protection | 6 | GET:3, POST:1, PUT:1, DELETE:1 |
| Collaborators/Members | 7 | GET:4, PUT:2, DELETE:1 |
| Webhooks | 6 | GET:2, POST:2, DELETE:1, PATCH:1 |
| Commits | 6 | GET:5, POST:1 |
| Releases | 8 | GET:6, POST:1, PATCH:1 |
| Contents/Files | 5 | GET:2, POST:1, PUT:1, DELETE:1 |
| Labels | 5 | 全方法各1 |
| Milestones | 5 | GET:2, POST:1, PATCH:1, DELETE:1 |
| OAuth | 3 | GET:1, POST:1 |
| Users/Search | 3 | GET:3 |
| Tags | 3 | GET:1, POST:1, DELETE:1 |
| Forks | 2 | GET:1, POST:1 |
| Git Data | 2 | GET:2 |
| Repo Comments | 4 | GET:2, DELETE:1, PATCH:1 |

---

## 5. 各分类 API 详情

### 5.1 User（用户管理）— 23 个端点

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v5/user` | 获取授权用户资料 |
| PATCH | `/api/v5/user` | 更新用户资料 |
| GET | `/api/v5/user/emails` | 获取用户邮箱列表 |
| GET | `/api/v5/user/issues` | 获取用户相关的 Issue |
| GET | `/api/v5/user/keys` | 获取用户公钥列表 |
| GET | `/api/v5/user/keys/{id}` | 获取单个公钥 |
| POST | `/api/v5/user/keys` | 添加公钥 |
| DELETE | `/api/v5/user/keys/{id}` | 删除公钥 |
| GET | `/api/v5/user/memberships/orgs/{org}` | 获取用户在组织中的角色 |
| DELETE | `/api/v5/user/memberships/orgs/{org}` | 退出组织 |
| GET | `/api/v5/user/namespace` | 获取用户命名空间 |
| GET | `/api/v5/user/namespaces` | 获取用户所有命名空间 |
| GET | `/api/v5/user/repos` | 获取用户仓库列表 |
| POST | `/api/v5/user/repos` | 创建用户仓库 |
| GET | `/api/v5/user/starred` | 获取用户 Star 的仓库 |
| GET | `/api/v5/user/{username}/starred` | 获取指定用户 Star 的仓库 |
| GET | `/api/v5/user/subscriptions` | 获取用户关注的仓库 |
| GET | `/api/v5/user/{username}/subscriptions` | 获取指定用户关注的仓库 |
| DELETE | `/api/v5/user/{...}` | 删除用户相关资源 |

**用户资料响应字段**：`id`, `login`, `name`, `avatar_url`, `html_url`, `url`, `bio`, `blog`, `company`, `email`, `followers`, `following`, `top_languages[]`, `type`

### 5.2 Users/Search（用户搜索）— 3 个端点

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v5/search/users` | 搜索用户 |
| GET | `/api/v5/search/repositories` | 搜索仓库 |
| GET | `/api/v5/search/issues` | 搜索 Issue |
| GET | `/api/v5/users/{username}` | 获取指定用户信息 |
| GET | `/api/v5/users/{username}/repos` | 获取指定用户的仓库 |
| GET | `/api/v5/users/{username}/events` | 获取用户动态 |
| GET | `/api/v5/users/{username}/orgs` | 获取用户所属组织 |
| GET | `/api/v5/users/orgs` | 获取当前用户所属组织 |
| GET | `/api/v5/users/merge_requests` | 获取用户的合并请求 |

### 5.3 Organizations（组织管理）— 26 个端点

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v5/orgs/{org}` | 获取组织详情 |
| POST | `/api/v5/orgs/{org}` | 创建组织 |
| PATCH | `/api/v5/orgs/{org}` | 更新组织信息 |
| DELETE | `/api/v5/orgs/{org}` | 删除组织 |
| GET | `/api/v5/orgs/{org}/repos` | 获取组织仓库列表 |
| POST | `/api/v5/orgs/{org}/repos` | 为组织创建仓库 |
| GET | `/api/v5/orgs/{org}/members` | 获取组织成员列表 |
| GET | `/api/v5/orgs/{org}/members/{username}` | 获取组织成员详情 |
| POST | `/api/v5/orgs/{org}/memberships/{username}` | 邀请成员 |
| DELETE | `/api/v5/orgs/{org}/memberships/{username}` | 移除成员 |
| GET | `/api/v5/orgs/{org}/customized_roles` | 获取组织自定义角色 |
| GET | `/api/v5/orgs/{org}/pull_requests` | 获取组织的 PR 列表 |
| GET | `/api/v5/orgs/{org}/issues` | 获取组织的 Issue 列表 |
| GET | `/api/v5/orgs/{org}/issue_extend_settings` | 获取 Issue 扩展设置 |
| GET | `/api/v5/orgs/{owner}/followers` | 获取组织的关注者 |
| PUT | `/api/v5/org/{org}/repo/{repo}/status` | 更新仓库状态 |
| POST | `/api/v5/org/{org}/projects/{repo}/transfer` | 项目转移 |
| GET | `/api/v5/org/{owner}/kanban/list` | 获取看板列表 |
| GET | `/api/v5/org/{owner}/kanban/{id}/detail` | 获取看板详情 |
| GET | `/api/v5/org/{owner}/kanban/{kanban_id}/item_list` | 获取看板事项列表 |
| POST | `/api/v5/org/{owner}/kanban/{id}/add_item` | 添加看板事项 |
| DELETE | `/api/v5/org/{owner}/kanban/{kanban_id}/item_list` | 删除看板事项 |
| DELETE | `/api/v5/org/{owner}/kanban/{kanban_id}/remove_item` | 移除看板事项 |
| PUT | `/api/v5/org/{owner}/kanban/{kanban_id}/state` | 更新看板状态 |
| PUT | `/api/v5/org/{owner}/kanban/{repo}/{type}/{iid}` | 关联仓库与看板 |

### 5.4 Enterprise（企业管理）— 21 个端点

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v5/enterprises/{enterprise}/members` | 获取企业成员 |
| GET | `/api/v5/enterprises/{enterprise}/members/{username}` | 获取企业成员详情 |
| PUT | `/api/v5/enterprises/{enterprise}/members/{username}` | 更新企业成员角色 |
| POST | `/api/v8/enterprises/{enterprise}/memberships/{username}` | 邀请企业成员 |
| DELETE | `/api/v8/enterprises/{enterprise}/members/{usernames}` | 批量移除成员 |
| GET | `/api/v5/enterprises/{enterprise}/labels` | 获取企业标签 |
| GET | `/api/v5/enterprises/{enterprise}/issues` | 获取企业 Issue |
| GET | `/api/v5/enterprises/{enterprise}/issues/{number}` | 获取企业 Issue 详情 |
| GET | `/api/v5/enterprises/{enterprise}/issues/{issue_id}/labels` | 获取 Issue 标签 |
| GET | `/api/v5/enterprises/{enterprise}/issues/{number}/comments` | 获取 Issue 评论 |
| GET | `/api/v5/enterprises/{enterprise}/issues/{number}/pull_requests` | 获取关联的 PR |
| GET | `/api/v5/enterprises/{enterprise}/issue_statuses` | 获取 Issue 状态列表 |
| GET | `/api/v5/enterprises/{enterprise}/pull_requests` | 获取企业 PR |
| GET | `/api/v8/enterprises/{enterprise_id}/milestones` | 获取企业里程碑 |
| POST | `/api/v8/enterprises/{enterprise_id}/milestones` | 创建企业里程碑 |
| PUT | `/api/v8/enterprises/{enterprise_id}/milestones/{milestone_id}` | 更新里程碑 |
| DELETE | `/api/v8/enterprises/{enterprise_id}/milestones/{milestone_id}` | 删除里程碑 |
| GET | `/api/v8/enterprises/{enterprise_id}/customized_roles` | 获取自定义角色 |
| GET | `/api/v8/enterprises/{enterprise_id}/groups_projects` | 获取分组项目 |
| GET | `/api/v8/enterprises/{enterprises_id}/issue_extend_field` | 获取扩展字段 |
| POST | `/api/v8/enterprises/{enterprises_id}/issues` | 创建企业 Issue |

### 5.5 Repository（仓库管理）— 26 个端点

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v5/repos/{owner}/{repo}` | 获取仓库详情 |
| PATCH | `/api/v5/repos/{owner}/{repo}` | 更新仓库信息 |
| DELETE | `/api/v5/repos/{owner}/{repo}` | 删除仓库 |
| PUT | `/api/v5/repos/{owner}/{repo}` | Fork 仓库（或更新仓库） |
| GET | `/api/v5/repos/{owner}/{repo}/languages` | 获取仓库语言构成 |
| GET | `/api/v5/repos/{owner}/{repo}/contributors` | 获取贡献者列表 |
| GET | `/api/v5/repos/{owner}/{repo}/contributors/statistic` | 获取贡献者统计 |
| GET | `/api/v5/repos/{owner}/{repo}/stargazers` | 获取 Star 用户列表 |
| GET | `/api/v5/repos/{owner}/{repo}/subscribers` | 获取 Watch 用户列表 |
| GET | `/api/v5/repos/{owner}/{repo}/download_statistics` | 下载统计 |
| GET | `/api/v5/repos/{owner}/{repo}/events` | 获取仓库动态（需 access_token） |
| GET | `/api/v5/repos/{owner}/{repo}/file_list` | 获取文件列表 |
| GET | `/api/v5/repos/{owner}/{repo}/repo_settings` | 获取仓库设置 |
| PUT | `/api/v5/repos/{owner}/{repo}/repo_settings` | 更新仓库设置 |
| GET | `/api/v5/repos/{owner}/{repo}/notifications` | 获取仓库通知 |
| PUT | `/api/v5/repos/{owner}/{repo}/notifications` | 更新通知设置 |
| GET | `/api/v5/repos/{owner}/{repo}/push_config` | 获取推送配置 |
| PUT | `/api/v5/repos/{owner}/{repo}/push_config` | 更新推送配置 |
| GET | `/api/v5/repos/{owner}/{repo}/pull_request_settings` | 获取 PR 设置 |
| PUT | `/api/v5/repos/{owner}/{repo}/pull_request_settings` | 更新 PR 设置 |
| GET | `/api/v5/repos/{owner}/{repo}/reviewer` | 获取评审人 |
| PUT | `/api/v5/repos/{owner}/{repo}/reviewer` | 设置评审人 |
| GET | `/api/v5/repos/{owner}/{repo}/transition` | 获取仓库迁移状态 |
| PUT | `/api/v5/repos/{owner}/{repo}/transition` | 迁移仓库 |
| POST | `/api/v5/repos/{owner}/{repo}/transfer` | 转移仓库 |
| PUT | `/api/v5/repos/{owner}/{repo}/module_setting` | 更新模块设置 |

### 5.6 Contents/Files（文件管理）— 5 个端点

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v5/repos/{owner}/{repo}/contents/{path}` | 获取文件/目录内容 |
| POST | `/api/v5/repos/{owner}/{repo}/contents/{path}` | **新建文件**（base64 编码） |
| PUT | `/api/v5/repos/{owner}/{repo}/contents/{path}` | 更新文件 |
| DELETE | `/api/v5/repos/{owner}/{repo}/contents/{path}` | 删除文件 |
| GET | `/api/v5/repos/{owner}/{repo}/raw/{path}` | 获取文件原始内容 |

**新建/更新文件请求体**：
```json
{
  "content": "base64编码的文件内容",
  "message": "commit信息",
  "branch": "目标分支",
  "author": {
    "name": "作者名",
    "email": "作者邮箱"
  }
}
```

### 5.7 Branches（分支管理）— 7 个端点

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v5/repos/{owner}/{repo}/branches` | 获取分支列表 |
| GET | `/api/v5/repos/{owner}/{repo}/branches/{branch}` | 获取分支详情 |
| POST | `/api/v5/repos/{owner}/{repo}/branches` | 创建分支 |
| DELETE | `/api/v5/repos/{owner}/{repo}/branches/{name}` | 删除分支 |
| PUT | `/api/v5/repos/{owner}/{repo}/branches/{setting}` | 更新分支设置 |
| DELETE | `/api/v5/repos/{owner}/{repo}/branches/{wildcard}/setting` | 删除通配符分支设置 |
| PUT | `/api/v5/repos/{owner}/{repo}/branches/{wildcard}/setting` | 更新通配符分支设置 |

### 5.8 Commits（提交管理）— 6 个端点

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v5/repos/{owner}/{repo}/commits` | 获取提交列表 |
| GET | `/api/v5/repos/{owner}/{repo}/commits/{sha}` | 获取提交详情 |
| GET | `/api/v5/repos/{owner}/{repo}/commits/{sha}/diff` | 获取提交差异 |
| GET | `/api/v5/repos/{owner}/{repo}/commits/{sha}/patch` | 获取 Patch |
| GET | `/api/v5/repos/{owner}/{repo}/commits/{ref}/comments` | 获取提交评论 |
| POST | `/api/v5/repos/{owner}/{repo}/commits/{sha}/comments` | 创建提交评论 |

### 5.9 Pull Requests（PR 管理）— 42 个端点

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v5/repos/{owner}/{repo}/pulls` | 获取 PR 列表 |
| GET | `/api/v5/repos/{owner}/{repo}/pulls/{number}` | 获取 PR 详情 |
| POST | `/api/v5/repos/{owner}/{repo}/pulls` | **创建 PR** |
| PATCH | `/api/v5/repos/{owner}/{repo}/pulls/{number}` | 更新 PR |
| GET | `/api/v5/repos/{owner}/{repo}/pulls/{number}/files` | 获取 PR 文件变更 |
| GET | `/api/v5/repos/{owner}/{repo}/pulls/{number}/commits` | 获取 PR 关联提交 |
| GET | `/api/v5/repos/{owner}/{repo}/pulls/{number}/comments` | 获取 PR 评论 |
| POST | `/api/v5/repos/{owner}/{repo}/pulls/{number}/comments` | 创建 PR 评论 |
| PATCH | `/api/v5/repos/{owner}/{repo}/pulls/{number}/comments/{id}` | 修改评论 |
| DELETE | `/api/v5/repos/{owner}/{repo}/pulls/{number}/comments/{id}` | 删除评论 |
| GET | `/api/v5/repos/{owner}/{repo}/pulls/{number}/labels` | 获取 PR 标签 |
| POST | `/api/v5/repos/{owner}/{repo}/pulls/{number}/labels` | 添加 PR 标签 |
| PUT | `/api/v5/repos/{owner}/{repo}/pulls/{number}/labels/{name}` | 替换 PR 标签 |
| DELETE | `/api/v5/repos/{owner}/{repo}/pulls/{number}/labels/{name}` | 删除 PR 标签 |
| POST | `/api/v5/repos/{owner}/{repo}/pulls/{number}/assignees` | 设置指派人 |
| DELETE | `/api/v5/repos/{owner}/{repo}/pulls/{number}/assignees` | 移除指派人 |
| POST | `/api/v5/repos/{owner}/{repo}/pulls/{number}/testers` | 设置测试人 |
| DELETE | `/api/v5/repos/{owner}/{repo}/pulls/{number}/testers` | 移除测试人 |
| POST | `/api/v5/repos/{owner}/{repo}/pulls/{number}/approval_reviewers` | 添加审批人 |
| DELETE | `/api/v5/repos/{owner}/{repo}/pulls/{number}/approval_reviewers` | 删除审批人 |
| GET | `/api/v5/repos/{owner}/{repo}/pulls/{number}/option/approval_reviewers` | 获取审批人选项 |
| GET | `/api/v5/repos/{owner}/{repo}/pulls/{number}/option/approval_testers` | 获取测试人选项 |
| PUT | `/api/v5/repos/{owner}/{repo}/pulls/{number}/merge` | 合并 PR |
| GET | `/api/v5/repos/{owner}/{repo}/pulls/{number}/issues` | 获取关联 Issue |
| POST | `/api/v5/repos/{owner}/{repo}/pulls/{number}/linked_issues` | 关联 Issue |
| DELETE | `/api/v5/repos/{owner}/{repo}/pulls/{number}/issues` | 取消关联 Issue |
| POST | `/api/v5/repos/{owner}/{repo}/pulls/{number}/review` | 提交评审 |
| POST | `/api/v5/repos/{owner}/{repo}/pulls/{number}/test` | 提交测试结果 |
| GET | `/api/v5/repos/{owner}/{repo}/pulls/{number}/user_reactions` | 获取用户表情反应 |
| GET | `/api/v5/repos/{owner}/{repo}/pulls/{number}/modify_history` | 获取修改历史 |
| GET | `/api/v5/repos/{owner}/{repo}/pulls/{number}/operate_logs` | 获取操作日志 |
| GET | `/api/v5/repos/{owner}/{repo}/pulls/{number}/files.json` | 获取文件变更（JSON） |
| POST | `/api/v5/repos/{owner}/{repo}/pulls/{number}/discussions/{discussions_id}/comments` | 回复讨论评论 |
| PUT | `/api/v5/repos/{owner}/{repo}/pulls/{number}/comments/{id}/discussions/{id}` | 解决讨论 |
| GET | `/api/v5/repos/{owner}/{repo}/pulls/comment/{comment_id}/modify_history` | 评论修改历史 |
| GET | `/api/v5/repos/{owner}/{repo}/pulls/comment/{comment_id}/user_reactions` | 评论表情反应 |
| PATCH | `/api/v5/repos/{owner}/{repo}/pulls/{number}/assignees` | 更新指派人 |
| PATCH | `/api/v5/repos/{owner}/{repo}/pulls/{number}/testers` | 更新测试人 |
| PUT | `/api/v5/repos/{owner}/{repo}/pulls/{number}/comments/{id}/discussions/{id}` | 更新讨论状态 |

### 5.10 Issues（Issue 管理）— 25 个端点

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v5/repos/{owner}/issues` | 获取用户 Issue 列表 |
| POST | `/api/v5/repos/{owner}/issues` | 创建 Issue |
| GET | `/api/v5/repos/{owner}/{repo}/issues` | 获取仓库 Issue 列表 |
| GET | `/api/v5/repos/{owner}/{repo}/issues/{number}` | 获取 Issue 详情 |
| PATCH | `/api/v5/repos/{owner}/issues/{number}` | 更新 Issue |
| GET | `/api/v5/repos/{owner}/{repo}/issues/{number}/comments` | 获取评论 |
| POST | `/api/v5/repos/{owner}/{repo}/issues/{number}/comments` | 创建评论 |
| PATCH | `/api/v5/repos/{owner}/{repo}/issues/comments/{id}` | 修改评论 |
| DELETE | `/api/v5/repos/{owner}/{repo}/issues/comments/{id}` | 删除评论 |
| GET | `/api/v5/repos/{owner}/{repo}/issues/{number}/labels` | 获取标签 |
| POST | `/api/v5/repos/{owner}/{repo}/issues/{number}/labels` | 添加标签 |
| PUT | `/api/v5/repos/{owner}/{repo}/issues/{number}/labels` | 替换标签 |
| DELETE | `/api/v5/repos/{owner}/{repo}/issues/{number}/labels/{name}` | 删除标签 |
| DELETE | `/api/v5/repos/{owner}/{repo}/issues/{number}/labels` | 清空标签 |
| GET | `/api/v5/repos/{owner}/{repo}/issues/{number}/pull_requests` | 获取关联 PR |
| GET | `/api/v5/repos/{owner}/{repo}/issues/{number}/user_reactions` | 表情反应 |
| GET | `/api/v5/repos/{owner}/{repo}/issues/{number}/modify_history` | 修改历史 |
| GET | `/api/v5/repos/{owner}/{repo}/issues/{number}/related_branches` | 关联分支 |
| PUT | `/api/v5/repos/{owner}/{repo}/issues/{number}/related_branches` | 关联分支 |
| GET | `/api/v5/repos/{owner}/{repo}/issues/{number}/operate_logs` | 操作日志 |
| GET | `/api/v5/repos/{owner}/{repo}/issues/comment/{comment_id}/modify_history` | 评论修改历史 |
| GET | `/api/v5/repos/{owner}/{repo}/issues/comment/{comment_id}/user_reactions` | 评论表情 |
| DELETE | `/api/v5/repos/{owner}/{repo}/labels/{name}` | 删除仓库标签 |
| DELETE | `/api/v5/repos/{owner}/{repo}/issues/comments/{id}` | 删除评论 |

### 5.11 Labels / Milestones / Tags / Releases

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v5/repos/{owner}/{repo}/labels` | 获取标签列表 |
| POST | `/api/v5/repos/{owner}/{repo}/labels` | 创建标签 |
| PATCH | `/api/v5/repos/{owner}/{repo}/labels/{original_name}` | 更新标签 |
| GET | `/api/v5/repos/{owner}/{repo}/milestones` | 获取里程碑列表 |
| POST | `/api/v5/repos/{owner}/{repo}/milestones` | 创建里程碑 |
| PATCH | `/api/v5/repos/{owner}/{repo}/milestones/{number}` | 更新里程碑 |
| DELETE | `/api/v5/repos/{owner}/{repo}/milestones/{number}` | 删除里程碑 |
| GET | `/api/v5/repos/{owner}/{repo}/tags` | 获取标签（Git Tag）列表 |
| POST | `/api/v5/repos/{owner}/{repo}/tags` | 创建 Tag |
| DELETE | `/api/v5/repos/{owner}/{repo}/tags/{tag_name}` | 删除 Tag |
| GET | `/api/v5/repos/{owner}/{repo}/releases` | 获取 Release 列表 |
| GET | `/api/v5/repos/{owner}/{repo}/releases/latest` | 获取最新 Release |
| GET | `/api/v5/repos/{owner}/{repo}/releases/{tag}` | 获取指定 Tag 的 Release |
| POST | `/api/v5/repos/{owner}/{repo}/releases` | 创建 Release |
| PATCH | `/api/v5/repos/{owner}/{repo}/releases/{tag}` | 更新 Release |
| GET | `/api/v5/repos/{owner}/{repo}/releases/{tag}/upload_url` | 获取附件上传地址 |
| GET | `/api/v5/repos/{owner}/{repo}/releases/attach_files/{file_name}/download` | 下载附件 |

### 5.12 Webhooks（Webhook 管理）— 6 个端点

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v5/repos/{owner}/{repo}/hooks` | 获取 Webhook 列表 |
| GET | `/api/v5/repos/{owner}/{repo}/hooks/{id}` | 获取 Webhook 详情 |
| POST | `/api/v5/repos/{owner}/{repo}/hooks` | 创建 Webhook |
| PATCH | `/api/v5/repos/{owner}/{repo}/hooks/{id}` | 更新 Webhook |
| DELETE | `/api/v5/repos/{owner}/{repo}/hooks/{id}` | 删除 Webhook |
| POST | `/api/v5/repos/{owner}/{repo}/hooks/{id}/tests` | 测试 Webhook |

### 5.13 Collaborators / Forks / Protection

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v5/repos/{owner}/{repo}/collaborators` | 获取协作者列表 |
| GET | `/api/v5/repos/{owner}/{repo}/collaborators/{username}` | 获取协作者权限 |
| PUT | `/api/v5/repos/{owner}/{repo}/collaborators/{username}` | 添加协作者 |
| DELETE | `/api/v5/repos/{owner}/{repo}/collaborators/{username}` | 移除协作者 |
| GET | `/api/v5/repos/{owner}/{repo}/collaborators/self/permission` | 获取当前用户权限 |
| GET | `/api/v5/repos/{owner}/{repo}/forks` | 获取 Fork 列表 |
| POST | `/api/v5/repos/{owner}/{repo}/forks` | Fork 仓库 |
| PUT | `/api/v5/repos/{owner}/{repo}/project_labels` | 更新项目标签 |
| GET | `/api/v5/repos/{owner}/{repo}/protect_branches` | 获取分支保护规则 |
| GET | `/api/v5/repos/{owner}/{repo}/protected_tags` | 获取受保护标签 |
| POST | `/api/v5/repos/{owner}/{repo}/protected_tags` | 创建受保护标签 |
| PUT | `/api/v5/repos/{owner}/{repo}/protected_tags/{tag_name}` | 更新受保护标签 |
| DELETE | `/api/v5/repos/{owner}/{repo}/protected_tags/{tag_name}` | 删除受保护标签 |

### 5.14 Git Data / Compare / Image Upload

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v5/repos/{owner}/{repo}/git/trees/{sha}` | 获取 Git Tree |
| GET | `/api/v5/repos/{owner}/{repo}/git/blobs/{sha}` | 获取 Git Blob |
| GET | `/api/v5/repos/{owner}/{repo}/compare/{base}...{head}` | 对比两个分支/提交 |
| GET | `/api/v5/{owner}/{repo}/raw/{head_sha}/{name}` | 获取原始文件 |
| POST | `/api/v5/repos/{owner}/{repo}/img/upload` | 图片上传 |
| POST | `/api/v5/repos/{owner}/{repo}/file_upload` | 文件上传 |

### 5.15 AI Services（AI 服务）— 7 个端点

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/v5/chat/completions` | AI 对话补全（OpenAI 兼容格式） |
| POST | `/api/v5/audio/classification` | 音频分类 |
| POST | `/api/v1/audio/transcriptions` | 音频转录 |
| POST | `/api/v5/detect_yolo` | YOLO 目标检测 |
| POST | `/api/v5/similarity` | 相似度计算 |
| POST | `/api/v5/video/generate` | 视频生成 |
| POST | `/api/v5/video/status` | 查询视频生成状态 |

### 5.16 OAuth（认证授权）— 3 个端点

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/oauth/authorize` | OAuth 授权跳转 |
| POST | `/oauth/token` | 获取 Access Token |

**OAuth 授权流程**：
1. 跳转 `GET /oauth/authorize?client_id={id}&redirect_uri={uri}&response_type=code&scope={scope}&state={state}`
2. 用户授权后获得 `code`
3. 使用 `code` 换取 Token：`POST /oauth/token?grant_type=authorization_code&code={code}&client_id={id}&client_secret={secret}`

---

## 6. 特殊端点

| 端点 | 说明 |
|------|------|
| `PUT /api/v5/repos/{owner}/{repo}/members/{username}` | 仓库成员管理 |
| `回复PR评论` | PR 评论回复（中文 URL） |
| `获取企业Issue状态` | 企业 Issue 状态查询（中文 URL） |

---

## 7. 速率限制

- **默认限制**：400 次/分钟，4000 次/小时
- 超过限制返回 `429 Too Many Requests`

---

## 8. Release Notes（变更日志）

API 文档还包含 Release Notes 页面（约 45 个），记录了各版本的 API 变更：
- 时间范围：2024-11 至 2026-04
- 包含新增端点、参数变更、功能调整等记录

文档地址：https://docs.gitcode.com/docs/apis/release/
