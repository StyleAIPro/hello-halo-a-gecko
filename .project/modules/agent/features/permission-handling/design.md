# 功能 -- 权限处理与转发

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（从现有代码逆向生成）
> 所属模块：modules/agent

## 描述

管理 Agent 工具调用的权限审批流程。通过 `dangerously-skip-permissions` 模式自动允许大部分工具，但特殊处理 `AskUserQuestion` 工具（暂停执行等待用户回答）。在多代理场景中，Worker 的权限请求通过邮箱系统转发给 Leader，由用户在 UI 中审批。

## 依赖

- `helpers.ts` -- `sendToRenderer` 向渲染进程发送事件
- `mailbox.ts` -- 权限请求转发（多代理场景）

## 实现逻辑

### 正常流程

1. **自动允许**：`createCanUseTool()` 返回的回调函数默认对所有非 AskUserQuestion 工具返回 `{ behavior: 'allow' }`
2. **AskUserQuestion 处理**：
   a. 生成唯一问题 ID
   b. 创建 Promise 等待用户回答
   c. 通过 `sendToRenderer('agent:ask-question')` 发送问题到前端
   d. 前端提交答案后，IPC handler 调用 `resolveQuestion()` 解析 Promise
   e. 返回 `{ behavior: 'allow', updatedInput: { ...input, answers } }`
3. **权限转发**（`permission-forwarder.ts`）：
   a. Worker 需要权限时，`forwardRequest()` 将请求发送到 Leader 邮箱
   b. Leader 收到后通过 IPC 转发到渲染进程
   c. 用户审批后，`postResponse()` 将结果发回 Worker 邮箱
   d. Worker 的 `handleResponse()` 解析等待中的 Promise

### 异常流程

1. **用户中断**：AbortSignal 触发时拒绝待处理问题
2. **问题取消**：`rejectQuestion()` 或 `rejectAllQuestions()` 取消等待中的问题
3. **权限超时**：权限请求默认 5 分钟超时，超时视为拒绝（`QUESTION_TIMEOUT_MS = 5 * 60 * 1000`）
4. **无 deps 调用**：预热场景中 AskUserQuestion 无 deps，自动允许并返回空答案
5. **渲染进程拒绝**：renderer 通过 `agent:reject-question` IPC 通道主动拒绝问题（`stopGeneration` 时调用 `rejectAllQuestions`）

## 涉及 API

- `createCanUseTool(deps?)` -- 创建工具权限处理器
- `resolveQuestion(id, answers)` -- 解析用户回答
- `rejectQuestion(id)` / `rejectAllQuestions()` -- 拒绝问题
- `PermissionForwarder.forwardRequest()` -- 转发权限请求
- `PermissionForwarder.handleResponse()` -- 处理权限响应
- `PermissionForwarder.postResponse()` -- 发送权限响应到 Worker

## 涉及数据

- `pendingQuestions: Map<questionId, PendingQuestionEntry>` -- 待处理问题注册表
- `PermissionForwarder.pendingRequests: Map<requestId, PendingPermissionRequest>` -- 待处理权限请求

## 变更

-> changelog.md
