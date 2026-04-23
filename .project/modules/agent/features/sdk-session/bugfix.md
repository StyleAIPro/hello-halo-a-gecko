# Bug 记录 -- SDK 会话管理

## BUG-001: sessionId 未定义导致 sendMessage 崩溃
- **日期**：2026-04-16
- **严重程度**：Critical
- **发现人**：@moonseeker1
- **问题**：发送消息时崩溃，报 `ReferenceError: sessionId is not defined`
- **根因**：参数对象化重构遗漏，日志中引用了不存在的 `sessionId` 变量，应为 `options.sessionId`
- **修复**：`session-manager.ts:656` `${sessionId}` → `${options.sessionId}`
- **PRD**：`prd/bugfix/agent/bugfix-sessionid-not-defined-v1.md`
- **影响文档**：
  - [ ] design.md

---

## BUG-002: Windows 删除空间 EBUSY 错误
- **日期**：2026-04-17
- **严重程度**：Major
- **发现人**：@zhaoyinqi
- **问题**：删除空间时报 EBUSY 错误，因为 `closeSessionsBySpaceId()` 不等待 SDK 子进程退出
- **根因**：`session.close()` 仅发送关闭信号，子进程终止是异步的。子进程 cwd 为空间目录，Windows 上 OS 释放文件句柄需要额外时间
- **修复**：`closeSessionsBySpaceId()` 改为 async，新增 `waitForSessionExit()` 通过 PID 轮询等待子进程退出（100ms 间隔，5s 超时后 SIGKILL）
- **PRD**：`prd/bugfix/space/bugfix-space-delete-ebusy-v1.md`
- **影响文档**：
  - [ ] design.md

---

## 统计

| 严重程度 | 数量 |
|---------|------|
| Critical | 1 |
| Major | 1 |
| Minor | 0 |
