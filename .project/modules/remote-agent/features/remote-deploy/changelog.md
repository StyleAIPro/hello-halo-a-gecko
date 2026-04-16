# 变更记录 — remote-deploy

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-17 | 修复 `checkAgentInstalled` 未做版本精确匹配：增加 `version === REQUIRED_SDK_VERSION` 校验，不匹配时设置 `sdkVersionMismatch: true`，UI 据此显示版本不匹配警告 | @zhaoyinqi | bugfix-sdk-version-check-v1 |
| 2026-04-17 | 修复 SDK 安装命令模板字符串未插值：3 处 npm install 单引号字符串改为反引号模板字符串，确保 `${REQUIRED_SDK_VERSION}` 正确插值，避免安装最新版而非指定版本 | @zhaoyinqi | bugfix-sdk-version-interpolation-v1 |
| 2026-04-17 | 修复 WebSocket 客户端认证 token 不一致：`createWsClient` 中 `authToken` 从 `server.password` 改为 `server.authToken`，与 Proxy 服务端保持一致 | @zhaoyinqi | bugfix-ws-auth-token-mismatch-v1 |
| 2026-04-17 | addServer 增加自动部署：检测到文件缺失或 SDK 不达标时自动部署，都 OK 时自动拉起 proxy；updateAgent/startAgent 后立即 verifyProxyHealth；健康监控 static 定时器防双实例 | @zhaoyinqi | bugfix-proxy-health-monitor-v1 |
| 2026-04-16 | updateAgent 增加快速重启路径（文件完整+SDK 匹配时只 restart），connectServer 成功后重置 autoRecoverFailures | @zhaoyinqi | bugfix-proxy-health-monitor-v1 |
| 2026-04-16 | 新增后台周期健康监控（30 秒），proxy 挂掉后自动恢复或告警提示 Update Agent | @zhaoyinqi | bugfix-proxy-health-monitor-v1 |
| 2026-04-16 | 统一 SDK Patch：构建脚本改用 `scripts/patch-sdk.mjs`（统一脚本），删除旧 `packages/remote-agent-proxy/scripts/patch-sdk.mjs` | @zhaoyinqi | unified-sdk-patch-v1 |
| 2026-04-16 | 初始设计：远程 Agent 代码部署与管理 | @moonseeker1 | 新功能 |
| 2026-04-16 | 重构：fs/list/read/write/delete 及 updateAgent 编排逻辑从 IPC 移入 remote-deploy.service.ts | @moonseeker1 | 代码审计 |
| 2026-04-16 | 统一 SDK 版本常量（`src/shared/constants/sdk.ts`），清理 0.2.87 遗留物，记录 SDK Patch 机制 | @StyleAIPro | unified-sdk-version-config-v1 |
