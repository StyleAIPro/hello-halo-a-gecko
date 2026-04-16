# 05-Digital Humans 平台设计

## 5.1 概述

Digital Humans 平台是 AICO-Bot 的自动化 AI 智能体运行平台，位于 `src/main/apps/` 目录下。它允许用户在 WorkSpace（空间）中安装和管理持久化的 AI 智能体（称为 App），这些 App 可以根据预设的调度计划、事件触发或手动指令自主执行任务。

### 5.1.1 平台定位

- 自动化 AI 智能体在后台按调度/事件驱动运行，无需用户实时在线
- 每个 App 拥有独立的系统提示词、内存文件、工作目录和活动记录
- 支持通过 `report_to_user` MCP 工具向用户汇报执行结果，通过 `escalation` 机制请求用户决策

### 5.1.2 三种 App 类型

| 类型 | 用途 | 运行时行为 |
|------|------|------------|
| `automation` | 自动化智能体，按调度/事件运行 | 独立 V2 会话，执行 `executeRun()` |
| `mcp` | MCP 服务器包装器 | 提供 `mcp_server` 配置，供 Claude Code 调用 |
| `skill` | 技能扩展（预留） | 供其他 App 依赖使用 |
| `extension` | 扩展类型（预留） | 预留，尚未实现 |

### 5.1.3 YAML 规格定义

App 通过 YAML 格式的文件定义其规格（App Spec）。YAML 文件经解析、规范化（别名展开、简写展开）后，通过 Zod Schema 验证，最终生成 `AppSpec` 类型对象。

---

## 5.2 App Spec 系统

源码位置：`src/main/apps/spec/`

### 5.2.1 设计原则

- **Zod Schema 作为唯一真相源**：TypeScript 类型通过 `z.infer<>` 从 Schema 推导，不手动编写
- 可选字段统一使用 `.optional()`，不使用 `.nullable()`
- 通过 `discriminatedUnion` 区分不同订阅源类型的配置
- 使用 `.superRefine()` 实现跨字段约束

### 5.2.2 AppSpecBaseSchema 字段一览

基础 Schema `AppSpecBaseSchema` 包含以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `spec_version` | `string` (默认 `"1"`) | 规格版本，用于前向兼容 |
| `name` | `nonEmptyString` | App 显示名称 |
| `version` | `versionString` | App 版本号 |
| `author` | `nonEmptyString` | 作者 |
| `description` | `nonEmptyString` | 描述 |
| `type` | `AppTypeSchema` | 枚举：`"mcp" | "skill" | "automation" | "extension"` |
| `icon` | `string?` | 图标标识或 URL |
| `system_prompt` | `string?` | 核心系统提示词，automation/skill 类型必填 |
| `requires` | `RequiresSchema?` | 依赖声明（MCP + Skill） |
| `subscriptions` | `SubscriptionDefSchema[]?` | 订阅定义，仅 automation 类型允许 |
| `filters` | `FilterRuleSchema[]?` | 事件过滤规则 |
| `memory_schema` | `MemorySchemaSchema?` | 内存结构定义，仅 automation 类型允许 |
| `config_schema` | `InputDefSchema[]?` | 用户配置表单定义 |
| `output` | `OutputConfigSchema?` | 输出配置（通知 + 格式） |
| `permissions` | `string[]?` | 权限声明（如 `"ai-browser"`） |
| `mcp_server` | `McpServerConfigSchema?` | MCP 服务器配置，仅 mcp 类型允许 |
| `escalation` | `EscalationConfigSchema?` | 升级行为配置 |
| `recommended_model` | `string?` | 推荐模型（信息性，不用于运行时） |
| `store` | `StoreMetadataSchema?` | 商店元数据 |
| `i18n` | `Record<string, I18nBlock>?` | 区域化显示文本覆盖 |

### 5.2.3 子 Schema 详解

**订阅源类型（Discriminated Union）**：

`SubscriptionSourceSchema` 是 `discriminatedUnion('type')`，包含 6 种源类型：

| 源类型 | 配置字段 |
|--------|----------|
| `schedule` | `every` (durationString, 如 `"30m"`) / `cron` (cronString) |
| `file` | `pattern` (glob 模式) / `path` (目录) |
| `webhook` | `path` (webhook 路径) / `secret` (HMAC 密钥) |
| `webpage` | `watch` / `selector` / `url` |
| `rss` | `url` (RSS feed 地址) |
| `custom` | `Record<string, unknown>` 自由配置 |

`schedule` 类型需满足互斥约束：`every` 和 `cron` 二选一（通过 `.refine()` 实现）。

**FilterRuleSchema**（过滤规则）：

```
{ field: string, op: FilterOp, value: unknown }
```

`FilterOp` 枚举：`"eq" | "neq" | "contains" | "matches" | "gt" | "lt" | "gte" | "lte"`

**InputDefSchema**（配置字段定义）：

```
{ key, label, type, description?, required?, default?, placeholder?, options? }
```

`InputType` 枚举：`"url" | "text" | "string" | "number" | "select" | "boolean" | "email"`

`select` 类型必须有至少一个 `options` 选项（通过 `.refine()` 验证）。

**EscalationConfigSchema**：

```
{ enabled?: boolean, timeout_hours?: number }
```

### 5.2.4 解析流程

解析流程由三个步骤组成：`parseYamlString` -> `normalizeRawSpec` -> `validateAppSpec`。

```
YAML 字符串
    │
    ▼ parseYamlString()
JS 对象 (raw)
    │
    ▼ normalizeRawSpec()
规范化对象
    │
    ▼ validateAppSpec()
AppSpec (类型安全)
```

**步骤 1：YAML 解析**（`parseYamlString`，位于 `parse.ts`）
- 使用 `yaml` 库的 `parse()` 函数
- 校验输入为非空字符串
- 校验解析结果为对象类型（非标量或数组）
- 解析失败抛出 `AppSpecParseError`（code: `APP_SPEC_PARSE_ERROR`）

**步骤 2：规范化**（`normalizeRawSpec`，位于 `parse.ts`）
- 在浅克隆上操作，不修改原始对象
- 字段别名展开：
  - `inputs` -> `config_schema`
  - `required_mcps` -> `requires.mcps`
  - `required_skills` -> `requires.skills`
  - `requires.mcp` -> `requires.mcps`（单数别名）
  - `requires.skill` -> `requires.skills`（单数别名）
  - `subscriptions[].input` -> `subscriptions[].config_key`
- 订阅简写展开：如果订阅对象顶层有 `type` 但无 `source`，自动包装为 `{ source: { type, config } }`
- MCP 依赖规范化：字符串数组 `["ai-browser"]` 转为 `[{ id: "ai-browser" }]`

**步骤 3：Zod 验证**（`validateAppSpec`，位于 `validate.ts`）
- 调用 `AppSpecSchema.parse()`
- `ZodError` 转换为 `AppSpecValidationError`（code: `APP_SPEC_VALIDATION_ERROR`）
- 错误结构化：每个 issue 包含 `path`（点分隔路径）、`message`、`received?`

### 5.2.5 跨字段验证规则

通过 `AppSpecSchema.superRefine()` 实现：

1. **`automation` 类型必须有 `system_prompt`**
2. **`skill` 类型必须有 `system_prompt`**
3. **`mcp` 类型必须有 `mcp_server`**
4. **`subscriptions` 仅 `automation` 类型允许**
5. **`memory_schema` 仅 `automation` 类型允许**
6. **`mcp_server` 仅 `mcp` 类型允许**
7. **订阅 ID 唯一性**：同一 spec 内不能有重复的 subscription id（含自动生成的 `sub_N`）
8. **`config_key` 引用存在性**：订阅中的 `config_key` 必须在 `config_schema` 中有对应 `key`

### 5.2.6 错误类型

| 错误类 | Code | 抛出场景 |
|--------|------|----------|
| `AppSpecParseError` | `APP_SPEC_PARSE_ERROR` | YAML 语法错误、空文档、非对象 |
| `AppSpecValidationError` | `APP_SPEC_VALIDATION_ERROR` | Zod Schema 验证失败，包含 `issues: ValidationIssue[]` |

---

## 5.3 App Manager（生命周期管理）

源码位置：`src/main/apps/manager/`

### 5.3.1 InstalledApp 接口

```typescript
interface InstalledApp {
  id: string                                    // UUID v4，安装 ID
  specId: string                                // 规格标识符（取自 spec.name）
  spaceId: string                               // 所属空间 ID
  spec: AppSpec                                 // App 规格快照（安装时设定，可更新）
  status: AppStatus                             // 运行时状态
  pendingEscalationId?: string                  // 待处理升级 ID（指向 activity_entries 记录）
  userConfig: Record<string, unknown>           // 用户配置值
  userOverrides: {
    frequency?: Record<string, string>           // 订阅 ID -> 频率覆盖
    notificationLevel?: 'all' | 'important' | 'none'  // 通知级别，默认 'important'
    modelSourceId?: string                       // AI 源覆盖
    modelId?: string                             // 模型覆盖
  }
  permissions: { granted: string[], denied: string[] }  // 权限授予/拒绝
  installedAt: number                           // 安装时间戳 (ms)
  lastRunAt?: number                            // 上次运行时间戳
  lastRunOutcome?: RunOutcome                   // 上次运行结果
  errorMessage?: string                         // 上次错误信息
  uninstalledAt?: number                        // 软删除时间戳
}
```

`RunOutcome` 类型：`"useful" | "noop" | "error" | "skipped"`

### 5.3.2 AppStatus 状态机

```typescript
type AppStatus = 'active' | 'paused' | 'error' | 'needs_login' | 'waiting_user' | 'uninstalled'
```

状态转换矩阵（`VALID_TRANSITIONS`，位于 `service.ts`）：

| 当前状态 | 可转换到的状态 |
|----------|----------------|
| `active` | `paused`, `error`, `needs_login`, `waiting_user`, `uninstalled` |
| `paused` | `active`, `uninstalled` |
| `error` | `active`, `paused`, `uninstalled` |
| `needs_login` | `active`, `paused`, `uninstalled` |
| `waiting_user` | `active`, `paused`, `error`, `uninstalled` |
| `uninstalled` | `active`（重新安装） |

非法转换抛出 `InvalidStatusTransitionError`（包含 `appId`、`fromStatus`、`toStatus`）。

### 5.3.3 SQLite 存储层（AppManagerStore）

位于 `store.ts`，所有操作基于 prepared statements，构造时一次性预编译。

**表结构**（`installed_apps`）：

```sql
CREATE TABLE installed_apps (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  pending_escalation_id TEXT,
  user_config_json TEXT NOT NULL DEFAULT '{}',
  user_overrides_json TEXT NOT NULL DEFAULT '{}',
  permissions_json TEXT NOT NULL DEFAULT '{"granted":[],"denied":[]}',
  installed_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_run_outcome TEXT,
  error_message TEXT,
  uninstalled_at INTEGER,
  UNIQUE(spec_id, space_id)
);
```

**索引**：
- `idx_installed_apps_space` ON `(space_id)`
- `idx_installed_apps_status` ON `(status)`

**Prepared Statements**（共 12 条）：

| 语句 | 用途 |
|------|------|
| `stmtInsert` | 插入新安装记录 |
| `stmtGetById` | 按 ID 查询 |
| `stmtGetBySpecAndSpace` | 按规格+空间查重 |
| `stmtListAll` | 列出所有（按 `installed_at DESC`） |
| `stmtDeleteById` | 硬删除 |
| `stmtUpdateStatus` | 更新状态+升级ID+错误信息 |
| `stmtUpdateConfig` | 更新用户配置 |
| `stmtUpdateOverrides` | 更新用户覆盖 |
| `stmtUpdatePermissions` | 更新权限 |
| `stmtUpdateLastRun` | 更新上次运行记录 |
| `stmtUpdateSpec` | 更新规格快照 |
| `stmtUpdateUninstalledAt` | 更新软删除时间戳 |

Store 层不执行业务规则校验，仅负责序列化/反序列化和 SQL 操作。

### 5.3.4 Service 方法

`AppManagerService` 接口定义了以下方法（实现位于 `service.ts`）：

**安装相关**：
- `install(spaceId, spec, userConfig?)` -> `Promise<string>`：安装 App，返回 appId
- `uninstall(appId, options?)` -> `Promise<void>`：软删除，设置 `uninstalled_at`
- `reinstall(appId)` -> `void`：从 `uninstalled` 恢复到 `active`
- `deleteApp(appId)` -> `Promise<void>`：硬删除数据库记录 + 可选清除工作目录

**状态管理**：
- `pause(appId)` -> `void`：暂停，仅允许从 `active` 转换
- `resume(appId)` -> `void`：恢复，允许从 `paused`/`error`/`needs_login` 转换
- `updateStatus(appId, status, extra?)` -> `void`：运行时状态更新

**配置**：
- `updateConfig(appId, config)` -> `void`：替换整个 userConfig
- `updateFrequency(appId, subscriptionId, frequency)` -> `void`：更新频率覆盖
- `updateOverrides(appId, partial)` -> `void`：合并更新 userOverrides
- `updateSpec(appId, specPatch)` -> `void`：JSON Merge Patch 语义更新规格

**运行跟踪**：
- `updateLastRun(appId, outcome, errorMessage?)` -> `void`

**查询**：
- `getApp(appId)` -> `InstalledApp | null`
- `listApps(filter?)` -> `InstalledApp[]`

**权限**：
- `grantPermission(appId, permission)` -> `void`：授予权限
- `revokePermission(appId, permission)` -> `void`：撤销权限

**文件系统**：
- `getAppWorkDir(appId)` -> `string`：获取/确保工作目录存在

**事件**：
- `onAppStatusChange(handler)` -> `Unsubscribe`：注册状态变更回调

### 5.3.5 安装流程

```
install(spaceId, spec, userConfig)
    │
    ├─ 1. 验证 space 存在 (getSpacePath)
    │     └─ 不存在 -> SpaceNotFoundError
    │
    ├─ 2. 验证 spec (validateAppSpec)
    │     └─ 失败 -> AppSpecValidationError
    │
    ├─ 3. 检查重复 (getBySpecAndSpace: spec.name + spaceId)
    │     └─ 已存在 -> AppAlreadyInstalledError
    │
    ├─ 4. 生成 UUID v4 (appId)
    │
    ├─ 5. 构建 InstalledApp 记录
    │     - status: 'active'
    │     - userConfig / userOverrides: {} / {}
    │     - permissions: { granted: [], denied: [] }
    │     - installedAt: Date.now()
    │
    ├─ 6. 持久化到 SQLite (store.insert)
    │     └─ UNIQUE 约束冲突 -> AppAlreadyInstalledError
    │         （处理并发安装场景）
    │
    ├─ 7. 创建工作目录
    │     - {spacePath}/.aico-bot/apps/{appId}/
    │     - {spacePath}/.aico-bot/apps/{appId}/memory/
    │     └─ 失败 -> 回滚数据库记录 (store.delete)
    │
    └─ 8. 返回 appId
```

### 5.3.6 工作目录结构

```
{spacePath}/.aico-bot/apps/{appId}/
├── memory/          # AI 内存文件目录
│   ├── memory.md    # 当前内存文件
│   └── run/         # 归档文件
└── runs/            # 运行会话 JSONL 文件
    ├── {runId}.jsonl
    └── chat.jsonl   # 交互式聊天会话
```

### 5.3.7 数据库迁移

迁移命名空间：`app_manager`

| 版本 | 描述 | 操作 |
|------|------|------|
| v1 | 创建 installed_apps 表 + 索引 | `CREATE TABLE installed_apps` + 两个索引 |
| v2 | 添加软删除支持 | `ALTER TABLE installed_apps ADD COLUMN uninstalled_at INTEGER` |

### 5.3.8 自定义错误类型

| 错误类 | 携带信息 | 抛出场景 |
|--------|----------|----------|
| `AppNotFoundError` | `appId` | 按 ID 查询不到 App |
| `AppAlreadyInstalledError` | `specId`, `spaceId` | 同规格同空间重复安装 |
| `InvalidStatusTransitionError` | `appId`, `fromStatus`, `toStatus` | 非法状态转换 |
| `SpaceNotFoundError` | `spaceId` | 安装时引用的空间不存在 |

---

## 5.4 App Runtime（运行引擎）

源码位置：`src/main/apps/runtime/`

### 5.4.1 TriggerType

```typescript
type TriggerType = 'schedule' | 'event' | 'manual' | 'escalation_followup'
```

| 触发类型 | 场景 | 上下文信息 |
|----------|------|------------|
| `schedule` | 调度器到期触发 | `jobId`，调度描述 |
| `event` | 事件总线触发 | `eventPayload` |
| `manual` | 用户/AI 手动触发 | 无 |
| `escalation_followup` | 用户响应升级后重新触发 | `escalation: { originalQuestion, userResponse }` |

### 5.4.2 AppRuntimeService 接口

```typescript
interface AppRuntimeService {
  // 激活/停用
  activate(appId: string): Promise<void>
  deactivate(appId: string): Promise<void>
  syncAppSchedule(appId: string): void
  // 执行
  triggerManually(appId: string): Promise<AppRunResult>
  // 状态查询
  getAppState(appId: string): AutomationAppState
  // 升级
  respondToEscalation(appId: string, entryId: string, response: EscalationResponse): Promise<void>
  // 活动查询
  getActivityEntries(appId: string, options?: ActivityQueryOptions): ActivityEntry[]
  getRun(runId: string): AutomationRun | null
  getRunsForApp(appId: string, limit?: number): AutomationRun[]
  // 生命周期
  activateAll(): Promise<void>
  deactivateAll(): Promise<void>
}
```

### 5.4.3 激活流程（activate）

```
activate(appId)
    │
    ├─ 幂等检查：activations.has(appId) -> 跳过
    ├─ 校验：App 存在且 type === 'automation'
    ├─ 校验：spec.subscriptions 非空 -> NoSubscriptionsError
    │
    ├─ 创建 ActivationState：
    │     { appId, schedulerJobIds: [], eventUnsubscribers: [], keepAliveDisposer: null }
    │
    ├─ 注册调度器任务（schedule 类型订阅）
    │     ├─ 检查同名任务是否已存在
    │     ├─ 已存在且 schedule 变化 -> remove + re-add（重置锚点时间）
    │     └─ 已存在且 schedule 未变 -> resumeJob
    │
    ├─ 注册事件总线订阅（file/webhook/webpage/rss 类型订阅）
    │     ├─ 构建 EventFilter（含 rules）
    │     └─ eventBus.on(filter, callback) -> 收集 unsub 函数
    │
    ├─ 注册 keep-alive（background.registerKeepAliveReason）
    │     原因字符串："automation-apps-active:{appId}"
    │
    └─ 存入 activations Map
```

**事件过滤器映射**（`subscriptionToEventFilter`）：

| 订阅源类型 | EventFilter.types | 附加规则 |
|------------|-------------------|----------|
| `file` | `['file.*']` | `payload.relativePath` matches pattern / `payload.filePath` contains path |
| `webhook` | `['webhook.received']` | `payload.path` eq webhook path |
| `webpage` | `['webpage.changed']` | 无 |
| `rss` | `['rss.updated']` | 无 |

### 5.4.4 并发控制（Semaphore）

位于 `concurrency.ts`。

```typescript
class Semaphore {
  constructor(maxConcurrent: number)
  async acquire(): Promise<void>      // 有槽位立即返回，否则排队等待
  tryAcquire(): boolean               // 不等待，立即返回
  release(): void                     // 释放槽位，唤醒下一个等待者
  rejectAll(reason: string): void     // 拒绝所有等待者（用于关机）
}
```

- 默认最大并发数：`DEFAULT_MAX_CONCURRENT = 10`
- FIFO 排队：等待者按到达顺序获取槽位
- 槽位转移：释放时直接转移给等待者（current 计数不变）

### 5.4.5 executeWithConcurrency 流程

```
executeWithConcurrency(app, trigger)
    │
    ├─ 1. 尝试非阻塞获取槽位 (semaphore.tryAcquire)
    │     └─ 无可用槽位 -> pendingTriggers 计数 +1，广播状态 -> semaphore.acquire() 阻塞
    │
    ├─ 2. 创建 AbortController
    │     - 生成唯一 executionKey: "{appId}:{counter}"
    │     - 存入 runningAbortControllers Map
    │
    ├─ 3. 广播运行开始状态
    │
    ├─ 4. 执行 executeRun({ app, trigger, store, memory, abortSignal })
    │
    ├─ 5. 后处理
    │     ├─ 5a. 回退活动条目：无 report_to_user 调用时创建 synthetic entry
    │     ├─ 5b. 更新 manager 运行记录 (updateLastRun)
    │     ├─ 5c. 处理升级结果 -> 设置 waiting_user 状态
    │     ├─ 5d. 连续错误检测 -> >= 5 次自动暂停
    │     └─ 5e. 输出通知 -> output.notify 配置检查 + 发送
    │
    ├─ 6. finally 块
    │     ├─ 删除 executionKey
    │     ├─ semaphore.release()
    │     └─ 广播运行结束状态
    │
    └─ 返回 AppRunResult
```

### 5.4.6 executeRun 流程

位于 `execute.ts`，是单次自动化运行的核心执行引擎。

```
executeRun({ app, trigger, store, memory, abortSignal })
    │
    ├─ 1. 生成 runId (UUID) 和 sessionKey ("app-run-{runId[0:8]}")
    ├─ 2. 记录运行开始到 ActivityStore (insertRun, status='running')
    │
    ├─ 3. 解析凭证和工作目录
    │     ├─ 使用 app.userOverrides?.modelSourceId 获取 AI 源（可选覆盖）
    │     ├─ resolveCredentialsForSdk -> 标准化凭证
    │     └─ getWorkingDir(spaceId) -> 工作目录
    │
    ├─ 4. 构建系统提示词 (buildAppSystemPrompt)
    │     ├─ app.spec.system_prompt（核心指令）
    │     ├─ memoryInstructions（内存使用指南）
    │     ├─ trigger.description（触发上下文）
    │     ├─ userConfig JSON（用户配置）
    │     ├─ usesAIBrowser 标记
    │     ├─ workDir 路径
    │     └─ modelInfo 显示名称
    │
    ├─ 5. 构建内存快照 (buildMemorySnapshot)
    │     └─ 预插入 # History 时间标题 (preInsertHistoryHeading)
    │
    ├─ 6. 构建初始消息 (buildInitialMessage)
    │     ├─ trigger.description
    │     ├─ userConfig
    │     ├─ appName
    │     └─ memorySnapshot 内容
    │
    ├─ 7. 创建 MCP 服务器
    │     ├─ aico-bot-memory: createMemoryStatusMcpServer(memoryScope)
    │     ├─ aico-bot-report: createReportToolServer(store, reportContext, onEscalation)
    │     ├─ aico-bot-notify: createNotifyToolServer(notifyContext)
    │     └─ ai-browser (如果权限允许): createAIBrowserMcpServer(scopedBrowserCtx)
    │
    ├─ 8. 创建 V2 会话 (unstable_v2_createSession)
    │     ├─ maxTurns = 100
    │     ├─ includePartialMessages = false
    │     └─ systemPrompt = 步骤 4 构建的提示词
    │
    ├─ 9. 打开 SessionWriter（JSONL 持久化，用于"查看过程"）
    │
    ├─ 10. 处理流 (processStream)
    │      ├─ session.send(message)
    │      └─ 消费 session.stream()，收集 finalText、tokens、检测 report_to_user 调用
    │
    ├─ 11. 自动续跑循环（Auto-Continue）
    │      └─ 最多 3 次 (MAX_AUTO_CONTINUES = 3)
    │          条件：未调用 report_to_user && 未报告错误 && 未中止
    │          第 3 次使用最终提醒消息 (AUTO_CONTINUE_FINAL_MESSAGE)
    │
    ├─ 12. 记录完成 (completeRun)
    │      ├─ 有 escalation -> status='waiting_user', outcome='useful'
    │      ├─ AI 报告错误 -> status='error', outcome='error'
    │      ├─ 未调用 report_to_user -> status='error', outcome='error'
    │      └─ 正常 -> status='ok', outcome=textLen>0 ? 'useful' : 'noop'
    │
    ├─ 13. 保存会话摘要到内存 (saveRunSessionSummary)
    ├─ 14. 检查内存压缩 (checkAndCompactMemory)
    │
    └─ 15. finally: 关闭 V2 会话 + 销毁 scoped browser context
```

**自动续跑消息**：

| 轮次 | 消息内容 |
|------|----------|
| 1-2 | "You ended your response without calling report_to_user..." |
| 3 (最终) | "FINAL REMINDER: You must call report_to_user NOW..." |

### 5.4.7 MCP 服务器（运行期间注入）

| MCP 服务器名称 | 创建函数 | 工具 | 用途 |
|----------------|----------|------|------|
| `aico-bot-memory` | `createMemoryStatusMcpServer()` | `memory_status` | 内存文件元数据查询（路径、行数、大小） |
| `aico-bot-report` | `createReportToolServer()` | `report_to_user` | 写入活动条目到 Activity Thread |
| `aico-bot-notify` | `createNotifyToolServer()` | `send_notification`、`list_notification_channels` | AI 自主发送外部通知 |
| `ai-browser` | `createAIBrowserMcpServer()` | 浏览器操作工具集 | 网页交互（需 `ai-browser` 权限） |

### 5.4.8 Report Tool（report_to_user）

位于 `report-tool.ts`。

**输入参数**（Zod Schema）：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | enum | 是 | `"run_complete" | "run_skipped" | "milestone" | "escalation" | "output"` |
| `summary` | string | 是 | 实际展示给用户的文本内容 |
| `data` | object | 否 | 结构化数据 |
| `question` | string | 否 | 仅 escalation 类型：向用户提问 |
| `choices` | string[] | 否 | 仅 escalation 类型：预设选项 |

**执行流程**：
1. 生成 `entryId`（UUID），创建 `ActivityEntry`
2. 持久化到 `activity_entries` 表
3. 广播 `app:activity_entry:new` 事件（WebSocket + Renderer IPC）
4. 根据 `notificationLevel` 决定是否发送系统桌面通知
   - `all`：所有类型都通知
   - `important`：仅 `escalation`、`milestone`、`output` 通知
   - `none`：不通知
5. 如果是 `escalation` 类型：
   - 调用 `onEscalation` 回调（设置 `escalationEntryId`）
   - 广播 `app:escalation:new` 事件
   - 返回提示"等待用户响应"

### 5.4.9 Notify Tool（send_notification）

位于 `notify-tool.ts`，提供两个 MCP 工具：

| 工具 | 参数 | 用途 |
|------|------|------|
| `send_notification` | `channel` (enum), `title` (string), `body` (string) | 发送外部通知 |
| `list_notification_channels` | 无 | 列出已启用的通知渠道 |

支持渠道：`email`、`wecom`、`dingtalk`、`feishu`、`webhook`。

运行期间实时读取配置（`getConfig()`），确保使用最新凭证。

### 5.4.10 自动续跑循环（Auto-Continue Loop）

常量：`MAX_AUTO_CONTINUES = 3`

当 AI 的 `end_turn` 响应中未检测到 `report_to_user` 工具调用时触发。这是自动化运行的**确定性完成信号**。循环逻辑：

```
while (!reportToolCalled && !aiReportedError && !aborted && count < MAX_AUTO_CONTINUES):
    count++
    message = (count == MAX_AUTO_CONTINUES) ? FINAL_REMINDER : CONTINUE_PROMPT
    processStream(message)
    merge results
```

如果循环结束后仍未调用 `report_to_user`，运行标记为 `error`，并插入 `run_error` 活动条目。

### 5.4.11 内存压缩（Memory Compaction）

在每次运行结束时检查是否需要压缩。

**阈值**：memory.md 文件大小超过 100KB 触发压缩。

**流程**：
1. `memory.needsCompaction()` 检查
2. 读取当前 memory.md 内容
3. 归档旧文件到 `memory/` 目录（`memory.compact()`）
4. LLM 生成压缩摘要（`generateCompactionSummary`）：
   - 使用 `@anthropic-ai/sdk` 直接调用（非完整 SDK 会话）
   - 最大输入：50,000 字符
   - 最大输出 token：16,384
   - 格式校验：必须包含 `# now` 和 `# History` 两个 H1 标题
   - 最多 2 次重试（`COMPACTION_MAX_RETRIES = 2`）
5. 写入摘要为新的 memory.md

**LLM 重试失败后的降级**：`buildFallbackCompactionSummary` 从原文中提取 `# now` 前 50 行 + `# History` 最近 10 个条目，手动组装有效结构。

### 5.4.12 会话存储（Session Store）

位于 `session-store.ts`。

**存储路径**：`{spacePath}/.aico-bot/apps/{appId}/runs/{runId}.jsonl`

**JSONL 格式**：每行一个 SDK 流事件，带 `_ts` 时间戳。

**SessionWriter 接口**：

```typescript
interface SessionWriter {
  writeEvent(event: Record<string, unknown>): void   // 追加 SDK 事件
  writeTrigger(content: string): void                // 写入触发消息（合成 user 事件）
}
```

**读取**：`readSessionMessages(spacePath, appId, runId)` 将 JSONL 事件转换为 `MessageRecord[]`，使用"累积-刷新"策略：
- 连续 assistant 事件的 thinking/tool_use 块累积为一个 `thoughts[]` 数组
- tool_result 合并到对应的 tool_use 记录中
- 仅当 assistant 事件包含 text 输出时才 flush 为一条 Message
- 结果：一个折叠的思考过程块 + 下方的文本气泡

### 5.4.13 活动条目与升级系统

**ActivityEntry 结构**：

```typescript
interface ActivityEntry {
  id: string
  appId: string
  runId: string
  type: ActivityEntryType     // 'run_complete' | 'run_skipped' | 'run_error' | 'milestone' | 'escalation' | 'output'
  ts: number
  sessionKey?: string
  content: ActivityEntryContent
  userResponse?: EscalationResponse  // 用户响应后填充
}
```

**升级流程**：
1. AI 调用 `report_to_user(type="escalation")`
2. 创建 `escalation` 类型活动条目，`userResponse` 为空
3. 设置 App 状态为 `waiting_user`，`pendingEscalationId` 指向条目 ID
4. 广播 `app:escalation:new` 事件
5. 用户响应 -> `respondToEscalation(appId, entryId, response)`
6. 记录用户响应，清除 `waiting_user` 状态 -> `active`
7. 异步触发 `escalation_followup` 类型的后续运行

**升级超时检查**：
- 定时器：每 5 分钟检查一次（`ESCALATION_CHECK_INTERVAL_MS = 5 * 60 * 1000`）
- 默认超时：24 小时（`DEFAULT_ESCALATION_TIMEOUT_HOURS = 24`）
- 超时处理：
  1. 自动解析升级（设置超时回复）
  2. 插入 `run_error` 活动条目
  3. App 状态转为 `error`
  4. 发送桌面通知

**连续错误自动暂停**：
- 阈值：`MAX_CONSECUTIVE_ERRORS = 5`
- 检查最近 N 次运行的连续错误计数
- 达到阈值后自动设置状态为 `error` 并 `deactivate()`

### 5.4.14 运行时数据库迁移

迁移命名空间：`app_runtime`

| 版本 | 描述 | 操作 |
|------|------|------|
| v1 | 创建 automation_runs 和 activity_entries 表 | `CREATE TABLE automation_runs` + 索引 `idx_runs_app`；`CREATE TABLE activity_entries` + 索引 `idx_entries_app` |
| v2 | 添加 run_id 查询索引和状态过滤索引 | `CREATE INDEX idx_entries_run` ON `(run_id)`；`CREATE INDEX idx_runs_status` ON `(status)` |

**表结构**：

```sql
-- automation_runs
CREATE TABLE automation_runs (
  run_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  trigger_type TEXT NOT NULL,
  trigger_data_json TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  tokens_used INTEGER,
  error_message TEXT,
  FOREIGN KEY (app_id) REFERENCES installed_apps(id) ON DELETE CASCADE
);

-- activity_entries
CREATE TABLE activity_entries (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  ts INTEGER NOT NULL,
  session_key TEXT,
  content_json TEXT NOT NULL,
  user_response_json TEXT,
  FOREIGN KEY (app_id) REFERENCES installed_apps(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES automation_runs(run_id) ON DELETE CASCADE
);
```

### 5.4.15 关键常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `DEFAULT_MAX_CONCURRENT` | `10` | 默认最大并发运行数 |
| `MAX_CONSECUTIVE_ERRORS` | `5` | 连续错误自动暂停阈值 |
| `MAX_AUTO_CONTINUES` | `3` | 自动续跑最大次数 |
| `MAX_TURNS` | `100` | 单次运行的最大 SDK 轮次 |
| `ESCALATION_TIMEOUT_HOURS` (默认) | `24` | 升级超时默认值 |
| `ESCALATION_CHECK_INTERVAL_MS` | `300000` (5 分钟) | 升级超时检查间隔 |
| `PRUNE_INTERVAL_MS` | `86400000` (24 小时) | 数据清理最小间隔 |
| `DEFAULT_RETENTION_MS` | `31536000000` (1 年) | 运行数据保留期 |
| `MAX_COMPACTION_INPUT_LENGTH` | `50000` | 压缩最大输入字符 |
| `COMPACTION_MAX_TOKENS` | `16384` | 压缩 LLM 最大输出 token |
| `COMPACTION_MAX_RETRIES` | `2` | 压缩格式校验最大重试次数 |
| `MAX_SUMMARY_LENGTH` | `2000` | 会话摘要最大字符 |

### 5.4.16 运行时自定义错误

| 错误类 | 携带信息 | 抛出场景 |
|--------|----------|----------|
| `AppNotRunnableError` | `appId`, `status` | 非活跃状态下尝试执行 |
| `NoSubscriptionsError` | `appId` | 激活无订阅的 App |
| `ConcurrencyLimitError` | `maxConcurrent`, `isPerApp`, `appId?` | 并发限制，分全局和 per-app 两种 |
| `EscalationNotFoundError` | `appId`, `entryId` | 升级条目不存在或已响应 |
| `RunExecutionError` | `appId`, `runId` | SDK/Agent 执行失败 |

---

## 5.5 Conversation MCP（对话管理工具）

源码位置：`src/main/apps/conversation-mcp/index.ts`

通过 `createAicoBotAppsMcpServer(spaceId)` 创建 in-process MCP 服务器，向 Claude Code Agent 提供 8 个自动化 App 管理工具。所有工具闭包捕获 `spaceId`，实现空间级作用域。

### 5.5.1 工具列表

| 工具名 | 参数 | 用途 |
|--------|------|------|
| `list_automation_apps` | 无 | 列出当前空间的所有 automation App（ID、名称、描述、状态） |
| `create_automation_app` | `spec` (JSON string) | 创建并安装新的 automation App。强制 `type="automation"`，默认 `version="1.0"`，`author="AICO-Bot"`。安装后自动激活 |
| `update_automation_app` | `app_id`, `updates` (JSON string) | JSON Merge Patch 更新 App 规格。支持 `frequency` 快捷字段（自动更新主订阅调度）。更新后触发 `deactivate/activate` 或 `syncAppSchedule` |
| `delete_automation_app` | `app_id` | 永久删除 App（先 deactvate 再 uninstall） |
| `get_automation_status` | `app_id` | 获取 App 完整详情（规格 + 运行时状态 + 上次运行信息） |
| `pause_automation_app` | `app_id` | 暂停 App（manager.pause + runtime.deactivate） |
| `resume_automation_app` | `app_id` | 恢复 App（manager.resume + runtime.activate） |
| `trigger_automation_app` | `app_id` | 立即手动触发一次运行。Per-app 去重：同一 App 同时只能有一个运行 |

### 5.5.2 启动容错

使用 `waitForAppManager(maxMs=5000, intervalMs=200)` 处理 bootstrap 竞态条件——`initPlatformAndApps()` 是 fire-and-forget 的，首个 MCP 工具调用到达时 AppManager 可能尚未就绪。

---

## 5.6 App Chat（交互式聊天）

源码位置：`src/main/apps/runtime/app-chat.ts`

### 5.6.1 设计定位

App Chat 提供了与自动化 App 的 AI 智能体进行**实时交互对话**的能力，区别于 `execute.ts` 的后台自动运行：

| 维度 | execute.ts（自动运行） | app-chat.ts（交互聊天） |
|------|------------------------|-------------------------|
| 触发方式 | 调度/事件/手动 | 用户消息 |
| 会话模式 | 一次性 V2 会话 | 复用 V2 会话（跨消息） |
| 流式输出 | 不渲染，仅收集最终结果 | 完整流式输出到渲染器 |
| MCP 工具 | report_to_user + notify + memory + ai-browser | memory_status + memory + ai-browser |
| 完成信号 | `report_to_user` 调用 | AI 自然结束回复 |
| 持久化 | JSONL (`runs/{runId}.jsonl`) | JSONL (`runs/chat.jsonl`) |

### 5.6.2 sendAppChatMessage 流程

```
sendAppChatMessage(mainWindow, { appId, spaceId, message, thinkingEnabled })
    │
    ├─ 1. 生成 conversationId = "app-chat:{appId}"
    ├─ 2. 获取 App + 凭证（支持 modelSourceId/modelId 覆盖）
    ├─ 3. 构建内存作用域 (MemoryCallerScope)
    ├─ 4. 构建交互式聊天系统提示词 (buildAppChatSystemPrompt)
    │     - 完整主 Agent 系统提示词（身份、工具、编码指南）
    │     - App Chat 上下文覆盖层（直接回复，不用 report_to_user）
    │     - App 专属 system_prompt
    │     - 内存指令 + 用户配置
    ├─ 5. 构建 MCP 服务器
    │     - aico-bot-memory
    │     - ai-browser（如果权限允许，scoped context 跨消息复用）
    │     - 注意：不注入 report_to_user 和 notify 工具
    ├─ 6. 获取或创建 V2 会话 (getOrCreateV2Session)
    │     - 按 conversationId 复用会话
    │     - 错误时关闭会话并销毁 scoped browser context
    ├─ 7. 设置 thinking tokens（10240 或 null）
    ├─ 8. 打开 SessionWriter (JSONL 持久化，runId='chat')
    ├─ 9. 处理流 (processStream)
    │     - 使用 stream-processor.ts 的完整流处理能力
    │     - onComplete / onRawMessage 回调
    │     - onRawMessage 中写入 JSONL（排除 stream_event）
    └─ 10. finally: 清理 active session
```

### 5.6.3 交互式聊天模式特点

- **不使用 `report_to_user`**：用户直接在聊天界面看到 AI 的文本输出
- **AskUserQuestion 可用**：chat 模式系统提示词中声明了 AskUserQuestion 工具，用于结构化用户输入（选择、确认）
- **V2 会话复用**：会话 key 为 `"app-chat:{appId}"`，跨消息复用提供上下文连续性
- **Scoped Browser Context 复用**：AI Browser 的作用域上下文保存在 `scopedContexts` Map 中，key 为 `conversationId`
- **JSONL 持久化**：消息持久化到 `{spacePath}/.aico-bot/apps/{appId}/runs/chat.jsonl`，用于页面刷新后的恢复

### 5.6.4 辅助函数

| 函数 | 用途 |
|------|------|
| `stopAppChat(appId)` | 停止当前正在生成的聊天响应（复用 `stopGeneration` 机制） |
| `isAppChatGenerating(appId)` | 检查是否有聊天会话正在生成 |
| `loadAppChatMessages(spacePath, appId)` | 加载持久化的聊天消息（JSONL -> Message[]） |
| `getAppChatSessionState(appId)` | 获取会话状态（是否活跃、思考块），用于页面刷新恢复 |
| `getAppChatConversationId(appId)` | 生成虚拟 conversationId `"app-chat:{appId}"` |
| `cleanupAppChatBrowserContext(appId)` | 清理 scoped browser context（删除 App 或重置聊天时调用） |

---

## 5.7 模块初始化与依赖注入

### 5.7.1 初始化顺序

App Runtime 初始化 (`initAppRuntime`) 依赖以下模块先就绪：

```
Phase 0: platform/store, apps/spec
Phase 1: platform/scheduler, platform/event-bus, platform/memory, platform/background
Phase 2: apps/manager
         └── apps/runtime (initAppRuntime)
```

### 5.7.2 初始化流程

```
initAppRuntime(deps)
    │
    ├─ 1. 获取 app-level 数据库 (deps.db.getAppDatabase())
    ├─ 2. 运行迁移 (runMigrations: app_runtime namespace)
    ├─ 3. 创建 ActivityStore
    ├─ 4. 创建 AppRuntimeService（注入依赖）
    ├─ 5. activateAll() —— 激活所有 status='active' 的 automation App
    └─ 6. 返回 AppRuntimeService
```

### 5.7.3 关机流程

```
shutdownAppRuntime()
    │
    ├─ 1. deactivateAll()
    │     ├─ 移除所有 scheduler 任务
    │     ├─ 取消所有 event-bus 订阅
    │     ├─ 中止所有 runningAbortControllers
    │     └─ semaphore.rejectAll('Runtime shutting down')
    ├─ 2. 停止 escalation 检查定时器
    └─ 3. 清除模块状态
```

---

## 5.8 数据流总览

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  YAML Spec   │────>│  apps/spec       │────>│  AppSpec (Zod)   │
│  (文件)      │     │  解析 + 验证      │     │  (类型安全对象)   │
└──────────────┘     └──────────────────┘     └────────┬─────────┘
                                                       │
                                                       ▼ install
                                              ┌──────────────────┐
                                              │  apps/manager     │
                                              │  InstalledApp     │
                                              │  SQLite 持久化    │
                                              └────────┬─────────┘
                                                       │
                                                       ▼ activate
                                              ┌──────────────────┐
                                              │  apps/runtime     │
                                              │  Scheduler Jobs   │
                                              │  Event Filters    │
                                              └────────┬─────────┘
                                                       │
                                          ┌────────────┼────────────┐
                                          ▼            ▼            ▼
                                     ┌─────────┐ ┌──────────┐ ┌──────────┐
                                     │ execute  │ │ execute  │ │ App Chat │
                                     │ (schedule│ │ (event)  │ │ (互动)   │
                                     │ /manual) │ │          │ │          │
                                     └────┬─────┘ └────┬─────┘ └────┬─────┘
                                          │            │            │
                                          ▼            ▼            ▼
                                     ┌──────────────────────────────────┐
                                     │  MCP 工具集                       │
                                     │  aico-bot-memory / report /       │
                                     │  notify / ai-browser              │
                                     └──────────────────────────────────┘
                                          │
                                          ▼
                                     ┌──────────────────────────────────┐
                                     │  Activity Store (SQLite)          │
                                     │  automation_runs + activity_entries│
                                     └──────────────────────────────────┘
```
