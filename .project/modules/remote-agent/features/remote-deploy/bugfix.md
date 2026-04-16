# Bug 记录 — remote-deploy

## 统计
| 严重程度 | 数量 |
|---------|------|
| Critical | 2 |
| Major | 2 |
| Minor | 0 |

### remote-deploy 多实例 token 冲突
- **严重程度**：Major
- **日期**：2026-04-16
- **现象**：dev/packaged 共享远端 proxy 时后启动实例 401 认证失败
- **根因**：proxy 单 token + registerTokenOnRemote() 未实现 + WS client 用错 token
- **PRD**：`prd/bugfix/remote-agent/bugfix-multi-token-registration-v1.md`

### startAgent pgrep 误判导致代理未启动
- **严重程度**：Critical
- **日期**：2026-04-16
- **现象**：Update Agent 后 proxy 始终显示"已停止"，远端确认无 node 进程
- **根因**：startAgent 仅用 pgrep 检查进程存在性，不验证 health 端点；pgrep 匹配到非 proxy 进程时误判"已在运行"并跳过启动
- **PRD**：`prd/bugfix/remote-agent/bugfix-startAgent-pgrep-false-positive-v1.md`

### Windows 下 tar 命令因反斜杠路径失败
- **严重程度**：Critical
- **日期**：2026-04-16
- **现象**：远程部署时报错 `Cannot connect to C: resolve failed`，部署完全不可用
- **根因**：`createDeployPackage()` 拼接 tar 参数时使用 Node.js 路径（含 `\`），Git Bash tar 将 `\` 视为转义符
- **PRD**：`prd/bugfix/remote-agent/bugfix-tar-path-windows-backslash-v1.md`

### connectServer 重连后代理状态未刷新
- **严重程度**：Major
- **日期**：2026-04-16
- **现象**：应用重启/重连后 UI 始终显示"Bot 代理已停止"，即使代理实际在运行
- **根因**：`connectServer()` 连接成功后不调用 `detectAgentInstalled()`，`proxyRunning` 保持旧值
- **PRD**：`prd/bugfix/remote-agent/bugfix-proxy-status-not-updated-after-reconnect-v1.md`
