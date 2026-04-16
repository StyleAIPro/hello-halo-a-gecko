# Bug 记录 -- 权限处理与转发

## BUG-001: AskUserQuestion 工具导致 Bot 卡死
- **日期**：2026-04-16
- **严重程度**：Critical
- **发现人**：@moonseeker1
- **问题**：Agent 调用 AskUserQuestion 后 Bot 永久卡住，用户无法看到问题卡片，只能手动停止
- **根因**：
  1. `permission-handler.ts` 的 pending promise 无超时机制，被丢弃后永远等待
  2. `chat.store.ts` 的 `isGenerating` 守卫静默丢弃问题，不通知主进程
  3. 缺少 renderer → main 的 reject IPC 通道
- **修复**：增加 5 分钟超时、放宽守卫、增加 reject IPC 通道
- **PRD**：`prd/bugfix-ask-user-question-hang-v1.md`
- **影响文档**：
  - [x] design.md — 异常流程补充超时和 reject 通道
  - [ ] api/ — 新增 IPC 通道需同步

---

## 统计

| 严重程度 | 数量 |
|---------|------|
| Critical | 1 |
| Major | 0 |
| Minor | 0 |
