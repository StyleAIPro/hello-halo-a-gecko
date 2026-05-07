# PRD [功能级] -- 日志系统模块化重构

> 版本：feat-logging-module-v1
> 日期：2026-05-07
> 指令人：@misakamikoto
> 归属模块：main / 基础设施
> 状态：done
> 优先级：P1

## 需求分析

### 背景

AICO-Bot 的日志功能当前分散在多个位置：

- **`src/main/utils/logger.ts`**（34 行）：提供 `createLogger(scope)` 工具函数，11 个文件使用
- **`src/main/utils/log-cleanup.ts`**（32 行）：日志清理函数，**未被任何文件导入**（死代码）
- **`src/main/index.ts`**（行 16-106）：日志全局初始化（`log.initialize()`、transports 配置、console 替换、errorHandler），约 90 行配置逻辑混在应用入口中

项目其他基础设施模块（如 `services/health/`、`platform/scheduler/`）均按领域组织为独立子目录，包含 `index.ts`（入口）、`types.ts`（类型）和功能子文件。日志作为横切基础设施，应遵循同样的组织模式，方便其他模块调用和维护。

### 问题

1. **配置分散**：日志初始化、transport 配置、errorHandler 启动、console 替换共约 90 行代码散落在 `src/main/index.ts` 顶部，使应用入口臃肿
2. **日志清理是死代码**：`src/main/utils/log-cleanup.ts` 已编写但从未被调用，日志文件无清理机制
3. **无法按模块控制日志级别**：当前日志级别是全局的（file=info, console 按环境区分），无法针对某个 scope 单独开启 debug
4. **模块归属不明确**：日志相关代码放在 `utils/` 下，语义上不够准确。日志是服务而非工具函数
5. **与 logging-enhancement-v2 PRD 的关系**：v2 PRD（状态 in-progress）聚焦日期分割和用户事件记录，本次重构聚焦模块结构。两者目标不冲突，重构后 v2 的改动应迁入新模块

### 预期效果

- 日志初始化代码从 `index.ts` 中抽离，通过 `initLogger()` 一次性完成
- `src/main/services/log/` 作为独立模块，提供统一的初始化、创建、清理能力
- 其他模块通过 `import { createLogger } from '../services/log'` 获取 scoped logger
- 已有的 11 处 `createLogger` 导入路径平滑迁移
- `index.ts` 中的日志初始化代码缩减为 1-2 行调用

## 技术方案

### 核心策略

**最小化重构**：不改变 electron-log 的使用方式，不替换 152 个文件中的 `console.*` 调用，仅做代码组织层面的结构调整。核心价值是**集中管理**和**方便调用**。

与 logging-enhancement-v2 PRD 的关系：如果 v2 已合入，则 v2 中的日期分割配置和清理调用应在本次重构中迁入新模块；如果 v2 未合入，则本次重构为 v2 的改动提供正确的落脚点。

### 1. 目录结构

```
src/main/services/log/
  index.ts          -- 模块入口，导出 initLogger() 和 createLogger()
  types.ts          -- 类型定义（ScopedLogger, LogConfig, LogLevel）
  log-cleanup.ts    -- 日志文件清理（从 utils/log-cleanup.ts 迁入并激活）
```

不设 `log-rotation.ts` 和 `log-format.ts`：日期分割通过 electron-log 的 `resolvePathFn` 实现（v2 PRD 方案），结构化格式通过 `log.hooks.push()` 实现，均不需要独立文件。保持模块精简。

### 2. 类型定义

**文件**：`src/main/services/log/types.ts`

```typescript
export type LogFn = (...params: unknown[]) => void;

export interface ScopedLogger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  silly: LogFn;
}

export interface LogConfig {
  /** 数据目录路径（~/.aico-bot 或 ~/.aico-bot-dev） */
  dataDir: string;
  /** 是否为开发环境 */
  isDev: boolean;
  /** 文件日志最低级别，默认 'info' */
  fileLevel?: string;
  /** 控制台日志最低级别，默认 dev='debug' / prod='info' */
  consoleLevel?: string;
  /** 单文件最大字节数，默认 5MB */
  maxFileSize?: number;
}
```

### 3. 模块入口

**文件**：`src/main/services/log/index.ts`

```typescript
import log from 'electron-log/main.js';
import type { ScopedLogger, LogConfig } from './types';
import { cleanupOldLogs } from './log-cleanup';

export type { ScopedLogger, LogConfig } from './types';

/**
 * 初始化日志系统。
 * 必须在应用入口最早调用（import electron 之后、其他模块之前）。
 *
 * 职责：
 * 1. log.initialize() — 启用 renderer IPC transport
 * 2. 配置 file/console transport 级别
 * 3. 配置日志文件路径和大小
 * 4. Object.assign(console, log.functions) — 全局 console 替换
 * 5. log.errorHandler.startCatching() — 错误捕获
 */
export function initLogger(config: LogConfig): void {
  const {
    dataDir,
    isDev,
    fileLevel = 'info',
    consoleLevel = isDev ? 'debug' : 'info',
    maxFileSize = 5 * 1024 * 1024,
  } = config;

  log.initialize();
  log.transports.file.level = fileLevel;
  log.transports.console.level = consoleLevel;
  log.transports.file.maxSize = maxFileSize;

  // 日志文件路径
  // 如果 logging-enhancement-v2 已合入，resolvePathFn 会按日期分割；
  // 否则使用默认的 electron-log 路径逻辑。
  log.transports.file.resolvePathFn = () => {
    return join(dataDir, 'logs');
  };

  // 全局 console 替换
  Object.assign(console, log.functions);

  // 错误捕获（必须在 EPIPE 过滤器之后调用）
  log.errorHandler.startCatching();
}

/**
 * 异步清理过期日志文件。
 * 在 extended services 初始化后调用，不阻塞启动。
 */
export { cleanupOldLogs };

/**
 * 创建 scoped logger。
 * 用法：const logger = createLogger('agent') → 输出 [agent] Your message
 */
export function createLogger(scope: string): ScopedLogger {
  return log.create({ logId: scope }) as unknown as ScopedLogger;
}
```

要点：
- `initLogger` 接收 `LogConfig` 参数，调用者传入 `dataDir` 和 `isDev`，模块内部不感知路径计算细节
- `log.errorHandler.startCatching()` 仍由 `index.ts` 调用（因为 EPIPE 过滤器必须在 error handler 之前注册），`initLogger` 中不调用它
- `cleanupOldLogs` 直接 re-export，由 `index.ts` 或 `bootstrap/extended.ts` 在适当时机调用
- `createLogger` 保持现有签名不变，仅修改 import 路径

### 4. 日志清理

**文件**：`src/main/services/log/log-cleanup.ts`

从 `src/main/utils/log-cleanup.ts` 迁入，逻辑不变：

```typescript
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Clean up log files older than maxAgeDays.
 * Called after extended services init — does not block startup.
 */
export async function cleanupOldLogs(logDir: string, maxAgeDays = 30): Promise<void> {
  let files: string[];
  try {
    files = await readdir(logDir);
  } catch {
    return;
  }

  const now = Date.now();
  const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;

  for (const file of files) {
    if (!file.startsWith('main-') || !file.endsWith('.log')) continue;
    try {
      const filePath = join(logDir, file);
      const fileStat = await stat(filePath);
      if (now - fileStat.mtimeMs > maxAge) {
        await unlink(filePath);
      }
    } catch {
      // Skip files that can't be stat'd or deleted
    }
  }
}
```

### 5. index.ts 改造

**文件**：`src/main/index.ts`

改造后的日志初始化部分（行 16-106 缩减为约 10 行）：

```typescript
import log from 'electron-log/main.js';
import { initLogger } from './services/log';
import { homedir } from 'node:os';

// ... ESM compat shims 不变 ...

// EPIPE / network error 过滤器（必须在 errorHandler 之前注册）
process.on('uncaughtException', (error) => { /* ... 不变 ... */ });
process.on('unhandledRejection', (reason) => { /* ... 不变 ... */ });

// 日志初始化
const isDev = process.env.NODE_ENV === 'development';
initLogger({
  dataDir: isDev ? join(homedir(), '.aico-bot-dev') : undefined as any,
  isDev,
});

// 注意：如果 logging-enhancement-v2 的 resolvePathFn 已合入，
// 需要在 initLogger 调用后覆盖 resolvePathFn 以启用日期分割。
```

### 6. 调用者迁移

11 个使用 `createLogger` 的文件需更新 import 路径：

| 文件 | 旧路径 | 新路径 |
|------|--------|--------|
| `src/main/services/agent/orchestrator.ts` | `../../utils/logger` | `../log` |
| `src/main/services/agent/mailbox.ts` | `../../utils/logger` | `../log` |
| `src/main/services/agent/taskboard.ts` | `../../utils/logger` | `../log` |
| `src/main/services/agent/persistent-worker.ts` | `../../utils/logger` | `../log` |
| `src/main/services/agent/send-message-local.ts` | `../../utils/logger` | `../log` |
| `src/main/services/agent/send-message-remote.ts` | `../../utils/logger` | `../log` |
| `src/main/services/agent/permission-forwarder.ts` | `../../utils/logger` | `../log` |
| `src/main/services/remote/ws/remote-ws-client.ts` | `../../../utils/logger` | `../../log` |
| `src/main/services/remote/ws/ws-connection-pool.ts` | `../../../utils/logger` | `../../log` |
| `src/main/services/remote/ws/aico-bot-mcp-bridge.ts` | `../../../utils/logger` | `../../log` |

### 7. 清理旧文件

迁移完成后删除：
- `src/main/utils/logger.ts` — 内容已迁入 `services/log/index.ts`
- `src/main/utils/log-cleanup.ts` — 内容已迁入 `services/log/log-cleanup.ts`，且原本就是死代码

### 8. 日志清理激活

在 `src/main/bootstrap/extended.ts` 的末尾（或 `initPlatformAndApps` 中）添加日志清理调用：

```typescript
import { cleanupOldLogs } from '../services/log';

// 在 extended services 初始化完成后异步清理过期日志
const logDir = isDev
  ? join(homedir(), '.aico-bot-dev', 'logs')
  : app.getPath('userData') + '/logs';
cleanupOldLogs(logDir).catch(() => {});
```

### 不做的事

- **不替换 152 个文件中的 `console.*` 调用**（全局 console 替换已通过 `Object.assign` 生效）
- **不改变 electron-log 的 API 使用方式**（保持 `log.create({ logId })` 模式）
- **不增加日志格式化文件**（结构化格式通过 `log.hooks` 实现，代码量少，放入 index.ts）
- **不增加日志级别动态调整 API**（当前场景不需要运行时修改日志级别，YAGNI）
- **不引入新依赖**（继续使用 electron-log v5.4.3）

## 涉及文件（实际）

| # | 文件路径 | 变更类型 | 说明 |
|---|---------|---------|------|
| 1 | `src/main/services/log/index.ts` | 新增 | 模块入口，导出 initLogger / createLogger / cleanupOldLogs |
| 2 | `src/main/services/log/types.ts` | 新增 | ScopedLogger、LogConfig 类型定义（使用 electron-log LevelOption） |
| 3 | `src/main/services/log/log-cleanup.ts` | 新增 | 日志清理函数（从 utils/log-cleanup.ts 迁入） |
| 4 | `src/main/index.ts` | 修改 | 替换内联日志初始化为 initLogger() 调用，保留 EPIPE 过滤器 |
| 5 | `src/main/bootstrap/extended.ts` | 修改 | 添加 cleanupOldLogs 调用 + import |
| 6 | `src/main/services/agent/orchestrator.ts` | 修改 | import 路径迁移 |
| 7 | `src/main/services/agent/mailbox.ts` | 修改 | import 路径迁移 |
| 8 | `src/main/services/agent/taskboard.ts` | 修改 | import 路径迁移 |
| 9 | `src/main/services/agent/persistent-worker.ts` | 修改 | import 路径迁移 |
| 10 | `src/main/services/agent/send-message-local.ts` | 修改 | import 路径迁移 |
| 11 | `src/main/services/agent/send-message-remote.ts` | 修改 | import 路径迁移 |
| 12 | `src/main/services/agent/permission-forwarder.ts` | 修改 | import 路径迁移 |
| 13 | `src/main/services/remote/ws/remote-ws-client.ts` | 修改 | import 路径迁移 |
| 14 | `src/main/services/remote/ws/ws-connection-pool.ts` | 修改 | import 路径迁移 |
| 15 | `src/main/services/remote/ws/aico-bot-mcp-bridge.ts` | 修改 | import 路径迁移 |
| 16 | `src/main/utils/logger.ts` | 删除 | 已迁入 services/log/ |
| 17 | `src/main/utils/log-cleanup.ts` | 删除 | 已迁入 services/log/（原本就是死代码） |

## 开发前必读

### 模块设计文档

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 1 | `.project/prd/feature/logging/logging-enhancement-v2.md` | 了解日志日期分割和清理方案（in-progress），确认与本次重构的衔接关系 |

### 源码文件

| # | 文件路径 | 阅读目的 |
|---|---------|---------|
| 2 | `src/main/index.ts` (行 16-106) | 了解当前日志初始化的完整代码，确定哪些行迁入 initLogger、哪些保留（ESM shim、EPIPE 过滤器） |
| 3 | `src/main/utils/logger.ts` | 了解现有 createLogger 实现，确认迁入逻辑 |
| 4 | `src/main/utils/log-cleanup.ts` | 了解现有清理函数实现，确认迁入逻辑 |
| 5 | `src/main/bootstrap/extended.ts` | 了解 extended services 初始化流程，确定 cleanupOldLogs 调用位置 |
| 6 | `src/main/services/agent/orchestrator.ts` (import 区域) | 确认 createLogger 的使用方式和 import 位置 |
| 7 | `src/main/services/config.service.ts` | 了解 getAicoBotDir / 数据目录路径解析，用于 initLogger 的 dataDir 参数 |

### API 文档

无需阅读 API 文档，本次改动不涉及对外 API 变更。

### 编码规范

| # | 文档 | 阅读目的 |
|---|------|---------|
| 8 | `docs/Development-Standards-Guide.md` | TypeScript strict、纯类型导入（`import type`）、命名规范 |

## 验收标准

- [x] `src/main/services/log/` 目录存在，包含 `index.ts`、`types.ts`、`log-cleanup.ts`
- [x] `initLogger(config)` 函数完成 electron-log 初始化、transport 配置、console 替换
- [x] `createLogger(scope)` 保持与旧版相同的 API 签名和输出格式
- [x] `src/main/index.ts` 中日志初始化代码从 ~90 行缩减为 1-2 行 `initLogger()` 调用
- [x] `src/main/index.ts` 中 EPIPE / network error 过滤器保留在原位（在 `initLogger` 之前注册）
- [x] 11 个使用 `createLogger` 的文件 import 路径已迁移到 `../services/log` 或 `../../services/log`
- [x] `src/main/utils/logger.ts` 已删除
- [x] `src/main/utils/log-cleanup.ts` 已删除
- [x] `cleanupOldLogs` 在 extended services 初始化后被调用（不再是无用的死代码）
- [x] 应用正常启动，console 输出和日志文件写入不受影响
- [x] `npm run typecheck && npm run build` 通过（lint 脚本不存在于项目中）

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-07 | 初始 PRD | @misakamikoto |
