# PRD: 修复日志按日期命名失效（variables.date 不存在）

## 元信息

- **创建时间**: 2026-05-08
- **状态**: done
- **指令人**: misakamikoto
- **级别**: bugfix
- **前置**: bugfix-log-daily-rotation-prod-v1（已 done，但根因分析有误）
- **优先级**: P0
- **影响范围**: 仅后端

## 问题描述

日志文件未按日期命名。实际生成的文件名为 `main-unknown.log`（而非预期的 `main-2026-05-08.log`），所有日志集中写入单个文件，没有按日期分割。

### 根因分析

`src/main/services/log/index.ts` 中 `createLogResolvePath` 依赖 `variables.date` 获取日期：

```typescript
const dateStr = variables.date?.toISOString().split('T')[0] ?? 'unknown';
```

但 electron-log 的 `resolvePathFn` 回调参数只包含路径变量（appData、userData、appName、temp 等），**不包含 `date` 字段**：

```json
{
  "appData": "C:\\Users\\...",
  "appName": "aico-bot",
  "appVersion": "2.1.2",
  "home": "C:\\Users\\...",
  "temp": "C:\\Users\\...\\Temp",
  "userData": "C:\\Users\\...\\aico-bot",
  "fileName": "main.log"
}
```

`variables.date` 始终为 `undefined`，回退到 `'unknown'`，导致所有日志写入 `main-unknown.log`。

## 技术方案

使用 `new Date()` 替代 `variables.date` 获取当前日期：

```typescript
export function createLogResolvePath(logDir: string) {
  return () => {
    const dateStr = new Date().toISOString().split('T')[0];
    return join(logDir, `main-${dateStr}.log`);
  };
}
```

## 涉及文件

| 文件 | 变更类型 |
|------|---------|
| `src/main/services/log/index.ts` | 修改 `createLogResolvePath`，用 `new Date()` 替代 `variables.date` |

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 源码文件 | `src/main/services/log/index.ts` | 理解当前 `createLogResolvePath` 实现 |
| 源码文件 | `src/main/services/log/log-cleanup.ts` | 确认 `main-*.log` 匹配模式不受影响 |

## 验收标准

- [x] 开发环境生成文件：`~/.aico-bot-dev/app-logs/main-2026-05-08.log`（非 `main-unknown.log`）
- [x] 生产环境生成文件：`{userData}/app-logs/main-2026-05-08.log`
- [x] 跨天后自动写入新日期文件
- [x] `npm run build` 通过
- [x] `cleanupOldLogs` 不受影响
