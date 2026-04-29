# PRD [功能级] -- 日志系统增强（按日期分割 + 网络请求捕获 + 用户事件记录）

> 版本：feature-logging-enhancement-v1
> 日期：2026-04-29
> 指令人：用户
> 归属模块：全栈（main + renderer + preload）
> 优先级：P1
> 影响范围：全栈
> 状态：in-progress

## 需求分析

### 现有日志系统

AICO-Bot 当前使用 `electron-log` (v5.4.3) 作为日志库，已在 `src/main/index.ts` 中初始化：

```typescript
import log from 'electron-log/main.js';
log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = isDev ? 'debug' : 'info';
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB auto-rotate
```

**日志存储位置**：
- 开发环境：`~/.aico-bot-dev/logs/`
- 生产环境：`~/.aico-bot/logs/`（默认 electron-log 路径 `%USERPROFILE%\AppData\Roaming\AICO-Bot\logs`）

**主进程日志工具**：`src/main/utils/logger.ts` 提供了 `createLogger(scope)` 工厂函数，基于 `electron-log` 的 `log.create({ logId: scope })` API 创建模块级 logger。当前有 9 个模块使用了此工具：
- `send-message.ts`, `orchestrator.ts`, `remote-ws-client.ts`, `aico-bot-mcp-bridge.ts`
- `taskboard.ts`, `persistent-worker.ts`, `permission-forwarder.ts`, `mailbox.ts`

**全局 console 替换**：`src/main/index.ts` 第 106 行 `Object.assign(console, log.functions)` 将全局 console 重定向到 electron-log。

**IPC handler 日志**：17 个 IPC handler 文件中有 127 处 `console.log` 调用（因为全局 console 已被 electron-log 替换，这些调用会自动写入文件日志）。

**打开日志文件夹**：已有 `system:open-log-folder` IPC 通道（`src/main/ipc/system.ts`），通过 `log.transports.file.getFile()` 获取日志文件路径并在系统文件管理器中打开。

### 现有系统的不足

| 问题 | 现状 | 影响 |
|------|------|------|
| **日志不按日期分割** | 仅按文件大小自动轮转（5MB），无日期维度 | 难以按天定位问题，日志文件混杂多天数据 |
| **无网络请求日志** | 没有使用 `session.webRequest` API 拦截网络请求 | 无法在日志中看到 Developer Tools Network 面板中的请求/响应信息 |
| **无用户交互事件日志** | IPC handler 中有零散的 console.log，但不统一、不结构化 | 无法追踪用户点击、设置变更等关键操作 |
| **渲染进程日志缺失** | 渲染进程使用原生 `console.log`（34 个文件中有 127+ 处），不会写入主进程日志文件 | 前端错误和事件只出现在 DevTools console 中，主进程日志文件看不到 |
| **无日志保留策略** | 无自动清理过期日志的机制 | 日志文件可能无限增长占用磁盘空间 |

### 用户痛点

1. **排查问题困难**：用户反馈 bug 时，开发者需要分别查看 DevTools Console、主进程日志文件、远程服务器日志，缺少统一的按日期分割的日志视图
2. **网络问题难以追溯**：API 请求失败时（如 Claude API 超时、远程服务器连接断开），日志中无法看到完整的请求 URL、状态码、耗时等关键信息
3. **用户操作链路不完整**：无法从日志中还原用户的操作步骤（如：点击了哪个按钮、修改了什么设置、触发了什么 IPC 调用）

### 预期效果

- 日志按天分割存储，文件名如 `aico-bot-2026-04-29.log`，方便按日期查找
- 所有网络 API 请求的关键信息（URL、方法、状态码、耗时）记录在日志中
- 用户关键操作（按钮点击、设置变更、IPC 调用）有结构化的日志记录
- 渲染进程日志通过 IPC 桥接到主进程，统一写入日志文件
- 过期日志自动清理，默认保留最近 30 天

## 技术方案

### 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                         AICO-Bot 日志增强                        │
│                                                                  │
│  ┌──────────────┐   IPC Bridge   ┌──────────────────────────┐   │
│  │  渲染进程     │ ──────────────► │  主进程                    │   │
│  │              │                │  ┌────────────────────┐  │   │
│  │ console.log  │                │  │ electron-log       │  │   │
│  │ user events  │                │  │ + daily rotation   │  │   │
│  │ click events │                │  │ + network capture  │  │   │
│  └──────────────┘                │  │ + retention policy │  │   │
│                                  │  └────────────────────┘  │   │
│  ┌──────────────┐   session.     │  ┌────────────────────┐  │   │
│  │  Network     │   webRequest   │  │ Log File           │  │   │
│  │  Requests    │ ──────────────►│  │ ~/.aico-bot/logs/  │  │   │
│  │  (Electron)  │                │  │ aico-bot-YYYY-MM-DD│  │   │
│  └──────────────┘                │  │   .log             │  │   │
│                                  │  └────────────────────┘  │   │
│                                  └──────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 1. 日志文件按日期分割

**核心改动**：配置 electron-log 的 `transports.file` 使用日期格式化的文件名。

**修改文件**：`src/main/index.ts`

```typescript
import { format } from 'node:date-fns';

// 日期格式化的日志文件路径
log.transports.file.resolvePathFn = (variables) => {
  const logDir = isDev
    ? join(homedir(), '.aico-bot-dev', 'logs')
    : join(app.getPath('userData'), 'logs');

  // 文件名格式: aico-bot-2026-04-29.log
  const dateStr = format(new Date(), 'yyyy-MM-dd');
  return join(logDir, `aico-bot-${dateStr}.log`);
};
```

**electron-log 的 `resolvePathFn`** 支持接收 `variables` 参数（包含 `{ date, pid }` 等），可以用 `variables.date` 来格式化日期，避免引入 `date-fns` 依赖：

```typescript
log.transports.file.resolvePathFn = (variables) => {
  const logDir = isDev
    ? join(homedir(), '.aico-bot-dev', 'logs')
    : join(app.getPath('userData'), 'logs');
  const dateStr = variables.date?.toISOString().split('T')[0] ?? 'unknown';
  return join(logDir, `aico-bot-${dateStr}.log`);
};
```

**日志保留策略**：在应用启动时（extended bootstrap 阶段），清理超过 30 天的日志文件：

```typescript
// src/main/utils/log-cleanup.ts
import { readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';

const LOG_RETENTION_DAYS = 30;

export async function cleanupOldLogs(logDir: string): Promise<void> {
  const files = await readdir(logDir);
  const now = Date.now();
  const retentionMs = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  for (const file of files) {
    if (!file.startsWith('aico-bot-') || !file.endsWith('.log')) continue;
    const filePath = join(logDir, file);
    try {
      const fileStat = await stat(filePath);
      if (now - fileStat.mtimeMs > retentionMs) {
        await unlink(filePath);
      }
    } catch {
      // 忽略清理失败的文件
    }
  }
}
```

**配置化**：将日志保留天数存入 `config.json`（可选），默认 30 天：

```typescript
// config type extension
logRetentionDays?: number; // default: 30
```

### 2. Network 日志捕获

**核心方案**：使用 Electron 的 `session.defaultSession.webRequest` API 拦截网络请求。

**新增文件**：`src/main/services/network-logger.ts`

```typescript
import log from 'electron-log/main.js';

const API_URL_PATTERNS = [
  /^https?:\/\/api\.anthropic\.com/,         // Claude API
  /^https?:\/\/api\.openai\.com/,            // OpenAI API
  /^https?:\/\/gitcode\.com\/api/,           // GitCode API
  /^https?:\/\/api\.github\.com/,            // GitHub API
  /^https?:\/\/localhost/,                   // 本地 HTTP 服务
  /\/api\//,                                 // 任何 /api/ 路径
];

function isApiRequest(url: string): boolean {
  return API_URL_PATTERNS.some(pattern => pattern.test(url));
}

// 用于记录请求开始时间的 Map
const requestTimings = new Map<string, number>();

export function setupNetworkLogger(session: Electron.Session): void {
  // 只在 onBeforeRequest 中记录 API 请求的开始时间
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details) => {
    if (!isApiRequest(details.url)) return;
    requestTimings.set(details.id.toString(), Date.now());
  });

  // 在 onCompleted 中记录完整的请求日志
  session.webRequest.onCompleted({ urls: ['<all_urls>'] }, (details) => {
    if (!isApiRequest(details.url)) return;
    const startTime = requestTimings.get(details.id.toString());
    requestTimings.delete(details.id.toString());
    const duration = startTime ? Date.now() - startTime : -1;

    log.info(
      `[Network] ${details.method} ${details.url}`,
      `→ ${details.statusCode}`,
      duration >= 0 ? `(${duration}ms)` : '',
    );
  });

  // 记录请求失败
  session.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (details) => {
    if (!isApiRequest(details.url)) return;
    requestTimings.delete(details.id.toString());
    log.warn(
      `[Network] ${details.method} ${details.url} FAILED`,
      details.error,
    );
  });
}
```

**集成位置**：在 `src/main/index.ts` 的 `app.whenReady()` 回调中，BrowserWindow 创建后调用：

```typescript
import { setupNetworkLogger } from './services/network-logger';

// 在 app.whenReady() 内，mainWindow 创建后
setupNetworkLogger(mainWindow.webContents.session);
```

**过滤策略**：
- 只记录匹配 `API_URL_PATTERNS` 的请求（API 类请求）
- 静态资源（`.js`, `.css`, `.png`, `.woff` 等）不记录
- 记录内容：方法、URL、状态码、耗时
- **不记录请求体和响应体**（避免日志文件膨胀和敏感信息泄露）

**日志输出示例**：
```
[2026-04-29 10:23:45.123] [info] [Network] POST https://api.anthropic.com/v1/messages → 200 (1523ms)
[2026-04-29 10:23:45.456] [info] [Network] GET https://gitcode.com/api/v5/repos/... → 200 (89ms)
[2026-04-29 10:23:46.789] [warn] [Network] GET https://api.github.com/repos/... FAILED net::ERR_CONNECTION_TIMED_OUT
```

### 3. 用户交互事件日志

**核心方案**：在关键 IPC handler 中添加结构化的事件日志。

**修改文件**：现有的 IPC handler 文件（按需选择关键通道）

**不改动所有 127 处 console.log**，而是只在以下关键操作中添加结构化的 `[Event]` 日志：

| 事件类别 | IPC 通道 | 记录内容 |
|---------|----------|---------|
| 消息发送 | `agent:send-message` | spaceId, conversationId, 消息长度 |
| 停止生成 | `agent:stop-generation` | conversationId |
| 工具审批 | `agent:approve-tool` / `agent:reject-tool` | conversationId |
| 设置变更 | `config:set` | 变更的 key 列表 |
| 空间操作 | `space:create` / `space:delete` | spaceId, name |
| 登录/登出 | `auth:*` 系列 | providerType |
| 技能安装/卸载 | `skill:install` / `skill:uninstall` | skillId |
| 远程部署 | `remote-server:deploy-agent` | serverId |

**实现方式**：创建一个轻量的辅助函数，在 IPC handler 的入口处调用：

```typescript
// src/main/utils/logger.ts 中新增
export function logUserEvent(category: string, action: string, details?: Record<string, string>): void {
  const log = createLogger('event');
  const detailStr = details ? ` ${JSON.stringify(details)}` : '';
  log.info(`[${category}] ${action}${detailStr}`);
}
```

**使用示例**（在 IPC handler 中）：
```typescript
ipcMain.handle('agent:send-message', async (_event, request) => {
  logUserEvent('Agent', 'sendMessage', {
    spaceId: request.spaceId,
    conversationId: request.conversationId,
    messageLength: String(request.message?.length ?? 0),
  });
  // ... existing handler logic
});
```

**注意**：不记录敏感信息（如 API Key、Token、消息内容等），只记录操作类型和标识符。

### 4. 渲染进程日志桥接

**核心方案**：在 preload 层暴露日志 IPC 通道，渲染进程的关键日志通过 IPC 发送到主进程。

**新增 IPC 通道**：`log:write`

**修改文件**：

#### 4.1 `src/preload/index.ts` -- 新增日志 API

```typescript
// 在 AicoBotExpose 接口中新增
logWrite: (level: 'info' | 'warn' | 'error', scope: string, message: string) => Promise<void>;

// 在 contextBridge.exposeInMainWorld 中新增
logWrite: (level, scope, message) => ipcRenderer.invoke('log:write', level, scope, message),
```

#### 4.2 `src/main/ipc/system.ts` -- 新增日志 handler

```typescript
ipcMain.handle('log:write', async (_event, level: string, scope: string, message: string) => {
  const log = createLogger(`renderer:${scope}`);
  switch (level) {
    case 'warn':
      log.warn(message);
      break;
    case 'error':
      log.error(message);
      break;
    default:
      log.info(message);
  }
  return { success: true };
});
```

#### 4.3 `src/renderer/utils/renderer-logger.ts` -- 新增渲染进程日志工具（新增文件）

```typescript
/**
 * Renderer-side logger that bridges logs to main process via IPC.
 * For Electron mode only - in remote web mode, logs stay in browser console.
 */

interface RendererLogger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

export function createRendererLogger(scope: string): RendererLogger {
  const isElectronMode = typeof window !== 'undefined' && window.aicoBot;

  function write(level: 'info' | 'warn' | 'error', message: string, args: unknown[]): void {
    const formatted = args.length > 0 ? `${message} ${args.map(String).join(' ')}` : message;

    // Always log to browser console
    switch (level) {
      case 'warn': console.warn(`[${scope}]`, message, ...args); break;
      case 'error': console.error(`[${scope}]`, message, ...args); break;
      default: console.log(`[${scope}]`, message, ...args);
    }

    // Bridge to main process in Electron mode
    if (isElectronMode) {
      window.aicoBot.logWrite(level, scope, formatted).catch(() => {
        // Silently ignore IPC errors - don't let logging failures crash the app
      });
    }
  }

  return {
    info: (msg, ...args) => write('info', msg, args),
    warn: (msg, ...args) => write('warn', msg, args),
    error: (msg, ...args) => write('error', msg, args),
  };
}
```

#### 4.4 关键场景接入

只在以下关键场景使用 renderer logger（不做全量替换，保持渐进式接入）：

| 场景 | 文件 | 说明 |
|------|------|------|
| API 调用层 | `src/renderer/api/transport.ts` | HTTP/WS 请求成功、失败 |
| Store 关键操作 | `src/renderer/stores/chat.store.ts` | 消息发送、停止生成 |
| 设置页面 | `src/renderer/components/settings/*.tsx` | 设置保存、验证失败 |
| 技能安装 | `src/renderer/components/skill/SkillMarket.tsx` | 安装/卸载操作 |

### 5. 简洁模式（INFO 级别）

**当前已有机制**：`log.transports.file.level = 'info'` 已经在文件传输层过滤了 debug/silly 级别。

**增强**：确保新增的网络日志和用户事件日志使用 `log.info()` 或 `log.warn()`，不使用 `log.debug()`。这样在简洁模式下：

- **记录**：网络请求（info）、用户操作（info）、错误（error/warn）
- **不记录**：详细的 IPC 参数（debug）、热更新细节（debug）、渲染进程生命周期细节（debug）

### 文件名规范

| 日志文件 | 格式 | 说明 |
|---------|------|------|
| 主日志 | `aico-bot-YYYY-MM-DD.log` | 当天的所有日志（main + renderer bridge + network） |
| 旧日志（归档） | `aico-bot-YYYY-MM-DD.log` | 超过 30 天自动删除 |

## 涉及文件

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `src/main/index.ts` | 修改 | `resolvePathFn` 改为日期分割；集成 `setupNetworkLogger()`；Extended 阶段调用 `cleanupOldLogs()` |
| 2 | `src/main/utils/logger.ts` | 修改 | 新增 `logUserEvent()` 辅助函数 |
| 3 | `src/main/utils/log-cleanup.ts` | 新增 | 日志文件清理服务（30 天保留策略） |
| 4 | `src/main/services/network-logger.ts` | 新增 | `session.webRequest` 网络请求拦截与日志记录 |
| 5 | `src/main/ipc/system.ts` | 修改 | 新增 `log:write` IPC handler |
| 6 | `src/main/ipc/agent.ts` | 修改 | sendMessage / stopGeneration 添加 `logUserEvent()` |
| 7 | `src/main/ipc/config.ts` | 修改 | config:set 添加 `logUserEvent()` |
| 8 | `src/main/ipc/space.ts` | 修改 | space:create / space:delete 添加 `logUserEvent()` |
| 9 | `src/main/ipc/auth.ts` | 修改 | startLogin / completeLogin / logout 添加 `logUserEvent()` |
| 10 | `src/main/ipc/skill.ts` | 修改 | skill:install / skill:uninstall 添加 `logUserEvent()` |
| 11 | `src/main/ipc/remote-server.ts` | 修改 | deploy/start/stop agent 添加 `logUserEvent()` |
| 12 | `src/preload/index.ts` | 修改 | 新增 `logWrite` API 暴露到 `window.aicoBot` |
| 13 | `src/renderer/utils/renderer-logger.ts` | 新增 | 渲染进程日志桥接工具 |
| 14 | `src/renderer/api/transport.ts` | 修改 | HTTP 请求日志增加耗时记录 |
| 15 | `.project/modules/settings/features/system-settings/changelog.md` | 修改 | 追加变更记录 |

## 开发前必读

### 模块设计文档

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 1 | `.project/modules/health/health-monitor-v1.md` | 了解健康监控模块中是否有日志相关的集成点 |
| 2 | `.project/modules/agent/features/stream-processing/design.md` | 了解流式处理中的日志模式，确保网络日志不干扰流式日志 |

### 源码文件

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 3 | `src/main/index.ts` | 理解 electron-log 初始化流程、日志目录配置、`resolvePathFn` 用法、console 替换机制 |
| 4 | `src/main/utils/logger.ts` | 理解 `createLogger()` 工厂函数和 `ScopedLogger` 接口，新增 `logUserEvent()` |
| 5 | `src/main/ipc/system.ts` | 理解现有 `system:open-log-folder` handler 实现，作为 `log:write` handler 的参考 |
| 6 | `src/main/ipc/agent.ts` | 理解 agent IPC handler 结构，确定 `logUserEvent()` 插入位置 |
| 7 | `src/main/ipc/config.ts` | 理解 config IPC handler 结构，确定设置变更日志位置 |
| 8 | `src/preload/index.ts` | 理解 `contextBridge.exposeInMainWorld` 模式、`AicoBotExpose` 接口定义 |
| 9 | `src/renderer/api/transport.ts` | 理解 HTTP/WS 传输层实现，确定 renderer logger 集成点 |
| 10 | `src/shared/constants/index.ts` | 理解共享常量的导出模式，新增日志 IPC 通道常量 |
| 11 | `src/main/services/proxy/proxy-fetch.ts` | 理解主进程的网络请求模式（proxyFetch），确认网络日志不会重复记录主进程发出的请求 |

### 编码规范

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 12 | `docs/Development-Standards-Guide.md` | 编码规范（TypeScript strict、禁止 any、纯类型导入、命名规范） |
| 13 | `docs/vibecoding-doc-standard.md` | 文档管理规范（PRD 状态流转、changelog 更新规则） |

## 验收标准

- [ ] 日志文件按日期分割，文件名格式为 `aico-bot-YYYY-MM-DD.log`
- [ ] 开发环境日志存储在 `~/.aico-bot-dev/logs/`，生产环境在 `~/.aico-bot/logs/`
- [ ] 每天产生独立的日志文件，跨天自动切换
- [ ] 超过 30 天的日志文件在应用启动时自动清理
- [ ] `system:open-log-folder` 打开日志目录后能看到按日期命名的日志文件
- [ ] API 类网络请求（Claude API、GitHub API、GitCode API、本地 HTTP 服务）在日志中有记录
- [ ] 网络请求日志包含：方法、URL、状态码、耗时（ms）
- [ ] 网络请求失败时以 warn 级别记录，包含错误信息
- [ ] 静态资源请求（.js、.css、.png、.woff 等）不被记录
- [ ] 用户关键操作（发送消息、设置变更、空间创建/删除、登录/登出、技能安装/卸载）在日志中有 `[Event]` 标记的结构化记录
- [ ] 用户事件日志不包含敏感信息（API Key、Token、消息正文）
- [ ] 渲染进程通过 IPC 桥接的关键日志（HTTP 请求、Store 操作、设置保存）写入主进程日志文件
- [ ] `log:write` IPC 通道已暴露到 preload 的 `window.aicoBot` 接口
- [ ] 简洁模式下（INFO 级别），日志只包含 info/warn/error，不包含 debug/silly
- [ ] 新增的日志输出不影响应用性能（网络请求拦截和 IPC 桥接均为异步操作）
- [ ] `npm run typecheck && npm run lint && npm run build` 全部通过
