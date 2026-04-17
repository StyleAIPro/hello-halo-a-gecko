# Bug 记录 — space-crud

## BUG-001: Windows 删除空间 EBUSY 错误
- **日期**：2026-04-17
- **严重程度**：Major
- **发现人**：@zhaoyinqi
- **问题**：删除空间时报 EBUSY (resource busy or locked) 错误，空间目录无法删除
- **根因**：`closeSessionsBySpaceId()` 调用 `session.close()` 后立即返回，不等待 SDK 子进程退出。子进程 cwd 为空间目录，Windows 上 OS 释放文件句柄需要额外时间，500ms 重试延迟不够
- **修复**：`closeSessionsBySpaceId()` 改为 async，通过 PID 轮询等待子进程退出；`deleteSpace()` 重试次数从 1 次增加到 3 次，退避延迟 500ms/1s/2s
- **PRD**：`prd/bugfix/space/bugfix-space-delete-ebusy-v1.md`
- **影响文档**：
  - [ ] design.md

---

## 统计
| 严重程度 | 数量 |
|---------|------|
| Critical | 0 |
| Major | 1 |
| Minor | 0 |
