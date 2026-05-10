# PRD [Feature] — IPC 全量操作日志拦截

| 字段 | 值 |
|------|------|
| 版本 | v1 |
| 日期 | 2026-05-07 |
| 指令人 | @misakamikoto |
| 模块 | main（IPC Logger） |
| 状态 | done |
| 优先级 | P1 |
| 影响范围 | 仅主进程日志文件 |

## 需求分析

### 背景

用户要求日志中记录每一次操作（点击、输入等）及其结果（成功/失败）。所有用户操作最终通过 IPC `invoke` → `ipcMain.handle` 到达主进程。当前 254 个 IPC handler 中只有 11 个有 `[event]` 日志，覆盖率不足 5%。

### 技术方案

创建 `wrapIpcHandle()` 包装函数替代 `ipcMain.handle()`，自动记录每个 IPC 调用的通道名、耗时、成功/失败。

#### 新建文件

`src/main/ipc/ipc-logger.ts` — 包装函数，导出 `wrapIpcHandle(channel, handler)`

日志格式：`[event] <channel> -> ok/fail/error <N>ms`

#### 修改文件

21 个 `src/main/ipc/*.ts` 文件 — `ipcMain.handle(` → `wrapIpcHandle(` + 添加 import

#### 保留

已有 11 处手动 `[event]` 日志保留（含额外上下文信息）

### 不做的事

- 不修改 handler 内部逻辑
- 不记录参数（隐私 + 噪声）
- 不改变返回值格式

## 涉及文件

| # | 文件路径 | 变更类型 |
|---|---------|---------|
| 1 | `src/main/ipc/ipc-logger.ts` | 新建 |
| 2 | `src/main/ipc/agent.ts` | 修改 |
| 3 | `src/main/ipc/ai-browser.ts` | 修改 |
| 4 | `src/main/ipc/artifact.ts` | 修改 |
| 5 | `src/main/ipc/auth.ts` | 修改 |
| 6 | `src/main/ipc/browser.ts` | 修改 |
| 7 | `src/main/ipc/config.ts` | 修改 |
| 8 | `src/main/ipc/conversation.ts` | 修改 |
| 9 | `src/main/ipc/git-bash.ts` | 修改 |
| 10 | `src/main/ipc/gitcode.ts` | 修改 |
| 11 | `src/main/ipc/github.ts` | 修改 |
| 12 | `src/main/ipc/health.ts` | 修改 |
| 13 | `src/main/ipc/hyper-space.ts` | 修改 |
| 14 | `src/main/ipc/onboarding.ts` | 修改 |
| 15 | `src/main/ipc/overlay.ts` | 修改 |
| 16 | `src/main/ipc/remote.ts` | 修改 |
| 17 | `src/main/ipc/remote-server.ts` | 修改 |
| 18 | `src/main/ipc/search.ts` | 修改 |
| 19 | `src/main/ipc/skill.ts` | 修改 |
| 20 | `src/main/ipc/space.ts` | 修改 |
| 21 | `src/main/ipc/store.ts` | 修改 |
| 22 | `src/main/ipc/system.ts` | 修改 |

## 验收标准

- [ ] 所有 IPC 调用在日志文件中产生 `[event] xxx -> ok/fail/error Nms` 格式日志
- [ ] 成功调用显示 `-> ok`
- [ ] 失败调用显示 `-> fail`
- [ ] 异常调用显示 `-> error` + 错误信息
- [ ] 已有手动 `[event]` 日志保留不受影响
- [ ] `npm run build` 通过

## 变更记录

| 日期 | 内容 | 作者 |
|------|------|------|
| 2026-05-07 | 初始版本：ipc-logger.ts 包装器 + 21 个 IPC 文件替换 | subagent |
