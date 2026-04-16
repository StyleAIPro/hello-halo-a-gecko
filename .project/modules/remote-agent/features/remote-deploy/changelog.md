# 变更记录 — remote-deploy

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-16 | 初始设计：远程 Agent 代码部署与管理 | @moonseeker1 | 新功能 |
| 2026-04-16 | 重构：fs/list/read/write/delete 及 updateAgent 编排逻辑从 IPC 移入 remote-deploy.service.ts | @moonseeker1 | 代码审计 |
| 2026-04-16 | 修复：多实例共享远端 proxy 时 auth token 冲突（实现 registerTokenOnRemote、proxy 多 token 支持） | @moonseeker1 | bugfix-multi-token-registration-v1 |
| 2026-04-16 | 修复：connectServer 重连后不检测代理状态，UI 错误显示"代理已停止" | @claude | bugfix-proxy-status-not-updated-after-reconnect-v1 |
| 2026-04-16 | 修复：Windows 下 createDeployPackage tar 命令因反斜杠路径失败（远程部署不可用） | @claude | bugfix-tar-path-windows-backslash-v1 |
| 2026-04-16 | 修复：startAgent pgrep 误判导致代理未启动（改用 health 端点作为权威判断，pgrep 仅用于清理僵尸进程） | @claude | bugfix-startAgent-pgrep-false-positive-v1 |
