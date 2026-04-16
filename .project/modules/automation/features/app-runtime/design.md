# 功能 — app-runtime

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：prd/automation-platform-v1.md
> 所属模块：modules/automation/automation-platform-v1

## 描述

App 执行引擎：负责将 App 订阅转换为调度任务和事件总线订阅，管理激活生命周期，控制并发执行，处理单次运行的完整流程（SDK V2 会话创建、流处理、结果记录、记忆管理），以及升级（escalation）超时管理。这是 apps/ 和 platform/ 之间的核心胶水层。

## 依赖

- `apps/manager` — AppManagerService 提供已安装 App 的数据和状态管理
- `apps/spec` — AppSpec 类型定义
- `platform/store` — DatabaseManager 提供数据库实例
- `platform/scheduler` — SchedulerService 定时任务调度
- `platform/event-bus` — EventBusService 事件驱动触发
- `platform/memory` — MemoryService AI 记忆文件管理
- `platform/background` — BackgroundService 进程保活
- `services/agent/sdk-config` — SDK 凭证解析和选项构建
- `services/agent/helpers` — API 凭证获取、工作目录解析
- `services/ai-browser` — AI Browser MCP 服务（按需启用）
- `services/notification.service` — 系统桌面通知

## 实现逻辑

### 正常流程

1. **初始化（initAppRuntime）**
   - 获取应用级数据库，运行迁移（automation_runs + activity_entries）
   - 创建 ActivityStore 和 AppRuntimeService
   - 调用 `activateAll()` 激活所有状态为 `active` 的 automation 类型 App
   - 启动升级超时检查器（每 5 分钟）

2. **激活（activate）**
   - 幂等操作，跳过已激活的 App
   - 跳过非 automation 类型
   - 检查是否有 subscriptions，无则抛出 `NoSubscriptionsError`
   - 为 schedule 类型订阅注册调度任务（支持 every/cron 两种模式）
   - 为 event 类型订阅注册事件总线监听（支持 file/webhook/webpage/rss）
   - 注册后台保活原因（防止进程退出）
   - 将 ActivationState 存入内存 Map

3. **调度任务注册（subscriptionToSchedulerJob）**
   - 读取用户频率覆盖（userOverrides.frequency）
   - 支持 `every`（间隔）和 `cron`（表达式）两种调度模式
   - 幂等：检查已有任务，未变则 resume，变更则重建

4. **事件订阅（subscriptionToEventFilter）**
   - file 类型：监听 `file.*`，支持 glob pattern 和路径过滤
   - webhook 类型：监听 `webhook.received`，支持路径匹配
   - webpage 类型：监听 `webpage.changed`
   - rss 类型：监听 `rss.updated`

5. **手动触发（triggerManually）**
   - 验证 App 存在且可运行（active/paused/error 状态）
   - error 状态自动恢复（等同 resume）
   - 每应用去重：同一 App 同时只能有一个运行或排队的执行
   - 构建触发上下文，调用 `executeWithConcurrency`

6. **并发控制（executeWithConcurrency）**
   - 全局信号量限制最大并发数（默认 10）
   - `tryAcquire` 即时获取，失败则排队等待
   - 排队状态广播给前端显示
   - 每次执行使用独立的 AbortController（`{appId}:{counter}` 键）
   - 执行完成后释放信号量，广播最终状态

7. **单次执行（executeRun）**
   - 生成 runId 和 sessionKey（`app-run-{runId前8位}`）
   - 在 ActivityStore 记录运行开始
   - 解析 API 凭证（支持 userOverrides.modelSourceId）
   - 构建系统提示词（完整 Agent prompt + 自动化上下文 + App 指令 + 记忆 + 报告规则）
   - 构建 Memory 快照并注入初始消息
   - 预插入 History 时间戳标题到 memory.md
   - 创建 MCP 服务器：aico-bot-memory、aico-bot-report、aico-bot-notify
   - 如启用 AI Browser，创建独立的浏览器上下文（scoped browser context）
   - 创建 SDK V2 会话（maxTurns=100, includePartialMessages=false）
   - 打开 SessionWriter（JSONL 持久化，用于"查看过程"）
   - 处理流：收集最终文本、token 使用量、report_to_user 调用
   - 自动续写（Auto-Continue）：AI 未调用 report_to_user 时最多重试 3 次
   - 记录运行完成结果

8. **report_to_user MCP 工具**
   - AI 通过此工具向用户报告结果
   - 支持类型：run_complete、run_skipped、milestone、escalation、output
   - escalation 类型触发等待用户响应状态
   - 根据通知级别（all/important/none）发送系统通知

9. **send_notification MCP 工具**
   - AI 可自主发送外部通知（邮件、企业微信、钉钉、飞书、webhook）
   - 配合 list_notification_channels 检查可用渠道

10. **升级处理（respondToEscalation）**
    - 验证升级记录存在且未回复
    - 记录用户回复
    - 广播升级解决事件
    - 清除 waiting_user 状态
    - 异步触发后续执行（携带升级上下文）

11. **升级超时检查（checkEscalationTimeouts）**
    - 每 5 分钟扫描所有待处理的升级
    - 默认超时 24 小时（可通过 spec.escalation.timeout_hours 配置）
    - 超时后：自动关闭、插入 run_error 条目、状态转为 error、发送通知

12. **连续错误自动暂停**
    - 最近 5 次运行均为 error 时自动暂停 App
    - 状态转为 error，deactivate 停止调度

13. **记忆压缩（checkAndCompactMemory）**
    - 当 memory.md 超过 100KB 时触发压缩
    - 归档旧 memory.md 到 memory/ 目录
    - 通过 LLM 生成精简摘要（支持格式验证 + 重试）
    - 回退方案：代码级提取 `# now` 和 `# History` 两个必要标题

14. **数据清理（pruneOldData）**
    - 自动删除超过 1 年的历史运行记录（CASCADE 删除关联条目）
    - 每 24 小时最多执行一次

15. **运行会话摘要（saveRunSessionSummary）**
    - 为每次运行生成 markdown 摘要写入记忆归档
    - 跳过 noop 运行
    - 包含 App 名、触发类型、结果、时长、token 用量、AI 输出

### 异常流程

1. **App 不存在**：抛出 `AppNotFoundError`
2. **无可订阅项**：抛出 `NoSubscriptionsError`
3. **并发限制**：同一 App 重复触发抛出 `ConcurrencyLimitError`（isPerApp=true）
4. **全局并发饱和**：排队等待，不抛出
5. **SDK 执行失败**：记录 error 活动、返回 error 结果、写入错误摘要
6. **AI 未调用 report_to_user**：自动续写 3 次后标记为 error
7. **会话关闭失败**：finally 块中 catch 不阻塞
8. **浏览器上下文清理**：finally 中 destroy，不阻塞
9. **记忆压缩失败**：best-effort，记录日志不中断运行
10. **凭证解析失败**：executeRun 整体失败，记录 error

## 涉及 API

→ 无独立 HTTP API，通过 IPC 通道暴露

## 涉及数据

→ db/schema.md

SQLite 表结构：
- `automation_runs`：run_id(PK), app_id(FK), session_key, status, trigger_type, trigger_data_json, started_at, finished_at, duration_ms, tokens_used, error_message
- `activity_entries`：id(PK), app_id(FK), run_id(FK), type, ts, session_key, content_json, user_response_json
- 索引：`idx_runs_app`(app_id, started_at DESC), `idx_entries_app`(app_id, ts DESC), `idx_entries_run`(run_id), `idx_runs_status`(status)

文件系统：
- 运行会话 JSONL：`{spacePath}/.aico-bot/apps/{appId}/runs/{runId}.jsonl`
- 聊天会话 JSONL：`{spacePath}/.aico-bot/apps/{appId}/runs/chat.jsonl`

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/main/apps/runtime/index.ts` | 模块入口，初始化/关闭，单例管理 |
| `src/main/apps/runtime/service.ts` | 核心编排层：激活、调度、事件、并发、升级 |
| `src/main/apps/runtime/execute.ts` | 单次执行引擎：SDK 会话、流处理、记忆管理 |
| `src/main/apps/runtime/store.ts` | SQLite CRUD（automation_runs + activity_entries） |
| `src/main/apps/runtime/types.ts` | 公共类型定义 |
| `src/main/apps/runtime/errors.ts` | 领域错误类型 |
| `src/main/apps/runtime/prompt.ts` | 自动化模式系统提示词构建 |
| `src/main/apps/runtime/prompt-chat.ts` | 聊天模式系统提示词构建 |
| `src/main/apps/runtime/report-tool.ts` | report_to_user MCP 工具 |
| `src/main/apps/runtime/notify-tool.ts` | send_notification MCP 工具 |
| `src/main/apps/runtime/concurrency.ts` | 信号量并发控制 |
| `src/main/apps/runtime/session-store.ts` | JSONL 会话持久化与读取 |
| `src/main/apps/runtime/migrations.ts` | 数据库迁移（v1 建表，v2 加索引） |

## 变更

→ changelog.md
