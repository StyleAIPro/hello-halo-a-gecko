# PRD [Bug 修复级] — Skill 相关日志降噪

> 版本：bugfix-skill-log-noise-v1
> 日期：2026-05-06
> 状态：draft
> 指令人：用户
> 归属模块：modules/agent
> 严重程度：P1
> 前序 PRD：
> - `.project/prd/feature/logging/feat-log-noise-reduction-v1.md`（日志降噪 v1，处理了 stream-processor 部分日志）

## 问题描述

### 期望行为

用户只关心**实际调用 skill 时**产生的日志（安装、卸载、执行）。对话创建、会话预热（warm-up）、SDK 配置构建等内部流程应使用 `console.debug` 输出，不在默认日志中显示。

### 实际行为

每次进入对话或发送消息时，主进程日志被大量 skill 相关内部流程日志淹没：
- 每个已安装 skill 每次会话创建都触发 `Linked skill` 日志
- `buildBaseSdkOptions`、`SDK options` 等配置日志每次 sendMessage + warm-up 各输出一次
- session 生命周期内部日志（reuse、resume、migration、exit listener 等）高频输出
- MCP server 注册日志每次消息都重复输出
- SkillManager 加载日志每个 skill 一条

### 复现步骤

1. 打开 AICO-Bot，进入一个已安装多个 skill 的空间
2. 发送任意消息
3. 观察主进程日志中大量 skill/SDK config/session 相关日志

## 技术方案

将以下日志从 `console.log` / `console.info` 降级为 `console.debug`。按文件分组：

### 1. `src/main/services/agent/sdk-config.ts`

| 行号 | 当前日志 | 降级后 | 触发场景 |
|------|---------|--------|---------|
| 171-173 | `console.log('[SDK Config] ${provider} provider: routing via...')` | `console.debug` | 每次 sendMessage + warm-up |
| 208 | `console.log('[SDK Config] Anthropic passthrough: routing via...')` | `console.debug` | 每次 warm-up |
| 297 | `console.log('[SDK Config] Removed stale skill link: ${entry.name}')` | `console.debug` | 每次 warm-up |
| 319 | `console.log('[SDK Config] Linked skill: ${name} -> ${sourcePath}')` | `console.debug` | **最大噪声源**，每个 skill 每次会话创建 |
| 444 | `console.log('[SDK Config] Created skills directory:...')` | `console.debug` | 一次性 |
| 453 | `console.log('[SDK Config] Replaced legacy junction with directory:...')` | `console.debug` | 一次性 |
| 475 | `console.log('[SDK Config] Created .claude/skills junction ->...')` | `console.debug` | 一次性 |
| 555-557 | `console.log('[SDK Config] buildBaseSdkOptions: workDir=...')` | `console.debug` | 每次 sendMessage + warm-up |
| 636-638 | `console.log('[SDK Config] SDK options: systemPrompt=...')` | `console.debug` | 每次 sendMessage + warm-up |

### 2. `src/main/services/agent/session-manager.ts`

| 行号 | 当前日志 | 降级后 | 触发场景 |
|------|---------|--------|---------|
| 78 | `console.log('[Agent][${id}] Session close: EPIPE...')` | `console.debug` | 进程退出时 |
| 138-140 | `console.log('[Agent][${id}] Health check failed (failures:...)')` | `console.debug` | 健康检查失败时 |
| 337-339 | `console.log('[Agent][${id}] Process exited but session was replaced...')` | `console.debug` | session 重建时 |
| 344 | `console.log('[Agent][${id}] Remaining sessions: ${size}')` | `console.debug` | 进程退出时 |
| 347 | `console.log('[Agent][${id}] Process exit listener registered')` | `console.debug` | 每次新会话 |
| 653 | `console.log('[Agent][${id}] Reusing existing V2 session')` | `console.debug` | 后续每条消息 |
| 671 | `console.log('[Agent][${id}] With resume: ${options.sessionId}')` | `console.debug` | session 恢复 |
| 674-676 | `console.log('[Agent][${id}] Session ${id} not found, starting fresh...')` | `console.debug` | session 文件不存在 |
| 680 | `console.log('[Agent][${id}] With resume: ${options.sessionId}')` | `console.debug` | 有 workDir 时 resume |
| 704-706 | `console.log('[Agent][${id}] SDK MCP servers registered via setMcpServers:...')` | `console.debug` | 新会话创建 |
| 719-720 | `console.log('[Agent][${id}] V2 session created in ${ms}ms, PID:...')` | `console.debug` | 新会话创建（与 send-message 重复） |
| 786 | `console.log('[Agent] Session warm using:...')` | `console.debug` | warm-up |
| 815 | `console.log('[Agent] Warming up V2 session:...')` | `console.debug` | warm-up |
| 817 | `console.log('[Agent] V2 session warmed up:...')` | `console.debug` | warm-up |
| 853 | `console.log('[Agent][${id}] Process ${pid} exited (${ms}ms)')` | `console.debug` | 进程退出 |
| 632-634 | `console.log('[Agent][${id}] ${reason} changed but request in flight, deferring rebuild')` | `console.debug` | 配置变更延迟重建 |
| 952 | `console.log('[Agent] Session marked for recreation (deferred):...')` | `console.debug` | 延迟重建标记 |
| 956 | `console.log('[Agent] Session closed for recreation:...')` | `console.debug` | 即时重建关闭 |
| 978 | `console.log('[Agent] Deferring session close until idle:...')` | `console.debug` | 配置变更延迟关闭 |
| 1060 | `console.log('[Agent][${id}] No session found for manual compact')` | `console.debug` | 手动压缩时 |
| 1079 | `console.log('[Agent][${id}] Compact skipped: threshold not met')` | `console.debug` | 压缩跳过 |
| 1088 | `console.log('[Agent][${id}] SDK compact not available, recreating session...')` | `console.debug` | 压缩回退 |
| 470 | `console.log('[Agent] Migration check: workDir=...')` | `console.debug` | session 迁移检查 |
| 482-484 | `console.log('[Agent] Checking paths: / New: / Old:')` (3 行) | `console.debug` | session 迁移检查 |
| 488 | `console.log('[Agent] Session file already exists in new directory')` | `console.debug` | session 迁移检查 |
| 503-505 | `console.log('[Agent] Migrated session file: / From: / To:')` (3 行) | `console.debug` | session 迁移成功 |
| 531-533 | `console.log('[Agent] Found session in unexpected project dir: / Copied from: / Copied to:')` (3 行) | `console.debug` | session 迁移发现 |
| 542 | `console.log('[Agent] Session file not found in any directory')` | `console.debug` | session 迁移未找到 |

### 3. `src/main/services/agent/send-message.ts`

| 行号 | 当前日志 | 降级后 | 触发场景 |
|------|---------|--------|---------|
| 315 | `console.log('[Agent] Using headless Electron as Node runtime:...')` | `console.debug` | 静态信息，每次 sendMessage |
| 327 | `console.log('[Agent][${id}] AI Browser module initialized')` | `console.debug` | 每次 sendMessage (aiBrowser) |
| 330 | `console.log('[Agent][${id}] AI Browser MCP server added')` | `console.debug` | 每次 sendMessage (aiBrowser) |
| 335 | `console.log('[Agent][${id}] AICO-Bot Apps MCP server added')` | `console.debug` | 每次 sendMessage |
| 339 | `console.log('[Agent][${id}] GitHub Search MCP server added')` | `console.debug` | 每次 sendMessage |
| 341 | `console.log('[mcpServers]${Object.keys(mcpServers)}')` | `console.debug` | 每次 sendMessage |
| 381-383 | `console.log('[Agent][${id}] MCP servers configured:...')` | `console.debug` | 每次 sendMessage |

### 4. `src/main/services/skill/skill-manager.ts`

| 行号 | 当前日志 | 降级后 | 触发场景 |
|------|---------|--------|---------|
| 107 | `console.log('[SkillManager] Loading skills from:...')` | `console.debug` | skill 加载 |
| 111 | `console.log('[SkillManager] Found N entries in...')` | `console.debug` | skill 加载 |
| 130-138 | `console.log('[SkillManager] Candidate skill:...')` | `console.debug` | skill 加载 |
| 140-148 | `console.log('[SkillManager] Skipping older duplicate skill:...')` | `console.debug` | skill 加载 |
| 162 | `console.log('[SkillManager] Loaded skill:...')` | `console.debug` | 每个 skill 加载 |
| 544 | `console.log('[SkillManager] Refreshed skills')` | `console.debug` | skill 刷新 |

### 5. `src/main/services/agent/stream-processor.ts`

| 行号 | 当前日志 | 降级后 | 触发场景 |
|------|---------|--------|---------|
| 964-966 | `console.log('Thinking block complete, length:...')` | `console.debug` | 每个 thinking 块完成 |
| 1347-1349 | `console.log('Result thought received...')` | `console.debug` | 结果接收 |
| 1574 | `console.log('[Agent][${id}] Token usage (single API):', tokenUsage)` | `console.debug` | 单次 API 调用 token 统计 |
| 1559-1561 | `console.log('[Agent][${id}] SDK result subtype=error_during_execution...')` | `console.debug` | 执行错误 |
| 1748-1750 | `console.log('[Agent][${id}] Sending interrupted error (...)')` | `console.debug` | 中断错误 |

> 注：`stream-processor.ts` 行 696 `Sending message to V2 session...` 保持 `console.info`，因为这是唯一的对话开始标记。

### 6. `src/main/controllers/skill.controller.ts`

| 行号 | 当前日志 | 降级后 | 触发场景 |
|------|---------|--------|---------|
| 919 | `console.log('[SkillController] listMarketSkills called:...')` | `console.debug` | 市场浏览 |
| 921-923 | `console.log('[SkillController] listMarketSkills result:...')` | `console.debug` | 市场浏览 |

### 7. `src/main/bootstrap/extended.ts`

| 行号 | 当前日志 | 降级后 | 触发场景 |
|------|---------|--------|---------|
| 224 | `console.log('[Bootstrap] Skill handlers registered')` | `console.debug` | 一次性启动 |

## 不需要修改的日志（保持 info）

以下日志属于**实际 skill 调用**或**关键操作**，应保持 `console.log` / `console.info`：

- `skill.ts` 中的 `logUserAction`（installSkill、uninstallSkill）
- `skill-manager.ts` 中的 install/uninstall/toggle 日志
- `skill.controller.ts` 中的 install 流程日志（download、npx、error）
- `skill-conversation.service.ts` 中的 skill 对话 session 创建和消息发送
- `stream-processor.ts` 中的 Subagent started/completed
- `session-manager.ts` 中的 session cleanup、force restart、config change rebuild（关键操作日志）
- `stream-processor.ts` 行 696 `Sending message to V2 session...`（对话开始标记）

## 开发前必读

| 分类 | 文件 | 阅读目的 |
|------|------|---------|
| 源码文件 | `src/main/services/agent/sdk-config.ts` | 定位需降级的 SDK 配置日志 |
| 源码文件 | `src/main/services/agent/session-manager.ts` | 定位需降级的 session 生命周期日志 |
| 源码文件 | `src/main/services/agent/send-message.ts` | 定位需降级的 MCP 注册日志 |
| 源码文件 | `src/main/services/agent/stream-processor.ts` | 定位需降级的流处理日志 |
| 源码文件 | `src/main/services/skill/skill-manager.ts` | 定位需降级的 skill 加载日志 |
| 源码文件 | `src/main/controllers/skill.controller.ts` | 定位需降级的市场浏览日志 |
| 源码文件 | `src/main/bootstrap/extended.ts` | 定位需降级的启动日志 |
| 编码规范 | `docs/Development-Standards-Guide.md` | ESLint 规范、编辑后 eslint --fix |

## 涉及文件

| # | 文件 | 修改类型 |
|---|------|---------|
| 1 | `src/main/services/agent/sdk-config.ts` | console.log -> console.debug |
| 2 | `src/main/services/agent/session-manager.ts` | console.log -> console.debug |
| 3 | `src/main/services/agent/send-message.ts` | console.log -> console.debug |
| 4 | `src/main/services/agent/stream-processor.ts` | console.log -> console.debug |
| 5 | `src/main/services/skill/skill-manager.ts` | console.log -> console.debug |
| 6 | `src/main/controllers/skill.controller.ts` | console.log -> console.debug |
| 7 | `src/main/bootstrap/extended.ts` | console.log -> console.debug |

## 验收标准

- [ ] 进入对话并发送消息时，默认日志中不再出现 `[SDK Config] Linked skill` 日志
- [ ] 进入对话并发送消息时，默认日志中不再出现 `[SDK Config] buildBaseSdkOptions` / `SDK options` 日志
- [ ] 进入对话并发送消息时，默认日志中不再出现 `[SkillManager] Loading skills from` / `Loaded skill` 日志
- [ ] 进入对话并发送消息时，默认日志中不再出现 `[Agent][${id}] Reusing existing V2 session` 日志
- [ ] 进入对话并发送消息时，默认日志中不再出现 MCP server 注册日志（AI Browser / Apps / GitHub Search）
- [ ] warm-up 流程日志（`Warming up V2 session`、`V2 session warmed up`）降为 debug
- [ ] session 迁移日志（`Migration check`、`Checking paths`、`Migrated session file`）降为 debug
- [ ] `stream-processor.ts` 中 `Thinking block complete`、`Result thought received`、`Token usage (single API)` 降为 debug
- [ ] `listMarketSkills` 调用/结果日志降为 debug
- [ ] **实际 skill 操作日志**（install、uninstall、toggle、执行）仍保持 info 级别
- [ ] **关键操作日志**（session cleanup、force restart、对话开始标记）仍保持 info 级别
- [ ] `npm run typecheck && npm run lint && npm run build` 全部通过
