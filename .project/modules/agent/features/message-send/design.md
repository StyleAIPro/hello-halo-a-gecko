# 功能 -- 消息发送流程

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（从现有代码逆向生成）
> 所属模块：modules/agent

## 描述

Agent 模块的消息发送主入口，负责将用户消息路由到正确的执行路径（本地、远程、Hyper Space），管理完整的消息生命周期：凭证解析、会话创建、流式处理、内容持久化、错误恢复和中断处理。

## 依赖

- `session-manager.ts` -- V2 会话获取/注册/注销
- `stream-processor.ts` -- 流式响应处理（`processStream`）
- `sdk-config.ts` -- 凭证解析和 SDK 选项构建
- `message-utils.ts` -- 消息内容构建（多模态、画布上下文）
- `orchestrator.ts` -- Hyper Space 路由和团队管理
- `remote-ws/remote-ws-client.ts` -- 远程 WebSocket 客户端
- `remote-ssh/ssh-tunnel.service.ts` -- SSH 隧道建立
- `conversation.service.ts` -- 消息持久化
- `control.ts` -- 生成控制（停止、状态查询）

## 实现逻辑

### 正常流程

1. **路由判断**：检查 `space.claudeSource` 和 `space.spaceType`，决定走本地、远程或 Hyper Space 路径
2. **本地路径**：
   a. 解析 API 凭证并构建 SDK 选项（含 MCP 服务器、AI Browser、gh-search 等）
   b. 获取或创建 V2 会话
   c. 设置运行时参数（模型、Thinking 模式）
   d. 构建消息内容（画布上下文前缀 + 多模态图片）
   e. 调用 `processStream()` 处理流式响应
   f. 循环处理 turn-level 消息注入（Worker 报告、认证重试）
   g. 持久化内容、thoughts、token 用量、文件变更摘要
3. **远程路径**（`executeRemoteMessage`）：
   a. 建立 SSH 隧道（可选）
   b. 检查/部署/启动远程 Agent
   c. 建立带连接池的 WebSocket 连接
   d. 注册 MCP Bridge 本地工具（供远程 Claude 调用）
   e. 发送聊天请求（增量或全量消息历史）
   f. 处理流式响应（thought、tool call、terminal output 等事件）
4. **Hyper Space 路径**：
   a. 创建或获取团队
   b. 路由到目标 Agent（Leader 或 @mention 指定的 Worker）
   c. 调用 `orchestrator.executeOnSingleAgent()`

### 异常流程

1. **用户中断**：AbortError 触发，持久化已生成的内容和 thoughts
2. **认证重试**：SDK 检测到 401 时，重新解析凭证并重建会话（最多 1 次）
3. **远程连接失败**：SSH 隧道或 WebSocket 连接错误，抛出异常并持久化已累积内容
4. **Windows 环境问题**：检测 Git Bash 配置，提供友好错误提示
5. **stderr 错误提取**：从 CLI stderr 缓冲区提取 MCP 配置错误等详细信息

## 涉及 API

- `sendMessage(mainWindow, request)` -- 消息发送主入口
- `executeRemoteMessage()` -- 远程执行（内部函数）
- `invalidateAuthTokenCache()` -- 使认证令牌缓存失效

## 涉及数据

- `authTokenCache: Map<serverId, AuthTokenCacheEntry>` -- 远程认证令牌缓存（5 分钟 TTL）
- `activeSessions` -- 注册进行中会话状态

## 变更

-> changelog.md
