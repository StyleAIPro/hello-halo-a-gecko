# 功能 -- SDK 会话管理

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（从现有代码逆向生成）
> 所属模块：modules/agent

## 描述

管理 Claude Code SDK V2 会话的完整生命周期，包括创建、复用、预热、健康检查、迁移和销毁。V2 会话通过进程复用避免每次消息都重启 CC 子进程（冷启动约 3-5s），是 Agent 模块的核心基础设施。

## 依赖

- `@anthropic-ai/claude-agent-sdk` -- SDK V2 会话 API（`unstable_v2_createSession`）
- `sdk-config.ts` -- 构建会话所需的 SDK 选项（凭证解析、环境变量、沙箱配置）
- `helpers.ts` -- 工作目录、API 凭证获取
- `conversation.service.ts` -- 对话持久化、sessionId 存取
- `config.service.ts` -- API 配置变更通知（`onApiConfigChange`）
- `health.ts` -- 进程注册/注销（孤儿进程检测）

## 实现逻辑

### 正常流程

1. **会话复用检查**：调用 `getOrCreateV2Session()` 时，先在 `v2Sessions` Map 中查找已有会话
2. **进程存活检测**：通过 `isSessionTransportReady()` 检查 SDK 内部 transport 状态，确认子进程仍存活
3. **凭证变更检测**：比对 `credentialsGeneration`，如变更且无进行中请求，则重建会话
4. **会话创建**：调用 `unstable_v2_createSession()`，传入模型、工作目录、MCP 服务器等配置
5. **MCP 服务器注册**：通过 `query.setMcpServers()` 注册 SDK 内部 MCP 实例（绕过 V2 构造器缺陷）
6. **进程退出监听**：通过 `transport.onExit()` 注册事件驱动清理，避免文件描述符泄漏
7. **会话迁移**：从旧目录 `~/.claude/` 迁移会话文件到新目录 `~/.agents/claude-config/`
8. **定期清理**：每 60 秒轮询检测闲置会话（30 分钟超时）、卡死会话（45 分钟无活动）、不健康会话（连续 5 次健康检查失败）

### 异常流程

1. **进程死亡**：`isSessionTransportReady()` 返回 false，清理旧会话后重建
2. **凭证变更时进行中请求**：加入 `pendingInvalidations` 集合，请求完成后再清理
3. **会话迁移失败**：扫描所有项目目录查找会话文件，仍找不到则创建全新会话
4. **健康检查超时**：强制重启卡死会话，清理健康状态
5. **上下文压缩**：支持手动触发 `compactContext()` 和自动压缩通知

## 涉及 API

- `getOrCreateV2Session()` -- 获取或创建 V2 会话
- `ensureSessionWarm()` -- 预热会话（用户切换对话时调用）
- `closeV2Session()` / `closeAllV2Sessions()` -- 关闭会话
- `invalidateAllSessions()` -- API 配置变更时使所有会话失效
- `compactContext()` -- 手动上下文压缩

## 涉及数据

- `v2Sessions: Map<conversationId, V2SessionInfo>` -- 持久会话映射
- `activeSessions: Map<conversationId, SessionState>` -- 进行中请求映射
- `sessionHealthMap: Map<conversationId, SessionHealthStatus>` -- 健康状态映射

## 变更

-> changelog.md
