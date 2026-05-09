# PRD [Feature] -- 日志噪声治理（文件传输层降噪）

| 字段 | 值 |
|------|------|
| 版本 | v1 |
| 日期 | 2026-05-07 |
| 指令人 | @misakamikoto |
| 模块 | main（日志模块 + Agent + SSH + 健康检查） |
| 状态 | done |
| 优先级 | P1 |
| 影响范围 | 仅主进程日志文件传输层 |

## 需求分析

### 背景

AICO-Bot 日志系统经多轮优化后（logging-module-v1、logging-enhancement-v2、log-content-optimization-v1、bugfix-log-noise-v1），日志按日期分割、用户操作 `[event]` 前缀、敏感数据脱敏等能力已就绪。但实际日志文件中仍存在大量高频低价值日志，严重干扰问题排查效率。

用户反馈三个核心诉求：
1. 删除 SSHManager 等类似心跳的无用日志信息
2. 将用户输入等操作单独列举出来方便查看
3. 简化 AI 思考过程日志，降低日志噪声

### 噪声源清单（按严重程度排序）

#### 1. `process-stream.ts` -- 最严重的噪声源（~40 处 console 调用）

每条 SDK 消息都做完整 `safeJsonStringify(sdkMessage, 2)` 输出。一次 API 调用可能产生 5-50+ 条 SDK 消息（assistant、tool_use、tool_result、result 等），每条都打印完整 JSON。

关键行号：
- **L786-789**: `console.log('[Agent] SDK messages [${conversationId}] ...')` + `safeJsonStringify(sdkMessage, 2)` -- 每条 SDK 消息完整序列化，高频且输出量极大
- **L627-699**: thinking/text/tool_use block 的 start/delta/stop 中间日志（约 10 处），包含完整 tool input JSON
- **L900-933**: injection 队列操作日志（queued/dequeued/cleared/turn boundary），每个 turn 2-4 行
- **L1165**: `Captured session ID:` -- 开发调试信息
- **L1191**: `MCP server status:` + `JSON.stringify(mcpServers)` -- 已有 `broadcastMcpStatus` 专门处理
- **L1200**: `Available tools: N` -- 启动信息
- **L1282**: `Subagent cleaned up (stream ended)` -- 中间状态
- **L1298-1302**: stream 结束诊断 -- `Stream content from xxx: N chars` / `No content from stream`
- **L1333**: `Pending injection detected - deferring agent:complete` -- 中间状态
- **L1382**: `User stopped - no error sent` -- 中间状态

一次含 3-5 次工具调用的 Agent 对话可产生数百行流式日志，关键节点被淹没。

#### 2. `send-message-local.ts` -- debug 残留

- **L92**: `console.log('[Agent] ========== FUNCTION START ==========')`
- **L93-94**: `sendMessage: conv=...` / `sendMessage: spaceId=...` 参数打印
- **L97**: `console.log('[Agent] ===== BEFORE GETSPACE =====')`
- **L98**: `getSpace function type:` -- 类型检查日志
- **L99**: `===== AFTER GETSPACE =====`
- **L100**: `About to call getSpace with spaceId=...`
- **L102-113**: `getSpace returned:` 完整对象打印（5 个字段展开）
- **L114-116**: `Remote routing check:` 路由判断详情
- **L120-122**: `*** ROUTING TO REMOTE EXECUTION ***` + 参数
- **L124**: `Calling executeRemoteMessage...`

共约 15 行 debug scaffold，每次发消息都触发。

#### 3. `ssh-manager.ts` -- SSH 心跳/命令执行日志（~24 处）

- **L110**: `Already connected to same server` -- 冗余状态确认（keepalive 触发）
- **L117**: `Cleaning up existing connection...` -- 中间过程
- **L136**: `Ready event fired - connection ready` -- keepalive 重建
- **L148**: `Connection closed, reason:` -- ssh2 keepalive 正常关闭（每 30s）
- **L171**: `Connecting with basic config` -- 冗余
- **L186**: `Executing command: ${command}` -- 每次 SSH 命令执行（pgrep、port check、echo ok 等）
- **L207**: `Command completed with exit code: ${code}` -- 每次命令完成
- **L239**: `Executing command (full):` -- 完整命令模式
- **L260**: `Command completed with exit code:` -- 完整命令模式
- **L291**: `Executing command (streaming):` -- 流式命令模式
- **L320**: `Streaming command completed with exit code:` -- 流式命令模式
- **L354**: `SFTP initialized` -- 一次性信息
- **L453**: `Local port forward already exists` -- 冗余

远程 Agent 操作期间，每个 SSH 命令产生 2-4 行日志，`echo ok` 健康检查每 120s 触发。

#### 4. `runtime-checker.ts` -- 健康检查轮询（每 120s）

- **L58**: `Fallback polling already running`
- **L74**: 轮询启动参数日志
- **L87**: `Fallback polling stopped`
- **L109**: `Running passive status collection...`
- **L177**: `Passive check complete: ${newStatus}` -- 每 120s
- **L199**: `Debounced: returning cached result`
- **L205**: `Check already running, waiting...`

#### 5. `watcher-host.service.ts` -- 文件监听 worker stdout/stderr 直通

- **L84-88**: `child.stdout?.on('data', ...)` / `child.stderr?.on('data', ...)` -- 每个 worker 输出行直接打印到主日志

#### 6. `orchestrator.ts` -- worker 心跳日志

- **L1773-1775**: `[Orchestrator] waitForCompletion: heartbeat from worker ${task.agentId}, extended deadline by ${heartbeatTimeout / 1000}s` -- 等待完成期间每个心跳打印一行

#### 7. `session-health.ts` -- 会话健康轮询

- **L66, 149**: 会话健康状态更新日志（每次健康检查触发）
- **L262, 269**: `Process exit listener registered` / `Remaining sessions: N`

### 预期效果

1. 心跳/健康检查/SSH 命令等周期性日志不在文件传输层写入（控制台 dev 模式仍可见）
2. Agent 流式日志只保留关键节点（对话开始/结束、thinking 摘要、tool call 摘要、错误、subagent 生命周期），中间过程降为 debug
3. debug 残留（FUNCTION START 等）直接删除
4. 用户操作 `[event]` 日志保持不变（已经足够醒目，无需额外包裹分隔行）

## 技术方案

### 核心策略

采用两层降噪，**不改变 console 输出**（dev 模式仍可看到 debug）：

1. **Hook 层**（`initLogger()` 中注册 `log.hooks.push()`）：在 `write` 阶段过滤文件传输层的特定模式日志
2. **源码层**：清理 debug 残留 + 高频日志降级（`console.log` -> `console.debug`）

`console.debug` 在生产环境 `fileLevel = 'info'` 配置下不会写入文件，但 dev 模式 `consoleLevel = 'debug'` 仍可见。

### 方案 1：扩展 `initLogger()` 添加文件传输过滤 Hook

在 `src/main/services/log/index.ts` 的 `initLogger()` 中注册 `log.hooks` 回调。**只在 `transport === log.transports.file` 时过滤**，控制台输出完全不受影响。

```typescript
// 在 initLogger() 末尾，Object.assign(console, log.functions) 之前
log.hooks.push((message, transport) => {
  // 只过滤文件传输，不影响控制台
  if (transport !== log.transports.file) return message;
  // debug 级别已被 fileLevel='info' 过滤，此处做补充过滤
  if (message.level === 'debug') return false;

  const text = String(message.data?.[0] ?? '');

  // === 周期性心跳/轮询噪音 ===
  const heartbeatPatterns = [
    // SSHManager keepalive (每 30s)
    '[SSHManager] Connection closed, reason:',
    '[SSHManager] Ready event fired - connection ready',
    '[SSHManager] Already connected to same server',
    // SSH 健康检查 (每 120s)
    '[SSHManager] Executing command: echo ok',
    '[SSHManager] Command completed with exit code: 0',
    // 健康检查轮询 (每 120s)
    '[Health][Runtime] Running passive status collection',
    '[Health][Runtime] Passive check complete:',
    '[Health][Runtime] Debounced: returning cached',
    // WebSocket ping (每 30s)
    'Message sent: ping',
    // Orchestrator heartbeat
    'heartbeat from worker',
    'extended deadline by',
  ];

  for (const pattern of heartbeatPatterns) {
    if (text.includes(pattern)) return false;
  }

  return message;
});
```

### 方案 2：清理 `send-message-local.ts` debug 残留

删除所有 debug scaffold 行（L92-124 区域），仅保留必要的错误处理日志：

| 行号 | 操作 | 说明 |
|------|------|------|
| L92 | 删除 | `========== FUNCTION START ==========` |
| L93-94 | 删除 | 参数打印（conv/spaceId） |
| L97-99 | 删除 | `BEFORE/AFTER GETSPACE` scaffold |
| L100 | 删除 | `About to call getSpace` |
| L102-113 | 删除 | `getSpace returned:` 完整对象打印 |
| L114-116 | 删除 | `Remote routing check:` 详情 |
| L120-122 | 降为 `console.debug` | `ROUTING TO REMOTE EXECUTION`（保留但降级） |
| L124 | 删除 | `Calling executeRemoteMessage...` |

### 方案 3：Agent 流式日志降级（`process-stream.ts`）

将高频中间日志从 `console.log`（info 级别）降为 `console.debug`。

**保留 info 级别的关键节点日志**（约 12 处）：

| # | 行号 | 日志内容 | 保留原因 |
|---|------|---------|---------|
| 1 | L359 | `Sending message to V2 session...` | 对话开始标记 |
| 2 | L384 | `Aborted` | 中断事件 |
| 3 | L627 | `Thinking block complete, length: N`（仅完成时） | thinking 节点摘要 |
| 4 | L683 | `Tool block complete [${name}], input length: N` | 工具调用摘要（简化 input 为长度） |
| 5 | L743 | `Text block completed, total accumulated: N chars` | 文本输出节点 |
| 6 | L989 | `Error thought received: ...` | 错误排查必须 |
| 7 | L1010 | `Result thought received, N thoughts accumulated` | 对话完成标记 |
| 8 | L1130 | `Subagent ${taskId} ${status}` | subagent 生命周期 |
| 9 | L1229 | `Token usage (total):` | 对话完成后的 token 汇总 |

**降为 debug 级别**（约 25 处）：

| # | 行号 | 日志内容 | 降级原因 |
|---|------|---------|---------|
| 1 | L786-789 | `SDK messages [convId] +Nms type:` + `safeJsonStringify` | 每条消息完整 JSON，最高频 |
| 2 | L415 | `message_start FULL:` 事件 JSON | 仅开发调试 |
| 3 | L648 | tool input 完整 JSON 打印 | 与 L683 摘要重复 |
| 4 | L692 | `Bash command intercepted for terminal:` | 中间过程 |
| 5 | L699 | `Stored mappings for tool` / commandId 映射 | 中间过程 |
| 6 | L766 | `Tool result merged into thought` | 中间过程 |
| 7 | L829 | tool_result terminal 更新 | 与 L766 重复 |
| 8 | L840 | commandId 映射相关 | 中间过程 |
| 9 | L854 | warn 级别保持 | 不变 |
| 10 | L900 | `Injection detected at turn boundary!` | 中间检测 |
| 11 | L906 | `Queued injection` | 队列操作 |
| 12 | L928 | `Dequeued injection` | 队列操作 |
| 13 | L933 | `Cleared N pending injection(s)` | 队列操作 |
| 14 | L1165 | `Captured session ID:` | 开发调试 |
| 15 | L1174 | 会话恢复相关 | 中间过程 |
| 16 | L1191 | `MCP server status:` + JSON | 已有专门处理 |
| 17 | L1200 | `Available tools: N` | 启动信息 |
| 18 | L1216 | `message_end` 诊断 | 中间诊断 |
| 19 | L1222 | stream content 摘要 | 中间诊断 |
| 20 | L1237 | `Token usage (single API):` | 与 L1229 total 重复 |
| 21 | L1282 | `Subagent cleaned up (stream ended)` | 中间状态 |
| 22 | L1298 | `Stream content from xxx: N chars` | 中间诊断 |
| 23 | L1302 | `No content from stream` | 中间诊断 |
| 24 | L1305 | `Error thought present:` | 与 L989 重复 |
| 25 | L1333 | `Pending injection detected - deferring agent:complete` | 中间状态 |
| 26 | L1382 | `User stopped - no error sent` | 中间状态 |

**简化保留日志的内容**（降低输出量但不降级）：

| # | 行号 | 修改前 | 修改后 | 说明 |
|---|------|--------|--------|------|
| 1 | L683 | `Tool block complete [${name}], input: ${safeJsonStringify(toolInput)}` | `Tool block complete [${name}], input length: ${JSON.stringify(toolInput).length} chars` | 不再输出完整 input JSON |
| 2 | L1229 | 保留 `Token usage (total)` | 保留 | 不变 |

### 方案 4：SSH 日志降级（`ssh-manager.ts`）

| # | 行号 | 当前日志 | 处理方式 | 理由 |
|---|------|---------|---------|------|
| 1 | L110 | `Already connected to same server` | `console.debug` | keepalive 冗余 |
| 2 | L117 | `Cleaning up existing connection...` | `console.debug` | 中间过程 |
| 3 | L136 | `Ready event fired - connection ready` | `console.debug` | keepalive 重建 |
| 4 | L148 | `Connection closed, reason:` | `console.debug` | keepalive 正常关闭 |
| 5 | L171 | `Connecting with basic config` | `console.debug` | 冗余 |
| 6 | L186 | `Executing command: ${command}` | `console.debug`（所有 executeCommand 调用） | 健康检查高频 |
| 7 | L207 | `Command completed with exit code: ${code}` | `console.debug`（exit code 0 时） | 正常完成无需 info |
| 8 | L239 | `Executing command (full):` | `console.debug` | 同上 |
| 9 | L260 | `Command completed with exit code:` | `console.debug`（exit code 0 时） | 同上 |
| 10 | L291 | `Executing command (streaming):` | `console.debug` | 同上 |
| 11 | L320 | `Streaming command completed with exit code:` | `console.debug`（exit code 0 时） | 同上 |
| 12 | L354 | `SFTP initialized` | `console.debug` | 一次性信息 |
| 13 | L453 | `Local port forward already exists` | `console.debug` | 冗余 |
| 14 | L367 | `Uploading ${path}` | **保持** `console.info` | 文件传输有价值 |
| 15 | L393 | `Downloading ${path}` | **保持** `console.info` | 文件传输有价值 |
| 16 | L683 | `Reconnecting...` | **保持** `console.info` | 重要事件 |
| 17 | L716 | `Forcibly disconnecting` | **保持** `console.info` | 重要事件 |

### 方案 5：健康检查日志降级（`runtime-checker.ts`）

| # | 行号 | 处理方式 | 理由 |
|---|------|---------|------|
| 1 | L58 | `console.debug` | 轮询状态 |
| 2 | L74 | `console.debug` | 轮询参数 |
| 3 | L87 | `console.debug` | 轮询停止 |
| 4 | L109 | `console.debug` | 周期性检查开始 |
| 5 | L177 | `console.debug` | 周期性检查结果 |
| 6 | L199 | `console.debug` | 防抖缓存 |
| 7 | L205 | `console.debug` | 并发等待 |
| 8 | L251 | **保持** info | 有意义的错误/状态变化 |
| 9 | L274 | **保持** warn/error | 死进程检测 |
| 10 | L282 | **保持** warn/error | 死进程检测 |
| 11 | L463 | `console.debug` | PPID scan 开始 |
| 12 | L491 | `console.debug` | PPID scan 详情 |
| 13 | L501 | `console.debug` | PPID scan 详情 |
| 14 | L529 | `console.debug` | PPID scan 结果 |

### 方案 6：其他日志降级

**`watcher-host.service.ts`** (L84-88):
- worker stdout/stderr 直通改为 `console.debug`，避免文件监听输出填满日志

**`orchestrator.ts`** (L1773-1775):
- worker heartbeat 日志降为 `console.debug`

**`session-health.ts`** (L66, 149, 262, 269):
- 会话健康状态更新和注册日志降为 `console.debug`
- 错误/warn 级别日志保持不变

**`send-message-remote.ts`** (L69-70):
- 已使用 `log.debug`，无需修改

### 不做的事

- **不改变 console 输出**：dev 模式 `consoleLevel = 'debug'` 仍可看到所有日志
- **不改变 electron-log 的 API 使用方式**：仅用 `log.hooks` + `console.debug` 降级
- **不新增日志文件或传输通道**：沿用现有 `main-YYYY-MM-DD.log`
- **不替换全量 console.log 为 createLogger**：改动面过大，不符合增量优化原则
- **不修改渲染进程日志**：已有独立噪音控制
- **不修改 WebSocket ping/pong 机制本身**：只过滤日志输出
- **不为 `[event]` 日志添加额外分隔行**：现有前缀已足够醒目，保持简洁

## 开发前必读

### 模块设计文档

| # | 文件 | 阅读目的 |
|---|------|---------|
| 1 | `.project/prd/feature/logging/logging-enhancement-v2.md` | 了解日期分割和 `[event]` 用户操作日志方案 |
| 2 | `.project/prd/bugfix/main/bugfix-log-noise-v1.md` | 了解现有噪音过滤 hook 方案（状态 in-progress，确认是否已实施） |
| 3 | `.project/prd/feature/logging/log-content-optimization-v1.md` | 了解脱敏 hook 和前缀统一方案（状态 done） |

### 源码文件

| # | 文件路径 | 阅读目的 |
|---|------|---------|
| 1 | `src/main/services/log/index.ts` | 了解 `initLogger()` 实现，确定 hook 注册位置 |
| 2 | `src/main/services/agent/process-stream.ts` | 了解全部 40 处 console 调用，逐一确认保留/降级 |
| 3 | `src/main/services/agent/send-message-local.ts` (L85-130) | 了解 debug 残留，确认删除范围 |
| 4 | `src/main/services/remote/ssh/ssh-manager.ts` | 了解 SSH 心跳和命令执行日志位置 |
| 5 | `src/main/services/health/health-checker/runtime-checker.ts` | 了解被动检查和 PPID scan 日志位置 |
| 6 | `src/main/services/file-watcher/watcher-host.service.ts` (L80-90) | 了解 worker stdout/stderr 直通机制 |
| 7 | `src/main/services/agent/orchestrator.ts` (L1770-1780) | 了解 heartbeat 日志位置 |
| 8 | `src/main/services/agent/session-health.ts` | 了解会话健康轮询日志位置 |

### 编码规范

| # | 文档 | 阅读目的 |
|---|------|---------|
| 1 | `docs/Development-Standards-Guide.md` | TypeScript strict、命名规范 |
| 2 | `CLAUDE.md` | 编辑文件后必须 `npx eslint --fix <file>` 并 re-read 确认逻辑 |

## 涉及文件

| # | 文件路径 | 变更类型 | 说明 |
|---|---------|---------|------|
| 1 | `src/main/services/log/index.ts` | 修改 | `initLogger()` 中注册 `log.hooks` 过滤文件传输层心跳日志 |
| 2 | `src/main/services/agent/process-stream.ts` | 修改 | ~25 处 `console.log` 降为 `console.debug`；L683 简化 tool input 输出 |
| 3 | `src/main/services/agent/send-message-local.ts` | 修改 | 删除 ~12 行 debug scaffold（L92-124 区域） |
| 4 | `src/main/services/remote/ssh/ssh-manager.ts` | 修改 | ~12 处日志降为 `console.debug` |
| 5 | `src/main/services/health/health-checker/runtime-checker.ts` | 修改 | ~7 处日志降为 `console.debug` |
| 6 | `src/main/services/file-watcher/watcher-host.service.ts` | 修改 | worker stdout/stderr 直通降为 `console.debug` |
| 7 | `src/main/services/agent/orchestrator.ts` | 修改 | L1773-1775 heartbeat 日志降为 `console.debug` |
| 8 | `src/main/services/agent/session-health.ts` | 修改 | ~4 处日志降为 `console.debug` |

## 验收标准

### 心跳/周期性噪音过滤

- [ ] 日志文件中不再出现 `SSHManager Connection closed, reason:` 的 keepalive 关闭日志
- [ ] 日志文件中不再出现 `SSHManager Ready event fired` 的 keepalive 重建日志
- [ ] 日志文件中不再出现 `SSHManager Already connected to same server` 冗余日志
- [ ] 日志文件中不再出现 `SSHManager Executing command: echo ok` 健康检查日志
- [ ] 日志文件中不再出现 `Health[Runtime] Running passive status collection` 周期性日志
- [ ] 日志文件中不再出现 `Health[Runtime] Passive check complete:` 周期性结果日志
- [ ] 日志文件中不再出现 `Health[Runtime] Debounced: returning cached` 防抖日志
- [ ] 日志文件中不再出现 `Message sent: ping` WebSocket ping 日志
- [ ] 日志文件中不再出现 `heartbeat from worker` orchestrator 心跳日志
- [ ] 控制台输出不受影响（dev 模式仍可看到完整日志）

### Debug 残留清理

- [ ] `send-message-local.ts` 中不再出现 `FUNCTION START`、`BEFORE GETSPACE`、`AFTER GETSPACE` 等 debug 横幅
- [ ] `send-message-local.ts` 中不再出现 `getSpace returned:` 完整对象打印
- [ ] `send-message-local.ts` 中不再出现 `Remote routing check:` 详情打印

### Agent 流式日志降噪

- [ ] 一次完整的 Agent 对话（含 3-5 次工具调用）在日志文件中的输出行数减少 50% 以上
- [ ] 日志文件中仍保留 `Sending message to V2 session...` 对话开始标记
- [ ] 日志文件中仍保留 thinking block 完成摘要（长度信息）
- [ ] 日志文件中仍保留 tool block 摘要（tool name + input length，不含完整 JSON）
- [ ] 日志文件中仍保留 text block 完成摘要（累计字数）
- [ ] 日志文件中仍保留 result 消息（完成标记）
- [ ] 日志文件中仍保留 token usage total 汇总
- [ ] 日志文件中仍保留所有 error/warn 级别日志
- [ ] 日志文件中仍保留 subagent 生命周期日志
- [ ] 日志文件中不再出现完整 SDK 消息 `safeJsonStringify` 序列化
- [ ] 日志文件中不再出现 injection 队列操作中间日志

### SSH 日志降级

- [ ] SSH keepalive 导致的 `Connection closed` 日志不在文件中出现
- [ ] SSH `echo ok` 健康检查执行和完成日志不在文件中出现
- [ ] SSH 正常命令完成（exit code 0）日志不在文件中出现
- [ ] SSH 文件上传/下载日志仍保留在文件中
- [ ] SSH 重连事件仍保留在文件中

### 健康检查日志降级

- [ ] `Passive check complete` 周期性结果不在文件中出现
- [ ] `PPID scan` 常规结果不在文件中出现
- [ ] 死进程检测的 warn/error 日志仍保留在文件中

### 其他

- [ ] 文件监听 worker stdout/stderr 不在文件中出现
- [ ] Orchestrator heartbeat 不在文件中出现
- [ ] Session health 轮询不在文件中出现
- [ ] 用户操作 `[event]` 日志完整保留在文件中
- [ ] 与 logging-enhancement-v2 的日期分割方案兼容
- [ ] 与 log-content-optimization-v1 的脱敏 hook 和前缀统一兼容
- [ ] `npm run typecheck && npm run lint && npm run build` 通过
- [ ] 应用正常启动，无崩溃或白屏

## 变更记录

| 日期 | 内容 | 作者 |
|------|------|------|
| 2026-05-07 | 初始版本：聚焦文件传输层降噪，两层策略（Hook 过滤 + 源码降级），覆盖 8 个噪声源 | subagent |
