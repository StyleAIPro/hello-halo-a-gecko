# 功能 -- 持久化 Worker 与任务板

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（从现有代码逆向生成）
> 所属模块：modules/agent

## 描述

Hyper Space 多代理协作的运行时基础设施，包含三个子模块：
- **持久化 Worker 循环**（persistent-worker.ts）：使 Worker 在任务间保持活跃，持续轮询邮箱和任务板
- **邮箱服务**（mailbox.ts）：基于文件的持久化消息传递系统，支持直接发送、广播和游标轮询
- **任务板服务**（taskboard.ts）：共享任务板，支持任务发布、认领、状态追踪和能力匹配

## 依赖

- `orchestrator.ts` -- AgentInstance 和 AgentTeam 类型定义
- `config.service.ts` -- 空间目录路径
- `shared/types/mailbox` -- 邮箱消息类型定义
- `shared/types/taskboard` -- 任务板类型定义

## 实现逻辑

### 正常流程

**持久化 Worker 循环**（PersistentWorkerLoop）：
1. `start()` 启动后台主循环（fire-and-forget）
2. 主循环每 3 秒执行一次：
   a. 轮询邮箱消息（`mailboxService.pollMessages()`）
   b. 处理消息：chat/direct 消息执行任务、task_assignment 认领任务、shutdown_request 停止
   c. 空闲时自动认领任务板上的未认领任务（`tryClaimTask()`）
   d. 按优先级排序（urgent > high > normal > low），按能力过滤
3. 执行任务时委派给 `orchestrator.executeOnSingleAgent()`
4. 完成后广播 task_completed 消息并通知空闲

**邮箱服务**（MailboxService）：
1. `initialize()` 为每个 Agent 创建邮箱文件（`~/.aico-bot/spaces/{spaceId}/mailboxes/{agentId}.json`）
2. `postMessage()` 原子追加消息（write-then-rename 模式，NTFS 安全）
3. `pollMessages()` 基于游标读取未读消息
4. `broadcastMessage()` 向空间内所有 Agent 广播（排除发送者）

**任务板服务**（TaskBoardService）：
1. `initialize()` 创建 `taskboard.json` 文件
2. `postTask()` 发布新任务（含优先级、能力要求、重试次数）
3. `claimTask()` 认领任务（仅 `posted` 或 `failed` 且可重试的任务可被认领）
4. `updateTaskStatus()` 更新任务状态（in_progress / completed / failed）
5. `findBestWorker()` 基于能力匹配和空闲状态查找最佳 Worker

### 异常流程

1. **Worker 崩溃**：主循环 catch 错误后将 Agent 状态设为 error
2. **优雅停止**：向 Worker 邮箱发送 shutdown_request，等待确认（超时 30 秒后强制停止）
3. **邮箱写入失败**：原子写入保证数据一致性，临时文件失败时自动清理
4. **任务认领竞争**：先到先得，后续认领者因状态不为 `posted` 被拒绝
5. **任务重试**：失败任务在 retryCount < maxRetries 时可被重新认领

## 涉及 API

- `PersistentWorkerLoop.start()` / `stop()` / `isActive()` -- Worker 生命周期
- `MailboxService.initialize()` / `postMessage()` / `pollMessages()` / `broadcastMessage()` -- 邮箱操作
- `TaskBoardService.initialize()` / `postTask()` / `claimTask()` / `updateTaskStatus()` / `getTasks()` -- 任务板操作

## 涉及数据

- `MailboxFile` -- 邮箱文件格式（messages 数组 + lastReadIndex 游标）
- `TaskBoardFile` -- 任务板文件格式（tasks 数组 + lastModified 时间戳）
- `TaskBoardTask` -- 任务对象（ID、标题、描述、状态、优先级、能力要求、认领信息）
- `MailboxMessage` -- 消息对象（ID、类型、发送者、内容、payload）

## 变更

-> changelog.md
