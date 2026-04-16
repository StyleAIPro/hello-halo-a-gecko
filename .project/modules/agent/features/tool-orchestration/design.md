# 功能 -- 工具编排与多代理团队

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（从现有代码逆向生成）
> 所属模块：modules/agent

## 描述

Hyper Space 多代理编排系统。管理代理团队（Leader + Workers）的创建与销毁、任务分发与路由、本地/远程代理执行、结果聚合、完成通知和停滞检测。支持持久化 Worker 循环模式，使 Worker 在任务间保持活跃。

## 依赖

- `mailbox.ts` -- 代理间邮箱消息系统
- `taskboard.ts` -- 共享任务板
- `persistent-worker.ts` -- 持久化 Worker 循环
- `permission-handler.ts` -- 工具权限处理
- `sdk-config.ts` -- SDK 选项构建
- `session-manager.ts` -- V2 会话管理
- `stream-processor.ts` -- 流式处理
- `conversation.service.ts` -- 消息持久化

## 实现逻辑

### 正常流程

1. **团队创建**（`createTeam`）：
   a. 验证至少有一个 Leader Agent
   b. 创建 AgentInstance（Leader + Workers）
   c. 初始化邮箱系统（每个 Agent 一个邮箱文件）
   d. 初始化任务板
2. **单 Agent 执行**（`executeOnSingleAgent`）：
   a. 本地代理：调用 `executeAgentLocally()`，创建独立 V2 会话
   b. 远程代理：调用 `executeAgentRemotely()`，通过远程部署服务执行
3. **团队上下文生成**（`getTeamContextForPrompt`）：
   a. 生成包含团队角色、能力、规则的系统提示
   b. Leader 获得委派指令，Worker 获得执行约束
4. **spawn_subagent 处理**：
   a. 通过 turn-level 注入机制将子代理 spawn 请求注入 Leader 会话
   b. 限制嵌套深度（最多 50 层）和每 Agent 并发子代理数（最多 5 个）
   c. Worker 报告结果通过 `reportToLeader()` 注入 Leader 会话
5. **停滞检测**：定期检查 Agent 心跳和任务时长，超时触发 `task:stalled` 事件

### 异常流程

1. **Agent 执行失败**：标记任务为 failed，广播失败通知
2. **停滞检测**：心跳超时（5 分钟）或任务时长超时（1 小时）
3. **团队销毁**（`destroyTeam`）：停止持久化 Worker、销毁邮箱和任务板、清理所有会话
4. **无限循环防护**：`spawnCycleCount` 限制防止 spawn 注入无限循环

## 涉及 API

- `createTeam()` / `destroyTeam()` -- 团队生命周期
- `executeOnSingleAgent()` -- 单 Agent 执行
- `getTeamContextForPrompt()` -- 生成团队上下文系统提示
- `reportToLeader()` / `sendAnnouncement()` / `sendAgentMessage()` -- 代理间通信
- `getWorkerSessionStates()` -- Worker 状态恢复（页面刷新后）

## 涉及数据

- `AgentTeam` -- 团队运行时状态（Leader、Workers、配置、turnThoughts）
- `AgentInstance` -- Agent 运行时状态（ID、配置、状态、当前任务）
- `SubagentTask` -- 子代理任务状态
- `teams: Map<teamId, AgentTeam>` -- 活跃团队
- `persistentWorkers: Map<agentId, PersistentWorkerLoop>` -- 持久化 Worker

## 变更

-> changelog.md
