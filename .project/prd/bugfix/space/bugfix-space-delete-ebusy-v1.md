# PRD [Bug 修复级] — Windows 删除空间 EBUSY 错误

> 版本：bugfix-space-delete-ebusy-v1
> 日期：2026-04-17
> 指令人：@zhaoyinqi
> 反馈人：@zhaoyinqi
> 归属模块：modules/space
> 严重程度：Major

## 问题描述
- **期望行为**：在 Windows 上删除空间时，空间目录应被正常删除
- **实际行为**：删除空间时报 `EBUSY (resource busy or locked)` 错误，空间目录无法删除
- **复现步骤**：
  1. 创建一个空间并启动 Agent 会话（SDK 子进程使用该空间目录作为 cwd）
  2. 删除该空间
  3. 观察到删除失败，报 EBUSY 错误

## 根因分析

### 删除流程

`src/main/services/space.service.ts` 的 `deleteSpace()` 函数（第 547-621 行）：

1. 调用 `closeSessionsBySpaceId(spaceId)` 关闭该空间的所有 V2 session
2. 调用 `await destroySpaceCache(spaceId)` 停止文件监听
3. 调用 `rmSync(spacePath, { recursive: true, force: true })` 删除目录
4. 如果失败（EBUSY/EPERM/EACCES），等待 500ms 后重试一次

### 问题根因

`closeSessionsBySpaceId()` 调用 `cleanupSession()`，后者调用 `info.session.close()` 来关闭 SDK session。`session.close()` 会触发 transport 关闭，进而终止 SDK 子进程。但这个过程是异步的：

1. `session.close()` 是同步调用，但子进程终止是异步的
2. SDK 子进程的工作目录（cwd）设置为空间目录（`sdk-config.ts` 的 `cwd: workDir`）
3. Windows 上子进程终止后，OS 释放文件句柄需要额外时间
4. 500ms 的重试延迟对 Windows 来说不够

### 关键代码位置

| 文件 | 行号 | 说明 |
|------|------|------|
| `session-manager.ts` | 73 | `info.session.close()` — 仅发送关闭信号，不等待子进程退出 |
| `session-manager.ts` | 711 | `const pid = (session as any).pid` — PID 已被记录但未在 cleanup 时使用 |
| `space.service.ts` | 579 | `await new Promise((r) => setTimeout(r, 500))` — 重试延迟仅 500ms |
| `sdk-config.ts` | `buildBaseSdkOptions()` | 子进程 cwd 设为空间目录 |

## 修复方案

在 `closeSessionsBySpaceId()` 中，调用 `session.close()` 后，等待子进程实际退出再返回。使用 PID 和 process kill 来确保子进程被终止。

### 修改 1：`session-manager.ts` — `closeSessionsBySpaceId()` 改为 async

将 `closeSessionsBySpaceId()` 改为异步函数，在 `session.close()` 后通过 PID 轮询等待子进程退出：

```typescript
// 改前（同步）
function closeSessionsBySpaceId(spaceId: string): void {
  // ... 遍历 sessions，调用 cleanupSession
}

// 改后（异步）
async function closeSessionsBySpaceId(spaceId: string): Promise<void> {
  // ... 遍历 sessions，调用 cleanupSession
  // ... 对每个已关闭 session，通过 PID 等待子进程退出
}
```

### 修改 2：`session-manager.ts` — 新增 `waitForSessionExit()` 辅助函数

通过 PID 轮询等待子进程退出，超时后强制 kill：

```typescript
async function waitForSessionExit(pid: number, timeoutMs: number = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0); // 检查进程是否存活
      await new Promise((r) => setTimeout(r, 100)); // 100ms 轮询间隔
    } catch {
      return; // 进程已退出
    }
  }
  // 超时，强制 kill
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 进程可能已经退出
  }
}
```

### 修改 3：`space.service.ts` — 增加重试次数和退避时间

将 `deleteSpace()` 中的重试逻辑从 1 次改为 3 次，使用指数退避：

```typescript
// 改前
await new Promise((r) => setTimeout(r, 500));
rmSync(spacePath, { recursive: true, force: true });

// 改后
const delays = [500, 1000, 2000];
for (const delay of delays) {
  await new Promise((r) => setTimeout(r, delay));
  rmSync(spacePath, { recursive: true, force: true });
}
```

## 影响范围
- [ ] 涉及 API 变更 → 无（内部逻辑修改，IPC 接口不变）
- [ ] 涉及数据结构变更 → 无
- [ ] 涉及功能设计变更 → 无（修复现有行为，不改变功能设计）

## 验证方式

1. 在 Windows 上创建空间，启动 Agent 会话，然后删除空间 — 应成功删除，无 EBUSY 错误
2. 在 macOS/Linux 上执行相同操作 — 应继续正常工作
3. 删除无活跃会话的空间 — 应立即删除
4. 删除有多个活跃会话的空间 — 所有会话的子进程均应被终止后才删除目录

## 变更
| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-17 | 初始 PRD | @zhaoyinqi |
