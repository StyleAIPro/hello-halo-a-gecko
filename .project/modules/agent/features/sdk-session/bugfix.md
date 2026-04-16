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

## 统计

| 严重程度 | 数量 |
|---------|------|
| Critical | 1 |
| Major | 0 |
| Minor | 0 |
