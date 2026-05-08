# PRD: 修复生产环境日志按日期分割失效

## 元信息

- **创建时间**: 2026-05-08
- **状态**: done
- **指令人**: misakamikoto
- **级别**: bugfix
- **优先级**: P1
- **影响范围**: 仅后端

## 问题描述

生产环境下日志文件未按日期分割存储。

### 根因分析

`src/main/index.ts:461-464` 中，生产环境在 `app.whenReady()` 后覆盖了 `resolvePathFn`：

```typescript
if (!isDev) {
  log.transports.file.resolvePathFn = () => {
    return join(app.getPath('userData'), 'app-logs');  // ← 返回的是目录，不是文件路径
  };
}
```

而 `initLogger()`（`src/main/services/log/index.ts:36-38`）中正确配置了日期格式：

```typescript
log.transports.file.resolvePathFn = (variables) => {
  const dateStr = variables.date?.toISOString().split('T')[0] ?? 'unknown';
  return join(logDir, `main-${dateStr}.log`);
};
```

生产环境覆盖时丢失了日期格式化逻辑，`resolvePathFn` 返回的是目录路径而非文件路径，导致 electron-log 回退到默认命名行为（`main.log`），日志不再按日期分割。

### 为什么 initLogger 时不能直接用生产路径

`app.getPath('userData')` 需要 `app.whenReady()` 之后才能调用，所以 `initLogger()` 在模块顶层执行时无法获取生产环境路径，只能在 `app.whenReady()` 回调中覆盖。

## 技术方案

### 方案：将日期格式化逻辑提取为共享函数，生产覆盖时复用

1. 在 `src/main/services/log/index.ts` 中导出一个 `createLogResolvePath(logDir: string)` 函数，封装日期格式化逻辑
2. 在 `src/main/index.ts` 的生产覆盖处调用该函数，而非手写 `resolvePathFn`

### 具体改动

#### 文件 1: `src/main/services/log/index.ts`

- 新增导出函数 `createLogResolvePath(logDir: string)`：
  ```typescript
  export function createLogResolvePath(logDir: string) {
    return (variables: any) => {
      const dateStr = variables.date?.toISOString().split('T')[0] ?? 'unknown';
      return join(logDir, `main-${dateStr}.log`);
    };
  }
  ```
- `initLogger()` 内部复用该函数

#### 文件 2: `src/main/index.ts`

- 导入 `createLogResolvePath`
- 生产覆盖改为：
  ```typescript
  if (!isDev) {
    log.transports.file.resolvePathFn = createLogResolvePath(
      join(app.getPath('userData'), 'app-logs')
    );
  }
  ```

## 涉及文件

| 文件 | 变更类型 |
|------|---------|
| `src/main/services/log/index.ts` | 新增 `createLogResolvePath` 导出函数，`initLogger` 内部复用 |
| `src/main/index.ts` | 导入 `createLogResolvePath`，修复生产 `resolvePathFn` |

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 源码文件 | `src/main/services/log/index.ts` | 理解当前 `initLogger` 实现 |
| 源码文件 | `src/main/services/log/types.ts` | 理解类型定义 |
| 源码文件 | `src/main/index.ts` (440-470行) | 理解生产覆盖逻辑 |
| 源码文件 | `src/main/services/log/log-cleanup.ts` | 确认清理不受影响 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript 规范 |

## 验收标准

- [x] 开发环境日志文件路径：`~/.aico-bot-dev/app-logs/main-YYYY-MM-DD.log`
- [x] 生产环境日志文件路径：`{userData}/app-logs/main-YYYY-MM-DD.log`
- [x] 跨天时自动生成新日志文件（日期变更后新日志写入新文件）
- [x] `npm run typecheck` 通过（既有错误与本次无关）
- [x] `npm run build` 通过
- [x] 已有 `cleanupOldLogs` 功能不受影响（仍匹配 `main-*.log` 模式）
