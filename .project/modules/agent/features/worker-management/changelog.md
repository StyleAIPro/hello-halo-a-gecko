# 变更记录 -- 持久化 Worker 与任务板

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-21 | 修复子 Agent 误报 "Stream interrupted"：streamChat 正常完成时不再发送 worker:completed failure 事件 — PRD: `prd/bugfix/agent/bugfix-remote-duplicate-subagent-v1` | @misakamikoto | bugfix-remote-duplicate-subagent-v1 |
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
