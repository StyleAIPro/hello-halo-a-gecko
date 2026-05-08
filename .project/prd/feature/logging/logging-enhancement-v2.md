# PRD [功能级] — 日志系统增强 v2

| 字段 | 值 |
|------|------|
| 版本 | v2 |
| 日期 | 2026-05-07（更新于模块化重构后） |
| 作者 | 人 |
| 模块 | main / services/log |
| 状态 | done |
| 优先级 | P1 |
| 影响范围 | 仅主进程 |

## 需求分析

### 背景

日志模块已通过 `feat-logging-module-v1` 重构为独立模块 `src/main/services/log/`，提供 `initLogger()`、`createLogger()`、`cleanupOldLogs()` 三个 API。当前日志系统：
- 日志文件位置：`~/.aico-bot/logs/`（生产）/ `~/.aico-bot-dev/logs/`（开发）
- 日志轮转：5 MB 单文件自动轮转，固定文件名（无日期区分）
- 无用户操作记录

### 问题

1. **日志无法按日期查找**：所有日志写入同一文件，轮转后旧日志被覆盖，无法按日期定位问题
2. **缺少用户操作记录**：日志中只有调试信息和错误，无法追踪用户的关键操作（发送消息、切换空间、修改设置等）

### 预期效果

- 每天的日志存入独立文件，如 `main-2026-05-07.log`
- 日志文件存放在 `app-logs/` 子目录中
- 关键用户操作被记录到日志中（`[event]` 前缀，`console.info` 级别）
- 超过 30 天的日志文件自动清理（已在 feat-logging-module-v1 中激活，需确认清理目录对齐）
- "打开日志文件夹"功能打开 `app-logs/` 目录

## 技术方案

### 核心策略

在已完成的日志模块基础上做增量修改：
1. 修改 `initLogger()` 的 `resolvePathFn` 实现按日期分割
2. 将日志目录从 `logs` 改为 `app-logs`
3. 在 IPC handler 中添加用户操作日志
4. 更新 `system:open-log-folder` 指向 `app-logs/`
5. 更新 `log-cleanup.ts` 匹配新文件名模式

### 1. 日志日期分割（修改 `src/main/services/log/index.ts`）

利用 electron-log 的 `resolvePathFn` 自定义日志文件路径和命名：

```typescript
// 修改前
log.transports.file.resolvePathFn = () => logDir;

// 修改后
log.transports.file.resolvePathFn = (variables) => {
  const dateStr = variables.date?.toISOString().split('T')[0] ?? 'unknown';
  return join(logDir, `main-${dateStr}.log`);
};
```

- `variables.date` 是 electron-log 注入的日志时间戳，自动按日期生成不同文件
- `LogConfig.logDir` 语义变为**目录**而非文件路径
- 仍保留 `maxFileSize = 5MB` 作为单日文件上限

### 2. 日志目录改为 `app-logs`（修改调用方）

修改 `index.ts` 和 `bootstrap/extended.ts` 中传入的 `logDir`：
- 开发环境：`~/.aico-bot-dev/app-logs`
- 生产环境：`app.getPath('userData')/app-logs`

### 3. 用户操作日志（IPC Handler 中添加）

在以下 IPC handler 中添加 `[event]` 前缀的 `console.info` 级别日志：

| 文件 | IPC 通道 | 日志内容 |
|------|---------|---------|
| `src/main/ipc/agent.ts:47` | `agent:send-message` | `[event] sendMessage: conversationId=xxx, spaceId=xxx` |
| `src/main/ipc/agent.ts:62` | `agent:stop` | `[event] stopGeneration: conversationId=xxx` |
| `src/main/ipc/space.ts:61` | `space:create` | `[event] createSpace: spaceId=xxx` |
| `src/main/ipc/space.ts:106` | `space:delete` | `[event] deleteSpace: spaceId=xxx` |
| `src/main/ipc/space.ts:139` | `space:update` | `[event] updateSpace: spaceId=xxx` |
| `src/main/ipc/config.ts:29` | `config:set` | `[event] updateConfig: keys=[...]` |
| `src/main/ipc/skill.ts:41` | `skill:install` | `[event] installSkill: skillId=xxx, mode=xxx` |
| `src/main/ipc/skill.ts:71` | `skill:uninstall` | `[event] uninstallSkill: skillId=xxx` |
| `src/main/ipc/remote-server.ts:198` | `remote-server:connect` | `[event] remoteConnect: serverId=xxx` |
| `src/main/ipc/remote-server.ts:211` | `remote-server:disconnect` | `[event] remoteDisconnect: serverId=xxx` |
| `src/main/ipc/remote-server.ts:185` | `remote-server:deploy` | `[event] remoteDeploy: serverId=xxx` |

日志格式统一为：
```typescript
console.info(`[event] 操作名: key=value, key=value`);
```

使用 `console.info` 而非 `console.log`，便于后续 hook 过滤器区分事件日志和调试日志。

### 4. 更新"打开日志文件夹"路径（`src/main/ipc/system.ts`）

```typescript
// 修改前（当前代码）
ipcMain.handle('system:open-log-folder', async () => {
  const logFile = log.transports.file.getFile();
  const logDir = dirname(logFile.path);
  await shell.openPath(logDir);
  return { success: true, data: logDir };
});

// 修改后：直接使用 app-logs 目录路径
ipcMain.handle('system:open-log-folder', async () => {
  const logDir = isDev
    ? join(homedir(), '.aico-bot-dev', 'app-logs')
    : join(app.getPath('userData'), 'app-logs');
  await shell.openPath(logDir);
  return { success: true, data: logDir };
});
```

### 5. 不做的事

- **不做全量 console.log → createLogger 替换**（152 个文件，太重）
- **不做渲染进程日志桥接**（preload log:write IPC 通道），渲染进程日志通过 electron-log IPC transport 已自动路由到主进程
- **不修改日志级别**：生产环境保持 info，开发环境保持 debug

## 开发前必读

### 模块设计文档

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 1 | `.project/prd/feature/logging/feat-logging-module-v1.md` | 了解日志模块化重构的架构，本次在其基础上增量修改 |

### 源码文件

| # | 文件路径 | 阅读目的 |
|---|---------|---------|
| 2 | `src/main/services/log/index.ts` | 了解 initLogger 和 resolvePathFn 当前实现 |
| 3 | `src/main/services/log/types.ts` | 了解 LogConfig 类型定义 |
| 4 | `src/main/services/log/log-cleanup.ts` | 确认清理函数的文件名过滤模式 |
| 5 | `src/main/index.ts` (行 33-39) | 了解 initLogger 调用参数（logDir 传入方式） |
| 6 | `src/main/bootstrap/extended.ts` (行 279-284) | 了解 cleanupOldLogs 调用参数 |
| 7 | `src/main/ipc/agent.ts` | agent:send-message 和 agent:stop handler 位置 |
| 8 | `src/main/ipc/space.ts` | space:create/delete/update handler 位置 |
| 9 | `src/main/ipc/config.ts` | config:set handler 位置 |
| 10 | `src/main/ipc/skill.ts` | skill:install/uninstall handler 位置 |
| 11 | `src/main/ipc/remote-server.ts` | remote-server connect/disconnect/deploy handler 位置 |
| 12 | `src/main/ipc/system.ts` (行 146-159) | system:open-log-folder 当前实现 |

### 编码规范

| # | 文档 | 阅读目的 |
|---|------|---------|
| 13 | `docs/Development-Standards-Guide.md` | TypeScript strict、命名规范 |

## 涉及文件

| # | 文件路径 | 变更类型 | 说明 |
|---|---------|---------|------|
| 1 | `src/main/services/log/index.ts` | 修改 | resolvePathFn 改为按日期分割文件名 |
| 2 | `src/main/index.ts` | 修改 | logDir 从 `logs` 改为 `app-logs` |
| 3 | `src/main/bootstrap/extended.ts` | 修改 | cleanupOldLogs 的 logDir 从 `logs` 改为 `app-logs` |
| 4 | `src/main/ipc/agent.ts` | 修改 | 添加 sendMessage / stopGeneration 事件日志 |
| 5 | `src/main/ipc/space.ts` | 修改 | 添加 space CRUD 事件日志 |
| 6 | `src/main/ipc/config.ts` | 修改 | 添加 config:set 事件日志 |
| 7 | `src/main/ipc/skill.ts` | 修改 | 添加 skill install/uninstall 事件日志 |
| 8 | `src/main/ipc/remote-server.ts` | 修改 | 添加远程服务器操作事件日志 |
| 9 | `src/main/ipc/system.ts` | 修改 | 更新"打开日志文件夹"路径指向 app-logs |

## 验收标准

- [x] 日志文件按日期分割，文件名为 `main-YYYY-MM-DD.log`
- [x] 日志目录为 `app-logs/`（开发环境 `~/.aico-bot-dev/app-logs/`，生产环境 `userData/app-logs/`）
- [x] 超过 30 天的日志文件在应用启动后自动清理
- [x] 用户发送消息时日志记录 conversationId 和 spaceId
- [x] 用户停止生成时日志记录 conversationId
- [x] 用户创建/删除/更新空间时日志记录 spaceId
- [x] 用户修改设置时日志记录变更的 keys
- [x] 用户安装/卸载技能时日志记录 skillId
- [x] 远程服务器连接/断开/部署时日志记录 serverId
- [x] "打开日志文件夹"功能打开的是 `app-logs/` 目录
- [x] 日志文件中可以看到 `[event]` 前缀的用户操作记录
- [x] 控制台输出不受影响（开发环境仍可看到 debug 日志）
- [x] `npm run build` 通过
- [x] 应用正常启动，无崩溃或白屏

## 变更

| 日期 | 内容 | 作者 |
|------|------|------|
| 2026-04-30 | 初始版本 | 人 |
| 2026-05-07 | 更新：对齐日志模块化重构后的代码结构，涉及文件和行号更新 | @misakamikoto |
